import { Router } from 'express';
import { Prisma, type PrismaClient } from '@prisma/client';
import { currentAdmin, currentUser, requireAdmin, requireUser } from '../../infrastructure/sessions.js';
import { logger } from '../../infrastructure/logger.js';
import type { WriteCoordinator } from '../../infrastructure/prisma.js';
import { rateLimit } from '../../infrastructure/rate-limit.js';
import { conflict, notFound } from '../../shared/errors.js';
import {
  createAdminSupportConversationSchema,
  createSupportMessageSchema,
  createUserSupportConversationSchema,
  markSupportReadSchema,
  supportConversationListSchema,
  supportConversationParamsSchema,
  supportMessageListSchema,
  updateSupportStatusSchema,
  type SupportActorType,
  type SupportStatus,
} from './support-schemas.js';
import { SupportRealtimeHub, type SupportRealtimeActor } from './support-realtime.js';

type SupportDb = PrismaClient | Prisma.TransactionClient;
type SupportActor = SupportRealtimeActor & { name: string; requestId?: string };

const conversationInclude = {
  user: { select: { id: true, name: true, email: true } },
} satisfies Prisma.SupportConversationInclude;

type ConversationRow = Prisma.SupportConversationGetPayload<{ include: typeof conversationInclude }>;
type MessageRow = Prisma.SupportMessageGetPayload<Record<string, never>>;
type ConversationUnreadRow = { conversationId: string; unreadCount: bigint | number };
type ActorUnreadRow = { actorType: SupportActorType; actorId: string; unreadCount: bigint | number };

const previewMessage = (content: string) => content.replace(/\s+/g, ' ').trim().slice(0, 160);
const adminSupportDisplayName = (name: string | null) => name?.trim() || 'Equipo de soporte';

function supportAudit(
  actor: SupportActor,
  action: string,
  conversationId: string,
  metadata: Record<string, unknown>,
): Prisma.AuditLogCreateInput {
  return {
    actorType: 'ADMIN',
    actorId: actor.id,
    action,
    entityType: 'SupportConversation',
    entityId: conversationId,
    metadata: JSON.stringify(metadata),
    requestId: actor.requestId,
  };
}

function mapMessage(message: MessageRow, viewer: SupportRealtimeActor) {
  const publicAdminSender = viewer.type === 'USER' && message.senderType === 'ADMIN';
  return {
    id: message.id,
    conversationId: message.conversationId,
    senderType: message.senderType,
    sender: publicAdminSender
      ? { id: 'support-team', name: 'Equipo de soporte' }
      : { id: message.senderId, name: message.senderName },
    content: message.content,
    createdAt: message.createdAt,
  };
}

const realtimeActorKey = (actor: SupportRealtimeActor) => `${actor.type}:${actor.id}`;

async function conversationUnreadCounts(
  db: SupportDb,
  conversationIds: string[],
  actor: SupportRealtimeActor,
): Promise<Map<string, number>> {
  const counts = new Map(conversationIds.map((id) => [id, 0]));
  if (conversationIds.length === 0) return counts;
  const rows = await db.$queryRaw<ConversationUnreadRow[]>(Prisma.sql`
    SELECT c."id" AS "conversationId", COUNT(m."id") AS "unreadCount"
    FROM "SupportConversation" c
    LEFT JOIN "SupportConversationRead" r
      ON r."conversationId" = c."id"
      AND r."actorType" = ${actor.type}
      AND r."actorId" = ${actor.id}
    LEFT JOIN "SupportMessage" m
      ON m."conversationId" = c."id"
      AND m."senderType" <> ${actor.type}
      AND (r."lastReadAt" IS NULL OR m."createdAt" > r."lastReadAt")
    WHERE c."id" IN (${Prisma.join(conversationIds)})
    GROUP BY c."id"
  `);
  for (const row of rows) counts.set(row.conversationId, Number(row.unreadCount));
  return counts;
}

async function actorUnreadCounts(
  db: SupportDb,
  actors: SupportRealtimeActor[],
  conversationId?: string,
): Promise<Map<string, number>> {
  const counts = new Map(actors.map((actor) => [realtimeActorKey(actor), 0]));
  if (actors.length === 0) return counts;
  const actorValues = Prisma.join(actors.map((actor) => Prisma.sql`(${actor.type}, ${actor.id})`));
  const rows = conversationId
    ? await db.$queryRaw<ActorUnreadRow[]>(Prisma.sql`
        WITH "RequestedActor" ("actorType", "actorId") AS (VALUES ${actorValues})
        SELECT a."actorType" AS "actorType", a."actorId" AS "actorId", COUNT(m."id") AS "unreadCount"
        FROM "RequestedActor" a
        LEFT JOIN "SupportConversationRead" r
          ON r."conversationId" = ${conversationId}
          AND r."actorType" = a."actorType"
          AND r."actorId" = a."actorId"
        LEFT JOIN "SupportMessage" m
          ON m."conversationId" = ${conversationId}
          AND m."senderType" <> a."actorType"
          AND (r."lastReadAt" IS NULL OR m."createdAt" > r."lastReadAt")
        GROUP BY a."actorType", a."actorId"
      `)
    : await db.$queryRaw<ActorUnreadRow[]>(Prisma.sql`
        WITH "RequestedActor" ("actorType", "actorId") AS (VALUES ${actorValues})
        SELECT a."actorType" AS "actorType", a."actorId" AS "actorId", COUNT(m."id") AS "unreadCount"
        FROM "RequestedActor" a
        LEFT JOIN "SupportConversation" c
          ON a."actorType" = 'ADMIN'
          OR (a."actorType" = 'USER' AND c."userId" = a."actorId")
        LEFT JOIN "SupportConversationRead" r
          ON r."conversationId" = c."id"
          AND r."actorType" = a."actorType"
          AND r."actorId" = a."actorId"
        LEFT JOIN "SupportMessage" m
          ON m."conversationId" = c."id"
          AND m."senderType" <> a."actorType"
          AND (r."lastReadAt" IS NULL OR m."createdAt" > r."lastReadAt")
        GROUP BY a."actorType", a."actorId"
      `);
  for (const row of rows) counts.set(`${row.actorType}:${row.actorId}`, Number(row.unreadCount));
  return counts;
}

function mapConversation(conversation: ConversationRow, unreadCount: number) {
  return {
    id: conversation.id,
    status: conversation.status,
    subject: conversation.subject,
    user: conversation.user,
    createdByType: conversation.createdByType,
    lastMessageAt: conversation.lastMessageAt,
    lastMessagePreview: conversation.lastMessagePreview,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    unreadCount,
  };
}

function conversationWhere(actor: SupportRealtimeActor, id?: string): Prisma.SupportConversationWhereInput {
  return {
    ...(id ? { id } : {}),
    ...(actor.type === 'USER' ? { userId: actor.id } : {}),
  };
}

async function findConversation(db: SupportDb, actor: SupportRealtimeActor, id: string): Promise<ConversationRow> {
  const conversation = await db.supportConversation.findFirst({
    where: conversationWhere(actor, id),
    include: conversationInclude,
  });
  if (!conversation) throw notFound('Conversación de soporte no encontrada');
  return conversation;
}

export async function getSupportUnreadCount(db: SupportDb, actor: SupportRealtimeActor): Promise<number> {
  const counts = await actorUnreadCounts(db, [actor]);
  return counts.get(realtimeActorKey(actor)) ?? 0;
}

class SupportNotifier {
  constructor(private readonly db: PrismaClient, private readonly hub: SupportRealtimeHub) {}

  private actorsForConversation(conversation: ConversationRow): SupportRealtimeActor[] {
    return [
      { type: 'USER', id: conversation.userId },
      ...this.hub.connectedAdminIds().map((id): SupportRealtimeActor => ({ type: 'ADMIN', id })),
    ];
  }

  async conversationCreated(conversationId: string): Promise<void> {
    const conversation = await this.db.supportConversation.findUniqueOrThrow({
      where: { id: conversationId },
      include: conversationInclude,
    });
    const actors = this.actorsForConversation(conversation);
    const [conversationCounts, totalCounts] = await Promise.all([
      actorUnreadCounts(this.db, actors, conversation.id),
      actorUnreadCounts(this.db, actors),
    ]);
    for (const actor of actors) {
      const key = realtimeActorKey(actor);
      const summary = mapConversation(conversation, conversationCounts.get(key) ?? 0);
      this.hub.send(actor, 'support.conversation.created', { conversation: summary });
      this.hub.send(actor, 'support.unread_count', { count: totalCounts.get(key) ?? 0 });
    }
  }

  async messageCreated(conversationId: string, message: MessageRow): Promise<void> {
    const conversation = await this.db.supportConversation.findUniqueOrThrow({
      where: { id: conversationId },
      include: conversationInclude,
    });
    const actors = this.actorsForConversation(conversation);
    const [conversationCounts, totalCounts] = await Promise.all([
      actorUnreadCounts(this.db, actors, conversation.id),
      actorUnreadCounts(this.db, actors),
    ]);
    for (const actor of actors) {
      const key = realtimeActorKey(actor);
      const summary = mapConversation(conversation, conversationCounts.get(key) ?? 0);
      this.hub.send(actor, 'support.message.created', {
        conversation: summary,
        message: mapMessage(message, actor),
        unreadCount: summary.unreadCount,
      });
      this.hub.send(actor, 'support.unread_count', { count: totalCounts.get(key) ?? 0 });
    }
  }

  async conversationRead(conversationId: string, reader: SupportRealtimeActor, readAt: Date): Promise<void> {
    const conversation = await this.db.supportConversation.findUniqueOrThrow({
      where: { id: conversationId },
      include: conversationInclude,
    });
    const actors = this.actorsForConversation(conversation);
    const totalCounts = await actorUnreadCounts(this.db, actors);
    for (const actor of actors) {
      this.hub.send(actor, 'support.conversation.read', {
        conversationId,
        readerType: reader.type,
        readerId: actor.type === 'USER' && reader.type === 'ADMIN' ? 'support-team' : reader.id,
        readAt,
      });
      this.hub.send(actor, 'support.unread_count', { count: totalCounts.get(realtimeActorKey(actor)) ?? 0 });
    }
  }

  async statusChanged(conversationId: string): Promise<void> {
    const conversation = await this.db.supportConversation.findUniqueOrThrow({
      where: { id: conversationId },
      include: conversationInclude,
    });
    const actors = this.actorsForConversation(conversation);
    const conversationCounts = await actorUnreadCounts(this.db, actors, conversation.id);
    for (const actor of actors) {
      this.hub.send(actor, 'support.conversation.status_changed', {
        conversation: mapConversation(conversation, conversationCounts.get(realtimeActorKey(actor)) ?? 0),
      });
    }
  }
}

async function safelyNotify(operation: Promise<void>, action: string): Promise<void> {
  try {
    await operation;
  } catch (error) {
    logger.error({ err: error, action }, 'Support realtime notification failed');
  }
}

async function listConversations(
  db: PrismaClient,
  actor: SupportRealtimeActor,
  query: ReturnType<typeof supportConversationListSchema.parse>,
) {
  const rows = await db.supportConversation.findMany({
    where: { ...conversationWhere(actor), ...(query.status ? { status: query.status } : {}) },
    include: conversationInclude,
    orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    take: query.limit + 1,
  });
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const unreadCounts = await conversationUnreadCounts(db, page.map((conversation) => conversation.id), actor);
  return {
    conversations: page.map((conversation) => mapConversation(conversation, unreadCounts.get(conversation.id) ?? 0)),
    nextCursor: hasMore ? page.at(-1)?.id ?? null : null,
  };
}

async function getConversationDetail(
  db: PrismaClient,
  actor: SupportRealtimeActor,
  id: string,
  query: ReturnType<typeof supportMessageListSchema.parse>,
) {
  const conversation = await findConversation(db, actor, id);
  const rows = await db.supportMessage.findMany({
    where: { conversationId: id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    take: query.limit + 1,
  });
  const hasMore = rows.length > query.limit;
  const pageDescending = hasMore ? rows.slice(0, query.limit) : rows;
  const nextCursor = hasMore ? pageDescending.at(-1)?.id ?? null : null;
  const unreadCounts = await conversationUnreadCounts(db, [conversation.id], actor);
  return {
    conversation: mapConversation(conversation, unreadCounts.get(conversation.id) ?? 0),
    messages: [...pageDescending].reverse().map((message) => mapMessage(message, actor)),
    nextCursor,
  };
}

type CreateConversationInput = {
  userId: string;
  subject: string;
  message: string;
  clientMessageId?: string;
};

async function createConversation(
  db: PrismaClient,
  coordinator: Pick<WriteCoordinator, 'run'>,
  notifier: SupportNotifier,
  actor: SupportActor,
  input: CreateConversationInput,
) {
  const result = await coordinator.run(() => db.$transaction(async (tx) => {
    if (input.clientMessageId) {
      const duplicate = await tx.supportMessage.findUnique({
        where: { clientMessageId: input.clientMessageId },
        include: { conversation: { select: { id: true, userId: true, subject: true, createdByType: true, createdById: true } } },
      });
      if (duplicate) {
        const exactRetry = duplicate.isInitial
          && duplicate.senderType === actor.type
          && duplicate.senderId === actor.id
          && duplicate.conversation.createdByType === actor.type
          && duplicate.conversation.createdById === actor.id
          && duplicate.conversation.userId === input.userId
          && duplicate.conversation.subject === input.subject
          && duplicate.content === input.message;
        if (!exactRetry) throw conflict('SUPPORT_MESSAGE_ID_REUSED', 'El identificador del mensaje ya fue utilizado');
        return { conversationId: duplicate.conversation.id, message: duplicate, created: false };
      }
    }
    const user = await tx.user.findFirst({
      where: { id: input.userId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!user) throw notFound('Usuario no encontrado');
    const now = new Date();
    const conversation = await tx.supportConversation.create({
      data: {
        userId: input.userId,
        subject: input.subject,
        createdByType: actor.type,
        createdById: actor.id,
        createdByName: actor.name,
        lastMessageAt: now,
        lastMessagePreview: previewMessage(input.message),
      },
    });
    const message = await tx.supportMessage.create({
      data: {
        conversationId: conversation.id,
        senderType: actor.type,
        senderId: actor.id,
        senderName: actor.name,
        content: input.message,
        clientMessageId: input.clientMessageId,
        isInitial: true,
        createdAt: now,
      },
    });
    await tx.supportConversationRead.create({
      data: { conversationId: conversation.id, actorType: actor.type, actorId: actor.id, lastReadAt: now },
    });
    if (actor.type === 'ADMIN') {
      await tx.auditLog.create({
        data: supportAudit(actor, 'SUPPORT_CONVERSATION_CREATED', conversation.id, {
          userId: input.userId,
          status: conversation.status,
        }),
      });
    }
    return { conversationId: conversation.id, message, created: true };
  }));

  if (result.created) await safelyNotify(notifier.conversationCreated(result.conversationId), 'conversation.created');
  const conversation = await db.supportConversation.findUniqueOrThrow({
    where: { id: result.conversationId },
    include: conversationInclude,
  });
  const unreadCounts = await conversationUnreadCounts(db, [conversation.id], actor);
  return { conversation: mapConversation(conversation, unreadCounts.get(conversation.id) ?? 0), reused: !result.created };
}

async function sendMessage(
  db: PrismaClient,
  coordinator: Pick<WriteCoordinator, 'run'>,
  notifier: SupportNotifier,
  actor: SupportActor,
  conversationId: string,
  input: ReturnType<typeof createSupportMessageSchema.parse>,
) {
  const result = await coordinator.run(() => db.$transaction(async (tx) => {
    const conversation = await findConversation(tx, actor, conversationId);

    if (input.clientMessageId) {
      const duplicate = await tx.supportMessage.findUnique({ where: { clientMessageId: input.clientMessageId } });
      if (duplicate) {
        if (
          duplicate.isInitial
          || duplicate.conversationId !== conversationId
          || duplicate.senderType !== actor.type
          || duplicate.senderId !== actor.id
          || duplicate.content !== input.content
        ) {
          throw conflict('SUPPORT_MESSAGE_ID_REUSED', 'El identificador del mensaje ya fue utilizado');
        }
        return { message: duplicate, created: false };
      }
    }
    if (conversation.status === 'CLOSED') throw conflict('SUPPORT_CONVERSATION_CLOSED', 'La conversación está cerrada');

    const now = new Date(Math.max(Date.now(), conversation.lastMessageAt.getTime() + 1));
    const message = await tx.supportMessage.create({
      data: {
        conversationId,
        senderType: actor.type,
        senderId: actor.id,
        senderName: actor.name,
        content: input.content,
        clientMessageId: input.clientMessageId,
        createdAt: now,
      },
    });
    const nextStatus: SupportStatus = conversation.status === 'RESOLVED'
      ? (actor.type === 'ADMIN' ? 'IN_PROGRESS' : 'OPEN')
      : conversation.status === 'OPEN' && actor.type === 'ADMIN'
        ? 'IN_PROGRESS'
        : conversation.status;
    await tx.supportConversation.update({
      where: { id: conversationId },
      data: {
        lastMessageAt: now,
        lastMessagePreview: previewMessage(input.content),
        ...(nextStatus !== conversation.status ? { status: nextStatus } : {}),
      },
    });
    await tx.supportConversationRead.upsert({
      where: { conversationId_actorType_actorId: { conversationId, actorType: actor.type, actorId: actor.id } },
      create: { conversationId, actorType: actor.type, actorId: actor.id, lastReadAt: now },
      update: { lastReadAt: now },
    });
    if (actor.type === 'ADMIN') {
      await tx.auditLog.create({
        data: supportAudit(actor, 'SUPPORT_MESSAGE_SENT', conversationId, {
          userId: conversation.userId,
          status: nextStatus,
          messageId: message.id,
        }),
      });
    }
    return { message, created: true };
  }));

  if (result.created) await safelyNotify(notifier.messageCreated(conversationId, result.message), 'message.created');
  return { message: mapMessage(result.message, actor), reused: !result.created };
}

async function markConversationRead(
  db: PrismaClient,
  coordinator: Pick<WriteCoordinator, 'run'>,
  notifier: SupportNotifier,
  actor: SupportRealtimeActor,
  conversationId: string,
  messageId?: string,
) {
  const readAt = await coordinator.run(() => db.$transaction(async (tx) => {
    await findConversation(tx, actor, conversationId);
    let target: Date;
    if (messageId) {
      const message = await tx.supportMessage.findFirst({
        where: { id: messageId, conversationId },
        select: { createdAt: true },
      });
      if (!message) throw notFound('Mensaje de soporte no encontrado');
      target = message.createdAt;
    } else {
      const latestMessage = await tx.supportMessage.findFirst({
        where: { conversationId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { createdAt: true },
      });
      target = latestMessage?.createdAt ?? new Date();
    }
    const current = await tx.supportConversationRead.findUnique({
      where: { conversationId_actorType_actorId: { conversationId, actorType: actor.type, actorId: actor.id } },
      select: { lastReadAt: true },
    });
    const nextReadAt = current && current.lastReadAt > target ? current.lastReadAt : target;
    await tx.supportConversationRead.upsert({
      where: { conversationId_actorType_actorId: { conversationId, actorType: actor.type, actorId: actor.id } },
      create: { conversationId, actorType: actor.type, actorId: actor.id, lastReadAt: nextReadAt },
      update: { lastReadAt: nextReadAt },
    });
    return nextReadAt;
  }));
  await safelyNotify(notifier.conversationRead(conversationId, actor, readAt), 'conversation.read');
  return { conversationId, readAt, unreadCount: await getSupportUnreadCount(db, actor) };
}

async function changeConversationStatus(
  db: PrismaClient,
  coordinator: Pick<WriteCoordinator, 'run'>,
  notifier: SupportNotifier,
  actor: SupportActor,
  conversationId: string,
  status: SupportStatus,
) {
  const changed = await coordinator.run(() => db.$transaction(async (tx) => {
    const existing = await findConversation(tx, actor, conversationId);
    if (existing.status === status) return false;
    await tx.supportConversation.update({ where: { id: conversationId }, data: { status } });
    await tx.auditLog.create({
      data: supportAudit(actor, 'SUPPORT_STATUS_CHANGED', conversationId, {
        userId: existing.userId,
        fromStatus: existing.status,
        toStatus: status,
      }),
    });
    return true;
  }));
  if (changed) await safelyNotify(notifier.statusChanged(conversationId), 'conversation.status_changed');
  const conversation = await findConversation(db, actor, conversationId);
  const unreadCounts = await conversationUnreadCounts(db, [conversation.id], actor);
  return { conversation: mapConversation(conversation, unreadCounts.get(conversation.id) ?? 0) };
}

export function createSupportRouters(
  db: PrismaClient,
  coordinator: Pick<WriteCoordinator, 'run'>,
  hub: SupportRealtimeHub,
) {
  const notifier = new SupportNotifier(db, hub);
  const userRouter = Router();
  const adminRouter = Router();
  userRouter.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    next();
  });
  userRouter.use(requireUser);
  adminRouter.use(requireAdmin);
  const userMutationLimit = rateLimit(30, 60_000, (request) => `support:user:${currentUser(request)?.user.id ?? request.ip ?? 'unknown'}`);
  const adminMutationLimit = rateLimit(30, 60_000, (request) => `support:admin:${currentAdmin(request)?.admin.id ?? request.ip ?? 'unknown'}`);

  userRouter.get('/conversations', async (req, res) => {
    const actor = { type: 'USER' as const, id: currentUser(req)!.user.id };
    const result = await listConversations(db, actor, supportConversationListSchema.parse(req.query));
    return res.json({ data: result.conversations, meta: { nextCursor: result.nextCursor } });
  });
  userRouter.post('/conversations', userMutationLimit, async (req, res) => {
    const user = currentUser(req)!.user;
    const input = createUserSupportConversationSchema.parse(req.body);
    const actor: SupportActor = { type: 'USER', id: user.id, name: user.name ?? user.email };
    const result = await createConversation(db, coordinator, notifier, actor, { userId: user.id, ...input });
    return res.status(result.reused ? 200 : 201).json({ data: { conversation: result.conversation }, meta: {} });
  });
  userRouter.get('/unread-count', async (req, res) => {
    const actor = { type: 'USER' as const, id: currentUser(req)!.user.id };
    return res.json({ data: { count: await getSupportUnreadCount(db, actor) }, meta: {} });
  });
  userRouter.get('/conversations/:id', async (req, res) => {
    const actor = { type: 'USER' as const, id: currentUser(req)!.user.id };
    const id = supportConversationParamsSchema.parse(req.params).id;
    const result = await getConversationDetail(db, actor, id, supportMessageListSchema.parse(req.query));
    return res.json({ data: { conversation: result.conversation, messages: result.messages }, meta: { nextCursor: result.nextCursor } });
  });
  userRouter.post('/conversations/:id/messages', userMutationLimit, async (req, res) => {
    const user = currentUser(req)!.user;
    const actor: SupportActor = { type: 'USER', id: user.id, name: user.name ?? user.email };
    const id = supportConversationParamsSchema.parse(req.params).id;
    const result = await sendMessage(db, coordinator, notifier, actor, id, createSupportMessageSchema.parse(req.body));
    return res.status(result.reused ? 200 : 201).json({ data: { message: result.message }, meta: {} });
  });
  userRouter.post('/conversations/:id/read', async (req, res) => {
    const actor = { type: 'USER' as const, id: currentUser(req)!.user.id };
    const id = supportConversationParamsSchema.parse(req.params).id;
    const input = markSupportReadSchema.parse(req.body ?? {});
    return res.json({ data: await markConversationRead(db, coordinator, notifier, actor, id, input.messageId), meta: {} });
  });

  adminRouter.get('/conversations', async (req, res) => {
    const actor = { type: 'ADMIN' as const, id: currentAdmin(req)!.admin.id };
    const result = await listConversations(db, actor, supportConversationListSchema.parse(req.query));
    return res.json({ data: result.conversations, meta: { nextCursor: result.nextCursor } });
  });
  adminRouter.post('/conversations', adminMutationLimit, async (req, res) => {
    const admin = currentAdmin(req)!.admin;
    const input = createAdminSupportConversationSchema.parse(req.body);
    const actor: SupportActor = { type: 'ADMIN', id: admin.id, name: adminSupportDisplayName(admin.name), requestId: req.id === undefined ? undefined : String(req.id) };
    const result = await createConversation(db, coordinator, notifier, actor, input);
    return res.status(result.reused ? 200 : 201).json({ data: { conversation: result.conversation }, meta: {} });
  });
  adminRouter.get('/unread-count', async (req, res) => {
    const actor = { type: 'ADMIN' as const, id: currentAdmin(req)!.admin.id };
    return res.json({ data: { count: await getSupportUnreadCount(db, actor) }, meta: {} });
  });
  adminRouter.get('/conversations/:id', async (req, res) => {
    const actor = { type: 'ADMIN' as const, id: currentAdmin(req)!.admin.id };
    const id = supportConversationParamsSchema.parse(req.params).id;
    const result = await getConversationDetail(db, actor, id, supportMessageListSchema.parse(req.query));
    return res.json({ data: { conversation: result.conversation, messages: result.messages }, meta: { nextCursor: result.nextCursor } });
  });
  adminRouter.post('/conversations/:id/messages', adminMutationLimit, async (req, res) => {
    const admin = currentAdmin(req)!.admin;
    const actor: SupportActor = { type: 'ADMIN', id: admin.id, name: adminSupportDisplayName(admin.name), requestId: req.id === undefined ? undefined : String(req.id) };
    const id = supportConversationParamsSchema.parse(req.params).id;
    const result = await sendMessage(db, coordinator, notifier, actor, id, createSupportMessageSchema.parse(req.body));
    return res.status(result.reused ? 200 : 201).json({ data: { message: result.message }, meta: {} });
  });
  adminRouter.post('/conversations/:id/read', async (req, res) => {
    const actor = { type: 'ADMIN' as const, id: currentAdmin(req)!.admin.id };
    const id = supportConversationParamsSchema.parse(req.params).id;
    const input = markSupportReadSchema.parse(req.body ?? {});
    return res.json({ data: await markConversationRead(db, coordinator, notifier, actor, id, input.messageId), meta: {} });
  });
  adminRouter.patch('/conversations/:id/status', async (req, res) => {
    const admin = currentAdmin(req)!.admin;
    const actor: SupportActor = { type: 'ADMIN', id: admin.id, name: adminSupportDisplayName(admin.name), requestId: req.id === undefined ? undefined : String(req.id) };
    const id = supportConversationParamsSchema.parse(req.params).id;
    const input = updateSupportStatusSchema.parse(req.body);
    return res.json({ data: await changeConversationStatus(db, coordinator, notifier, actor, id, input.status), meta: {} });
  });

  return { userRouter, adminRouter };
}

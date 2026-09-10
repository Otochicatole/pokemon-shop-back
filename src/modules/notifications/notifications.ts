import { Router } from 'express';
import { Prisma, type PrismaClient, NotificationType } from '@prisma/client';
import { z } from 'zod';
import { currentAdmin, currentUser, requireAdmin, requireUser } from '../../infrastructure/sessions.js';
import { logger } from '../../infrastructure/logger.js';
import { conflict, notFound } from '../../shared/errors.js';
import { SupportRealtimeHub, type SupportRealtimeActor } from '../support/support-realtime.js';

type NotificationDb = PrismaClient | Prisma.TransactionClient;

const notificationListSchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  unreadOnly: z.preprocess((value) => value === 'true' ? true : value === 'false' ? false : value, z.boolean().default(false)),
});

const notificationInclude = {
  order: { select: { number: true } },
  supportConversation: { select: { id: true } },
} satisfies Prisma.NotificationInclude;

type NotificationRow = Prisma.NotificationGetPayload<{ include: typeof notificationInclude }>;

export type NotificationCreateInput = {
  type: NotificationType;
  title: string;
  message: string;
  dedupeKey: string;
  orderId?: string;
  supportConversationId?: string;
};

export type CreatedNotification = { id: string; recipientType: 'USER' | 'ADMIN'; userId: string | null; adminId: string | null };

export function statusLabel(status: string): string {
  return ({
    PENDING_PAYMENT: 'pendiente de pago',
    PAYMENT_REVIEW: 'en revisión',
    PAID: 'pagada',
    PREPARING: 'en preparación',
    READY_FOR_PICKUP: 'lista para retirar',
    SHIPPED: 'enviada',
    COMPLETED: 'completada',
    CANCELLED: 'cancelada',
    EXPIRED: 'vencida',
    REFUND_RECORDED: 'con reembolso registrado',
    PAYMENT_REQUIRES_REVIEW: 'requiere revisión de pago',
  } as Record<string, string>)[status] ?? status;
}

export function mapNotification(row: NotificationRow) {
  const reference = row.order
    ? { kind: 'ORDER' as const, orderNumber: row.order.number }
    : row.supportConversation
      ? { kind: 'SUPPORT_CONVERSATION' as const, conversationId: row.supportConversation.id }
      : null;
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    message: row.message,
    readAt: row.readAt,
    createdAt: row.createdAt,
    reference,
  };
}

function notificationData(input: NotificationCreateInput) {
  if ((input.orderId ? 1 : 0) + (input.supportConversationId ? 1 : 0) !== 1) {
    throw new Error('A notification must reference exactly one entity');
  }
  return {
    type: input.type,
    title: input.title,
    message: input.message,
    dedupeKey: input.dedupeKey,
    orderId: input.orderId,
    supportConversationId: input.supportConversationId,
  };
}

async function createUnique(db: NotificationDb, recipient: { userId?: string; adminId?: string }, input: NotificationCreateInput): Promise<CreatedNotification> {
  if ((recipient.userId ? 1 : 0) + (recipient.adminId ? 1 : 0) !== 1) throw new Error('A notification must have exactly one recipient');
  const recipientType = recipient.userId ? 'USER' : 'ADMIN';
  const row = await db.notification.upsert({
    where: { dedupeKey: input.dedupeKey },
    create: { ...notificationData(input), recipientType, userId: recipient.userId, adminId: recipient.adminId },
    update: {},
    select: { id: true, recipientType: true, userId: true, adminId: true },
  });
  return row as CreatedNotification;
}

export function createUserNotification(db: NotificationDb, userId: string, input: NotificationCreateInput) {
  return createUnique(db, { userId }, input);
}

export async function createAdminNotifications(db: NotificationDb, input: NotificationCreateInput): Promise<CreatedNotification[]> {
  const admins = await db.admin.findMany({ where: { status: 'ACTIVE' }, select: { id: true } });
  const rows: CreatedNotification[] = [];
  for (const admin of admins) {
    rows.push(await createUnique(db, { adminId: admin.id }, { ...input, dedupeKey: `${input.dedupeKey}:admin:${admin.id}` }));
  }
  return rows;
}

export function createOrderStatusNotification(db: NotificationDb, order: { id: string; number: string; userId: string }, history: { id: string; toStatus: string }) {
  return createUserNotification(db, order.userId, {
    type: NotificationType.ORDER_STATUS_CHANGED,
    title: 'Actualización de tu orden',
    message: `La orden ${order.number} ahora está ${statusLabel(history.toStatus)}.`,
    dedupeKey: `order-status:${history.id}:user:${order.userId}`,
    orderId: order.id,
  });
}

export function createOrderCreatedNotifications(db: NotificationDb, order: { id: string; number: string }) {
  return createAdminNotifications(db, {
    type: NotificationType.ORDER_CREATED,
    title: 'Nueva orden recibida',
    message: `La orden ${order.number} fue creada y espera seguimiento.`,
    dedupeKey: `order-created:${order.id}`,
    orderId: order.id,
  });
}

export function createReceiptSubmittedNotifications(db: NotificationDb, order: { id: string; number: string }, receiptId: string) {
  return createAdminNotifications(db, {
    type: NotificationType.TRANSFER_RECEIPT_SUBMITTED,
    title: 'Nuevo comprobante para revisar',
    message: `La orden ${order.number} recibió un comprobante de transferencia.`,
    dedupeKey: `transfer-receipt:${receiptId}`,
    orderId: order.id,
  });
}

export function createPaymentReviewNotifications(db: NotificationDb, order: { id: string; number: string }, sourceKey: string) {
  return createAdminNotifications(db, {
    type: NotificationType.PAYMENT_REQUIRES_REVIEW,
    title: 'Pago requiere revisión',
    message: `El pago de la orden ${order.number} requiere una revisión.`,
    dedupeKey: `payment-review:${sourceKey}`,
    orderId: order.id,
  });
}

export function createPaymentApprovedNotifications(db: NotificationDb, order: { id: string; number: string }, sourceKey: string) {
  return createAdminNotifications(db, {
    type: NotificationType.PAYMENT_APPROVED,
    title: 'Pago aprobado',
    message: `El pago de la orden ${order.number} fue aprobado y está lista para preparar.`,
    dedupeKey: `payment-approved:${sourceKey}`,
    orderId: order.id,
  });
}

export function createSupportNotification(db: NotificationDb, recipient: { userId?: string; adminId?: string }, conversationId: string, messageId: string, preview: string) {
  return createUnique(db, recipient, {
    type: NotificationType.SUPPORT_MESSAGE,
    title: recipient.userId ? 'Nuevo mensaje de soporte' : 'Nueva consulta de soporte',
    message: preview.length > 160 ? `${preview.slice(0, 157)}…` : preview,
    dedupeKey: `support-message:${messageId}:${recipient.userId ? `user:${recipient.userId}` : `admin:${recipient.adminId}`}`,
    supportConversationId: conversationId,
  });
}

async function rowsForActor(db: NotificationDb, actor: SupportRealtimeActor, query: z.infer<typeof notificationListSchema>) {
  const where: Prisma.NotificationWhereInput = actor.type === 'USER' ? { userId: actor.id } : { adminId: actor.id };
  if (query.unreadOnly) where.readAt = null;
  const rows = await db.notification.findMany({
    where,
    include: notificationInclude,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}),
  });
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  return { rows: page, nextCursor: hasMore ? page.at(-1)?.id ?? null : null };
}

export async function getNotificationUnreadCount(db: NotificationDb, actor: SupportRealtimeActor): Promise<number> {
  return db.notification.count({ where: actor.type === 'USER' ? { userId: actor.id, readAt: null } : { adminId: actor.id, readAt: null } });
}

async function notifyUnreadCount(db: PrismaClient, hub: SupportRealtimeHub, actor: SupportRealtimeActor) {
  try {
    hub.send(actor, 'notifications.unread_count', { count: await getNotificationUnreadCount(db, actor) });
  } catch (error) {
    logger.warn({ err: error, actorType: actor.type, actorId: actor.id }, 'Notification count realtime delivery failed');
  }
}

export async function publishNotifications(db: PrismaClient, hub: SupportRealtimeHub, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    const rows = await db.notification.findMany({ where: { id: { in: ids } }, include: notificationInclude });
    for (const row of rows) {
      const actor: SupportRealtimeActor = row.recipientType === 'USER' && row.userId
        ? { type: 'USER', id: row.userId }
        : { type: 'ADMIN', id: row.adminId! };
      hub.send(actor, 'notification.created', { notification: mapNotification(row), unreadCount: await getNotificationUnreadCount(db, actor) });
    }
  } catch (error) {
    logger.error({ err: error, notificationIds: ids }, 'Notification realtime delivery failed');
  }
}

export function createNotificationsRouters(db: PrismaClient, hub: SupportRealtimeHub) {
  const userRouter = Router();
  const adminRouter = Router();
  userRouter.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Pragma', 'no-cache'); next(); });
  adminRouter.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Pragma', 'no-cache'); next(); });
  userRouter.use(requireUser);
  adminRouter.use(requireAdmin);

  const register = (router: Router, actorType: 'USER' | 'ADMIN') => {
    const actor = (req: Parameters<Parameters<typeof router.get>[1]>[0]): SupportRealtimeActor => actorType === 'USER'
      ? { type: 'USER', id: currentUser(req)!.user.id }
      : { type: 'ADMIN', id: currentAdmin(req)!.admin.id };
    const ownerWhere = (value: SupportRealtimeActor): Prisma.NotificationWhereInput => value.type === 'USER' ? { userId: value.id } : { adminId: value.id };

    router.get('/', async (req, res) => {
      const current = actor(req);
      const result = await rowsForActor(db, current, notificationListSchema.parse(req.query));
      return res.json({ data: result.rows.map(mapNotification), meta: { nextCursor: result.nextCursor } });
    });
    router.get('/unread-count', async (req, res) => res.json({ data: { count: await getNotificationUnreadCount(db, actor(req)) }, meta: {} }));
    router.post('/read-all', async (req, res) => {
      const current = actor(req);
      const result = await db.notification.updateMany({ where: { ...ownerWhere(current), readAt: null }, data: { readAt: new Date() } });
      await notifyUnreadCount(db, hub, current);
      return res.json({ data: { updatedCount: result.count, unreadCount: 0 }, meta: {} });
    });
    router.post('/:id/read', async (req, res) => {
      const current = actor(req);
      const id = z.string().uuid().parse(req.params.id);
      const result = await db.notification.updateMany({ where: { id, ...ownerWhere(current) }, data: { readAt: new Date() } });
      if (result.count !== 1) throw notFound('Notificación no encontrada');
      const row = await db.notification.findUniqueOrThrow({ where: { id }, include: notificationInclude });
      const unreadCount = await getNotificationUnreadCount(db, current);
      await notifyUnreadCount(db, hub, current);
      return res.json({ data: { notification: mapNotification(row), unreadCount }, meta: {} });
    });
  };

  register(userRouter, 'USER');
  register(adminRouter, 'ADMIN');
  return { userRouter, adminRouter };
}

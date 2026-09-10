import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { WebSocket } from 'ws';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../src/app.js';
import { createCompositionRoot, type CompositionRoot } from '../src/app/composition-root.js';
import { prisma } from '../src/infrastructure/prisma.js';
import { ADMIN_COOKIE, ADMIN_CSRF_COOKIE, USER_COOKIE } from '../src/infrastructure/sessions.js';
import { sha256 } from '../src/shared/ids.js';
import { hashPassword } from '../src/shared/crypto.js';
import {
  attachSupportWebSocketServer,
  getSupportUnreadCount,
  MAX_SUPPORT_SOCKETS_PER_ACTOR,
  SUPPORT_SESSION_REVOKED_CLOSE_CODE,
  SUPPORT_SOCKET_LIMIT_CLOSE_CODE,
} from '../src/modules/support/index.js';

type JsonEvent = { type: string; payload: Record<string, unknown>; sentAt: string };

const fixture = randomUUID();
const userId = randomUUID();
const otherUserId = randomUUID();
const adminId = randomUUID();
const otherAdminId = randomUUID();
const adminEmail = `support-admin-${fixture}@example.test`;
const otherAdminEmail = `support-admin-other-${fixture}@example.test`;
const userEmail = `support-user-${fixture}@example.test`;
const otherUserEmail = `support-other-${fixture}@example.test`;
const userPassword = 'SupportUserPassword123!';
const otherUserPassword = 'SupportOtherPassword123!';
const otherAdminPassword = 'SupportOtherAdminPassword123!';
const userToken = `support-user-${fixture}`;
const otherUserToken = `support-other-${fixture}`;
const adminToken = `support-admin-${fixture}`;
const userCsrf = `support-user-csrf-${fixture}`;
const otherUserCsrf = `support-other-csrf-${fixture}`;
const adminCsrf = `support-admin-csrf-${fixture}`;

const cookie = (name: string, value: string) => `${name}=${value}`;

function waitForEvent(socket: WebSocket, type: string): Promise<JsonEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error(`Timed out waiting for ${type}`));
    }, 5_000);
    const onMessage = (raw: WebSocket.RawData) => {
      const event = JSON.parse(raw.toString()) as JsonEvent;
      if (event.type !== type) return;
      clearTimeout(timeout);
      socket.off('message', onMessage);
      resolve(event);
    };
    socket.on('message', onMessage);
  });
}

function rejectedUpgrade(url: string, options?: ConstructorParameters<typeof WebSocket>[1]): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error('Timed out waiting for rejected websocket upgrade'));
    }, 5_000);
    socket.on('error', () => undefined);
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timeout);
      response.resume();
      socket.terminate();
      resolve(response.statusCode ?? 0);
    });
    socket.once('open', () => {
      clearTimeout(timeout);
      socket.close();
      reject(new Error('Websocket upgrade was unexpectedly accepted'));
    });
  });
}

function waitForClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for websocket close')), 5_000);
    socket.once('close', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

describe('support conversations and realtime notifications', () => {
  let composition: CompositionRoot;
  let testApp: ReturnType<typeof createApp>;
  let server: Server;
  let closeWebSockets: () => Promise<void>;
  let wsBaseUrl = '';
  let adminSocket: WebSocket | null = null;
  let userSocket: WebSocket | null = null;
  let conversationId = '';

  beforeAll(async () => {
    const [userPasswordHash, otherUserPasswordHash, otherAdminPasswordHash] = await Promise.all([
      hashPassword(userPassword),
      hashPassword(otherUserPassword),
      hashPassword(otherAdminPassword),
    ]);
    await prisma.user.createMany({ data: [
      { id: userId, email: userEmail, name: 'Cliente soporte', passwordHash: userPasswordHash, emailVerifiedAt: new Date() },
      { id: otherUserId, email: otherUserEmail, name: 'Otro cliente', passwordHash: otherUserPasswordHash, emailVerifiedAt: new Date() },
    ] });
    await prisma.admin.createMany({ data: [
      { id: adminId, email: adminEmail, name: '   ', passwordHash: 'unused' },
      { id: otherAdminId, email: otherAdminEmail, name: 'Administradora dos', passwordHash: otherAdminPasswordHash },
    ] });
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await prisma.userSession.createMany({ data: [
      { userId, tokenHash: sha256(userToken), csrfHash: sha256(userCsrf), expiresAt },
      { userId: otherUserId, tokenHash: sha256(otherUserToken), csrfHash: sha256(otherUserCsrf), expiresAt },
    ] });
    await prisma.adminSession.create({ data: { adminId, tokenHash: sha256(adminToken), csrfHash: sha256(adminCsrf), expiresAt } });

    composition = createCompositionRoot();
    testApp = createApp(composition);
    server = createServer(testApp);
    const attached = attachSupportWebSocketServer(server, {
      hub: composition.realtime.support,
      getUnreadCount: (actor) => getSupportUnreadCount(prisma, actor),
    });
    closeWebSockets = attached.close;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Ephemeral test server did not expose an address');
    wsBaseUrl = `ws://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    adminSocket?.terminate();
    userSocket?.terminate();
    await closeWebSockets?.();
    await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    await prisma.supportConversation.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.auditLog.deleteMany({ where: { actorId: adminId, entityType: 'SupportConversation' } });
    await prisma.adminSession.deleteMany({ where: { adminId: { in: [adminId, otherAdminId] } } });
    await prisma.userSession.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.admin.deleteMany({ where: { id: { in: [adminId, otherAdminId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  });

  it('rejects websocket upgrades without a valid role session or from a disallowed origin', async () => {
    expect(await rejectedUpgrade(`${wsBaseUrl}/api/v2/support/ws?role=admin`, { origin: 'http://localhost:3001' })).toBe(401);
    expect(await rejectedUpgrade(`${wsBaseUrl}/api/v2/support/ws?role=admin`, {
      origin: 'https://evil.example',
      headers: { Cookie: cookie(ADMIN_COOKIE, adminToken) },
    })).toBe(403);
  });

  it('delivers customer messages to authenticated administrators and maintains unread counters', async () => {
    adminSocket = new WebSocket(`${wsBaseUrl}/api/v2/support/ws?role=admin`, {
      origin: 'http://localhost:3001',
      headers: { Cookie: cookie(ADMIN_COOKIE, adminToken) },
    });
    const ready = await waitForEvent(adminSocket, 'connection.ready');
    expect(ready.payload).toMatchObject({ actorType: 'ADMIN', actorId: adminId, unreadCount: 0 });

    const initialClientMessageId = randomUUID();
    let createdEventCount = 0;
    const countCreatedEvents = (raw: WebSocket.RawData) => {
      const event = JSON.parse(raw.toString()) as JsonEvent;
      if (event.type === 'support.conversation.created') createdEventCount += 1;
    };
    adminSocket.on('message', countCreatedEvents);
    const createdEvent = waitForEvent(adminSocket, 'support.conversation.created');
    const createInput = { subject: 'Problema con mi pedido', message: 'Necesito ayuda inicial.', clientMessageId: initialClientMessageId };
    const created = await request(testApp)
      .post('/api/v2/support/conversations')
      .set('Cookie', cookie(USER_COOKIE, userToken))
      .set('X-CSRF-Token', userCsrf)
      .send(createInput);
    expect(created.status).toBe(201);
    expect(created.headers['cache-control']).toContain('no-store');
    conversationId = created.body.data.conversation.id;
    expect((await createdEvent).payload).toMatchObject({
      conversation: { id: conversationId, unreadCount: 1 },
    });

    const retried = await request(testApp)
      .post('/api/v2/support/conversations')
      .set('Cookie', cookie(USER_COOKIE, userToken))
      .set('X-CSRF-Token', userCsrf)
      .send(createInput);
    expect(retried.status).toBe(200);
    expect(retried.body.data).toEqual({ conversation: created.body.data.conversation });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(createdEventCount).toBe(1);
    adminSocket.off('message', countCreatedEvents);
    expect(await prisma.supportMessage.count({ where: { clientMessageId: initialClientMessageId } })).toBe(1);
    expect(await prisma.supportConversation.count({ where: { messages: { some: { clientMessageId: initialClientMessageId } } } })).toBe(1);

    const conflictingRetry = await request(testApp)
      .post('/api/v2/support/conversations')
      .set('Cookie', cookie(USER_COOKIE, userToken))
      .set('X-CSRF-Token', userCsrf)
      .send({ ...createInput, message: 'Contenido diferente' });
    expect(conflictingRetry.status).toBe(409);
    expect(conflictingRetry.body.code).toBe('SUPPORT_MESSAGE_ID_REUSED');

    const messageEvent = waitForEvent(adminSocket, 'support.message.created');
    const sent = await request(testApp)
      .post(`/api/v2/support/conversations/${conversationId}/messages`)
      .set('Cookie', cookie(USER_COOKIE, userToken))
      .set('X-CSRF-Token', userCsrf)
      .send({ content: 'Este es el segundo mensaje.' });
    expect(sent.status).toBe(201);
    expect((await messageEvent).payload).toMatchObject({
      conversation: { id: conversationId, unreadCount: 2 },
      message: { id: sent.body.data.message.id, senderType: 'USER', content: 'Este es el segundo mensaje.' },
      unreadCount: 2,
    });

    const unread = await request(testApp)
      .get('/api/v2/admin/support/unread-count')
      .set('Cookie', cookie(ADMIN_COOKIE, adminToken));
    expect(unread.status).toBe(200);
    expect(unread.body.data.count).toBe(2);

    userSocket = new WebSocket(`${wsBaseUrl}/api/v2/support/ws?role=user`, {
      origin: 'http://localhost:3001',
      headers: { Cookie: cookie(USER_COOKIE, userToken) },
    });
    await waitForEvent(userSocket, 'connection.ready');
    const readEvent = waitForEvent(userSocket, 'support.conversation.read');
    const read = await request(testApp)
      .post(`/api/v2/admin/support/conversations/${conversationId}/read`)
      .set('Cookie', cookie(ADMIN_COOKIE, adminToken))
      .set('X-CSRF-Token', adminCsrf)
      .send({ messageId: sent.body.data.message.id });
    expect(read.status).toBe(200);
    expect(read.body.data).toMatchObject({ conversationId, unreadCount: 0 });
    expect((await readEvent).payload).toMatchObject({ conversationId, readerType: 'ADMIN', readerId: 'support-team' });
  });

  it('enforces ownership, message idempotency, workflow status, audit redaction, and cursor pagination', async () => {
    const inaccessible = await request(testApp)
      .get(`/api/v2/support/conversations/${conversationId}`)
      .set('Cookie', cookie(USER_COOKIE, otherUserToken));
    expect(inaccessible.status).toBe(404);

    const clientMessageId = randomUUID();
    const first = await request(testApp)
      .post(`/api/v2/support/conversations/${conversationId}/messages`)
      .set('Cookie', cookie(USER_COOKIE, userToken))
      .set('X-CSRF-Token', userCsrf)
      .send({ content: 'Mensaje con idempotencia', clientMessageId });
    const repeated = await request(testApp)
      .post(`/api/v2/support/conversations/${conversationId}/messages`)
      .set('Cookie', cookie(USER_COOKIE, userToken))
      .set('X-CSRF-Token', userCsrf)
      .send({ content: 'Mensaje con idempotencia', clientMessageId });
    expect(first.status).toBe(201);
    expect(repeated.status).toBe(200);
    expect(repeated.body.data.message.id).toBe(first.body.data.message.id);
    expect(await prisma.supportMessage.count({ where: { clientMessageId } })).toBe(1);
    const changedPayload = await request(testApp)
      .post(`/api/v2/support/conversations/${conversationId}/messages`)
      .set('Cookie', cookie(USER_COOKIE, userToken))
      .set('X-CSRF-Token', userCsrf)
      .send({ content: 'Contenido distinto con el mismo identificador', clientMessageId });
    expect(changedPayload.status).toBe(409);
    expect(changedPayload.body.code).toBe('SUPPORT_MESSAGE_ID_REUSED');

    const customerMessageEvent = waitForEvent(userSocket!, 'support.message.created');
    const adminReply = await request(testApp)
      .post(`/api/v2/admin/support/conversations/${conversationId}/messages`)
      .set('Cookie', cookie(ADMIN_COOKIE, adminToken))
      .set('X-CSRF-Token', adminCsrf)
      .send({ content: 'Respuesta administrativa secreta' });
    expect(adminReply.status).toBe(201);
    expect(adminReply.body.data.message.sender).toEqual({ id: adminId, name: 'Equipo de soporte' });
    expect((await customerMessageEvent).payload).toMatchObject({
      message: { id: adminReply.body.data.message.id, sender: { id: 'support-team', name: 'Equipo de soporte' } },
    });

    const customerDetail = await request(testApp)
      .get(`/api/v2/support/conversations/${conversationId}?limit=100`)
      .set('Cookie', cookie(USER_COOKIE, userToken));
    const visibleAdminReply = customerDetail.body.data.messages.find((message: { id: string }) => message.id === adminReply.body.data.message.id);
    expect(visibleAdminReply.sender).toEqual({ id: 'support-team', name: 'Equipo de soporte' });
    expect(JSON.stringify(customerDetail.body.data.messages)).not.toContain(adminEmail);

    const firstPage = await request(testApp)
      .get(`/api/v2/support/conversations/${conversationId}?limit=2`)
      .set('Cookie', cookie(USER_COOKIE, userToken));
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.data.messages).toHaveLength(2);
    expect(firstPage.body.meta.nextCursor).toEqual(expect.any(String));
    const firstIds = firstPage.body.data.messages.map((message: { id: string }) => message.id);

    const secondPage = await request(testApp)
      .get(`/api/v2/support/conversations/${conversationId}?limit=2&cursor=${firstPage.body.meta.nextCursor}`)
      .set('Cookie', cookie(USER_COOKIE, userToken));
    expect(secondPage.status).toBe(200);
    const secondIds = secondPage.body.data.messages.map((message: { id: string }) => message.id);
    expect(secondIds.length).toBeGreaterThan(0);
    expect(secondIds.every((id: string) => !firstIds.includes(id))).toBe(true);

    const closed = await request(testApp)
      .patch(`/api/v2/admin/support/conversations/${conversationId}/status`)
      .set('Cookie', cookie(ADMIN_COOKIE, adminToken))
      .set('X-CSRF-Token', adminCsrf)
      .send({ status: 'CLOSED' });
    expect(closed.status).toBe(200);
    expect(closed.body.data.conversation.status).toBe('CLOSED');

    const replayAfterClose = await request(testApp)
      .post(`/api/v2/support/conversations/${conversationId}/messages`)
      .set('Cookie', cookie(USER_COOKIE, userToken))
      .set('X-CSRF-Token', userCsrf)
      .send({ content: 'Mensaje con idempotencia', clientMessageId });
    expect(replayAfterClose.status).toBe(200);
    expect(replayAfterClose.body.data.message.id).toBe(first.body.data.message.id);

    const rejectedReply = await request(testApp)
      .post(`/api/v2/support/conversations/${conversationId}/messages`)
      .set('Cookie', cookie(USER_COOKIE, userToken))
      .set('X-CSRF-Token', userCsrf)
      .send({ content: 'No debería enviarse' });
    expect(rejectedReply.status).toBe(409);
    expect(rejectedReply.body.code).toBe('SUPPORT_CONVERSATION_CLOSED');

    const audits = await prisma.auditLog.findMany({
      where: { actorId: adminId, entityType: 'SupportConversation', entityId: conversationId },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.map((entry) => entry.action)).toEqual(expect.arrayContaining(['SUPPORT_MESSAGE_SENT', 'SUPPORT_STATUS_CHANGED']));
    expect(audits.every((entry) => !entry.metadata?.includes('Respuesta administrativa secreta'))).toBe(true);
    expect(audits.every((entry) => entry.requestId !== null)).toBe(true);
  });

  it('aggregates the global unread total in one database round trip', async () => {
    const countingDb = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
    let queryCount = 0;
    countingDb.$on('query', () => { queryCount += 1; });
    try {
      await countingDb.$connect();
      queryCount = 0;
      const count = await getSupportUnreadCount(countingDb, { type: 'USER', id: userId });
      expect(count).toBeGreaterThanOrEqual(0);
      expect(queryCount).toBe(1);
    } finally {
      await countingDb.$disconnect();
    }
  });

  it('reuses an exact admin-created conversation once and stores later messages monotonically', async () => {
    const clientMessageId = randomUUID();
    const input = {
      userId: otherUserId,
      subject: 'Contacto iniciado por soporte',
      message: 'Mensaje administrativo inicial',
      clientMessageId,
    };
    const created = await request(testApp)
      .post('/api/v2/admin/support/conversations')
      .set('Cookie', cookie(ADMIN_COOKIE, adminToken))
      .set('X-CSRF-Token', adminCsrf)
      .send(input);
    const retried = await request(testApp)
      .post('/api/v2/admin/support/conversations')
      .set('Cookie', cookie(ADMIN_COOKIE, adminToken))
      .set('X-CSRF-Token', adminCsrf)
      .send(input);
    expect(created.status).toBe(201);
    expect(retried.status).toBe(200);
    expect(retried.body.data).toEqual({ conversation: created.body.data.conversation });
    expect(await prisma.auditLog.count({
      where: { actorId: adminId, action: 'SUPPORT_CONVERSATION_CREATED', entityId: created.body.data.conversation.id },
    })).toBe(1);

    const futureLastMessageAt = new Date(Date.now() + 60_000);
    await prisma.supportConversation.update({
      where: { id: created.body.data.conversation.id },
      data: { lastMessageAt: futureLastMessageAt },
    });
    const sent = await request(testApp)
      .post(`/api/v2/admin/support/conversations/${created.body.data.conversation.id}/messages`)
      .set('Cookie', cookie(ADMIN_COOKIE, adminToken))
      .set('X-CSRF-Token', adminCsrf)
      .send({ content: 'Mensaje posterior al reloj lógico' });
    expect(sent.status).toBe(201);
    const persisted = await prisma.supportMessage.findUniqueOrThrow({ where: { id: sent.body.data.message.id } });
    expect(persisted.createdAt.getTime()).toBe(futureLastMessageAt.getTime() + 1);

    const readLatest = await request(testApp)
      .post(`/api/v2/support/conversations/${created.body.data.conversation.id}/read`)
      .set('Cookie', cookie(USER_COOKIE, otherUserToken))
      .set('X-CSRF-Token', otherUserCsrf)
      .send({});
    expect(readLatest.status).toBe(200);
    expect(readLatest.body.data).toMatchObject({
      conversationId: created.body.data.conversation.id,
      unreadCount: 0,
      readAt: persisted.createdAt.toISOString(),
    });
  });

  it('bounds simultaneous websocket connections per actor and closes the oldest', async () => {
    const sockets: WebSocket[] = [];
    let oldestClose: Promise<number> | undefined;
    try {
      for (let index = 0; index <= MAX_SUPPORT_SOCKETS_PER_ACTOR; index += 1) {
        const socket = new WebSocket(`${wsBaseUrl}/api/v2/support/ws?role=user`, {
          origin: 'http://localhost:3001',
          headers: { Cookie: cookie(USER_COOKIE, otherUserToken) },
        });
        if (index === 0) {
          oldestClose = new Promise((resolve) => socket.once('close', (code) => resolve(code)));
        }
        sockets.push(socket);
        await waitForEvent(socket, 'connection.ready');
      }
      expect(await oldestClose).toBe(SUPPORT_SOCKET_LIMIT_CLOSE_CODE);
      expect(sockets.slice(1).filter((socket) => socket.readyState === WebSocket.OPEN)).toHaveLength(MAX_SUPPORT_SOCKETS_PER_ACTOR);
    } finally {
      for (const socket of sockets) socket.terminate();
    }
  });

  it('closes every websocket tied to sessions revoked by actor-switch login, password reset, and logout', async () => {
    const sockets: WebSocket[] = [];
    try {
      const switchedActorTabs: WebSocket[] = [];
      for (let index = 0; index < 2; index += 1) {
        const socket = new WebSocket(`${wsBaseUrl}/api/v2/support/ws?role=user`, {
          origin: 'http://localhost:3001',
          headers: { Cookie: cookie(USER_COOKIE, userToken) },
        });
        sockets.push(socket);
        switchedActorTabs.push(socket);
        await waitForEvent(socket, 'connection.ready');
      }
      const switchedActorCloses = switchedActorTabs.map(waitForClose);
      const switched = await request(testApp)
        .post('/api/v2/auth/login')
        .set('Cookie', cookie(USER_COOKIE, userToken))
        .set('X-CSRF-Token', userCsrf)
        .send({ email: otherUserEmail, password: otherUserPassword });
      expect(switched.status).toBe(200);
      expect(switched.body.data.user.id).toBe(otherUserId);
      expect(await Promise.all(switchedActorCloses)).toEqual([
        SUPPORT_SESSION_REVOKED_CLOSE_CODE,
        SUPPORT_SESSION_REVOKED_CLOSE_CODE,
      ]);
      const replacedSession = await prisma.userSession.findUniqueOrThrow({ where: { tokenHash: sha256(userToken) } });
      expect(replacedSession.revokedAt).not.toBeNull();

      const setCookies = (switched.headers['set-cookie'] ?? []) as unknown as string[];
      const newSessionCookie = setCookies.find((value) => value.startsWith(`${USER_COOKIE}=`));
      const newSessionToken = newSessionCookie?.split(';', 1)[0]?.slice(USER_COOKIE.length + 1);
      expect(newSessionToken).toEqual(expect.any(String));

      const resetTabs: WebSocket[] = [];
      for (const token of [otherUserToken, newSessionToken!]) {
        const socket = new WebSocket(`${wsBaseUrl}/api/v2/support/ws?role=user`, {
          origin: 'http://localhost:3001',
          headers: { Cookie: cookie(USER_COOKIE, token) },
        });
        sockets.push(socket);
        resetTabs.push(socket);
        await waitForEvent(socket, 'connection.ready');
      }
      const resetCloses = resetTabs.map(waitForClose);
      const resetToken = `support-reset-${randomUUID()}`;
      await prisma.userToken.create({
        data: {
          userId: otherUserId,
          type: 'PASSWORD_RESET',
          tokenHash: sha256(resetToken),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      const reset = await request(testApp)
        .post('/api/v2/auth/reset-password')
        .send({ token: resetToken, password: 'ReplacementPassword123!' });
      expect(reset.status).toBe(204);
      expect(await Promise.all(resetCloses)).toEqual([
        SUPPORT_SESSION_REVOKED_CLOSE_CODE,
        SUPPORT_SESSION_REVOKED_CLOSE_CODE,
      ]);
      expect(await prisma.userSession.count({ where: { userId: otherUserId, revokedAt: null } })).toBe(0);

      const adminSwitchTabs: WebSocket[] = [];
      for (let index = 0; index < 2; index += 1) {
        const socket = new WebSocket(`${wsBaseUrl}/api/v2/support/ws?role=admin`, {
          origin: 'http://localhost:3001',
          headers: { Cookie: cookie(ADMIN_COOKIE, adminToken) },
        });
        sockets.push(socket);
        adminSwitchTabs.push(socket);
        await waitForEvent(socket, 'connection.ready');
      }
      const adminSwitchCloses = adminSwitchTabs.map(waitForClose);
      const adminSwitch = await request(testApp)
        .post('/api/v2/admin/auth/login')
        .set('Cookie', cookie(ADMIN_COOKIE, adminToken))
        .set('X-CSRF-Token', adminCsrf)
        .send({ email: otherAdminEmail, password: otherAdminPassword });
      expect(adminSwitch.status).toBe(200);
      expect(adminSwitch.body.data.admin.id).toBe(otherAdminId);
      expect(await Promise.all(adminSwitchCloses)).toEqual([
        SUPPORT_SESSION_REVOKED_CLOSE_CODE,
        SUPPORT_SESSION_REVOKED_CLOSE_CODE,
      ]);

      const adminSetCookies = (adminSwitch.headers['set-cookie'] ?? []) as unknown as string[];
      const newAdminSessionCookie = adminSetCookies.find((value) => value.startsWith(`${ADMIN_COOKIE}=`));
      const newAdminCsrfCookie = adminSetCookies.find((value) => value.startsWith(`${ADMIN_CSRF_COOKIE}=`));
      const newAdminToken = newAdminSessionCookie?.split(';', 1)[0]?.slice(ADMIN_COOKIE.length + 1);
      const newAdminCsrf = newAdminCsrfCookie?.split(';', 1)[0]?.slice(ADMIN_CSRF_COOKIE.length + 1);
      expect(newAdminToken).toEqual(expect.any(String));
      expect(newAdminCsrf).toEqual(expect.any(String));

      const adminLogoutTabs: WebSocket[] = [];
      for (let index = 0; index < 2; index += 1) {
        const socket = new WebSocket(`${wsBaseUrl}/api/v2/support/ws?role=admin`, {
          origin: 'http://localhost:3001',
          headers: { Cookie: cookie(ADMIN_COOKIE, newAdminToken!) },
        });
        sockets.push(socket);
        adminLogoutTabs.push(socket);
        await waitForEvent(socket, 'connection.ready');
      }
      const adminLogoutCloses = adminLogoutTabs.map(waitForClose);
      const logout = await request(testApp)
        .post('/api/v2/admin/auth/logout')
        .set('Cookie', cookie(ADMIN_COOKIE, newAdminToken!))
        .set('X-CSRF-Token', newAdminCsrf!);
      expect(logout.status).toBe(204);
      expect(await Promise.all(adminLogoutCloses)).toEqual([
        SUPPORT_SESSION_REVOKED_CLOSE_CODE,
        SUPPORT_SESSION_REVOKED_CLOSE_CODE,
      ]);
    } finally {
      for (const socket of sockets) socket.terminate();
    }
  });
});

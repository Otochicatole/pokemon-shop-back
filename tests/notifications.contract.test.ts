import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/infrastructure/prisma.js';
import { randomUUID } from 'node:crypto';
import { sha256 } from '../src/shared/ids.js';
import { ADMIN_COOKIE, ADMIN_CSRF_COOKIE, USER_COOKIE, USER_CSRF_COOKIE } from '../src/infrastructure/sessions.js';

const fixture = randomUUID();
const userToken = `notification-user-${fixture}`;
const adminToken = `notification-admin-${fixture}`;
const userCsrf = `notification-user-csrf-${fixture}`;
const adminCsrf = `notification-admin-csrf-${fixture}`;
const cookie = (name: string, value: string) => `${name}=${value}`;

describe('notifications contract', () => {
  it('documents customer and admin notification APIs', async () => {
    const response = await request(app).get('/openapi.json');
    expect(response.status).toBe(200);
    expect(response.body.paths).toEqual(expect.objectContaining({
      '/api/v2/notifications': expect.objectContaining({ get: expect.any(Object) }),
      '/api/v2/notifications/unread-count': expect.objectContaining({ get: expect.any(Object) }),
      '/api/v2/notifications/{id}/read': expect.objectContaining({ post: expect.any(Object) }),
      '/api/v2/notifications/read-all': expect.objectContaining({ post: expect.any(Object) }),
      '/api/v2/admin/notifications': expect.objectContaining({ get: expect.any(Object) }),
      '/api/v2/admin/notifications/unread-count': expect.objectContaining({ get: expect.any(Object) }),
    }));
    expect(response.body['x-websocket']).toEqual(expect.objectContaining({
      canonicalUrl: '/api/v2/notifications/ws?role={user|admin}',
      serverEvents: expect.arrayContaining(['notification.created', 'notifications.unread_count']),
    }));
  });

  it('protects customer and admin notification feeds independently', async () => {
    const [customer, admin] = await Promise.all([
      request(app).get('/api/v2/notifications'),
      request(app).get('/api/v2/admin/notifications'),
    ]);
    expect(customer.status).toBe(401);
    expect(admin.status).toBe(401);
  });

  it('lists, isolates and marks notifications as read', async () => {
    const user = await prisma.user.create({ data: { email: `${fixture}@example.test`, name: 'Notification User', emailVerifiedAt: new Date() } });
    const admin = await prisma.admin.create({ data: { email: `admin-${fixture}@example.test`, passwordHash: 'test', name: 'Notification Admin' } });
    const conversation = await prisma.supportConversation.create({ data: { userId: user.id, subject: 'Aviso de prueba', createdByType: 'USER', createdById: user.id, createdByName: 'Notification User' } });
    const userNotification = await prisma.notification.create({ data: { recipientType: 'USER', userId: user.id, type: 'SUPPORT_MESSAGE', title: 'Nuevo mensaje', message: 'Probá tu bandeja', dedupeKey: `test-user-${fixture}`, supportConversationId: conversation.id } });
    await prisma.notification.create({ data: { recipientType: 'ADMIN', adminId: admin.id, type: 'SUPPORT_MESSAGE', title: 'Nueva consulta', message: 'Probá tu bandeja admin', dedupeKey: `test-admin-${fixture}`, supportConversationId: conversation.id } });
    await prisma.userSession.create({ data: { userId: user.id, tokenHash: sha256(userToken), csrfHash: sha256(userCsrf), expiresAt: new Date(Date.now() + 60_000) } });
    await prisma.adminSession.create({ data: { adminId: admin.id, tokenHash: sha256(adminToken), csrfHash: sha256(adminCsrf), expiresAt: new Date(Date.now() + 60_000) } });
    try {
      const userCookie = `${cookie(USER_COOKIE, userToken)}; ${cookie(USER_CSRF_COOKIE, userCsrf)}`;
      const adminCookie = `${cookie(ADMIN_COOKIE, adminToken)}; ${cookie(ADMIN_CSRF_COOKIE, adminCsrf)}`;
      const userList = await request(app).get('/api/v2/notifications').set('Cookie', userCookie);
      expect(userList.status).toBe(200);
      expect(userList.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: userNotification.id, reference: { kind: 'SUPPORT_CONVERSATION', conversationId: conversation.id } })]));
      expect((await request(app).get('/api/v2/admin/notifications').set('Cookie', adminCookie)).body.data).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'SUPPORT_MESSAGE' })]));
      expect((await request(app).get(`/api/v2/notifications/${userNotification.id}/read`).set('Cookie', userCookie)).status).toBe(404);
      const read = await request(app).post(`/api/v2/notifications/${userNotification.id}/read`).set('Cookie', userCookie).set('X-CSRF-Token', userCsrf).send({});
      expect(read.status).toBe(200);
      expect(read.body.data.unreadCount).toBe(0);
      expect((await request(app).post('/api/v2/notifications/read-all').set('Cookie', userCookie).set('X-CSRF-Token', userCsrf).send({})).body.data.unreadCount).toBe(0);
      expect((await request(app).get('/api/v2/admin/notifications/unread-count').set('Cookie', adminCookie)).body.data.count).toBe(1);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.admin.delete({ where: { id: admin.id } });
    }
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { app } from '../src/app.js';
import { prisma } from '../src/infrastructure/prisma.js';
import {
  ADMIN_COOKIE,
  ADMIN_CSRF_COOKIE,
  ADMIN_IDLE_TIMEOUT_MS,
  USER_COOKIE,
  USER_CSRF_COOKIE,
} from '../src/infrastructure/sessions.js';
import { sha256 } from '../src/shared/ids.js';
import { hashPassword } from '../src/shared/crypto.js';

const adminId = randomUUID();
const userId = randomUUID();
const adminEmail = `admin-security-${randomUUID()}@example.test`;
const adminPassword = 'AdminPassword123!';
const userEmail = `user-security-${randomUUID()}@example.test`;

const userToken = `user-${randomUUID()}`;
const userCsrf = `user-csrf-${randomUUID()}`;
const adminToken = `admin-${randomUUID()}`;
const adminCsrf = `admin-csrf-${randomUUID()}`;

const cookieHeader = (...cookies: Array<[string, string]>) => (
  cookies.map(([name, value]) => `${name}=${value}`).join('; ')
);

describe('admin session and CSRF isolation', () => {
  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: userId,
        email: userEmail,
        passwordHash: 'not-used-by-this-test',
        emailVerifiedAt: new Date(),
      },
    });
    await prisma.admin.create({
      data: {
        id: adminId,
        email: adminEmail,
        passwordHash: await hashPassword(adminPassword),
      },
    });
    await prisma.userSession.create({
      data: {
        userId,
        tokenHash: sha256(userToken),
        csrfHash: sha256(userCsrf),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    await prisma.adminSession.create({
      data: {
        adminId,
        tokenHash: sha256(adminToken),
        csrfHash: sha256(adminCsrf),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
  });

  afterAll(async () => {
    await prisma.adminSession.deleteMany({ where: { adminId } });
    await prisma.userSession.deleteMany({ where: { userId } });
    await prisma.admin.deleteMany({ where: { id: adminId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it('authenticates an admin using only email and password', async () => {
    const response = await request(app)
      .post('/api/v2/admin/auth/login')
      .send({ email: adminEmail, password: adminPassword });

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body.data.admin).toEqual(expect.objectContaining({
      id: adminId,
      email: adminEmail,
      role: 'SUPER_ADMIN',
    }));
    expect(response.body.data.csrfToken).toEqual(expect.any(String));

    const setCookies = (response.headers['set-cookie'] ?? []) as unknown as string[];
    expect(setCookies.some((cookie) => cookie.startsWith(`${ADMIN_COOKIE}=`))).toBe(true);
    expect(setCookies.some((cookie) => cookie.startsWith(`${ADMIN_CSRF_COOKIE}=`))).toBe(true);
  });

  it('rejects the retired OTP field instead of silently accepting it', async () => {
    const response = await request(app)
      .post('/api/v2/admin/auth/login')
      .send({ email: adminEmail, password: adminPassword, otp: '123456' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(response.headers['cache-control']).toContain('no-store');
  });

  it('rotates only the admin token at the admin CSRF endpoint', async () => {
    const response = await request(app)
      .get('/api/v2/admin/auth/csrf')
      .set('Cookie', cookieHeader([USER_COOKIE, userToken], [ADMIN_COOKIE, adminToken]));

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body.data.csrfToken).toEqual(expect.any(String));

    const setCookies = (response.headers['set-cookie'] ?? []) as unknown as string[];
    expect(setCookies.some((cookie) => cookie.startsWith(`${ADMIN_CSRF_COOKIE}=`))).toBe(true);
    expect(setCookies.some((cookie) => cookie.startsWith(`${USER_CSRF_COOKIE}=`))).toBe(false);

    const [adminSession, userSession] = await Promise.all([
      prisma.adminSession.findUniqueOrThrow({ where: { tokenHash: sha256(adminToken) } }),
      prisma.userSession.findUniqueOrThrow({ where: { tokenHash: sha256(userToken) } }),
    ]);
    expect(adminSession.csrfHash).toBe(sha256(response.body.data.csrfToken as string));
    expect(userSession.csrfHash).toBe(sha256(userCsrf));
  });

  it('uses the route namespace when customer and admin cookies coexist', async () => {
    const cookies = cookieHeader([USER_COOKIE, userToken], [ADMIN_COOKIE, adminToken]);
    const currentAdminSession = await prisma.adminSession.findUniqueOrThrow({ where: { tokenHash: sha256(adminToken) } });

    const rejected = await request(app)
      .post('/api/v2/admin/auth/logout')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', userCsrf);
    expect(rejected.status).toBe(403);
    expect(rejected.body.code).toBe('FORBIDDEN');
    expect(rejected.headers['cache-control']).toContain('no-store');

    const accepted = await request(app)
      .post('/api/v2/admin/auth/logout')
      .set('Cookie', cookies)
      .set('X-CSRF-Token', currentAdminSession.csrfHash === sha256(adminCsrf)
        ? adminCsrf
        : await fetchFreshAdminCsrf(cookies));
    expect(accepted.status).toBe(204);
    expect(accepted.headers['cache-control']).toContain('no-store');

    const [adminSession, userSession] = await Promise.all([
      prisma.adminSession.findUniqueOrThrow({ where: { tokenHash: sha256(adminToken) } }),
      prisma.userSession.findUniqueOrThrow({ where: { tokenHash: sha256(userToken) } }),
    ]);
    expect(adminSession.revokedAt).not.toBeNull();
    expect(userSession.revokedAt).toBeNull();
  });

  it('rejects sessions after 15 minutes of inactivity or their absolute expiry', async () => {
    const idleToken = `idle-${randomUUID()}`;
    const expiredToken = `expired-${randomUUID()}`;
    const now = Date.now();
    await prisma.adminSession.createMany({
      data: [
        {
          adminId,
          tokenHash: sha256(idleToken),
          csrfHash: sha256(`csrf-${idleToken}`),
          lastSeenAt: new Date(now - ADMIN_IDLE_TIMEOUT_MS - 1_000),
          expiresAt: new Date(now + 60 * 60 * 1000),
        },
        {
          adminId,
          tokenHash: sha256(expiredToken),
          csrfHash: sha256(`csrf-${expiredToken}`),
          lastSeenAt: new Date(now),
          expiresAt: new Date(now - 1_000),
        },
      ],
    });

    const [idleResponse, expiredResponse] = await Promise.all([
      request(app).get('/api/v2/admin/auth/me').set('Cookie', cookieHeader([ADMIN_COOKIE, idleToken])),
      request(app).get('/api/v2/admin/auth/me').set('Cookie', cookieHeader([ADMIN_COOKIE, expiredToken])),
    ]);

    expect(idleResponse.status).toBe(401);
    expect(expiredResponse.status).toBe(401);
    expect(idleResponse.headers['cache-control']).toContain('no-store');
    expect(expiredResponse.headers['cache-control']).toContain('no-store');

    const invalidSessions = await prisma.adminSession.findMany({
      where: { tokenHash: { in: [sha256(idleToken), sha256(expiredToken)] } },
    });
    expect(invalidSessions).toHaveLength(2);
    expect(invalidSessions.every((session) => session.revokedAt !== null)).toBe(true);
  });

  it('touches an active admin session without extending its absolute expiry', async () => {
    const token = `active-${randomUUID()}`;
    const originalLastSeenAt = new Date(Date.now() - 2 * 60 * 1000);
    const absoluteExpiry = new Date(Date.now() + 60 * 60 * 1000);
    await prisma.adminSession.create({
      data: {
        adminId,
        tokenHash: sha256(token),
        csrfHash: sha256(`csrf-${token}`),
        lastSeenAt: originalLastSeenAt,
        expiresAt: absoluteExpiry,
      },
    });

    const response = await request(app)
      .get('/api/v2/admin/auth/me')
      .set('Cookie', cookieHeader([ADMIN_COOKIE, token]));
    expect(response.status).toBe(200);

    const touched = await prisma.adminSession.findUniqueOrThrow({ where: { tokenHash: sha256(token) } });
    expect(touched.lastSeenAt.getTime()).toBeGreaterThan(originalLastSeenAt.getTime());
    expect(touched.expiresAt.getTime()).toBe(absoluteExpiry.getTime());
  });

  it('does not keep an admin session alive while browsing the storefront', async () => {
    const token = `storefront-${randomUUID()}`;
    const originalLastSeenAt = new Date(Date.now() - 2 * 60 * 1000);
    await prisma.adminSession.create({
      data: {
        adminId,
        tokenHash: sha256(token),
        csrfHash: sha256(`csrf-${token}`),
        lastSeenAt: originalLastSeenAt,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const response = await request(app)
      .get('/api/v2/catalog/products?limit=1')
      .set('Cookie', cookieHeader([ADMIN_COOKIE, token]));
    expect(response.status).toBe(200);

    const untouched = await prisma.adminSession.findUniqueOrThrow({ where: { tokenHash: sha256(token) } });
    expect(untouched.lastSeenAt.getTime()).toBe(originalLastSeenAt.getTime());
  });

  it('documents the independent admin session and CSRF contract in OpenAPI 3.1', async () => {
    const response = await request(app).get('/openapi.json');
    expect(response.status).toBe(200);
    expect(response.body.openapi).toBe('3.1.0');
    expect(response.body.components.securitySchemes.adminCookie).toEqual(expect.objectContaining({
      type: 'apiKey',
      in: 'cookie',
    }));
    expect(response.body.paths).toHaveProperty('/api/v2/admin/auth/login');
    expect(response.body.paths).toHaveProperty('/api/v2/admin/auth/csrf');
    expect(response.body.paths['/api/v2/admin/auth/csrf'].get.security).toEqual([{ adminCookie: [] }]);

    const loginSchema = response.body.paths['/api/v2/admin/auth/login'].post.requestBody
      .content['application/json'].schema;
    expect(loginSchema.required).toEqual(expect.arrayContaining(['email', 'password']));
    expect(loginSchema.required).toHaveLength(2);
    expect(loginSchema.properties).not.toHaveProperty('otp');
    expect(loginSchema.additionalProperties).toBe(false);

    const logoutParameters = response.body.paths['/api/v2/admin/auth/logout'].post.parameters as Array<{ in: string; name: string }>;
    expect(logoutParameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ in: 'header', name: 'x-csrf-token' }),
    ]));

    const cmsPaths = [
      '/api/v2/admin/dashboard',
      '/api/v2/admin/products',
      '/api/v2/admin/products/{id}',
      '/api/v2/admin/products/{id}/publish',
      '/api/v2/admin/products/{id}/archive',
      '/api/v2/admin/products/{id}/images',
      '/api/v2/admin/products/{id}/images/{imageId}',
      '/api/v2/admin/products/{id}/images/order',
      '/api/v2/admin/products/{id}/inventory-adjustments',
      '/api/v2/admin/products/{id}/inventory-adjustment',
      '/api/v2/admin/inventory',
      '/api/v2/admin/orders',
      '/api/v2/admin/orders/{number}',
      '/api/v2/admin/orders/{number}/cancel',
      '/api/v2/admin/orders/{number}/transition',
      '/api/v2/admin/orders/{number}/transfer-receipts/{receiptId}/approve',
      '/api/v2/admin/orders/{number}/transfer-receipts/{receiptId}/reject',
      '/api/v2/admin/orders/{number}/late-payment/fulfill',
      '/api/v2/admin/orders/{number}/refund',
      '/api/v2/admin/payments',
      '/api/v2/admin/fulfillment',
      '/api/v2/admin/fulfillment/shipping-zones',
      '/api/v2/admin/fulfillment/shipping-zones/{id}',
      '/api/v2/admin/fulfillment/shipping-zones/{id}/active',
      '/api/v2/admin/fulfillment/pickup-points',
      '/api/v2/admin/fulfillment/pickup-points/{id}',
      '/api/v2/admin/fulfillment/pickup-points/{id}/active',
      '/api/v2/admin/customers',
      '/api/v2/admin/customers/{id}',
      '/api/v2/admin/customers/{id}/orders',
      '/api/v2/admin/audit',
    ];
    for (const path of cmsPaths) expect(response.body.paths).toHaveProperty(path);

    const createProduct = response.body.paths['/api/v2/admin/products'].post;
    expect(createProduct.security).toEqual([{ adminCookie: [] }]);
    expect(createProduct.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ in: 'header', name: 'x-csrf-token' }),
    ]));

    const productListSchema = response.body.paths['/api/v2/admin/products'].get.responses['200']
      .content['application/json'].schema;
    expect(productListSchema.properties.data.items.properties).toEqual(expect.objectContaining({
      sku: expect.objectContaining({ type: 'string' }),
      inventory: expect.objectContaining({ properties: expect.objectContaining({ available: expect.objectContaining({ type: 'integer' }) }) }),
    }));

    const dashboardSchema = response.body.paths['/api/v2/admin/dashboard'].get.responses['200']
      .content['application/json'].schema;
    expect(dashboardSchema.properties.data.properties.recentActivity).toEqual(expect.objectContaining({ type: 'array' }));

    const imageUploadSchema = response.body.paths['/api/v2/admin/products/{id}/images'].post.requestBody
      .content['multipart/form-data'].schema;
    expect(imageUploadSchema.required).toEqual(expect.arrayContaining(['expectedVersion', 'images']));

    const imagePatchSchema = response.body.paths['/api/v2/admin/products/{id}/images/{imageId}'].patch.requestBody
      .content['application/json'].schema;
    expect(imagePatchSchema.required).toEqual(expect.arrayContaining(['expectedVersion', 'altText']));
  });
});

async function fetchFreshAdminCsrf(cookies: string): Promise<string> {
  const response = await request(app).get('/api/v2/admin/auth/csrf').set('Cookie', cookies);
  return response.body.data.csrfToken as string;
}

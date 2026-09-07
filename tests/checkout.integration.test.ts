import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';
import { prisma } from '../src/infrastructure/prisma.js';

describe('checkout invariants', () => {
  const email = `buyer-${Date.now()}@example.test`;
  let userAgent: request.Agent;
  let csrfToken = '';
  let productId = '';

  beforeAll(async () => {
    const pickup = await prisma.pickupPoint.create({ data: { name: `Test pickup ${Date.now()}`, address: 'Test address' } });
    const product = await prisma.product.create({ data: { sku: `TEST-${Date.now()}`, slug: `test-${Date.now()}`, name: 'Test card', description: 'Test', kind: 'SINGLE_CARD', stockMode: 'UNIQUE', priceMinor: 1000n, currency: 'ARS', status: 'PUBLISHED', publishedAt: new Date(), inventory: { create: { onHand: 1 } } } });
    productId = product.id;
    const registered = await request(app).post('/api/v2/auth/register').send({ email, password: 'correct horse battery staple', name: 'Buyer' });
    expect(registered.status).toBe(201);
    await prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
    userAgent = request.agent(app);
    const login = await userAgent.post('/api/v2/auth/login').send({ email, password: 'correct horse battery staple' });
    expect(login.status).toBe(200);
    csrfToken = login.body.data.csrfToken;
    (userAgent as request.Agent & { pickupId?: string }).pickupId = pickup.id;
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { user: { email } } });
    await prisma.pickupPoint.deleteMany({ where: { name: { startsWith: 'Test pickup ' } } });
    await prisma.product.delete({ where: { id: productId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { email } });
    await prisma.$disconnect();
  });

  it('revalidates stock and returns the same order for an idempotent retry', async () => {
    const pickupId = (userAgent as request.Agent & { pickupId?: string }).pickupId;
    const body = { items: [{ productId, quantity: 1, productVersion: 1 }], fulfillment: { type: 'PICKUP', pickupPointId: pickupId }, paymentMethod: 'BANK_TRANSFER' };
    const idempotencyKey = `test-key-${Date.now()}-unique`;
    const first = await userAgent.post('/api/v2/orders').set('X-CSRF-Token', csrfToken).set('Idempotency-Key', idempotencyKey).send(body);
    expect(first.status).toBe(201);
    expect(first.body.data.order.payment.method).toBe('BANK_TRANSFER');
    const second = await userAgent.post('/api/v2/orders').set('X-CSRF-Token', csrfToken).set('Idempotency-Key', idempotencyKey).send(body);
    expect(second.status).toBe(200);
    expect(second.body.data.reused).toBe(true);
    const inventory = await prisma.inventory.findUnique({ where: { productId } });
    expect(inventory?.reserved).toBe(1);
  });
});

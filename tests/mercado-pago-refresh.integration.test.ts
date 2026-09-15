import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createCompositionRoot } from '../src/app/composition-root.js';
import { env } from '../src/config/env.js';
import { prisma } from '../src/infrastructure/prisma.js';
import { createOrdersRouter } from '../src/modules/orders/index.js';
import type { MercadoPagoGateway } from '../src/modules/payments/index.js';

describe('Mercado Pago customer payment-status refresh', () => {
  const fixture = randomUUID();
  const orderNumber = `BCS-MP-REFRESH-${fixture}`;
  const providerOrderId = `ORD-${fixture}`;
  const providerPaymentId = `PAY-${fixture}`;
  const productId = randomUUID();
  const ownerEmail = `mp-refresh-owner-${fixture}@example.test`;
  const strangerEmail = `mp-refresh-stranger-${fixture}@example.test`;
  let ownerId = '';
  let strangerId = '';
  let orderId = '';
  let ownerAgent: request.Agent;
  let strangerAgent: request.Agent;
  let ownerCsrf = '';
  let strangerCsrf = '';

  const getOrder = vi.fn<MercadoPagoGateway['getOrder']>(async () => ({
    id: providerOrderId,
    external_reference: orderNumber,
    total_amount: '93.60',
    currency: 'ARS',
    status: 'processed',
    status_detail: 'accredited',
    ...(env.MERCADOPAGO_COLLECTOR_ID ? { user_id: env.MERCADOPAGO_COLLECTOR_ID } : {}),
    transactions: {
      payments: [{ id: providerPaymentId, amount: '93.60', currency: 'ARS', status: 'processed', status_detail: 'accredited' }],
    },
  } as Awaited<ReturnType<MercadoPagoGateway['getOrder']>>));

  const gateway: MercadoPagoGateway = {
    createOrder: vi.fn(async () => { throw new Error('Unexpected createOrder call'); }),
    getOrder,
    getPayment: vi.fn(async () => { throw new Error('Unexpected getPayment call'); }),
    validateWebhook: vi.fn(),
  };

  const composition = createCompositionRoot();
  composition.payments.mercadoPago = gateway;
  composition.routers.commerce = createOrdersRouter(prisma, composition.upload, composition.realtime.support, gateway);
  const testApp = createApp(composition);

  beforeAll(async () => {
    for (const email of [ownerEmail, strangerEmail]) {
      const registered = await request(testApp).post('/api/v2/auth/register').send({
        email,
        password: 'correct horse battery staple',
        name: 'Mercado Pago refresh tester',
      });
      expect(registered.status).toBe(201);
      await prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
    }

    ownerId = (await prisma.user.findUniqueOrThrow({ where: { email: ownerEmail } })).id;
    strangerId = (await prisma.user.findUniqueOrThrow({ where: { email: strangerEmail } })).id;
    ownerAgent = request.agent(testApp);
    strangerAgent = request.agent(testApp);
    const [ownerLogin, strangerLogin] = await Promise.all([
      ownerAgent.post('/api/v2/auth/login').send({ email: ownerEmail, password: 'correct horse battery staple' }),
      strangerAgent.post('/api/v2/auth/login').send({ email: strangerEmail, password: 'correct horse battery staple' }),
    ]);
    expect(ownerLogin.status).toBe(200);
    expect(strangerLogin.status).toBe(200);
    ownerCsrf = ownerLogin.body.data.csrfToken;
    strangerCsrf = strangerLogin.body.data.csrfToken;

    await prisma.product.create({
      data: {
        id: productId,
        sku: `MP-REFRESH-${fixture}`,
        slug: `mp-refresh-${fixture}`,
        name: 'Mercado Pago refresh fixture',
        description: 'Test fixture',
        kind: 'ACCESSORY',
        stockMode: 'QUANTITY',
        priceMinor: 1n,
        currency: 'USD',
        status: 'PUBLISHED',
        publishedAt: new Date(),
        inventory: { create: { onHand: 2, reserved: 1 } },
      },
    });
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    const order = await prisma.order.create({
      data: {
        userId: ownerId,
        number: orderNumber,
        status: 'PENDING_PAYMENT',
        paymentMethod: 'MERCADO_PAGO',
        fulfillmentType: 'PICKUP',
        currency: 'USD',
        subtotalMinor: 1n,
        shippingMinor: 0n,
        totalMinor: 1n,
        idempotencyKey: `mp-refresh-${fixture}`,
        idempotencyHash: fixture,
        expiresAt,
        payment: {
          create: {
            method: 'MERCADO_PAGO',
            status: 'PENDING',
            amountMinor: 1n,
            currency: 'USD',
            mercadoPago: {
              create: {
                integrationMode: 'ORDER_V1',
                providerOrderId,
                providerAmountMinor: 9_360n,
                providerCurrency: 'ARS',
                status: 'created',
                expiresAt,
              },
            },
          },
        },
        reservations: { create: { productId, quantity: 1, expiresAt } },
        statusHistory: { create: { toStatus: 'PENDING_PAYMENT', note: 'Order created' } },
      },
    });
    orderId = order.id;
  });

  afterAll(async () => {
    if (orderId) await prisma.order.deleteMany({ where: { id: orderId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, strangerId].filter(Boolean) } } });
    await prisma.$disconnect();
  });

  it('does not expose or query another customer order', async () => {
    const unauthenticated = await request(testApp).post(`/api/v2/orders/${orderNumber}/payment-status/refresh`).send({});
    const foreign = await strangerAgent
      .post(`/api/v2/orders/${orderNumber}/payment-status/refresh`)
      .set('X-CSRF-Token', strangerCsrf)
      .send({});

    expect(unauthenticated.status).toBe(401);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(getOrder).not.toHaveBeenCalled();
  });

  it('reconciles from Order.get and remains idempotent', async () => {
    const first = await ownerAgent
      .post(`/api/v2/orders/${orderNumber}/payment-status/refresh`)
      .set('X-CSRF-Token', ownerCsrf)
      .send({});
    const second = await ownerAgent
      .post(`/api/v2/orders/${orderNumber}/payment-status/refresh`)
      .set('X-CSRF-Token', ownerCsrf)
      .send({});

    expect(first.status).toBe(200);
    expect(first.body.data.order).toEqual(expect.objectContaining({
      number: orderNumber,
      status: 'PAID',
      payment: expect.objectContaining({ status: 'APPROVED' }),
    }));
    expect(second.status).toBe(200);
    expect(second.body.data.order.status).toBe('PAID');
    expect(getOrder).toHaveBeenCalledTimes(2);
    expect(getOrder).toHaveBeenNthCalledWith(1, providerOrderId);

    const [storedOrder, inventory, reservation, attemptCount] = await Promise.all([
      prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { payment: { include: { mercadoPago: true } }, statusHistory: true } }),
      prisma.inventory.findUniqueOrThrow({ where: { productId } }),
      prisma.inventoryReservation.findFirstOrThrow({ where: { orderId } }),
      prisma.mercadoPagoPaymentAttempt.count({ where: { mercadoPagoPayment: { payment: { orderId } } } }),
    ]);
    expect(storedOrder.status).toBe('PAID');
    expect(storedOrder.version).toBe(2);
    expect(storedOrder.payment).toEqual(expect.objectContaining({
      status: 'APPROVED',
      providerReference: providerOrderId,
      mercadoPago: expect.objectContaining({ status: 'processed', statusDetail: 'accredited' }),
    }));
    expect(storedOrder.statusHistory.filter((entry) => entry.toStatus === 'PAID')).toHaveLength(1);
    expect(inventory).toEqual(expect.objectContaining({ onHand: 1, reserved: 0 }));
    expect(reservation.consumedAt).toBeInstanceOf(Date);
    expect(attemptCount).toBe(1);
  });
});

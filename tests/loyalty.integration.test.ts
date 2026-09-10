import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { LoyaltyProgram } from '@prisma/client';
import { Payment as MercadoPayment } from 'mercadopago';
import { app } from '../src/app.js';
import { env } from '../src/config/env.js';
import { prisma, writeCoordinator } from '../src/infrastructure/prisma.js';
import { createAdminCmsApplication, createPrismaAdminCmsRepositories } from '../src/modules/backoffice/index.js';
import { reconcileMercadoPayment } from '../src/modules/orders/orders.js';

const cms = createAdminCmsApplication(createPrismaAdminCmsRepositories(prisma, writeCoordinator), {
  integrations: { bankTransfer: false, mercadoPago: false, smtp: false },
});

describe('loyalty purchase lifecycle', () => {
  const fixture = randomUUID();
  const adminId = randomUUID();
  const userEmail = `loyalty-${fixture}@example.test`;
  const productId = randomUUID();
  const pickupPointId = randomUUID();
  const receiptFileId = randomUUID();
  const receiptId = randomUUID();
  const actor = { adminId, requestId: `loyalty-test-${fixture}` };
  let originalProgram: LoyaltyProgram | null = null;
  let userId = '';
  let orderId = '';
  let orderNumber = '';
  let mercadoPagoUserId = '';
  let mercadoPagoOrderId = '';
  let userAgent: request.Agent;
  let csrfToken = '';

  beforeAll(async () => {
    originalProgram = await prisma.loyaltyProgram.findUnique({ where: { id: 'default' } });
    await prisma.loyaltyProgram.upsert({
      where: { id: 'default' },
      update: {
        enabled: true,
        currency: 'ARS',
        spendPerPointMinor: 100n,
        pointsPerStep: 1,
        pointValueMinor: 100n,
        minimumRedemptionPoints: 1,
        maximumRedemptionPercent: 50,
        updatedById: null,
      },
      create: {
        id: 'default',
        enabled: true,
        currency: 'ARS',
        spendPerPointMinor: 100n,
        pointsPerStep: 1,
        pointValueMinor: 100n,
        minimumRedemptionPoints: 1,
        maximumRedemptionPercent: 50,
      },
    });
    await prisma.admin.create({ data: { id: adminId, email: `loyalty-admin-${fixture}@example.test`, passwordHash: 'not-used' } });
    await prisma.pickupPoint.create({ data: { id: pickupPointId, name: `Loyalty pickup ${fixture}`, address: 'Test address' } });
    await prisma.product.create({
      data: {
        id: productId,
        sku: `LOYALTY-${fixture}`,
        slug: `loyalty-${fixture}`,
        name: 'Loyalty fixture',
        description: 'Loyalty lifecycle fixture',
        kind: 'ACCESSORY',
        stockMode: 'QUANTITY',
        priceMinor: 2_000n,
        currency: 'ARS',
        status: 'PUBLISHED',
        publishedAt: new Date(),
        inventory: { create: { onHand: 1 } },
      },
    });

    const registered = await request(app).post('/api/v2/auth/register').send({
      email: userEmail,
      password: 'correct horse battery staple',
      name: 'Loyalty buyer',
    });
    expect(registered.status).toBe(201);
    const user = await prisma.user.update({ where: { email: userEmail }, data: { emailVerifiedAt: new Date() } });
    userId = user.id;
    await prisma.loyaltyAccount.create({ data: { userId, balance: 5 } });

    userAgent = request.agent(app);
    const login = await userAgent.post('/api/v2/auth/login').send({ email: userEmail, password: 'correct horse battery staple' });
    expect(login.status).toBe(200);
    csrfToken = login.body.data.csrfToken;
  });

  afterAll(async () => {
    if (orderId) {
      await prisma.refundRecord.deleteMany({ where: { payment: { orderId } } });
      await prisma.order.deleteMany({ where: { id: orderId } });
    }
    if (mercadoPagoOrderId) await prisma.order.deleteMany({ where: { id: mercadoPagoOrderId } });
    if (mercadoPagoUserId) await prisma.user.deleteMany({ where: { id: mercadoPagoUserId } });
    await prisma.storedFile.deleteMany({ where: { id: receiptFileId } });
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.pickupPoint.deleteMany({ where: { id: pickupPointId } });
    await prisma.auditLog.deleteMany({ where: { actorId: adminId } });

    if (originalProgram) {
      await prisma.loyaltyProgram.update({
        where: { id: 'default' },
        data: {
          enabled: originalProgram.enabled,
          currency: originalProgram.currency,
          spendPerPointMinor: originalProgram.spendPerPointMinor,
          pointsPerStep: originalProgram.pointsPerStep,
          pointValueMinor: originalProgram.pointValueMinor,
          minimumRedemptionPoints: originalProgram.minimumRedemptionPoints,
          maximumRedemptionPercent: originalProgram.maximumRedemptionPercent,
          version: originalProgram.version,
          updatedById: originalProgram.updatedById,
          updatedAt: originalProgram.updatedAt,
        },
      });
    } else {
      await prisma.loyaltyProgram.deleteMany({ where: { id: 'default' } });
    }
    await prisma.admin.deleteMany({ where: { id: adminId } });
    await prisma.$disconnect();
  });

  it('reserves, redeems and earns points, then reverses both sides on a full refund', async () => {
    const checkout = await userAgent
      .post('/api/v2/orders')
      .set('X-CSRF-Token', csrfToken)
      .set('Idempotency-Key', `loyalty-order-${fixture}`)
      .send({
        items: [{ productId, quantity: 1, productVersion: 1 }],
        fulfillment: { type: 'PICKUP', pickupPointId },
        paymentMethod: 'BANK_TRANSFER',
        pointsToRedeem: 5,
      });

    expect(checkout.status).toBe(201);
    expect(checkout.body.data.order).toEqual(expect.objectContaining({
      status: 'PENDING_PAYMENT',
      loyalty: expect.objectContaining({ pointsRedeemed: 5, pointsEarned: 15, redemptionStatus: 'RESERVED' }),
      totals: expect.objectContaining({
        subtotal: { amountMinor: '2000', currency: 'ARS' },
        discount: { amountMinor: '500', currency: 'ARS' },
        total: { amountMinor: '1500', currency: 'ARS' },
      }),
    }));
    orderId = checkout.body.data.order.id;
    orderNumber = checkout.body.data.order.number;

    expect(await prisma.loyaltyAccount.findUniqueOrThrow({ where: { userId } })).toEqual(expect.objectContaining({ balance: 5, reserved: 5 }));

    await prisma.storedFile.create({
      data: {
        id: receiptFileId,
        storageKey: `private/receipts/${receiptFileId}.webp`,
        mimeType: 'image/webp',
        sizeBytes: 1,
        sha256: '5'.repeat(64),
        visibility: 'PRIVATE',
      },
    });
    await prisma.transferReceipt.create({ data: { id: receiptId, orderId, fileId: receiptFileId } });

    const approved = await cms.payments.reviewTransfer(actor, orderNumber, receiptId, 1, 'APPROVED', 'Transfer verified');
    expect(approved).toEqual(expect.objectContaining({ status: 'PAID', version: 2 }));

    expect(await prisma.loyaltyAccount.findUniqueOrThrow({ where: { userId } })).toEqual(expect.objectContaining({
      balance: 15,
      reserved: 0,
      lifetimeEarned: 15,
      lifetimeRedeemed: 5,
    }));
    expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).toEqual(expect.objectContaining({
      status: 'PAID',
      loyaltyRedemptionStatus: 'REDEEMED',
    }));
    expect(await prisma.loyaltyTransaction.findMany({ where: { orderId }, select: { type: true, points: true, balanceAfter: true } })).toEqual(expect.arrayContaining([
      { type: 'REDEEM', points: -5, balanceAfter: 0 },
      { type: 'EARN', points: 15, balanceAfter: 15 },
    ]));

    const refunded = await cms.payments.recordFullRefund(actor, orderNumber, 2, 'Full loyalty refund', `LOYALTY-REFUND-${fixture}`);
    expect(refunded).toEqual(expect.objectContaining({ status: 'REFUND_RECORDED', version: 3, amount: { amountMinor: '1500', currency: 'ARS' } }));

    expect(await prisma.loyaltyAccount.findUniqueOrThrow({ where: { userId } })).toEqual(expect.objectContaining({ balance: 5, reserved: 0 }));
    expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { payment: true } })).toEqual(expect.objectContaining({
      status: 'REFUND_RECORDED',
      loyaltyRedemptionStatus: 'RESTORED',
      payment: expect.objectContaining({ status: 'REFUNDED' }),
    }));
    expect(await prisma.loyaltyTransaction.findMany({ where: { orderId }, select: { type: true, points: true, balanceAfter: true } })).toEqual(expect.arrayContaining([
      { type: 'REDEEM', points: -5, balanceAfter: 0 },
      { type: 'EARN', points: 15, balanceAfter: 15 },
      { type: 'EARN_REVERSAL', points: -15, balanceAfter: 0 },
      { type: 'REDEEM_REVERSAL', points: 5, balanceAfter: 5 },
    ]));

    await expect(cms.payments.recordFullRefund(actor, orderNumber, 3, 'Duplicate refund', `LOYALTY-REFUND-DUPLICATE-${fixture}`))
      .rejects.toMatchObject({ code: 'ORDER_NOT_REFUNDABLE' });
    expect(await prisma.loyaltyTransaction.count({ where: { orderId } })).toBe(4);
  });

  it('reconciles a Mercado Pago refund exactly once without creating an admin refund record', async () => {
    const externalPaymentId = `MP-LOYALTY-${fixture}`;
    const number = `BCS-MP-LOYALTY-${fixture}`;
    const user = await prisma.user.create({ data: { email: `loyalty-mp-${fixture}@example.test`, emailVerifiedAt: new Date() } });
    mercadoPagoUserId = user.id;
    const account = await prisma.loyaltyAccount.create({
      data: { userId: user.id, balance: 12, lifetimeEarned: 6, lifetimeRedeemed: 4, version: 3 },
    });
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        number,
        status: 'PAID',
        paymentMethod: 'MERCADO_PAGO',
        fulfillmentType: 'PICKUP',
        currency: 'ARS',
        subtotalMinor: 1_900n,
        shippingMinor: 0n,
        totalMinor: 1_500n,
        loyaltyProgramVersion: 1,
        loyaltySpendPerPointMinor: 100n,
        loyaltyPointValueMinor: 100n,
        pointsRedeemed: 4,
        pointsDiscountMinor: 400n,
        pointsEarned: 6,
        loyaltyRedemptionStatus: 'REDEEMED',
        idempotencyKey: `mp-loyalty-order-${fixture}`,
        idempotencyHash: fixture,
        payment: {
          create: {
            method: 'MERCADO_PAGO',
            status: 'APPROVED',
            amountMinor: 1_500n,
            currency: 'ARS',
            mercadoPago: { create: { status: 'approved' } },
          },
        },
        statusHistory: { create: [{ toStatus: 'PENDING_PAYMENT' }, { fromStatus: 'PENDING_PAYMENT', toStatus: 'PAID' }] },
      },
      include: { payment: true },
    });
    mercadoPagoOrderId = order.id;
    await prisma.loyaltyTransaction.createMany({
      data: [
        { accountId: account.id, userId: user.id, orderId: order.id, type: 'REDEEM', points: -4, balanceAfter: 6 },
        { accountId: account.id, userId: user.id, orderId: order.id, type: 'EARN', points: 6, balanceAfter: 12 },
      ],
    });

    const previousAccessToken = env.MERCADOPAGO_ACCESS_TOKEN;
    env.MERCADOPAGO_ACCESS_TOKEN = 'test-access-token';
    const getPayment = vi.spyOn(MercadoPayment.prototype, 'get').mockResolvedValue({
      external_reference: number,
      transaction_amount: 15,
      currency_id: 'ARS',
      status: 'refunded',
      status_detail: 'refunded',
    } as never);

    try {
      await reconcileMercadoPayment(externalPaymentId);
      await reconcileMercadoPayment(externalPaymentId);
    } finally {
      getPayment.mockRestore();
      env.MERCADOPAGO_ACCESS_TOKEN = previousAccessToken;
    }

    const refundedOrder = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { payment: { include: { mercadoPago: true, refunds: true } }, statusHistory: true },
    });
    expect(refundedOrder).toEqual(expect.objectContaining({
      status: 'REFUND_RECORDED',
      version: 2,
      loyaltyRedemptionStatus: 'RESTORED',
      payment: expect.objectContaining({
        status: 'REFUNDED',
        providerReference: externalPaymentId,
        mercadoPago: expect.objectContaining({ externalPaymentId, status: 'refunded', statusDetail: 'refunded' }),
        refunds: [],
      }),
    }));
    expect(refundedOrder.statusHistory.filter((entry) => entry.toStatus === 'REFUND_RECORDED')).toHaveLength(1);
    expect(await prisma.loyaltyAccount.findUniqueOrThrow({ where: { userId: user.id } })).toEqual(expect.objectContaining({ balance: 10, reserved: 0 }));
    expect(await prisma.loyaltyTransaction.findMany({ where: { orderId: order.id }, select: { type: true, points: true, balanceAfter: true } })).toEqual(expect.arrayContaining([
      { type: 'REDEEM', points: -4, balanceAfter: 6 },
      { type: 'EARN', points: 6, balanceAfter: 12 },
      { type: 'EARN_REVERSAL', points: -6, balanceAfter: 6 },
      { type: 'REDEEM_REVERSAL', points: 4, balanceAfter: 10 },
    ]));
    expect(await prisma.refundRecord.count({ where: { paymentId: order.payment!.id } })).toBe(0);
  });
});

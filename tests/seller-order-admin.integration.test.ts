import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { FulfillmentType, SellerOrderStatus } from '@prisma/client';
import { prisma } from '../src/infrastructure/prisma.js';
import { sellerOrderAllowedActions, transitionSellerOrder } from '../src/modules/affiliates/affiliate-marketplace-service.js';

const userId = randomUUID();
const orderId = randomUUID();
const sellerOrderId = randomUUID();
const orderNumber = `BCS-STORE-STATUS-${randomUUID()}`;

describe('administrative store-order fulfillment', () => {
  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `store-status-${userId}@example.test`, emailVerifiedAt: new Date() } });
    await prisma.order.create({
      data: {
        id: orderId,
        userId,
        number: orderNumber,
        status: 'PAID',
        paymentMethod: 'BANK_TRANSFER',
        fulfillmentType: 'PICKUP',
        subtotalMinor: 1000n,
        shippingMinor: 0n,
        totalMinor: 1000n,
        idempotencyKey: randomUUID(),
        idempotencyHash: 'seller-order-admin-test',
        sellerOrders: {
          create: {
            id: sellerOrderId,
            number: `${orderNumber}-01`,
            sellerType: 'STORE',
            sellerName: 'Card Shop',
            status: 'PAID',
            subtotalMinor: 1000n,
            shippingMinor: 0n,
            sellerNetMinor: 1000n,
            fulfillmentType: 'PICKUP',
          },
        },
      },
    });
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { id: orderId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it('exposes and executes the complete pickup flow from the general admin order', async () => {
    expect(sellerOrderAllowedActions({ status: SellerOrderStatus.PAID, sellerType: 'STORE', fulfillmentType: FulfillmentType.PICKUP }, 'ADMIN')).toContain('START_PREPARING');
    expect(sellerOrderAllowedActions({ status: SellerOrderStatus.PREPARING, sellerType: 'STORE', fulfillmentType: FulfillmentType.SHIPMENT }, 'ADMIN')).toContain('MARK_SHIPPED');

    const preparing = await prisma.$transaction((tx) => transitionSellerOrder(tx, { sellerOrderId, expectedVersion: 1, nextStatus: SellerOrderStatus.PREPARING, actor: 'ADMIN', note: 'Preparing store order' }));
    expect(preparing).toMatchObject({ status: 'PREPARING', version: 2 });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('IN_FULFILLMENT');

    const ready = await prisma.$transaction((tx) => transitionSellerOrder(tx, { sellerOrderId, expectedVersion: 2, nextStatus: SellerOrderStatus.READY_FOR_PICKUP, actor: 'ADMIN', note: 'Ready at store' }));
    expect(ready).toMatchObject({ status: 'READY_FOR_PICKUP', version: 3 });

    const pickedUp = await prisma.$transaction((tx) => transitionSellerOrder(tx, { sellerOrderId, expectedVersion: 3, nextStatus: SellerOrderStatus.PICKED_UP, actor: 'ADMIN', note: 'Customer picked up order' }));
    expect(pickedUp).toMatchObject({ status: 'PICKED_UP', version: 4 });
    expect(pickedUp.autoCompleteAt).not.toBeNull();

    const completed = await prisma.$transaction((tx) => transitionSellerOrder(tx, { sellerOrderId, expectedVersion: 4, nextStatus: SellerOrderStatus.COMPLETED, actor: 'ADMIN', note: 'Delivery completed' }));
    expect(completed).toMatchObject({ status: 'COMPLETED', version: 5 });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('COMPLETED');
  });
});

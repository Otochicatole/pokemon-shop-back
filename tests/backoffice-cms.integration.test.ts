import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma, writeCoordinator } from '../src/infrastructure/prisma.js';
import { createAdminCmsApplication, createPrismaAdminCmsRepositories } from '../src/modules/backoffice/index.js';
import { AppError } from '../src/shared/errors.js';

const cms = createAdminCmsApplication(createPrismaAdminCmsRepositories(prisma, writeCoordinator), {
  integrations: { bankTransfer: false, mercadoPago: false, smtp: false },
});
const adminId = randomUUID();
const userId = randomUUID();
const fixtureKey = randomUUID();
let productId = '';
const imageProductId = randomUUID();
const fileId = randomUUID();
const productImageFileIds = [randomUUID(), randomUUID(), randomUUID()];
const actor = { adminId, requestId: `cms-test-${randomUUID()}` };
let orderNumber = '';
let rejectedOrderNumber = '';
const rejectedReceiptFileIds = [randomUUID(), randomUUID()];

describe('backoffice CMS invariants', () => {
  beforeAll(async () => {
    await prisma.admin.create({ data: { id: adminId, email: `cms-${adminId}@example.test`, passwordHash: 'not-used', totpSecretCipher: 'not-used', totpEnabledAt: new Date() } });
    await prisma.user.create({ data: { id: userId, email: `cms-${userId}@example.test`, emailVerifiedAt: new Date() } });
    await prisma.product.create({ data: { id: imageProductId, sku: `CMS-IMAGES-${fixtureKey}`, slug: `cms-images-${fixtureKey}`, name: 'CMS image fixture', description: 'Fixture', kind: 'ACCESSORY', stockMode: 'QUANTITY', priceMinor: 100n } });
  });

  afterAll(async () => {
    await prisma.refundRecord.deleteMany({ where: { createdById: adminId } });
    if (orderNumber) await prisma.order.deleteMany({ where: { number: orderNumber } });
    if (rejectedOrderNumber) await prisma.order.deleteMany({ where: { number: rejectedOrderNumber } });
    await prisma.storedFile.deleteMany({ where: { id: fileId } });
    await prisma.storedFile.deleteMany({ where: { id: { in: rejectedReceiptFileIds } } });
    await prisma.fileCleanupJob.deleteMany({ where: { fileId: { in: productImageFileIds } } });
    await prisma.inventoryAdjustment.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { id: { in: [productId, imageProductId].filter(Boolean) } } });
    await prisma.storedFile.deleteMany({ where: { id: { in: productImageFileIds } } });
    await prisma.auditLog.deleteMany({ where: { actorId: adminId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.admin.deleteMany({ where: { id: adminId } });
  });

  it('uses the product version for every image mutation and schedules retired media cleanup', async () => {
    await prisma.storedFile.createMany({
      data: productImageFileIds.map((id, index) => ({
        id,
        storageKey: `public/products/${id}.webp`,
        mimeType: 'image/webp',
        sizeBytes: index + 1,
        sha256: String(index + 3).repeat(64),
        visibility: 'PUBLIC' as const,
      })),
    });

    const added = await cms.products.addImages(actor, imageProductId, 1, [
      { id: productImageFileIds[0]!, altText: 'Front' },
      { id: productImageFileIds[1]!, altText: 'Back' },
    ]);
    expect(added.version).toBe(2);
    await expect(cms.products.addImages(actor, imageProductId, 1, [{ id: productImageFileIds[2]! }]))
      .rejects.toMatchObject({ code: 'PRODUCT_CHANGED', status: 409 });

    const first = added.images[0]!;
    const second = added.images[1]!;
    await expect(cms.products.updateImage(actor, imageProductId, first.id, 1, 'Stale'))
      .rejects.toMatchObject({ code: 'PRODUCT_CHANGED', status: 409 });
    expect((await cms.products.updateImage(actor, imageProductId, first.id, 2, 'Updated front')).version).toBe(3);
    await expect(cms.products.reorderImages(actor, imageProductId, 2, [second.id, first.id]))
      .rejects.toMatchObject({ code: 'PRODUCT_CHANGED', status: 409 });
    expect((await cms.products.reorderImages(actor, imageProductId, 3, [second.id, first.id])).version).toBe(4);
    await expect(cms.products.retireImage(actor, imageProductId, second.id, 3))
      .rejects.toMatchObject({ code: 'PRODUCT_CHANGED', status: 409 });
    await cms.products.retireImage(actor, imageProductId, second.id, 4);

    expect(await prisma.product.findUniqueOrThrow({ where: { id: imageProductId } })).toEqual(expect.objectContaining({ version: 5 }));
    expect(await prisma.fileCleanupJob.findUnique({ where: { fileId: productImageFileIds[1]! } })).toEqual(expect.objectContaining({ status: 'PENDING' }));
  });

  it('creates draft products, records initial stock and rejects stale edits', async () => {
    const created = await cms.products.create(actor, {
      sku: `CMS-${fixtureKey}`, slug: `cms-${fixtureKey}`, name: 'CMS fixture', description: 'Fixture',
      kind: 'SINGLE_CARD', stockMode: 'UNIQUE', priceMinor: '12500', initialStock: 1,
      pokemonCard: { pokemonType: 'FIRE', setName: 'CMS Set', setCode: 'CMS', cardNumber: '1/1', rarity: 'Rare', language: 'ES', condition: 'NM', finish: 'Holo' },
    });
    productId = created.product.id;
    expect(created.product).toEqual(expect.objectContaining({ status: 'DRAFT', version: 1, inventory: expect.objectContaining({ onHand: 1 }) }));

    const updated = await cms.products.update(actor, created.product.id, {
      expectedVersion: 1,
      priceMinor: '13000',
      pokemonCard: {
        pokemonType: 'FIRE', setName: 'CMS Set', setCode: null, cardNumber: '1/1', rarity: 'Rare',
        language: 'ES', condition: 'NM', finish: null,
      },
    });
    expect(updated.product).toEqual(expect.objectContaining({ version: 2, price: { amountMinor: '13000', currency: 'USD' } }));
    expect(updated.product.pokemonCard).toEqual(expect.objectContaining({ setCode: null, finish: null }));
    await expect(cms.products.update(actor, created.product.id, { expectedVersion: 1, name: 'Stale' })).rejects.toMatchObject({ code: 'PRODUCT_CHANGED', status: 409 });
    await expect(cms.inventory.adjust(actor, created.product.id, 1, 'Would exceed unique stock')).rejects.toMatchObject({ code: 'UNIQUE_STOCK_INVALID', status: 400 });
  });

  it('approves a specific transfer exactly once and consumes its reservation atomically', async () => {
    orderNumber = `BCS-CMS-${Date.now()}`;
    const orderId = randomUUID();
    const paymentId = randomUUID();
    const receiptId = randomUUID();
    await prisma.storedFile.create({ data: { id: fileId, storageKey: `private/receipts/${fileId}.webp`, mimeType: 'image/webp', sizeBytes: 1, sha256: '0'.repeat(64), visibility: 'PRIVATE' } });
    await prisma.order.create({ data: {
      id: orderId, userId, number: orderNumber, paymentMethod: 'BANK_TRANSFER', fulfillmentType: 'PICKUP', subtotalMinor: 13000n, shippingMinor: 0n, totalMinor: 13000n,
      idempotencyKey: randomUUID(), idempotencyHash: 'hash', status: 'PAYMENT_REVIEW',
      items: { create: { productId, sku: `CMS-${fixtureKey}`, productName: 'CMS fixture', productSnapshot: '{}', unitPriceMinor: 13000n, quantity: 1, lineTotalMinor: 13000n } },
      payment: { create: { id: paymentId, method: 'BANK_TRANSFER', status: 'UNDER_REVIEW', amountMinor: 13000n, transfer: { create: { reference: `REF-${orderId}` } } } },
      reservations: { create: { productId, quantity: 1, expiresAt: new Date(Date.now() + 60_000) } },
      transferReceipts: { create: { id: receiptId, fileId } },
      statusHistory: { create: { toStatus: 'PAYMENT_REVIEW' } },
    } });
    await prisma.inventory.update({ where: { productId }, data: { reserved: 1 } });

    const [outOfStock, available] = await Promise.all([
      cms.products.list({ search: `CMS-${fixtureKey}`, stock: 'OUT', limit: 20 }),
      cms.products.list({ search: `CMS-${fixtureKey}`, stock: 'AVAILABLE', limit: 20 }),
    ]);
    expect(outOfStock.data.map((product) => product.id)).toContain(productId);
    expect(available.data.map((product) => product.id)).not.toContain(productId);

    const approved = await cms.payments.reviewTransfer(actor, orderNumber, receiptId, 1, 'APPROVED', 'Bank verified');
    expect(approved).toEqual(expect.objectContaining({ status: 'PAID', version: 2 }));
    const [inventory, order, receipt] = await Promise.all([
      prisma.inventory.findUniqueOrThrow({ where: { productId } }),
      prisma.order.findUniqueOrThrow({ where: { number: orderNumber }, include: { payment: true, reservations: true } }),
      prisma.transferReceipt.findUniqueOrThrow({ where: { id: receiptId } }),
    ]);
    expect(inventory).toEqual(expect.objectContaining({ onHand: 0, reserved: 0 }));
    expect(order.payment?.status).toBe('APPROVED');
    expect(order.reservations[0]?.consumedAt).not.toBeNull();
    expect(receipt.review).toBe('APPROVED');
    await expect(cms.payments.reviewTransfer(actor, orderNumber, receiptId, 1, 'APPROVED')).rejects.toBeInstanceOf(AppError);
  });

  it('rejects every still-pending receipt when rejecting a transfer order', async () => {
    rejectedOrderNumber = `BCS-CMS-REJECT-${Date.now()}`;
    const orderId = randomUUID();
    const selectedReceiptId = randomUUID();
    const supersededReceiptId = randomUUID();
    await prisma.storedFile.createMany({
      data: rejectedReceiptFileIds.map((id, index) => ({
        id,
        storageKey: `private/receipts/${id}.webp`,
        mimeType: 'image/webp',
        sizeBytes: index + 1,
        sha256: String(index + 1).repeat(64),
        visibility: 'PRIVATE' as const,
      })),
    });
    await prisma.order.create({
      data: {
        id: orderId,
        userId,
        number: rejectedOrderNumber,
        paymentMethod: 'BANK_TRANSFER',
        fulfillmentType: 'PICKUP',
        subtotalMinor: 13000n,
        shippingMinor: 0n,
        totalMinor: 13000n,
        idempotencyKey: randomUUID(),
        idempotencyHash: 'reject-hash',
        status: 'PAYMENT_REVIEW',
        payment: {
          create: {
            method: 'BANK_TRANSFER',
            status: 'UNDER_REVIEW',
            amountMinor: 13000n,
            transfer: { create: { reference: `REF-${orderId}` } },
          },
        },
        transferReceipts: {
          create: [
            { id: selectedReceiptId, fileId: rejectedReceiptFileIds[0]! },
            { id: supersededReceiptId, fileId: rejectedReceiptFileIds[1]! },
          ],
        },
        statusHistory: { create: { toStatus: 'PAYMENT_REVIEW' } },
      },
    });

    await cms.payments.reviewTransfer(actor, rejectedOrderNumber, selectedReceiptId, 1, 'REJECTED', 'Receipt does not match');

    const receipts = await prisma.transferReceipt.findMany({ where: { orderId }, orderBy: { id: 'asc' } });
    expect(receipts).toHaveLength(2);
    expect(receipts.every((receipt) => receipt.review === 'REJECTED' && receipt.reviewedById === adminId && receipt.reviewedAt !== null)).toBe(true);
    expect(receipts.find((receipt) => receipt.id === selectedReceiptId)?.note).toBe('Receipt does not match');
    expect(receipts.find((receipt) => receipt.id === supersededReceiptId)?.note).toBe('Superseded by rejected order');
    expect(await prisma.transferReceipt.count({ where: { orderId, review: 'PENDING' } })).toBe(0);
  });

  it('enforces fulfillment transitions and records one full refund without restoring stock', async () => {
    await expect(cms.orders.transition(actor, orderNumber, 2, 'SHIPPED')).rejects.toMatchObject({ code: 'INVALID_ORDER_TRANSITION' });
    await cms.orders.transition(actor, orderNumber, 2, 'PREPARING');
    await expect(cms.orders.transition(actor, orderNumber, 3, 'SHIPPED')).rejects.toMatchObject({ code: 'INVALID_FULFILLMENT_TRANSITION' });
    const refunded = await cms.payments.recordFullRefund(actor, orderNumber, 3, 'External bank refund', `BANK-${randomUUID()}`);
    expect(refunded).toEqual(expect.objectContaining({ amount: { amountMinor: '13000', currency: 'USD' }, status: 'REFUND_RECORDED' }));
    await expect(cms.payments.recordFullRefund(actor, orderNumber, 4, 'Duplicate', `BANK-${randomUUID()}`)).rejects.toMatchObject({ code: 'ORDER_NOT_REFUNDABLE' });
    expect((await prisma.inventory.findUniqueOrThrow({ where: { productId } })).onHand).toBe(0);
    const customer = await cms.customers.get(userId);
    expect(customer.customer.ordersCount).toBeGreaterThanOrEqual(2);
    expect(customer.customer.paidTotal).toEqual({ amountMinor: '13000', currency: 'USD' });
    expect(customer.customer.orders.length).toBeLessThanOrEqual(20);
    expect((await cms.customers.listOrders(userId, undefined, 1)).data).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { actorId: adminId } })).toBeGreaterThanOrEqual(5);
    const dashboard = await cms.dashboard.get('30D');
    expect(dashboard.recentActivity.length).toBeGreaterThan(0);
    expect(dashboard.recentActivity.some((entry) => entry.actorId === adminId)).toBe(true);
  });
});

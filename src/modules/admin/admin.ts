import { Router, type Request } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { currentAdmin, requireAdmin } from '../../infrastructure/sessions.js';
import { writeCoordinator } from '../../infrastructure/prisma.js';
import { conflict, badRequest, notFound } from '../../shared/errors.js';
import { parseMinor } from '../../shared/money.js';
import { saveImage } from '../media/index.js';
import { releaseReservations } from '../orders/index.js';

const productSchema = z.object({
  sku: z.string().trim().min(1).max(80), slug: z.string().regex(/^[a-z0-9-]+$/).max(120), name: z.string().trim().min(1).max(180), description: z.string().max(5000), kind: z.enum(['SINGLE_CARD', 'SEALED_PRODUCT']), stockMode: z.enum(['UNIQUE', 'QUANTITY']), priceMinor: z.string().regex(/^\d+$/), stock: z.number().int().min(0).max(1_000_000), pokemonCard: z.object({ setName: z.string().min(1).max(120), setCode: z.string().max(40).optional(), cardNumber: z.string().min(1).max(30), rarity: z.string().min(1).max(80), language: z.string().min(1).max(40), condition: z.enum(['NM', 'EXCELLENT', 'GOOD', 'PLAYED', 'DAMAGED']), finish: z.string().max(50).optional(), edition: z.string().max(80).optional(), gradingCompany: z.string().max(80).optional(), grade: z.string().max(30).optional(), certificationNumber: z.string().max(100).optional() }).optional(), });
const updateProductSchema = productSchema.partial().omit({ stock: true }).extend({ stock: z.number().int().min(0).max(1_000_000).optional() });
const adjustmentSchema = z.object({ delta: z.number().int().min(-1_000_000).max(1_000_000), reason: z.string().trim().min(3).max(500) });
const refundSchema = z.object({ amountMinor: z.string().regex(/^\d+$/), reason: z.string().trim().min(3).max(500), externalReference: z.string().trim().min(3).max(150) });
const statusSchema = z.object({ status: z.enum(['PREPARING', 'READY_FOR_PICKUP', 'SHIPPED', 'COMPLETED', 'CANCELLED']), note: z.string().max(500).optional() });

const adminActor = (req: Request) => currentAdmin(req)!.admin.id;

async function audit(prisma: PrismaClient, req: Request, action: string, entityType: string, entityId: string, metadata?: unknown) {
  await prisma.auditLog.create({ data: { actorType: 'ADMIN', actorId: adminActor(req), action, entityType, entityId, metadata: metadata ? JSON.stringify(metadata) : undefined, requestId: req.id === undefined ? undefined : String(req.id) } });
}

export function createAdminRouter(prisma: PrismaClient, upload: any): Router {
  const router = Router();
  router.use(requireAdmin);

  router.post('/products', async (req, res) => {
    const input = productSchema.parse(req.body);
    if (input.stockMode === 'UNIQUE' && input.stock > 1) throw badRequest('UNIQUE_STOCK_INVALID', 'Unique products cannot have more than one unit');
    const product = await writeCoordinator.run(() => prisma.product.create({ data: { sku: input.sku.toUpperCase(), slug: input.slug, name: input.name, description: input.description, kind: input.kind, stockMode: input.stockMode, priceMinor: parseMinor(input.priceMinor), inventory: { create: { onHand: input.stock, reserved: 0 } }, ...(input.pokemonCard ? { pokemonCard: { create: input.pokemonCard } } : {}) }, include: { inventory: true, pokemonCard: true } }));
    await audit(prisma, req, 'PRODUCT_CREATED', 'Product', product.id, { sku: product.sku });
    return res.status(201).json({ product: { id: product.id, sku: product.sku, slug: product.slug, version: product.version } });
  });

  router.patch('/products/:id', async (req, res) => {
    const input = updateProductSchema.parse(req.body);
    const existing = await prisma.product.findUnique({ where: { id: req.params.id }, include: { pokemonCard: true, inventory: true } });
    if (!existing) throw notFound('Product not found');
    const product = await writeCoordinator.run(() => prisma.$transaction(async (tx) => {
      const updated = await tx.product.update({ where: { id: existing.id }, data: { ...(input.sku ? { sku: input.sku.toUpperCase() } : {}), ...(input.slug ? { slug: input.slug } : {}), ...(input.name ? { name: input.name } : {}), ...(input.description !== undefined ? { description: input.description } : {}), ...(input.kind ? { kind: input.kind } : {}), ...(input.stockMode ? { stockMode: input.stockMode } : {}), ...(input.priceMinor ? { priceMinor: parseMinor(input.priceMinor) } : {}), version: { increment: 1 } } });
      if (input.pokemonCard) await tx.pokemonCardDetails.upsert({ where: { productId: existing.id }, create: { productId: existing.id, ...input.pokemonCard }, update: input.pokemonCard });
      if (input.stock !== undefined) {
        if (input.stock < (existing.inventory?.reserved ?? 0)) throw conflict('STOCK_BELOW_RESERVED', 'Stock cannot be lower than reserved units');
        if ((input.stockMode ?? existing.stockMode) === 'UNIQUE' && input.stock > 1) throw badRequest('UNIQUE_STOCK_INVALID', 'Unique products cannot have more than one unit');
        await tx.inventory.update({ where: { productId: existing.id }, data: { onHand: input.stock, version: { increment: 1 } } });
      }
      return updated;
    }));
    await audit(prisma, req, 'PRODUCT_UPDATED', 'Product', product.id, { version: product.version });
    return res.json({ product: { id: product.id, sku: product.sku, slug: product.slug, version: product.version } });
  });

  router.post('/products/:id/publish', async (req, res) => {
    const product = await prisma.product.update({ where: { id: req.params.id }, data: { status: 'PUBLISHED', publishedAt: new Date(), archivedAt: null, version: { increment: 1 } } });
    await audit(prisma, req, 'PRODUCT_PUBLISHED', 'Product', product.id);
    return res.json({ published: true });
  });

  router.post('/products/:id/archive', async (req, res) => {
    const product = await prisma.product.update({ where: { id: req.params.id }, data: { status: 'ARCHIVED', archivedAt: new Date(), version: { increment: 1 } } });
    await audit(prisma, req, 'PRODUCT_ARCHIVED', 'Product', product.id);
    return res.json({ archived: true });
  });

  router.post('/products/:id/images', upload.array('images', 8), async (req: Request, res) => {
    const product = await prisma.product.findUnique({ where: { id: String(req.params.id) } });
    if (!product) throw notFound('Product not found');
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) throw badRequest('IMAGES_REQUIRED', 'At least one image is required');
    const created = [] as string[];
    for (const file of files) {
      const stored = await saveImage(prisma, file, 'PUBLIC', 'products');
      try {
        const image = await prisma.productImage.create({ data: { productId: product.id, fileId: stored.id, altText: req.body.altText === undefined ? undefined : String(req.body.altText).slice(0, 255), sortOrder: created.length, createdById: adminActor(req) } });
        created.push(image.id);
      } catch (error) { await prisma.storedFile.delete({ where: { id: stored.id } }).catch(() => undefined); throw error; }
    }
    await audit(prisma, req, 'PRODUCT_IMAGES_ADDED', 'Product', product.id, { count: created.length });
    return res.status(201).json({ imageIds: created });
  });

  router.post('/products/:id/inventory-adjustment', async (req, res) => {
    const input = adjustmentSchema.parse(req.body);
    const product = await prisma.product.findUnique({ where: { id: req.params.id }, include: { inventory: true } });
    if (!product?.inventory) throw notFound('Product not found');
    const updated = await writeCoordinator.run(() => prisma.$transaction(async (tx) => {
      const inventory = await tx.inventory.findUniqueOrThrow({ where: { productId: product.id } });
      const next = inventory.onHand + input.delta;
      if (next < inventory.reserved) throw conflict('STOCK_BELOW_RESERVED', 'Adjustment would consume reserved stock');
      if (product.stockMode === 'UNIQUE' && next > 1) throw badRequest('UNIQUE_STOCK_INVALID', 'Unique products cannot have more than one unit');
      const value = await tx.inventory.update({ where: { productId: product.id }, data: { onHand: next, version: { increment: 1 } } });
      await tx.inventoryAdjustment.create({ data: { productId: product.id, delta: input.delta, reason: input.reason, createdById: adminActor(req) } });
      return value;
    }));
    await audit(prisma, req, 'INVENTORY_ADJUSTED', 'Product', product.id, { delta: input.delta, reason: input.reason });
    return res.json({ onHand: updated.onHand, reserved: updated.reserved });
  });

  router.get('/orders', async (req, res) => {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 20)));
    const orders = await prisma.order.findMany({ orderBy: { createdAt: 'desc' }, take: limit + 1, ...(req.query.cursor ? { skip: 1, cursor: { id: String(req.query.cursor) } } : {}), include: { items: true, payment: { include: { transfer: true, mercadoPago: true } } } });
    const hasMore = orders.length > limit;
    const page = hasMore ? orders.slice(0, limit) : orders;
    return res.json({ data: page.map((order) => ({ id: order.id, number: order.number, status: order.status, total: { amountMinor: order.totalMinor.toString(), currency: order.currency }, payment: order.payment ? { method: order.payment.method, status: order.payment.status } : null, createdAt: order.createdAt })), nextCursor: hasMore ? page.at(-1)?.id ?? null : null });
  });

  router.post('/orders/:number/transfer/approve', async (req, res) => {
    const order = await prisma.order.findFirst({ where: { number: req.params.number, paymentMethod: 'BANK_TRANSFER' }, include: { payment: { include: { transfer: true } } } });
    if (!order?.payment?.transfer) throw notFound('Order not found');
    await writeCoordinator.run(() => prisma.$transaction(async (tx) => {
      const current = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
      if (!['PENDING_PAYMENT', 'PAYMENT_REVIEW'].includes(current.status)) throw conflict('ORDER_NOT_REVIEWABLE', 'Order cannot be approved');
      await tx.payment.update({ where: { orderId: order.id }, data: { status: 'APPROVED' } });
      await tx.bankTransfer.update({ where: { paymentId: order.payment!.id }, data: { reviewStatus: 'APPROVED', reviewedAt: new Date(), reviewedById: adminActor(req) } });
      await tx.order.update({ where: { id: order.id }, data: { status: 'PAID' } });
      await tx.orderStatusHistory.create({ data: { orderId: order.id, fromStatus: current.status, toStatus: 'PAID', changedById: adminActor(req), note: 'Transfer approved' } });
      const reservations = await tx.inventoryReservation.findMany({ where: { orderId: order.id, consumedAt: null, releasedAt: null } });
      for (const reservation of reservations) {
        await tx.inventory.update({ where: { productId: reservation.productId }, data: { onHand: { decrement: reservation.quantity }, reserved: { decrement: reservation.quantity }, version: { increment: 1 } } });
        await tx.inventoryReservation.update({ where: { id: reservation.id }, data: { consumedAt: new Date() } });
      }
    }));
    await audit(prisma, req, 'TRANSFER_APPROVED', 'Order', order.id);
    return res.json({ approved: true });
  });

  router.post('/orders/:number/transfer/reject', async (req, res) => {
    const order = await prisma.order.findFirst({ where: { number: req.params.number, paymentMethod: 'BANK_TRANSFER' }, include: { payment: true } });
    if (!order?.payment) throw notFound('Order not found');
    await writeCoordinator.run(() => prisma.$transaction(async (tx) => {
      const current = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
      if (!['PENDING_PAYMENT', 'PAYMENT_REVIEW'].includes(current.status)) throw conflict('ORDER_NOT_REVIEWABLE', 'Order cannot be rejected');
      await tx.payment.update({ where: { orderId: order.id }, data: { status: 'REJECTED' } });
      await tx.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
      await tx.orderStatusHistory.create({ data: { orderId: order.id, fromStatus: current.status, toStatus: 'CANCELLED', changedById: adminActor(req), note: 'Transfer rejected' } });
      await releaseReservations(tx, order.id);
    }));
    await audit(prisma, req, 'TRANSFER_REJECTED', 'Order', order.id);
    return res.json({ rejected: true });
  });

  router.patch('/orders/:number/status', async (req, res) => {
    const input = statusSchema.parse(req.body);
    const order = await prisma.order.findUnique({ where: { number: req.params.number } });
    if (!order) throw notFound('Order not found');
    await writeCoordinator.run(() => prisma.$transaction(async (tx) => {
      const current = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
      if (current.status === 'CANCELLED' || current.status === 'EXPIRED') throw conflict('ORDER_TERMINAL', 'Order is already terminal');
      await tx.order.update({ where: { id: order.id }, data: { status: input.status } });
      await tx.orderStatusHistory.create({ data: { orderId: order.id, fromStatus: current.status, toStatus: input.status, changedById: adminActor(req), note: input.note ?? null } });
    }));
    await audit(prisma, req, 'ORDER_STATUS_CHANGED', 'Order', order.id, { status: input.status });
    return res.json({ status: input.status });
  });

  router.post('/orders/:number/refund', async (req, res) => {
    const input = refundSchema.parse(req.body);
    const order = await prisma.order.findUnique({ where: { number: req.params.number }, include: { payment: true } });
    if (!order?.payment) throw notFound('Order not found');
    if (!['PAID', 'PREPARING', 'SHIPPED', 'COMPLETED'].includes(order.status)) throw conflict('ORDER_NOT_REFUNDABLE', 'Order is not paid');
    if (parseMinor(input.amountMinor) > order.payment.amountMinor) throw badRequest('REFUND_TOO_LARGE', 'Refund exceeds payment amount');
    const record = await writeCoordinator.run(() => prisma.$transaction(async (tx) => {
      const refund = await tx.refundRecord.create({ data: { paymentId: order.payment!.id, amountMinor: parseMinor(input.amountMinor), reason: input.reason, externalReference: input.externalReference, createdById: adminActor(req) } });
      await tx.payment.update({ where: { id: order.payment!.id }, data: { status: 'REFUNDED' } });
      await tx.order.update({ where: { id: order.id }, data: { status: 'REFUND_RECORDED' } });
      await tx.orderStatusHistory.create({ data: { orderId: order.id, fromStatus: order.status, toStatus: 'REFUND_RECORDED', changedById: adminActor(req), note: 'Manual refund recorded' } });
      return refund;
    }));
    await audit(prisma, req, 'REFUND_RECORDED', 'Order', order.id, { refundId: record.id });
    return res.status(201).json({ refundId: record.id, recorded: true });
  });

  router.post('/shipping-zones', async (req, res) => {
    const input = z.object({ name: z.string().min(1).max(100), provinces: z.array(z.string().min(1).max(100)).min(1), rates: z.array(z.object({ name: z.string().min(1).max(100), priceMinor: z.string().regex(/^\d+$/) })).min(1) }).parse(req.body);
    const zone = await prisma.shippingZone.create({ data: { name: input.name, provinces: { create: input.provinces.map((province) => ({ province })) }, rates: { create: input.rates.map((rate) => ({ name: rate.name, priceMinor: parseMinor(rate.priceMinor), currency: 'ARS' })) } }, include: { provinces: true, rates: true } });
    await audit(prisma, req, 'SHIPPING_ZONE_CREATED', 'ShippingZone', zone.id);
    return res.status(201).json({ zone: { id: zone.id, name: zone.name, provinces: zone.provinces.map((p) => p.province), rates: zone.rates.map((r) => ({ id: r.id, name: r.name, priceMinor: r.priceMinor.toString() })) } });
  });

  router.post('/pickup-points', async (req, res) => {
    const input = z.object({ name: z.string().min(1).max(100), address: z.string().min(1).max(300) }).parse(req.body);
    const point = await prisma.pickupPoint.create({ data: input });
    await audit(prisma, req, 'PICKUP_POINT_CREATED', 'PickupPoint', point.id);
    return res.status(201).json({ pickupPoint: point });
  });

  return router;
}

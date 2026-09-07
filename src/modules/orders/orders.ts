import { Router } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { PaymentStatus, ProductStatus } from '@prisma/client';
import { MercadoPagoConfig, Preference, Payment as MercadoPayment, WebhookSignatureValidator } from 'mercadopago';
import type { Request } from 'express';
import { env } from '../../config/env.js';
import { conflict, badRequest, forbidden, notFound, AppError } from '../../shared/errors.js';
import { currentUser, requireUser } from '../../infrastructure/sessions.js';
import { prisma as db, writeCoordinator } from '../../infrastructure/prisma.js';
import { publicOrderNumber, sha256 } from '../../shared/ids.js';
import { moneyDto } from '../../shared/money.js';
import { saveImage } from '../media/media.js';
import { logger } from '../../infrastructure/logger.js';

const itemSchema = z.object({ productId: z.string().uuid(), quantity: z.number().int().min(1).max(100), productVersion: z.number().int().min(1) });
const fulfillmentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('PICKUP'), pickupPointId: z.string().uuid() }),
  z.object({ type: z.literal('SHIPMENT'), shippingRateId: z.string().uuid(), recipientName: z.string().trim().min(1).max(120), recipientPhone: z.string().trim().min(6).max(40), addressLine1: z.string().trim().min(1).max(180), addressLine2: z.string().trim().max(180).optional(), city: z.string().trim().min(1).max(100), province: z.string().trim().min(1).max(100), postalCode: z.string().trim().min(3).max(20) }),
]);
const checkoutSchema = z.object({ items: z.array(itemSchema).min(1).max(50), fulfillment: fulfillmentSchema, paymentMethod: z.enum(['BANK_TRANSFER', 'MERCADO_PAGO']) });

type CheckoutInput = z.infer<typeof checkoutSchema>;

function canonical(input: CheckoutInput) {
  return JSON.stringify({ ...input, items: [...input.items].sort((a, b) => a.productId.localeCompare(b.productId)) });
}

function mapOrder(order: any) {
  const bankConfigured = Boolean(env.BANK_NAME && env.BANK_ACCOUNT_HOLDER && (env.BANK_CBU || env.BANK_ALIAS));
  return {
    id: order.id,
    number: order.number,
    status: order.status,
    paymentMethod: order.paymentMethod,
    fulfillmentType: order.fulfillmentType,
    totals: { subtotal: moneyDto({ amountMinor: order.subtotalMinor, currency: 'ARS' }), shipping: moneyDto({ amountMinor: order.shippingMinor, currency: 'ARS' }), total: moneyDto({ amountMinor: order.totalMinor, currency: 'ARS' }) },
    expiresAt: order.expiresAt,
    items: order.items?.map((item: any) => ({ productId: item.productId, sku: item.sku, name: item.productName, quantity: item.quantity, unitPrice: moneyDto({ amountMinor: item.unitPriceMinor, currency: 'ARS' }), lineTotal: moneyDto({ amountMinor: item.lineTotalMinor, currency: 'ARS' }) })),
    fulfillment: order.fulfillmentType === 'SHIPMENT' ? { type: 'SHIPMENT', recipientName: order.recipientName, recipientPhone: order.recipientPhone, addressLine1: order.addressLine1, addressLine2: order.addressLine2, city: order.city, province: order.province, postalCode: order.postalCode, shippingRateId: order.shippingRateId } : { type: 'PICKUP', pickupPointId: order.pickupPointId },
    payment: order.payment ? { method: order.payment.method, status: order.payment.status, bankReference: order.payment.transfer?.reference ?? null, bankInstructions: order.payment.method === 'BANK_TRANSFER' && bankConfigured ? { bankName: env.BANK_NAME, accountHolder: env.BANK_ACCOUNT_HOLDER, cbu: env.BANK_CBU ?? null, alias: env.BANK_ALIAS ?? null } : null, receipt: order.transferReceipts?.[0] ? { fileId: order.transferReceipts[0].fileId, review: order.transferReceipts[0].review, createdAt: order.transferReceipts[0].createdAt } : null, checkoutUrl: order.payment.mercadoPago?.checkoutUrl ?? null, paymentSessionStatus: order.payment.mercadoPago && !order.payment.mercadoPago.checkoutUrl ? 'RETRY_REQUIRED' : 'READY' } : null,
    createdAt: order.createdAt,
  };
}

async function calculateCheckout(tx: any, input: CheckoutInput) {
  const products = [] as any[];
  let subtotal = 0n;
  for (const item of input.items) {
    const product = await tx.product.findUnique({ where: { id: item.productId }, include: { pokemonCard: true, inventory: true, images: { orderBy: { sortOrder: 'asc' } } } });
    if (!product || product.status !== ProductStatus.PUBLISHED) throw conflict('PRODUCT_UNAVAILABLE', 'A product is no longer available');
    if (product.version !== item.productVersion) throw conflict('PRODUCT_CHANGED', 'A product changed since it was loaded', { productId: item.productId, currentVersion: product.version });
    const available = (product.inventory?.onHand ?? 0) - (product.inventory?.reserved ?? 0);
    if (available < item.quantity) throw conflict('OUT_OF_STOCK', 'Insufficient stock', { productId: item.productId });
    const line = product.priceMinor * BigInt(item.quantity);
    subtotal += line;
    products.push({ item, product, line });
  }

  let shipping = 0n;
  if (input.fulfillment.type === 'SHIPMENT') {
    const shipment = input.fulfillment;
    const rate = await tx.shippingRate.findUnique({ where: { id: shipment.shippingRateId }, include: { zone: { include: { provinces: true } } } });
    if (!rate || !rate.active || !rate.zone.active || !rate.zone.provinces.some((province: any) => province.province.toLowerCase() === shipment.province.toLowerCase())) throw badRequest('INVALID_SHIPPING_RATE', 'Shipping rate is not valid for this province');
    shipping = rate.priceMinor;
  } else {
    const pickup = await tx.pickupPoint.findUnique({ where: { id: input.fulfillment.pickupPointId } });
    if (!pickup?.active) throw badRequest('INVALID_PICKUP_POINT', 'Pickup point is not available');
  }
  return { products, subtotal, shipping, total: subtotal + shipping };
}

async function createMercadoPreference(order: any) {
  if (!env.MERCADOPAGO_ACCESS_TOKEN) throw new AppError(503, 'PAYMENT_PROVIDER_NOT_CONFIGURED', 'Mercado Pago is not configured');
  const client = new MercadoPagoConfig({ accessToken: env.MERCADOPAGO_ACCESS_TOKEN });
  const preference = new Preference(client);
  const response = await preference.create({ body: {
    items: order.items.map((item: any) => ({ id: item.sku, title: item.productName, quantity: item.quantity, currency_id: 'ARS', unit_price: Number(item.unitPriceMinor) / 100 })),
    external_reference: order.number,
    notification_url: `${env.PUBLIC_API_URL ?? `http://localhost:${env.PORT}`}/api/v1/webhooks/mercado-pago`,
    back_urls: { success: `${env.frontendOrigins[0] ?? 'http://localhost:5173'}/orders/${order.number}`, failure: `${env.frontendOrigins[0] ?? 'http://localhost:5173'}/orders/${order.number}`, pending: `${env.frontendOrigins[0] ?? 'http://localhost:5173'}/orders/${order.number}` },
    auto_return: 'approved',
    expires: true,
    expiration_date_to: order.expiresAt?.toISOString(),
  } as any });
  return { id: response.id, initPoint: response.init_point ?? response.sandbox_init_point };
}

async function reconcileMercadoPayment(externalId: string) {
  if (!env.MERCADOPAGO_ACCESS_TOKEN) return;
  try {
    const client = new MercadoPagoConfig({ accessToken: env.MERCADOPAGO_ACCESS_TOKEN });
    const response: any = await new MercadoPayment(client).get({ id: externalId });
    const externalReference = String(response.external_reference ?? '');
    const payment = await db.payment.findFirst({ where: { order: { number: externalReference, paymentMethod: 'MERCADO_PAGO' } }, include: { order: true, mercadoPago: true } });
    if (!payment) return;
    const expectedMinor = payment.amountMinor;
    const receivedMinor = typeof response.transaction_amount === 'number' ? BigInt(Math.round(response.transaction_amount * 100)) : -1n;
    const valid = response.currency_id === 'ARS' && receivedMinor === expectedMinor && (!env.MERCADOPAGO_COLLECTOR_ID || String(response.collector_id ?? '') === env.MERCADOPAGO_COLLECTOR_ID);
    const providerStatus = String(response.status ?? '');
    const mapped = providerStatus === 'approved' ? 'APPROVED' : providerStatus === 'pending' || providerStatus === 'in_process' || providerStatus === 'authorized' ? 'PENDING' : providerStatus === 'refunded' ? 'REFUNDED' : providerStatus === 'charged_back' || providerStatus === 'in_mediation' ? 'DISPUTED' : 'REJECTED';
    await writeCoordinator.run(() => db.$transaction(async (tx) => {
      await tx.mercadoPagoPayment.update({ where: { paymentId: payment.id }, data: { externalPaymentId: externalId, status: providerStatus, statusDetail: response.status_detail ? String(response.status_detail) : null } });
      const current = await tx.order.findUniqueOrThrow({ where: { id: payment.orderId } });
      if (!valid) {
        await tx.payment.update({ where: { id: payment.id }, data: { status: 'REQUIRES_REVIEW', providerReference: externalId } });
        if (!['PAID', 'COMPLETED', 'REFUND_RECORDED'].includes(current.status)) await tx.order.update({ where: { id: current.id }, data: { status: 'PAYMENT_REQUIRES_REVIEW' } });
        return;
      }
      await tx.payment.update({ where: { id: payment.id }, data: { status: mapped as any, providerReference: externalId } });
      if (mapped === 'APPROVED' && ['PENDING_PAYMENT', 'PAYMENT_REVIEW'].includes(current.status) && current.expiresAt && current.expiresAt > new Date()) {
        await tx.order.update({ where: { id: current.id }, data: { status: 'PAID' } });
        await tx.orderStatusHistory.create({ data: { orderId: current.id, fromStatus: current.status, toStatus: 'PAID', note: 'Mercado Pago approved webhook' } });
        const reservations = await tx.inventoryReservation.findMany({ where: { orderId: current.id, consumedAt: null, releasedAt: null } });
        for (const reservation of reservations) {
          await tx.inventory.update({ where: { productId: reservation.productId }, data: { onHand: { decrement: reservation.quantity }, reserved: { decrement: reservation.quantity }, version: { increment: 1 } } });
          await tx.inventoryReservation.update({ where: { id: reservation.id }, data: { consumedAt: new Date() } });
        }
      } else if (mapped === 'REJECTED' && ['PENDING_PAYMENT', 'PAYMENT_REVIEW'].includes(current.status)) {
        await tx.order.update({ where: { id: current.id }, data: { status: 'CANCELLED' } });
        await releaseReservations(tx, current.id);
      } else if (mapped === 'APPROVED' && current.status === 'EXPIRED') {
        await tx.order.update({ where: { id: current.id }, data: { status: 'PAYMENT_REQUIRES_REVIEW' } });
      }
    }));
  } catch (error) {
    logger.error({ err: error, externalId }, 'Mercado Pago reconciliation failed');
  }
}

export function createOrdersRouter(prisma: PrismaClient, upload: any): Router {
  const router = Router();
  router.get('/checkout/options', async (_req, res) => {
    const [zones, pickupPoints] = await Promise.all([
      prisma.shippingZone.findMany({ where: { active: true }, include: { provinces: true, rates: { where: { active: true }, orderBy: { priceMinor: 'asc' } } }, orderBy: { name: 'asc' } }),
      prisma.pickupPoint.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
    ]);
    const bankConfigured = Boolean(env.BANK_NAME && env.BANK_ACCOUNT_HOLDER && (env.BANK_CBU || env.BANK_ALIAS));
    return res.json({ fulfillment: { shippingZones: zones.map((zone) => ({ id: zone.id, name: zone.name, provinces: zone.provinces.map((province) => province.province), rates: zone.rates.map((rate) => ({ id: rate.id, name: rate.name, price: moneyDto({ amountMinor: rate.priceMinor, currency: 'ARS' }) })) })), pickupPoints: pickupPoints.map((point) => ({ id: point.id, name: point.name, address: point.address })) }, paymentMethods: { BANK_TRANSFER: env.NODE_ENV !== 'production' || bankConfigured, MERCADO_PAGO: Boolean(env.MERCADOPAGO_ACCESS_TOKEN) } });
  });
  router.post('/checkout/preview', requireUser, async (req, res) => {
    const user = currentUser(req)!.user;
    if (!user.emailVerifiedAt) throw forbidden('Verify your email before checkout');
    const input = checkoutSchema.parse(req.body);
    if (env.NODE_ENV === 'production' && input.paymentMethod === 'BANK_TRANSFER' && !(env.BANK_NAME && env.BANK_ACCOUNT_HOLDER && (env.BANK_CBU || env.BANK_ALIAS))) throw new AppError(503, 'PAYMENT_METHOD_NOT_CONFIGURED', 'Bank transfer is not configured');
    if (input.paymentMethod === 'MERCADO_PAGO' && !env.MERCADOPAGO_ACCESS_TOKEN) throw new AppError(503, 'PAYMENT_METHOD_NOT_CONFIGURED', 'Mercado Pago is not configured');
    const quote = await calculateCheckout(prisma, input);
    return res.json({ subtotal: moneyDto({ amountMinor: quote.subtotal, currency: 'ARS' }), shipping: moneyDto({ amountMinor: quote.shipping, currency: 'ARS' }), total: moneyDto({ amountMinor: quote.total, currency: 'ARS' }), expiresAt: new Date(Date.now() + 10 * 60 * 1000) });
  });

  router.post('/orders', requireUser, async (req, res) => {
    const user = currentUser(req)!.user;
    if (!user.emailVerifiedAt) throw forbidden('Verify your email before checkout');
    const input = checkoutSchema.parse(req.body);
    if (env.NODE_ENV === 'production' && input.paymentMethod === 'BANK_TRANSFER' && !(env.BANK_NAME && env.BANK_ACCOUNT_HOLDER && (env.BANK_CBU || env.BANK_ALIAS))) throw new AppError(503, 'PAYMENT_METHOD_NOT_CONFIGURED', 'Bank transfer is not configured');
    if (input.paymentMethod === 'MERCADO_PAGO' && !env.MERCADOPAGO_ACCESS_TOKEN) throw new AppError(503, 'PAYMENT_METHOD_NOT_CONFIGURED', 'Mercado Pago is not configured');
    const key = req.get('idempotency-key');
    if (!key || !/^[A-Za-z0-9._:-]{16,120}$/.test(key)) throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'A valid Idempotency-Key header is required');
    const hash = sha256(canonical(input));
    const result = await writeCoordinator.run(async () => prisma.$transaction(async (tx) => {
      const previous = await tx.order.findUnique({ where: { userId_idempotencyKey: { userId: user.id, idempotencyKey: key } }, include: { items: true, payment: { include: { transfer: true, mercadoPago: true } } } });
      if (previous) {
        if (previous.idempotencyHash !== hash) throw conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used with a different request');
        return { order: previous, reused: true };
      }
      const quote = await calculateCheckout(tx, input);
      const expiresAt = new Date(Date.now() + (input.paymentMethod === 'BANK_TRANSFER' ? 24 * 60 * 60 * 1000 : 30 * 60 * 1000));
      const order = await tx.order.create({ data: {
        userId: user.id, number: publicOrderNumber(), paymentMethod: input.paymentMethod, fulfillmentType: input.fulfillment.type, subtotalMinor: quote.subtotal, shippingMinor: quote.shipping, totalMinor: quote.total, idempotencyKey: key, idempotencyHash: hash, expiresAt,
        ...(input.fulfillment.type === 'SHIPMENT' ? { shippingRateId: input.fulfillment.shippingRateId, recipientName: input.fulfillment.recipientName, recipientPhone: input.fulfillment.recipientPhone, addressLine1: input.fulfillment.addressLine1, addressLine2: input.fulfillment.addressLine2, city: input.fulfillment.city, province: input.fulfillment.province, postalCode: input.fulfillment.postalCode } : { pickupPointId: input.fulfillment.pickupPointId }),
        items: { create: quote.products.map(({ item, product, line }) => ({ productId: product.id, sku: product.sku, productName: product.name, productSnapshot: JSON.stringify({ ...product, priceMinor: product.priceMinor.toString(), inventory: undefined }), unitPriceMinor: product.priceMinor, quantity: item.quantity, lineTotalMinor: line })) },
        payment: { create: { method: input.paymentMethod, amountMinor: quote.total, ...(input.paymentMethod === 'BANK_TRANSFER' ? { transfer: { create: { reference: publicOrderNumber() } } } : { mercadoPago: { create: { expiresAt } } }) } },
        statusHistory: { create: { toStatus: 'PENDING_PAYMENT', note: 'Order created' } },
      }, include: { items: true, payment: { include: { transfer: true, mercadoPago: true } } } });
      for (const { item, product } of quote.products) {
        const inventory = product.inventory!;
        const updated = await tx.inventory.updateMany({ where: { productId: product.id, version: inventory.version, reserved: { lte: inventory.onHand - item.quantity } }, data: { reserved: { increment: item.quantity }, version: { increment: 1 } } });
        if (updated.count !== 1) throw conflict('OUT_OF_STOCK', 'Stock changed while creating the order');
        await tx.inventoryReservation.create({ data: { orderId: order.id, productId: product.id, quantity: item.quantity, expiresAt } });
      }
      return { order, reused: false };
    }));

    let order: any = result.order;
    if (!result.reused && input.paymentMethod === 'MERCADO_PAGO') {
      try {
        const preference = await createMercadoPreference(order);
        await prisma.mercadoPagoPayment.update({ where: { paymentId: order.payment!.id }, data: { preferenceId: preference.id ?? null, checkoutUrl: preference.initPoint ?? null } });
        order = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true, payment: { include: { transfer: true, mercadoPago: true } } } });
      } catch (error) { logger.error({ err: error, orderId: order.id }, 'Mercado Pago preference creation failed'); }
    }
    return res.status(result.reused ? 200 : 201).json({ order: mapOrder(order), reused: result.reused });
  });

  router.get('/orders', requireUser, async (req, res) => {
    const user = currentUser(req)!.user;
    const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 20)));
    const orders = await prisma.order.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: limit + 1, ...(req.query.cursor ? { skip: 1, cursor: { id: String(req.query.cursor) } } : {}), include: { items: true, transferReceipts: { orderBy: { createdAt: 'desc' }, take: 1 }, payment: { include: { transfer: true, mercadoPago: true } } } });
    const hasMore = orders.length > limit;
    const page = hasMore ? orders.slice(0, limit) : orders;
    return res.json({ data: page.map(mapOrder), nextCursor: hasMore ? page.at(-1)?.id ?? null : null });
  });

  router.get('/orders/:number', requireUser, async (req, res) => {
    const user = currentUser(req)!.user;
    const order = await prisma.order.findFirst({ where: { number: String(req.params.number), userId: user.id }, include: { items: true, transferReceipts: { orderBy: { createdAt: 'desc' }, take: 1 }, payment: { include: { transfer: true, mercadoPago: true } } } });
    if (!order) throw notFound('Order not found');
    return res.json({ order: mapOrder(order) });
  });

  router.post('/orders/:number/cancel', requireUser, async (req, res) => {
    const user = currentUser(req)!.user;
    const order = await prisma.order.findFirst({ where: { number: String(req.params.number), userId: user.id } });
    if (!order) throw notFound('Order not found');
    await writeCoordinator.run(() => prisma.$transaction(async (tx) => {
      const current = await tx.order.findUnique({ where: { id: order.id } });
      if (!current || !['PENDING_PAYMENT', 'PAYMENT_REVIEW'].includes(current.status)) throw conflict('ORDER_NOT_CANCELLABLE', 'Order cannot be cancelled');
      await tx.order.update({ where: { id: current.id }, data: { status: 'CANCELLED' } });
      await tx.orderStatusHistory.create({ data: { orderId: current.id, fromStatus: current.status, toStatus: 'CANCELLED', note: 'Cancelled by customer' } });
      await releaseReservations(tx, current.id);
    }));
    return res.status(204).send();
  });

  router.post('/orders/:number/transfer-receipt', requireUser, upload.single('receipt'), async (req: Request, res) => {
    const user = currentUser(req)!.user;
    const order = await prisma.order.findFirst({ where: { number: String(req.params.number), userId: user.id, paymentMethod: 'BANK_TRANSFER' }, include: { payment: true } });
    if (!order || !order.payment) throw notFound('Order not found');
    if (!['PENDING_PAYMENT', 'PAYMENT_REVIEW'].includes(order.status) || !req.file) throw badRequest('INVALID_RECEIPT', 'A valid receipt is required for this order');
    const file = await saveImage(prisma, req.file, 'PRIVATE', 'receipts');
    await prisma.transferReceipt.create({ data: { orderId: order.id, fileId: file.id } });
    await prisma.payment.update({ where: { id: order.payment.id }, data: { status: PaymentStatus.UNDER_REVIEW } });
    await prisma.order.update({ where: { id: order.id }, data: { status: 'PAYMENT_REVIEW' } });
    return res.status(201).json({ accepted: true, fileId: file.id });
  });

  router.post('/webhooks/mercado-pago', async (req, res) => {
    if (!env.MERCADOPAGO_WEBHOOK_SECRET) return res.status(503).json({ error: 'Webhook not configured' });
    try {
      WebhookSignatureValidator.validate({ xSignature: req.get('x-signature'), xRequestId: req.get('x-request-id'), dataId: req.query['data.id'] as string, secret: env.MERCADOPAGO_WEBHOOK_SECRET, toleranceSeconds: 300 });
    } catch { return res.status(401).json({ error: 'Invalid signature' }); }
    const paymentId = String(req.query['data.id'] ?? (req.body as { data?: { id?: string } }).data?.id ?? '');
    if (!paymentId) return res.status(400).json({ error: 'Missing payment id' });
    const existing = await prisma.webhookEvent.findUnique({ where: { provider_externalKey: { provider: 'mercadopago', externalKey: paymentId } } });
    if (!existing) await prisma.webhookEvent.create({ data: { provider: 'mercadopago', externalKey: paymentId, payload: JSON.stringify(req.body) } });
    queueMicrotask(() => { void reconcileMercadoPayment(paymentId); });
    // The event is persisted before acknowledging; reconciliation is intentionally idempotent.
    return res.status(200).json({ received: true });
  });

  return router;
}

async function releaseReservations(tx: any, orderId: string) {
  const reservations = await tx.inventoryReservation.findMany({ where: { orderId, releasedAt: null, consumedAt: null } });
  for (const reservation of reservations) {
    await tx.inventory.update({ where: { productId: reservation.productId }, data: { reserved: { decrement: reservation.quantity }, version: { increment: 1 } } });
    await tx.inventoryReservation.update({ where: { id: reservation.id }, data: { releasedAt: new Date() } });
  }
}

export { mapOrder, releaseReservations };

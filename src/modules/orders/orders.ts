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
import { BASE_CURRENCY } from '../../shared/currency.js';
import { discardUnattachedFile, saveImage } from '../media/index.js';
import { logger } from '../../infrastructure/logger.js';
import { calculateLoyaltyQuote, releaseOrderLoyaltyReservation, reserveLoyaltyPoints, reverseOrderLoyalty, settleOrderLoyalty } from '../loyalty/index.js';
import { createOrderCreatedNotifications, createOrderStatusNotification, createPaymentApprovedNotifications, createPaymentReviewNotifications, createReceiptSubmittedNotifications, publishNotifications } from '../notifications/index.js';
import type { SupportRealtimeHub } from '../support/support-realtime.js';
import { getTransferSettings, mapTransferInstructions, transferSettingsConfigured, type TransferSettingsRecord } from '../payments/index.js';

const itemSchema = z.object({ productId: z.string().uuid(), quantity: z.number().int().min(1).max(100), productVersion: z.number().int().min(1) });
const fulfillmentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('PICKUP'), pickupPointId: z.string().uuid() }),
  z.object({ type: z.literal('SHIPMENT'), shippingRateId: z.string().uuid(), recipientName: z.string().trim().min(1).max(120), recipientPhone: z.string().trim().min(6).max(40), addressLine1: z.string().trim().min(1).max(180), addressLine2: z.string().trim().max(180).optional(), city: z.string().trim().min(1).max(100), province: z.string().trim().min(1).max(100), postalCode: z.string().trim().min(3).max(20) }),
]);
const checkoutSchema = z.object({
  items: z.array(itemSchema).min(1).max(50),
  fulfillment: fulfillmentSchema,
  paymentMethod: z.enum(['BANK_TRANSFER', 'MERCADO_PAGO']),
  pointsToRedeem: z.number().int().min(0).max(2_000_000_000).default(0),
});

type CheckoutInput = z.infer<typeof checkoutSchema>;

function canonical(input: CheckoutInput) {
  return JSON.stringify({ ...input, items: [...input.items].sort((a, b) => a.productId.localeCompare(b.productId)) });
}

function mapOrder(order: any, transferSettings: TransferSettingsRecord) {
  const bankConfigured = transferSettingsConfigured(transferSettings);
  return {
    id: order.id,
    number: order.number,
    version: order.version,
    status: order.status,
    paymentMethod: order.paymentMethod,
    fulfillmentType: order.fulfillmentType,
    totals: { subtotal: moneyDto({ amountMinor: order.subtotalMinor, currency: BASE_CURRENCY }), discount: moneyDto({ amountMinor: order.pointsDiscountMinor, currency: BASE_CURRENCY }), shipping: moneyDto({ amountMinor: order.shippingMinor, currency: BASE_CURRENCY }), total: moneyDto({ amountMinor: order.totalMinor, currency: BASE_CURRENCY }) },
    loyalty: {
      programVersion: order.loyaltyProgramVersion ?? null,
      pointsRedeemed: order.pointsRedeemed,
      pointsDiscount: moneyDto({ amountMinor: order.pointsDiscountMinor, currency: BASE_CURRENCY }),
      pointsEarned: order.pointsEarned,
      redemptionStatus: order.loyaltyRedemptionStatus,
      spendPerPoint: order.loyaltySpendPerPointMinor === null || order.loyaltySpendPerPointMinor === undefined ? null : moneyDto({ amountMinor: order.loyaltySpendPerPointMinor, currency: BASE_CURRENCY }),
      pointValue: order.loyaltyPointValueMinor === null || order.loyaltyPointValueMinor === undefined ? null : moneyDto({ amountMinor: order.loyaltyPointValueMinor, currency: BASE_CURRENCY }),
    },
    expiresAt: order.expiresAt,
    items: order.items?.map((item: any) => ({ productId: item.productId, sku: item.sku, name: item.productName, imageFileId: item.imageFileId ?? null, imageUrl: item.imageFileId ? `/media/public/${item.imageFileId}` : null, quantity: item.quantity, unitPrice: moneyDto({ amountMinor: item.unitPriceMinor, currency: BASE_CURRENCY }), lineTotal: moneyDto({ amountMinor: item.lineTotalMinor, currency: BASE_CURRENCY }) })),
    timeline: Array.isArray(order.statusHistory) ? order.statusHistory.map((event: any) => ({ id: event.id, fromStatus: event.fromStatus ?? null, toStatus: event.toStatus, createdAt: event.createdAt })) : [],
    fulfillment: order.fulfillmentType === 'SHIPMENT' ? { type: 'SHIPMENT', recipientName: order.recipientName, recipientPhone: order.recipientPhone, addressLine1: order.addressLine1, addressLine2: order.addressLine2, city: order.city, province: order.province, postalCode: order.postalCode, shippingRateId: order.shippingRateId, shippingZoneName: order.shippingZoneName ?? null, shippingRateName: order.shippingRateName ?? null, shippingRatePrice: order.shippingRatePriceMinor === null || order.shippingRatePriceMinor === undefined ? null : moneyDto({ amountMinor: order.shippingRatePriceMinor, currency: BASE_CURRENCY }) } : { type: 'PICKUP', pickupPointId: order.pickupPointId, pickupPointName: order.pickupPointName ?? null, pickupPointAddress: order.pickupPointAddress ?? null },
    payment: order.payment ? { method: order.payment.method, status: order.payment.status, bankReference: order.payment.transfer?.reference ?? null, bankInstructions: order.payment.method === 'BANK_TRANSFER' && bankConfigured ? mapTransferInstructions(transferSettings) : null, receipt: order.transferReceipts?.[0] ? { fileId: order.transferReceipts[0].fileId, review: order.transferReceipts[0].review, createdAt: order.transferReceipts[0].createdAt } : null, checkoutUrl: order.payment.mercadoPago?.checkoutUrl ?? null, paymentSessionStatus: order.payment.mercadoPago && !order.payment.mercadoPago.checkoutUrl ? 'RETRY_REQUIRED' : 'READY' } : null,
    createdAt: order.createdAt,
  };
}

async function calculateCheckout(tx: any, input: CheckoutInput, userId: string) {
  const products = [] as any[];
  let subtotal = 0n;
  for (const item of input.items) {
    const product = await tx.product.findUnique({ where: { id: item.productId }, include: { pokemonCard: true, inventory: true, images: { where: { retiredAt: null }, orderBy: { sortOrder: 'asc' } } } });
    if (!product || product.status !== ProductStatus.PUBLISHED) throw conflict('PRODUCT_UNAVAILABLE', 'A product is no longer available');
    if (product.version !== item.productVersion) throw conflict('PRODUCT_CHANGED', 'A product changed since it was loaded', { productId: item.productId, currentVersion: product.version });
    const available = (product.inventory?.onHand ?? 0) - (product.inventory?.reserved ?? 0);
    if (available < item.quantity) throw conflict('OUT_OF_STOCK', 'Insufficient stock', { productId: item.productId });
    const line = product.priceMinor * BigInt(item.quantity);
    subtotal += line;
    products.push({ item, product, line });
  }

  let shipping = 0n;
  let fulfillmentSnapshot: { shippingZoneName?: string; shippingRateName?: string; shippingRatePriceMinor?: bigint; pickupPointName?: string; pickupPointAddress?: string } = {};
  if (input.fulfillment.type === 'SHIPMENT') {
    const shipment = input.fulfillment;
    const rate = await tx.shippingRate.findUnique({ where: { id: shipment.shippingRateId }, include: { zone: { include: { provinces: true } } } });
    if (!rate || !rate.active || !rate.zone.active || !rate.zone.provinces.some((province: any) => province.province.toLowerCase() === shipment.province.toLowerCase())) throw badRequest('INVALID_SHIPPING_RATE', 'Shipping rate is not valid for this province');
    shipping = rate.priceMinor;
    fulfillmentSnapshot = { shippingZoneName: rate.zone.name, shippingRateName: rate.name, shippingRatePriceMinor: rate.priceMinor };
  } else {
    const pickup = await tx.pickupPoint.findUnique({ where: { id: input.fulfillment.pickupPointId } });
    if (!pickup?.active) throw badRequest('INVALID_PICKUP_POINT', 'Pickup point is not available');
    fulfillmentSnapshot = { pickupPointName: pickup.name, pickupPointAddress: pickup.address };
  }
  const loyalty = await calculateLoyaltyQuote(tx, userId, subtotal, input.pointsToRedeem);
  return { products, subtotal, shipping, discount: loyalty.discountMinor, total: subtotal + shipping - loyalty.discountMinor, fulfillmentSnapshot, loyalty };
}

async function createMercadoPreference(order: any) {
  if (!env.MERCADOPAGO_ACCESS_TOKEN) throw new AppError(503, 'PAYMENT_PROVIDER_NOT_CONFIGURED', 'Mercado Pago is not configured');
  const client = new MercadoPagoConfig({ accessToken: env.MERCADOPAGO_ACCESS_TOKEN });
  const preference = new Preference(client);
  const response = await preference.create({ body: {
    items: [{ id: order.number, title: `Compra ${order.number}`, quantity: 1, currency_id: BASE_CURRENCY, unit_price: Number(order.totalMinor) / 100 }],
    external_reference: order.number,
    notification_url: `${env.PUBLIC_API_URL ?? `http://localhost:${env.PORT}`}/api/v2/webhooks/mercado-pago`,
    back_urls: { success: `${env.frontendOrigins[0] ?? 'http://localhost:5173'}/account/orders/${order.number}`, failure: `${env.frontendOrigins[0] ?? 'http://localhost:5173'}/account/orders/${order.number}`, pending: `${env.frontendOrigins[0] ?? 'http://localhost:5173'}/account/orders/${order.number}` },
    auto_return: 'approved',
    expires: true,
    expiration_date_to: order.expiresAt?.toISOString(),
  } as any });
  return { id: response.id, initPoint: response.init_point ?? response.sandbox_init_point };
}

function mercadoPagoUsdUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : JSON.stringify(error);
  return /(currency_id|currency|usd).*(unsupported|not supported|invalid|not available|not allowed)|(unsupported|not supported|invalid|not available|not allowed).*(currency_id|currency|usd)/i.test(message);
}

export async function reconcileMercadoPayment(externalId: string, realtime?: SupportRealtimeHub) {
  if (!env.MERCADOPAGO_ACCESS_TOKEN) return;
  try {
    const client = new MercadoPagoConfig({ accessToken: env.MERCADOPAGO_ACCESS_TOKEN });
    const response: any = await new MercadoPayment(client).get({ id: externalId });
    const externalReference = String(response.external_reference ?? '');
    const payment = await db.payment.findFirst({ where: { order: { number: externalReference, paymentMethod: 'MERCADO_PAGO' } }, include: { order: true, mercadoPago: true } });
    if (!payment) return;
    const expectedMinor = payment.amountMinor;
    const receivedMinor = typeof response.transaction_amount === 'number' ? BigInt(Math.round(response.transaction_amount * 100)) : -1n;
    const valid = response.currency_id === BASE_CURRENCY && receivedMinor === expectedMinor && (!env.MERCADOPAGO_COLLECTOR_ID || String(response.collector_id ?? '') === env.MERCADOPAGO_COLLECTOR_ID);
    const providerStatus = String(response.status ?? '');
    const mapped = providerStatus === 'approved' ? 'APPROVED' : providerStatus === 'pending' || providerStatus === 'in_process' || providerStatus === 'authorized' ? 'PENDING' : providerStatus === 'refunded' ? 'REFUNDED' : providerStatus === 'charged_back' || providerStatus === 'in_mediation' ? 'DISPUTED' : 'REJECTED';
    const notificationIds = await writeCoordinator.run(() => db.$transaction(async (tx) => {
      const createdIds: string[] = [];
      await tx.mercadoPagoPayment.update({ where: { paymentId: payment.id }, data: { externalPaymentId: externalId, status: providerStatus, statusDetail: response.status_detail ? String(response.status_detail) : null } });
      const current = await tx.order.findUniqueOrThrow({ where: { id: payment.orderId } });
      if (!valid) {
        await tx.payment.update({ where: { id: payment.id }, data: { status: 'REQUIRES_REVIEW', providerReference: externalId } });
        if (!['PAID', 'COMPLETED', 'REFUND_RECORDED', 'PAYMENT_REQUIRES_REVIEW'].includes(current.status)) {
          await tx.order.update({ where: { id: current.id }, data: { status: 'PAYMENT_REQUIRES_REVIEW', version: { increment: 1 } } });
          const history = await tx.orderStatusHistory.create({ data: { orderId: current.id, fromStatus: current.status, toStatus: 'PAYMENT_REQUIRES_REVIEW', note: 'Mercado Pago validation failed' } });
          createdIds.push((await createOrderStatusNotification(tx, current, history)).id);
          createdIds.push(...(await createPaymentReviewNotifications(tx, current, history.id)).map((row) => row.id));
        }
        return createdIds;
      }
      await tx.payment.update({ where: { id: payment.id }, data: { status: mapped as any, providerReference: externalId } });
      if (mapped === 'APPROVED' && ['PENDING_PAYMENT', 'PAYMENT_REVIEW'].includes(current.status) && current.expiresAt && current.expiresAt > new Date()) {
        await tx.order.update({ where: { id: current.id }, data: { status: 'PAID', version: { increment: 1 } } });
        const history = await tx.orderStatusHistory.create({ data: { orderId: current.id, fromStatus: current.status, toStatus: 'PAID', note: 'Mercado Pago approved webhook' } });
        createdIds.push((await createOrderStatusNotification(tx, current, history)).id);
        createdIds.push(...(await createPaymentApprovedNotifications(tx, current, history.id)).map((row) => row.id));
        const reservations = await tx.inventoryReservation.findMany({ where: { orderId: current.id, consumedAt: null, releasedAt: null } });
        for (const reservation of reservations) {
          await tx.inventory.update({ where: { productId: reservation.productId }, data: { onHand: { decrement: reservation.quantity }, reserved: { decrement: reservation.quantity }, version: { increment: 1 } } });
          await tx.inventoryReservation.update({ where: { id: reservation.id }, data: { consumedAt: new Date() } });
        }
        await settleOrderLoyalty(tx, current.id);
      } else if (mapped === 'REJECTED' && ['PENDING_PAYMENT', 'PAYMENT_REVIEW'].includes(current.status)) {
        await tx.order.update({ where: { id: current.id }, data: { status: 'CANCELLED', version: { increment: 1 } } });
        const history = await tx.orderStatusHistory.create({ data: { orderId: current.id, fromStatus: current.status, toStatus: 'CANCELLED', note: 'Mercado Pago rejected webhook' } });
        createdIds.push((await createOrderStatusNotification(tx, current, history)).id);
        await releaseReservations(tx, current.id);
        await releaseOrderLoyaltyReservation(tx, current.id);
      } else if (mapped === 'REFUNDED') {
        await releaseReservations(tx, current.id);
        await releaseOrderLoyaltyReservation(tx, current.id);
        if (current.status !== 'REFUND_RECORDED') {
          await tx.order.update({ where: { id: current.id }, data: { status: 'REFUND_RECORDED', version: { increment: 1 } } });
          const history = await tx.orderStatusHistory.create({ data: { orderId: current.id, fromStatus: current.status, toStatus: 'REFUND_RECORDED', note: 'Mercado Pago refunded webhook' } });
          createdIds.push((await createOrderStatusNotification(tx, current, history)).id);
        }
        await reverseOrderLoyalty(tx, current.id);
      } else if (mapped === 'APPROVED' && current.status === 'EXPIRED') {
        await tx.order.update({ where: { id: current.id }, data: { status: 'PAYMENT_REQUIRES_REVIEW', version: { increment: 1 } } });
        const history = await tx.orderStatusHistory.create({ data: { orderId: current.id, fromStatus: current.status, toStatus: 'PAYMENT_REQUIRES_REVIEW', note: 'Mercado Pago approved after expiration' } });
        createdIds.push((await createOrderStatusNotification(tx, current, history)).id);
        createdIds.push(...(await createPaymentReviewNotifications(tx, current, history.id)).map((row) => row.id));
      }
      return createdIds;
    }));
    if (realtime && notificationIds.length) await publishNotifications(db, realtime, notificationIds);
  } catch (error) {
    logger.error({ err: error, externalId }, 'Mercado Pago reconciliation failed');
  }
}

export function createOrdersRouter(prisma: PrismaClient, upload: any, realtime?: SupportRealtimeHub): Router {
  const router = Router();
  router.get('/checkout/options', async (_req, res) => {
    const [zones, pickupPoints] = await Promise.all([
      prisma.shippingZone.findMany({ where: { active: true }, include: { provinces: true, rates: { where: { active: true }, orderBy: { priceMinor: 'asc' } } }, orderBy: { name: 'asc' } }),
      prisma.pickupPoint.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
    ]);
    const transferSettings = await getTransferSettings(prisma);
    return res.json({ fulfillment: { shippingZones: zones.map((zone) => ({ id: zone.id, name: zone.name, provinces: zone.provinces.map((province) => province.province), rates: zone.rates.map((rate) => ({ id: rate.id, name: rate.name, price: moneyDto({ amountMinor: rate.priceMinor, currency: BASE_CURRENCY }) })) })), pickupPoints: pickupPoints.map((point) => ({ id: point.id, name: point.name, address: point.address })) }, paymentMethods: { BANK_TRANSFER: transferSettingsConfigured(transferSettings), MERCADO_PAGO: Boolean(env.MERCADOPAGO_ACCESS_TOKEN) } });
  });
  router.post('/checkout/preview', requireUser, async (req, res) => {
    const user = currentUser(req)!.user;
    if (!user.emailVerifiedAt) throw forbidden('Verify your email before checkout');
    const input = checkoutSchema.parse(req.body);
    const transferSettings = await getTransferSettings(prisma);
    if (input.paymentMethod === 'BANK_TRANSFER' && !transferSettingsConfigured(transferSettings)) throw new AppError(503, 'PAYMENT_METHOD_NOT_CONFIGURED', 'Bank transfer is not configured');
    if (input.paymentMethod === 'MERCADO_PAGO' && !env.MERCADOPAGO_ACCESS_TOKEN) throw new AppError(503, 'PAYMENT_METHOD_NOT_CONFIGURED', 'Mercado Pago is not configured');
    const quote = await calculateCheckout(prisma, input, user.id);
    return res.json({
      subtotal: moneyDto({ amountMinor: quote.subtotal, currency: BASE_CURRENCY }),
      discount: moneyDto({ amountMinor: quote.discount, currency: BASE_CURRENCY }),
      shipping: moneyDto({ amountMinor: quote.shipping, currency: BASE_CURRENCY }),
      total: moneyDto({ amountMinor: quote.total, currency: BASE_CURRENCY }),
      loyalty: {
        enabled: quote.loyalty.program.enabled,
        balance: quote.loyalty.balance,
        reserved: quote.loyalty.reserved,
        available: quote.loyalty.available,
        pointsRedeemed: quote.loyalty.pointsRedeemed,
        maximumRedeemablePoints: quote.loyalty.maximumRedeemablePoints,
        minimumRedemptionPoints: quote.loyalty.program.minimumRedemptionPoints,
        pointsToEarn: quote.loyalty.pointsToEarn,
        pointValue: moneyDto({ amountMinor: quote.loyalty.program.pointValueMinor, currency: BASE_CURRENCY }),
      },
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
  });

  router.post('/orders', requireUser, async (req, res) => {
    const user = currentUser(req)!.user;
    if (!user.emailVerifiedAt) throw forbidden('Verify your email before checkout');
    const input = checkoutSchema.parse(req.body);
    const transferSettings = await getTransferSettings(prisma);
    if (input.paymentMethod === 'BANK_TRANSFER' && !transferSettingsConfigured(transferSettings)) throw new AppError(503, 'PAYMENT_METHOD_NOT_CONFIGURED', 'Bank transfer is not configured');
    if (input.paymentMethod === 'MERCADO_PAGO' && !env.MERCADOPAGO_ACCESS_TOKEN) throw new AppError(503, 'PAYMENT_METHOD_NOT_CONFIGURED', 'Mercado Pago is not configured');
    const key = req.get('idempotency-key');
    if (!key || !/^[A-Za-z0-9._:-]{16,120}$/.test(key)) throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'A valid Idempotency-Key header is required');
    const hash = sha256(canonical(input));
    const result = await writeCoordinator.run(async () => prisma.$transaction(async (tx) => {
      const currentTransferSettings = await getTransferSettings(tx);
      const previous = await tx.order.findUnique({ where: { userId_idempotencyKey: { userId: user.id, idempotencyKey: key } }, include: { items: true, payment: { include: { transfer: true, mercadoPago: true } } } });
      if (previous) {
        if (previous.idempotencyHash !== hash) throw conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used with a different request');
        return { order: previous, reused: true, notificationIds: [] as string[], transferSettings: currentTransferSettings };
      }
      if (input.paymentMethod === 'BANK_TRANSFER' && !transferSettingsConfigured(currentTransferSettings)) throw new AppError(503, 'PAYMENT_METHOD_NOT_CONFIGURED', 'Bank transfer is not configured');
      const quote = await calculateCheckout(tx, input, user.id);
      const expiresAt = new Date(Date.now() + (input.paymentMethod === 'BANK_TRANSFER' ? 24 * 60 * 60 * 1000 : 30 * 60 * 1000));
      const order = await tx.order.create({ data: {
        userId: user.id, number: publicOrderNumber(), paymentMethod: input.paymentMethod, fulfillmentType: input.fulfillment.type, currency: BASE_CURRENCY, subtotalMinor: quote.subtotal, shippingMinor: quote.shipping, totalMinor: quote.total, idempotencyKey: key, idempotencyHash: hash, expiresAt,
        loyaltyProgramVersion: quote.loyalty.program.version,
        loyaltySpendPerPointMinor: quote.loyalty.program.spendPerPointMinor,
        loyaltyPointValueMinor: quote.loyalty.program.pointValueMinor,
        pointsRedeemed: quote.loyalty.pointsRedeemed,
        pointsDiscountMinor: quote.loyalty.discountMinor,
        pointsEarned: quote.loyalty.pointsToEarn,
        loyaltyRedemptionStatus: quote.loyalty.pointsRedeemed > 0 ? 'RESERVED' : 'NONE',
        ...quote.fulfillmentSnapshot,
        ...(input.fulfillment.type === 'SHIPMENT' ? { shippingRateId: input.fulfillment.shippingRateId, recipientName: input.fulfillment.recipientName, recipientPhone: input.fulfillment.recipientPhone, addressLine1: input.fulfillment.addressLine1, addressLine2: input.fulfillment.addressLine2, city: input.fulfillment.city, province: input.fulfillment.province, postalCode: input.fulfillment.postalCode } : { pickupPointId: input.fulfillment.pickupPointId }),
        items: { create: quote.products.map(({ item, product, line }) => ({ productId: product.id, sku: product.sku, productName: product.name, productSnapshot: JSON.stringify({ ...product, priceMinor: product.priceMinor.toString(), inventory: undefined }), imageFileId: product.images[0]?.fileId ?? null, unitPriceMinor: product.priceMinor, quantity: item.quantity, lineTotalMinor: line })) },
        payment: { create: { method: input.paymentMethod, amountMinor: quote.total, currency: BASE_CURRENCY, ...(input.paymentMethod === 'BANK_TRANSFER' ? { transfer: { create: { reference: publicOrderNumber() } } } : { mercadoPago: { create: { expiresAt } } }) } },
        statusHistory: { create: { toStatus: 'PENDING_PAYMENT', note: 'Order created' } },
      }, include: { items: true, payment: { include: { transfer: true, mercadoPago: true } } } });
      await reserveLoyaltyPoints(tx, user.id, quote.loyalty.pointsRedeemed);
      for (const { item, product } of quote.products) {
        const inventory = product.inventory!;
        const updated = await tx.inventory.updateMany({ where: { productId: product.id, version: inventory.version, reserved: { lte: inventory.onHand - item.quantity } }, data: { reserved: { increment: item.quantity }, version: { increment: 1 } } });
        if (updated.count !== 1) throw conflict('OUT_OF_STOCK', 'Stock changed while creating the order');
        await tx.inventoryReservation.create({ data: { orderId: order.id, productId: product.id, quantity: item.quantity, expiresAt } });
      }
      const adminNotifications = await createOrderCreatedNotifications(tx, order);
      return { order, reused: false, notificationIds: adminNotifications.map((row) => row.id), transferSettings: currentTransferSettings };
    }));

    if (!result.reused && realtime && result.notificationIds.length) await publishNotifications(prisma, realtime, result.notificationIds);

    let order: any = result.order;
    if (!result.reused && input.paymentMethod === 'MERCADO_PAGO') {
      try {
        const preference = await createMercadoPreference(order);
        await prisma.mercadoPagoPayment.update({ where: { paymentId: order.payment!.id }, data: { preferenceId: preference.id ?? null, checkoutUrl: preference.initPoint ?? null } });
        order = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true, payment: { include: { transfer: true, mercadoPago: true } } } });
      } catch (error) {
        logger.error({ err: error, orderId: order.id }, 'Mercado Pago preference creation failed');
        if (mercadoPagoUsdUnsupported(error)) throw new AppError(503, 'MERCADOPAGO_USD_UNSUPPORTED', 'Mercado Pago no admite pagos en USD para esta cuenta');
      }
    }
    return res.status(result.reused ? 200 : 201).json({ order: mapOrder(order, result.transferSettings), reused: result.reused });
  });

  router.get('/orders', requireUser, async (req, res) => {
    const user = currentUser(req)!.user;
    const transferSettings = await getTransferSettings(prisma);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 20)));
    const orders = await prisma.order.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: limit + 1, ...(req.query.cursor ? { skip: 1, cursor: { id: String(req.query.cursor) } } : {}), include: { items: true, transferReceipts: { orderBy: { createdAt: 'desc' }, take: 1 }, payment: { include: { transfer: true, mercadoPago: true } } } });
    const hasMore = orders.length > limit;
    const page = hasMore ? orders.slice(0, limit) : orders;
    return res.json({ data: page.map((order) => mapOrder(order, transferSettings)), nextCursor: hasMore ? page.at(-1)?.id ?? null : null });
  });

  router.get('/orders/:number', requireUser, async (req, res) => {
    const user = currentUser(req)!.user;
    const transferSettings = await getTransferSettings(prisma);
    const order = await prisma.order.findFirst({ where: { number: String(req.params.number), userId: user.id }, include: { items: true, statusHistory: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }, transferReceipts: { orderBy: { createdAt: 'desc' }, take: 1 }, payment: { include: { transfer: true, mercadoPago: true } } } });
    if (!order) throw notFound('Order not found');
    return res.json({ order: mapOrder(order, transferSettings) });
  });

  router.post('/orders/:number/cancel', requireUser, async (req, res) => {
    const user = currentUser(req)!.user;
    const order = await prisma.order.findFirst({ where: { number: String(req.params.number), userId: user.id } });
    if (!order) throw notFound('Order not found');
    const notificationIds = await writeCoordinator.run(() => prisma.$transaction(async (tx) => {
      const current = await tx.order.findUnique({ where: { id: order.id } });
      if (!current || !['PENDING_PAYMENT', 'PAYMENT_REVIEW'].includes(current.status)) throw conflict('ORDER_NOT_CANCELLABLE', 'Order cannot be cancelled');
      await tx.order.update({ where: { id: current.id }, data: { status: 'CANCELLED', version: { increment: 1 } } });
      const history = await tx.orderStatusHistory.create({ data: { orderId: current.id, fromStatus: current.status, toStatus: 'CANCELLED', note: 'Cancelled by customer' } });
      await releaseReservations(tx, current.id);
      await releaseOrderLoyaltyReservation(tx, current.id);
      return [(await createOrderStatusNotification(tx, current, history)).id];
    }));
    if (realtime && notificationIds.length) await publishNotifications(prisma, realtime, notificationIds);
    return res.status(204).send();
  });

  router.post('/orders/:number/transfer-receipt', requireUser, upload.single('receipt'), async (req: Request, res) => {
    const user = currentUser(req)!.user;
    const order = await prisma.order.findFirst({ where: { number: String(req.params.number), userId: user.id, paymentMethod: 'BANK_TRANSFER' }, include: { payment: true } });
    if (!order || !order.payment) throw notFound('Order not found');
    if (!['PENDING_PAYMENT', 'PAYMENT_REVIEW'].includes(order.status) || !req.file) throw badRequest('INVALID_RECEIPT', 'A valid receipt is required for this order');
    const file = await saveImage(prisma, req.file, 'PRIVATE', 'receipts');
    try {
      const transactionResult = await writeCoordinator.run(() => prisma.$transaction(async (tx) => {
        const current = await tx.order.findUnique({ where: { id: order.id }, include: { payment: true } });
        if (!current?.payment || !['PENDING_PAYMENT', 'PAYMENT_REVIEW'].includes(current.status)) {
          throw conflict('ORDER_NOT_RECEIPT_ELIGIBLE', 'Order no longer accepts transfer receipts');
        }
        const receipt = await tx.transferReceipt.create({ data: { orderId: current.id, fileId: file.id } });
        await tx.payment.update({ where: { id: current.payment.id }, data: { status: PaymentStatus.UNDER_REVIEW } });
        const notificationIds = (await createReceiptSubmittedNotifications(tx, current, receipt.id)).map((row) => row.id);
        const statusNotificationIds: string[] = [];
        if (current.status !== 'PAYMENT_REVIEW') {
          await tx.order.update({ where: { id: current.id }, data: { status: 'PAYMENT_REVIEW', version: { increment: 1 } } });
          const history = await tx.orderStatusHistory.create({ data: { orderId: current.id, fromStatus: current.status, toStatus: 'PAYMENT_REVIEW', note: 'Transfer receipt submitted' } });
          statusNotificationIds.push((await createOrderStatusNotification(tx, current, history)).id);
        }
        return [...notificationIds, ...statusNotificationIds];
      }));
      if (realtime && transactionResult.length) await publishNotifications(prisma, realtime, transactionResult);
    } catch (error) {
      await discardUnattachedFile(prisma, file.id).catch(() => false);
      throw error;
    }
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
    queueMicrotask(() => { void reconcileMercadoPayment(paymentId, realtime); });
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

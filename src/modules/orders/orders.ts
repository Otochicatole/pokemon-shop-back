import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { NotificationType, OrderStatus, PaymentStatus, ProductStatus } from '@prisma/client';
import type { Request } from 'express';
import { env } from '../../config/env.js';
import { conflict, badRequest, forbidden, notFound, AppError } from '../../shared/errors.js';
import { currentUser, requireUser } from '../../infrastructure/sessions.js';
import { prisma as db, writeCoordinator } from '../../infrastructure/prisma.js';
import { rateLimit } from '../../infrastructure/rate-limit.js';
import { publicOrderNumber, sha256 } from '../../shared/ids.js';
import { moneyDto } from '../../shared/money.js';
import { BASE_CURRENCY } from '../../shared/currency.js';
import { discardUnattachedFile, saveImage } from '../media/index.js';
import { logger } from '../../infrastructure/logger.js';
import { calculateLoyaltyQuote, releaseOrderLoyaltyReservation, reserveLoyaltyPoints, reverseOrderLoyalty, settleOrderLoyalty } from '../loyalty/index.js';
import { createAdminNotifications, createOrderCreatedNotifications, createOrderStatusNotification, createPaymentApprovedNotifications, createPaymentReviewNotifications, createReceiptSubmittedNotifications, createSellerOrderAdminNotifications, createSellerOrderStatusNotification, publishNotifications } from '../notifications/index.js';
import type { SupportRealtimeHub } from '../support/support-realtime.js';
import { buildMercadoPagoCheckoutOrder, createMercadoPagoGateway, DOLARAPI_SOURCE, formatRate, getDolarBlueVenta, getTransferSettings, providerAmountToMinor, usdMinorToArsMinor, mapTransferInstructions, transferSettingsConfigured, type ExchangeRateQuote, type MercadoPagoGateway, type TransferSettingsRecord } from '../payments/index.js';
import { closeAndReverseAffiliateSellerOrdersOnParentRefund, closeUnpaidSellerOrders, createBuyerIssue, reconcileParentOrder, sellerOrderAllowedActions, transitionSellerOrder } from '../affiliates/affiliate-marketplace-service.js';

const itemSchema = z.object({ productId: z.string().uuid(), quantity: z.number().int().min(1).max(100), productVersion: z.number().int().min(1) });
const fulfillmentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('PICKUP'), pickupPointId: z.string().uuid() }),
  z.object({ type: z.literal('SHIPMENT'), shippingRateId: z.string().uuid(), recipientName: z.string().trim().min(1).max(120), recipientPhone: z.string().trim().min(6).max(40), addressLine1: z.string().trim().min(1).max(180), addressLine2: z.string().trim().max(180).optional(), city: z.string().trim().min(1).max(100), province: z.string().trim().min(1).max(100), postalCode: z.string().trim().min(3).max(20) }),
]);
const checkoutSchema = z.object({
  items: z.array(itemSchema).min(1).max(50),
  fulfillment: fulfillmentSchema,
  sellerFulfillments: z.array(z.object({ sellerKey: z.string().min(1).max(80), fulfillment: fulfillmentSchema })).max(20).optional(),
  paymentMethod: z.enum(['BANK_TRANSFER', 'MERCADO_PAGO']),
  pointsToRedeem: z.number().int().min(0).max(2_000_000_000).default(0),
  rateSnapshotId: z.string().uuid().optional(),
});
const mercadoPagoWebhookSchema = z.object({
  id: z.union([z.string().min(1), z.number().int().positive()]),
  type: z.enum(['order', 'payment']),
  action: z.string().min(1).max(100).optional(),
  data: z.object({ id: z.union([z.string().min(1), z.number().int().positive()]) }),
});

type CheckoutInput = z.infer<typeof checkoutSchema>;

type SellerGroup = {
  key: string;
  sellerType: 'STORE' | 'AFFILIATE';
  affiliateId: string | null;
  sellerName: string;
  products: any[];
  subtotal: bigint;
  shipping: bigint;
  commissionBps: number;
  commission: bigint;
  sellerNet: bigint;
  fulfillment: any;
  snapshot: Record<string, unknown>;
};

function canonical(input: CheckoutInput) {
  return JSON.stringify({ ...input, items: [...input.items].sort((a, b) => a.productId.localeCompare(b.productId)) });
}

function mapBuyerSellerOrder(sellerOrder: any, paymentStatus: string | undefined) {
  const paymentCredited = ['APPROVED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(paymentStatus ?? '');
  return {
    id: sellerOrder.id,
    number: sellerOrder.number,
    sellerType: sellerOrder.sellerType,
    affiliateId: sellerOrder.affiliateId,
    sellerName: sellerOrder.sellerName,
    ...(paymentCredited ? { sellerContactPhone: sellerOrder.sellerContactPhone } : {}),
    status: sellerOrder.status,
    version: sellerOrder.version,
    allowedActions: sellerOrderAllowedActions(sellerOrder, 'BUYER'),
    subtotal: moneyDto({ amountMinor: sellerOrder.subtotalMinor, currency: BASE_CURRENCY }),
    shipping: moneyDto({ amountMinor: sellerOrder.shippingMinor, currency: BASE_CURRENCY }),
    commission: moneyDto({ amountMinor: sellerOrder.commissionMinor, currency: BASE_CURRENCY }),
    sellerNet: moneyDto({ amountMinor: sellerOrder.sellerNetMinor, currency: BASE_CURRENCY }),
    fulfillmentType: sellerOrder.fulfillmentType,
    fulfillment: !paymentCredited ? { type: sellerOrder.fulfillmentType, hidden: true } : sellerOrder.fulfillmentType === 'SHIPMENT' ? { type: 'SHIPMENT', recipientName: sellerOrder.recipientName, recipientPhone: sellerOrder.recipientPhone, addressLine1: sellerOrder.addressLine1, addressLine2: sellerOrder.addressLine2, city: sellerOrder.city, province: sellerOrder.province, postalCode: sellerOrder.postalCode, shippingRateName: sellerOrder.shippingRateName, shippingZoneName: sellerOrder.shippingZoneName } : { type: 'PICKUP', pickupPointName: sellerOrder.pickupPointName, pickupPointAddress: sellerOrder.pickupPointAddress },
    carrier: sellerOrder.carrier,
    trackingCode: sellerOrder.trackingCode,
    items: sellerOrder.items?.map((item: any) => ({ productId: item.productId, name: item.productName, quantity: item.quantity, unitPrice: moneyDto({ amountMinor: item.unitPriceMinor, currency: BASE_CURRENCY }), lineTotal: moneyDto({ amountMinor: item.lineTotalMinor, currency: BASE_CURRENCY }) })),
    timeline: sellerOrder.statusHistory ?? [],
    issues: sellerOrder.issues ?? [],
  };
}

function mapOrder(order: any, transferSettings: TransferSettingsRecord) {
  const bankConfigured = transferSettingsConfigured(transferSettings);
  const mercadoPago = order.payment?.mercadoPago;
  const mercadoPagoClosed = [OrderStatus.EXPIRED, OrderStatus.CANCELLED, OrderStatus.PAYMENT_REQUIRES_REVIEW, OrderStatus.REFUND_RECORDED].includes(order.status);
  const mercadoPagoCheckoutStatus = !mercadoPago
    ? null
    : mercadoPagoClosed
      ? 'CLOSED'
      : mercadoPago.checkoutUrl
        ? 'READY'
        : 'RETRY_REQUIRED';
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
    sellerOrders: order.sellerOrders?.map((sellerOrder: any) => mapBuyerSellerOrder(sellerOrder, order.payment?.status)) ?? [],
    fulfillment: order.fulfillmentType === 'SHIPMENT' ? { type: 'SHIPMENT', recipientName: order.recipientName, recipientPhone: order.recipientPhone, addressLine1: order.addressLine1, addressLine2: order.addressLine2, city: order.city, province: order.province, postalCode: order.postalCode, shippingRateId: order.shippingRateId, shippingZoneName: order.shippingZoneName ?? null, shippingRateName: order.shippingRateName ?? null, shippingRatePrice: order.shippingRatePriceMinor === null || order.shippingRatePriceMinor === undefined ? null : moneyDto({ amountMinor: order.shippingRatePriceMinor, currency: BASE_CURRENCY }) } : { type: 'PICKUP', pickupPointId: order.pickupPointId, pickupPointName: order.pickupPointName ?? null, pickupPointAddress: order.pickupPointAddress ?? null },
    payment: order.payment ? {
      method: order.payment.method,
      status: order.payment.status,
      bankReference: order.payment.transfer?.reference ?? null,
      bankInstructions: order.payment.method === 'BANK_TRANSFER' && bankConfigured ? mapTransferInstructions(transferSettings) : null,
      receipt: order.transferReceipts?.[0] ? { fileId: order.transferReceipts[0].fileId, review: order.transferReceipts[0].review, createdAt: order.transferReceipts[0].createdAt } : null,
      checkoutUrl: mercadoPago?.checkoutUrl ?? null,
      paymentSessionStatus: mercadoPagoCheckoutStatus,
      mercadoPago: mercadoPago ? {
        integrationMode: mercadoPago.integrationMode,
        providerOrderId: mercadoPago.providerOrderId ?? null,
        checkoutUrl: mercadoPago.checkoutUrl ?? null,
        checkoutStatus: mercadoPagoCheckoutStatus,
        amount: mercadoPago.providerAmountMinor === null || mercadoPago.providerAmountMinor === undefined ? null : moneyDto({ amountMinor: mercadoPago.providerAmountMinor, currency: 'ARS' }),
        rate: mercadoPago.exchangeRateSnapshot ? {
          source: mercadoPago.exchangeRateSnapshot.source,
          rate: formatRate(mercadoPago.exchangeRateSnapshot.sellRateMicros),
          fetchedAt: mercadoPago.exchangeRateSnapshot.fetchedAt,
          expiresAt: mercadoPago.exchangeRateSnapshot.expiresAt,
        } : null,
        expiresAt: mercadoPago.expiresAt ?? null,
      } : null,
    } : null,
    createdAt: order.createdAt,
  };
}

async function calculateCheckout(tx: any, input: CheckoutInput, userId: string) {
  const products = [] as any[];
  let subtotal = 0n;
  for (const item of input.items) {
    const product = await tx.product.findUnique({ where: { id: item.productId }, include: { pokemonCard: true, inventory: true, images: { where: { retiredAt: null }, orderBy: { sortOrder: 'asc' } }, affiliate: { include: { user: true } }, affiliateListing: true } });
    if (!product || product.status !== ProductStatus.PUBLISHED) throw conflict('PRODUCT_UNAVAILABLE', 'A product is no longer available');
    if (product.affiliate && (product.affiliate.status !== 'ACTIVE' || product.affiliateListing?.status !== 'APPROVED')) throw conflict('PRODUCT_UNAVAILABLE', 'A seller listing is no longer available');
    if (product.affiliate?.userId === userId) throw forbidden('You cannot purchase your own products');
    if (product.version !== item.productVersion) throw conflict('PRODUCT_CHANGED', 'A product changed since it was loaded', { productId: item.productId, currentVersion: product.version });
    const available = (product.inventory?.onHand ?? 0) - (product.inventory?.reserved ?? 0);
    if (available < item.quantity) throw conflict('OUT_OF_STOCK', 'Insufficient stock', { productId: item.productId });
    const line = product.priceMinor * BigInt(item.quantity);
    subtotal += line;
    products.push({ item, product, line, sellerKey: product.affiliateId ?? 'STORE' });
  }

  const commissionSettings = await tx.affiliateProgramSettings.upsert({ where: { id: 'default' }, create: {}, update: {} });
  const bySeller = new Map<string, SellerGroup>();
  for (const entry of products) {
    const affiliate = entry.product.affiliate;
    const group: SellerGroup = bySeller.get(entry.sellerKey) ?? { key: entry.sellerKey, sellerType: affiliate ? 'AFFILIATE' : 'STORE', affiliateId: affiliate?.id ?? null, sellerName: affiliate?.publicName ?? 'Card Shop', products: [], subtotal: 0n, shipping: 0n, commissionBps: affiliate ? (affiliate.commissionBpsOverride ?? commissionSettings.commissionBps) : 0, commission: 0n, sellerNet: 0n, fulfillment: input.fulfillment, snapshot: {} };
    group.products.push(entry); group.subtotal += entry.line; bySeller.set(entry.sellerKey, group);
  }
  const requested = new Map((input.sellerFulfillments ?? []).map((entry) => [entry.sellerKey, entry.fulfillment]));
  for (const group of bySeller.values()) {
    const fulfillment = requested.get(group.key) ?? (bySeller.size === 1 ? input.fulfillment : null);
    if (!fulfillment) throw badRequest('SELLER_FULFILLMENT_REQUIRED', 'Select a delivery option for each seller');
    group.fulfillment = fulfillment;
    if (fulfillment.type === 'SHIPMENT') {
      const rate = await tx.shippingRate.findUnique({ where: { id: fulfillment.shippingRateId }, include: { zone: { include: { provinces: true } } } });
      if (!rate || !rate.active || !rate.zone.active || rate.zone.affiliateId !== group.affiliateId || !rate.zone.provinces.some((province: any) => province.province.toLowerCase() === fulfillment.province.toLowerCase())) throw badRequest('INVALID_SHIPPING_RATE', 'Shipping rate is not valid for this seller and province');
      group.shipping = rate.priceMinor; group.snapshot = { shippingZoneName: rate.zone.name, shippingRateName: rate.name, shippingRatePriceMinor: rate.priceMinor, shippingRateId: rate.id };
    } else {
      const pickup = await tx.pickupPoint.findUnique({ where: { id: fulfillment.pickupPointId } });
      if (!pickup?.active || pickup.affiliateId !== group.affiliateId) throw badRequest('INVALID_PICKUP_POINT', 'Pickup point is not available for this seller');
      group.snapshot = { pickupPointName: pickup.name, pickupPointAddress: pickup.address, pickupPointId: pickup.id };
    }
    group.commission = group.affiliateId ? (group.subtotal * BigInt(group.commissionBps) + 9999n) / 10000n : 0n;
    group.sellerNet = group.subtotal + group.shipping - group.commission;
  }
  const groups = [...bySeller.values()];
  const storeSubtotal = groups.filter((group) => !group.affiliateId).reduce((sum, group) => sum + group.subtotal, 0n);
  const shipping = groups.reduce((sum, group) => sum + group.shipping, 0n);
  const loyalty = await calculateLoyaltyQuote(tx, userId, storeSubtotal, input.pointsToRedeem);
  const fulfillmentSnapshot = groups.length === 1 ? groups[0]?.snapshot ?? {} : {};
  return { products, groups, subtotal, shipping, discount: loyalty.discountMinor, total: subtotal + shipping - loyalty.discountMinor, fulfillmentSnapshot, loyalty };
}

function isMercadoPagoCheckoutUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (hostname === 'mercadopago.com' || hostname.endsWith('.mercadopago.com') || hostname === 'mercadopago.com.ar' || hostname.endsWith('.mercadopago.com.ar'));
  } catch {
    return false;
  }
}

function mercadoPagoConfigError() {
  return new AppError(503, 'PAYMENT_PROVIDER_NOT_CONFIGURED', 'Mercado Pago is not configured');
}

function providerOrderBody(order: any, user: { email: string; name?: string | null }): Parameters<NonNullable<MercadoPagoGateway>['createOrder']>[0] {
  const amountMinor = BigInt(order.payment.mercadoPago.providerAmountMinor);
  return buildMercadoPagoCheckoutOrder({
    number: order.number,
    amountMinor,
    publicWebUrl: env.PUBLIC_WEB_URL!,
    publicApiUrl: env.PUBLIC_API_URL!,
    payer: { email: user.email, ...(user.name ? { first_name: user.name } : {}) },
  });
}

async function ensureMercadoCheckoutSession(prisma: PrismaClient, orderId: string, user: { email: string; name?: string | null }, gateway: MercadoPagoGateway | null) {
  if (!gateway) throw mercadoPagoConfigError();
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { payment: { include: { mercadoPago: { include: { exchangeRateSnapshot: true } } } } } });
  if (!order?.payment?.mercadoPago) throw notFound('Mercado Pago session not found');
  const session = order.payment.mercadoPago;
  if (session.checkoutUrl) return order;
  if (!isPaymentPendingOrder(order.status)) throw conflict('CHECKOUT_SESSION_CLOSED', 'This order cannot be paid anymore');
  if (order.expiresAt && order.expiresAt <= new Date()) throw conflict('CHECKOUT_SESSION_EXPIRED', 'The payment window has expired');
  if (!session.providerIdempotencyKey || session.providerAmountMinor === null || session.providerAmountMinor === undefined) throw new AppError(500, 'PAYMENT_SESSION_INCOMPLETE', 'Mercado Pago session is incomplete');
  const response = await gateway.createOrder(providerOrderBody(order, user), session.providerIdempotencyKey);
  const providerOrderId = String(response.id ?? '');
  const checkoutUrl = response.checkout_url;
  if (!providerOrderId || !isMercadoPagoCheckoutUrl(checkoutUrl)) throw new AppError(502, 'PAYMENT_PROVIDER_INVALID_RESPONSE', 'Mercado Pago returned an invalid checkout URL');
  await prisma.mercadoPagoPayment.update({ where: { paymentId: order.payment.id }, data: { providerOrderId, checkoutUrl, status: String(response.status ?? 'created'), statusDetail: response.status_detail ? String(response.status_detail) : null } });
  return prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { payment: { include: { mercadoPago: { include: { exchangeRateSnapshot: true } } } } } });
}

type ProviderState = {
  externalReference: string;
  providerId: string;
  providerOrderId?: string;
  providerPaymentId?: string;
  amountMinor: bigint;
  currency: string;
  collectorId?: string;
  status: string;
  statusDetail?: string;
  approved: boolean;
  rejected: boolean;
  terminal: boolean;
  refundedMinor: bigint;
  disputed: boolean;
  expectedCurrency: string;
  payload: unknown;
  attempts?: Array<{
    providerPaymentId?: string;
    attemptNumber: number;
    status: string;
    statusDetail?: string;
    amountMinor: bigint;
    refundedMinor: bigint;
    currency?: string;
    payload: unknown;
  }>;
};

function providerStateFromOrder(response: any, providerOrderId: string): ProviderState {
  const payments = Array.isArray(response.transactions?.payments) ? response.transactions.payments : [];
  const paymentStatuses = payments.map((payment: any) => String(payment.status ?? ''));
  let attemptSequence = 0;
  const attempts = payments.flatMap((payment: any) => {
    const nested = Array.isArray(payment.attempts) && payment.attempts.length ? payment.attempts : [payment];
    return nested.map((attempt: any, nestedIndex: number) => {
      attemptSequence += 1;
      const providerPaymentId = attempt.id
        ? String(attempt.id)
        : payment.id
          ? nested.length === 1 ? String(payment.id) : `${String(payment.id)}:${nestedIndex + 1}`
          : undefined;
      const refunded = providerAmountToMinor(attempt.refunded_amount ?? payment.refunded_amount);
      return {
        providerPaymentId,
        attemptNumber: nested.length === 1 && Number.isInteger(payment.attempt_number) && payment.attempt_number > 0 ? payment.attempt_number : attemptSequence,
        status: String(attempt.status ?? payment.status ?? response.status ?? ''),
        statusDetail: attempt.status_detail ? String(attempt.status_detail) : payment.status_detail ? String(payment.status_detail) : undefined,
        amountMinor: providerAmountToMinor(attempt.amount ?? payment.amount ?? response.total_amount),
        refundedMinor: refunded > 0n ? refunded : 0n,
        currency: attempt.currency ? String(attempt.currency) : String(response.currency ?? ''),
        payload: attempt,
      };
    });
  });
  const refundedMinorFromPayments = payments.reduce((total: bigint, payment: any) => { const refunded = providerAmountToMinor(payment.refunded_amount); return total + (refunded > 0n ? refunded : 0n); }, 0n);
  const refundedMinorFromRefunds = Array.isArray(response.transactions?.refunds)
    ? response.transactions.refunds.reduce((total: bigint, refund: any) => { const amount = providerAmountToMinor(refund.amount); return total + (amount > 0n ? amount : 0n); }, 0n)
    : 0n;
  const status = String(response.status ?? '');
  const detail = String(response.status_detail ?? payments.at(-1)?.status_detail ?? '');
  const rejected = status === 'rejected' || paymentStatuses.includes('rejected');
  const terminal = ['failed', 'canceled', 'cancelled', 'expired'].includes(status);
  const approved = !terminal && (status === 'processed' || status === 'approved' || paymentStatuses.includes('approved') || detail === 'accredited');
  const disputed = status === 'charged_back' || status === 'in_mediation' || paymentStatuses.some((value: string) => ['charged_back', 'in_mediation'].includes(value));
  const totalMinor = providerAmountToMinor(response.total_amount);
  const refundedMinor = status === 'refunded' && totalMinor >= 0n ? totalMinor : refundedMinorFromPayments > refundedMinorFromRefunds ? refundedMinorFromPayments : refundedMinorFromRefunds;
  return {
    externalReference: String(response.external_reference ?? ''),
    providerId: providerOrderId,
    providerOrderId,
    providerPaymentId: payments.at(-1)?.id ? String(payments.at(-1).id) : undefined,
    amountMinor: totalMinor,
    currency: String(response.currency ?? ''),
    collectorId: response.user_id ? String(response.user_id) : undefined,
    status,
    statusDetail: detail || undefined,
    approved,
    rejected,
    terminal,
    refundedMinor,
    disputed,
    expectedCurrency: 'ARS',
    payload: response,
    attempts,
  };
}

function providerStateFromPayment(response: any, providerPaymentId: string): ProviderState {
  const status = String(response.status ?? '');
  const amountMinor = providerAmountToMinor(response.transaction_amount);
  const refundedMinorValue = providerAmountToMinor(response.transaction_amount_refunded);
  const refundedMinor = status === 'refunded' && amountMinor >= 0n ? amountMinor : refundedMinorValue < 0n ? 0n : refundedMinorValue;
  return {
    externalReference: String(response.external_reference ?? ''),
    providerId: providerPaymentId,
    providerPaymentId,
    amountMinor,
    currency: String(response.currency_id ?? ''),
    collectorId: response.collector_id ? String(response.collector_id) : undefined,
    status,
    statusDetail: response.status_detail ? String(response.status_detail) : undefined,
    approved: status === 'approved',
    rejected: ['rejected', 'cc_rejected'].includes(status),
    terminal: false,
    refundedMinor: refundedMinor < 0n ? 0n : refundedMinor,
    disputed: ['charged_back', 'in_mediation'].includes(status),
    expectedCurrency: BASE_CURRENCY,
    payload: response,
    attempts: [{
      providerPaymentId,
      attemptNumber: 1,
      status,
      statusDetail: response.status_detail ? String(response.status_detail) : undefined,
      amountMinor,
      refundedMinor,
      currency: String(response.currency_id ?? ''),
      payload: response,
    }],
  };
}

function isPaymentPendingOrder(status: OrderStatus): boolean {
  return status === OrderStatus.PENDING_PAYMENT || status === OrderStatus.PAYMENT_REVIEW;
}

function statusForProvider(state: ProviderState, expectedMinor: bigint, expectedReference: string): PaymentStatus {
  const collectorValid = !env.MERCADOPAGO_COLLECTOR_ID || state.collectorId === env.MERCADOPAGO_COLLECTOR_ID;
  if (state.amountMinor < 0n || state.amountMinor !== expectedMinor || state.currency !== state.expectedCurrency || !collectorValid || state.externalReference !== expectedReference) return PaymentStatus.REQUIRES_REVIEW;
  if (state.disputed) return PaymentStatus.DISPUTED;
  if (state.refundedMinor >= expectedMinor && expectedMinor > 0n) return PaymentStatus.REFUNDED;
  if (state.refundedMinor > 0n) return PaymentStatus.PARTIALLY_REFUNDED;
  if (state.approved) return PaymentStatus.APPROVED;
  if (state.rejected) return PaymentStatus.REJECTED;
  if (state.terminal) return PaymentStatus.FAILED;
  if (['created', 'processing', 'action_required', 'pending', 'in_process', 'authorized'].includes(state.status)) return PaymentStatus.PENDING;
  return PaymentStatus.REQUIRES_REVIEW;
}

async function moveOrderToPaymentReview(tx: any, current: any, note: string, sourceKey: string, notificationIds: string[]) {
  if (['PAID', 'COMPLETED', 'REFUND_RECORDED', 'PAYMENT_REQUIRES_REVIEW'].includes(current.status)) return;
  await tx.order.update({ where: { id: current.id }, data: { status: OrderStatus.PAYMENT_REQUIRES_REVIEW, version: { increment: 1 } } });
  const history = await tx.orderStatusHistory.create({ data: { orderId: current.id, fromStatus: current.status, toStatus: OrderStatus.PAYMENT_REQUIRES_REVIEW, note } });
  notificationIds.push((await createOrderStatusNotification(tx, current, history)).id);
  notificationIds.push(...(await createPaymentReviewNotifications(tx, current, sourceKey)).map((row: any) => row.id));
}

export async function applyMercadoProviderState(state: ProviderState, realtime?: SupportRealtimeHub) {
  const paymentLookup = [
    ...(state.providerOrderId ? [{ mercadoPago: { providerOrderId: state.providerOrderId } }] : []),
    ...(state.providerPaymentId ? [{ mercadoPago: { externalPaymentId: state.providerPaymentId } }] : []),
    ...(state.externalReference ? [{ order: { number: state.externalReference, paymentMethod: 'MERCADO_PAGO' as const } }] : []),
  ];
  const payment = await db.payment.findFirst({
    where: paymentLookup.length === 1 ? paymentLookup[0] : { OR: paymentLookup },
    include: { order: true, mercadoPago: true },
  });
  if (!payment || !payment.mercadoPago) throw new Error(`No internal payment found for Mercado Pago resource ${state.providerId}`);
  const expectedMinor = payment.mercadoPago.providerAmountMinor ?? payment.amountMinor;
  const mapped = statusForProvider(state, expectedMinor, payment.order.number);
  const notificationIds = await writeCoordinator.run(() => db.$transaction(async (tx) => {
    const createdIds: string[] = [];
    await tx.mercadoPagoPayment.update({ where: { paymentId: payment.id }, data: {
      providerOrderId: state.providerOrderId ?? undefined,
      externalPaymentId: state.providerPaymentId ?? undefined,
      status: state.status,
      statusDetail: state.statusDetail ?? null,
    } });
    const attempts = state.attempts?.length ? state.attempts : [{ providerPaymentId: state.providerPaymentId, attemptNumber: 1, status: state.status, statusDetail: state.statusDetail, amountMinor: state.amountMinor, refundedMinor: state.refundedMinor, currency: state.currency, payload: state.payload }];
    for (const attempt of attempts) {
      if (!attempt.providerPaymentId) continue;
      await tx.mercadoPagoPaymentAttempt.upsert({
        where: { providerPaymentId: attempt.providerPaymentId },
        create: { mercadoPagoPaymentId: payment.mercadoPago!.id, providerPaymentId: attempt.providerPaymentId, attemptNumber: attempt.attemptNumber, status: attempt.status, statusDetail: attempt.statusDetail ?? null, amountMinor: attempt.amountMinor >= 0n ? attempt.amountMinor : null, refundedAmountMinor: attempt.refundedMinor, currency: attempt.currency ?? null, payload: JSON.stringify(attempt.payload) },
        update: { status: attempt.status, statusDetail: attempt.statusDetail ?? null, amountMinor: attempt.amountMinor >= 0n ? attempt.amountMinor : null, refundedAmountMinor: attempt.refundedMinor, currency: attempt.currency ?? null, payload: JSON.stringify(attempt.payload) },
      });
    }
    const current = await tx.order.findUniqueOrThrow({ where: { id: payment.orderId } });
    await tx.payment.update({ where: { id: payment.id }, data: { status: mapped, providerReference: state.providerId } });
    if (mapped === PaymentStatus.REQUIRES_REVIEW || mapped === PaymentStatus.DISPUTED || mapped === PaymentStatus.PARTIALLY_REFUNDED) {
      await moveOrderToPaymentReview(tx, current, mapped === PaymentStatus.DISPUTED ? 'Mercado Pago dispute notification' : mapped === PaymentStatus.PARTIALLY_REFUNDED ? 'Mercado Pago partial refund notification' : 'Mercado Pago validation failed', state.providerId, createdIds);
      return createdIds;
    }
    if (mapped === PaymentStatus.APPROVED) {
      if (current.status === OrderStatus.EXPIRED || current.status === OrderStatus.CANCELLED || !current.expiresAt || current.expiresAt <= new Date()) {
        await moveOrderToPaymentReview(tx, current, 'Mercado Pago approved after expiration', state.providerId, createdIds);
      } else if (isPaymentPendingOrder(current.status)) {
        const reservations = await tx.inventoryReservation.findMany({ where: { orderId: current.id } });
        const now = new Date();
        const reservationsValid = reservations.length > 0 && reservations.every((reservation: any) => reservation.releasedAt === null && reservation.consumedAt === null && reservation.expiresAt > now);
        if (!reservationsValid) {
          await moveOrderToPaymentReview(tx, current, 'Mercado Pago approved without a valid stock reservation', state.providerId, createdIds);
          return createdIds;
        }
        await tx.order.update({ where: { id: current.id }, data: { status: OrderStatus.PAID, version: { increment: 1 } } });
        const history = await tx.orderStatusHistory.create({ data: { orderId: current.id, fromStatus: current.status, toStatus: OrderStatus.PAID, note: 'Mercado Pago approved webhook' } });
        createdIds.push((await createOrderStatusNotification(tx, current, history)).id);
        createdIds.push(...(await createPaymentApprovedNotifications(tx, current, state.providerId)).map((row: any) => row.id));
        for (const reservation of reservations) {
          await tx.inventory.update({ where: { productId: reservation.productId }, data: { onHand: { decrement: reservation.quantity }, reserved: { decrement: reservation.quantity }, version: { increment: 1 } } });
          await tx.inventoryReservation.update({ where: { id: reservation.id }, data: { consumedAt: new Date() } });
        }
        createdIds.push(...await settleSellerOrdersOnPayment(tx, current.id));
        await settleOrderLoyalty(tx, current.id);
      }
    } else if (mapped === PaymentStatus.FAILED && state.terminal && isPaymentPendingOrder(current.status)) {
      await tx.order.update({ where: { id: current.id }, data: { status: OrderStatus.EXPIRED, version: { increment: 1 } } });
      const history = await tx.orderStatusHistory.create({ data: { orderId: current.id, fromStatus: current.status, toStatus: OrderStatus.EXPIRED, note: 'Mercado Pago order failed' } });
      createdIds.push((await createOrderStatusNotification(tx, current, history)).id);
      await closeUnpaidSellerOrders(tx, current.id, 'CANCELLED', 'Mercado Pago order failed before payment');
      await releaseReservations(tx, current.id);
      await releaseOrderLoyaltyReservation(tx, current.id);
    } else if (mapped === PaymentStatus.REFUNDED) {
      await releaseReservations(tx, current.id);
      await releaseOrderLoyaltyReservation(tx, current.id);
      if (current.status !== OrderStatus.REFUND_RECORDED) {
        await tx.order.update({ where: { id: current.id }, data: { status: OrderStatus.REFUND_RECORDED, version: { increment: 1 } } });
        const history = await tx.orderStatusHistory.create({ data: { orderId: current.id, fromStatus: current.status, toStatus: OrderStatus.REFUND_RECORDED, note: 'Mercado Pago refunded webhook' } });
        createdIds.push((await createOrderStatusNotification(tx, current, history)).id);
      }
      await reverseOrderLoyalty(tx, current.id);
      await closeAndReverseAffiliateSellerOrdersOnParentRefund(tx, current.id, 'system', 'Mercado Pago refund webhook');
    }
    return createdIds;
  }));
  if (realtime && notificationIds.length) await publishNotifications(db, realtime, notificationIds);
}

export async function reconcileMercadoPayment(externalId: string, realtime?: SupportRealtimeHub, gateway = createMercadoPagoGateway(true)) {
  if (!gateway) return;
  const response = await gateway.getPayment(externalId);
  await applyMercadoProviderState(providerStateFromPayment(response, externalId), realtime);
}

export async function reconcileMercadoOrder(providerOrderId: string, realtime?: SupportRealtimeHub, gateway = createMercadoPagoGateway()) {
  if (!gateway) return;
  const response = await gateway.getOrder(providerOrderId);
  await applyMercadoProviderState(providerStateFromOrder(response, providerOrderId), realtime);
}

async function mercadoPagoAvailability(prisma: PrismaClient, gateway: MercadoPagoGateway | null) {
  if (!gateway) return { enabled: false, reason: 'NOT_CONFIGURED' as const };
  try {
    await getDolarBlueVenta(prisma);
    return { enabled: true, reason: undefined } as const;
  } catch (error) {
    logger.warn({ err: error }, 'DolarAPI quote unavailable; disabling Mercado Pago checkout');
    return { enabled: false, reason: 'FX_UNAVAILABLE' } as const;
  }
}

export function createOrdersRouter(prisma: PrismaClient, upload: any, realtime?: SupportRealtimeHub, mercadoPago: MercadoPagoGateway | null = createMercadoPagoGateway()): Router {
  const router = Router();
  const mercadoPagoRefreshLimit = rateLimit(10, 60_000, (request) => `mercado-pago-refresh:${currentUser(request)?.user.id ?? request.ip ?? 'unknown'}`);
  router.get('/checkout/options', async (_req, res) => {
    const [zones, pickupPoints] = await Promise.all([
      prisma.shippingZone.findMany({ where: { active: true }, include: { provinces: true, rates: { where: { active: true }, orderBy: { priceMinor: 'asc' } } }, orderBy: { name: 'asc' } }),
      prisma.pickupPoint.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
    ]);
    const transferSettings = await getTransferSettings(prisma);
    const mercadoPagoAvailabilityState = await mercadoPagoAvailability(prisma, mercadoPago);
    return res.json({ fulfillment: { shippingZones: zones.map((zone) => ({ id: zone.id, name: zone.name, provinces: zone.provinces.map((province) => province.province), rates: zone.rates.map((rate) => ({ id: rate.id, name: rate.name, price: moneyDto({ amountMinor: rate.priceMinor, currency: BASE_CURRENCY }) })) })), pickupPoints: pickupPoints.map((point) => ({ id: point.id, name: point.name, address: point.address })) }, paymentMethods: { BANK_TRANSFER: transferSettingsConfigured(transferSettings), MERCADO_PAGO: mercadoPagoAvailabilityState.enabled }, paymentMethodUnavailableReasons: mercadoPagoAvailabilityState.reason ? { MERCADO_PAGO: mercadoPagoAvailabilityState.reason } : {} });
  });
  router.post('/checkout/options', requireUser, async (req, res) => {
    const user = currentUser(req)!.user;
    const input = z.object({ items: z.array(itemSchema).min(1).max(50) }).parse(req.body);
    const products = await prisma.product.findMany({ where: { id: { in: input.items.map((item) => item.productId) }, status: ProductStatus.PUBLISHED }, include: { affiliate: true, affiliateListing: true } });
    if (products.length !== input.items.length || products.some((product) => product.affiliate && (product.affiliate.status !== 'ACTIVE' || product.affiliateListing?.status !== 'APPROVED'))) throw conflict('PRODUCT_UNAVAILABLE', 'A product is no longer available');
    if (products.some((product) => product.affiliate?.userId === user.id)) throw forbidden('You cannot purchase your own products');
    const sellerIds = [...new Set(products.map((product) => product.affiliateId))];
    const [zones, pickupPoints, transferSettings] = await Promise.all([
      prisma.shippingZone.findMany({ where: { active: true, OR: sellerIds.map((affiliateId) => ({ affiliateId })) }, include: { provinces: true, rates: { where: { active: true }, orderBy: { priceMinor: 'asc' } } }, orderBy: { name: 'asc' } }),
      prisma.pickupPoint.findMany({ where: { active: true, OR: sellerIds.map((affiliateId) => ({ affiliateId })) }, orderBy: { name: 'asc' } }),
      getTransferSettings(prisma),
    ]);
    const sellerOptions = products.map((product) => { const key = product.affiliateId ?? 'STORE'; const affiliate = product.affiliate; return { sellerKey: key, seller: { type: affiliate ? 'AFFILIATE' : 'STORE', id: affiliate?.id ?? null, name: affiliate?.publicName ?? 'Card Shop' }, shippingZones: zones.filter((zone) => zone.affiliateId === product.affiliateId).map((zone) => ({ id: zone.id, name: zone.name, provinces: zone.provinces.map((province) => province.province), rates: zone.rates.map((rate) => ({ id: rate.id, name: rate.name, price: moneyDto({ amountMinor: rate.priceMinor, currency: BASE_CURRENCY }) })) })), pickupPoints: pickupPoints.filter((point) => point.affiliateId === product.affiliateId).map((point) => ({ id: point.id, name: point.name, address: point.address })) }; });
    const unique = [...new Map(sellerOptions.map((option) => [option.sellerKey, option])).values()];
     const mercadoPagoAvailabilityState = await mercadoPagoAvailability(prisma, mercadoPago);
     return res.json({ fulfillment: { shippingZones: unique[0]?.shippingZones ?? [], pickupPoints: unique[0]?.pickupPoints ?? [] }, sellers: unique, paymentMethods: { BANK_TRANSFER: transferSettingsConfigured(transferSettings), MERCADO_PAGO: mercadoPagoAvailabilityState.enabled }, paymentMethodUnavailableReasons: mercadoPagoAvailabilityState.reason ? { MERCADO_PAGO: mercadoPagoAvailabilityState.reason } : {} });
  });
  router.post('/checkout/preview', requireUser, async (req, res) => {
    const user = currentUser(req)!.user;
    if (!user.emailVerifiedAt) throw forbidden('Verify your email before checkout');
    const input = checkoutSchema.parse(req.body);
    const transferSettings = await getTransferSettings(prisma);
    if (input.paymentMethod === 'BANK_TRANSFER' && !transferSettingsConfigured(transferSettings)) throw new AppError(503, 'PAYMENT_METHOD_NOT_CONFIGURED', 'Bank transfer is not configured');
    if (input.paymentMethod === 'MERCADO_PAGO' && !mercadoPago) throw mercadoPagoConfigError();
    const quote = await calculateCheckout(prisma, input, user.id);
    let rate: ExchangeRateQuote | null = null;
    if (input.paymentMethod === 'MERCADO_PAGO') {
      try { rate = await getDolarBlueVenta(prisma); }
      catch (error) { logger.warn({ err: error }, 'Unable to obtain DolarAPI quote for checkout preview'); throw new AppError(503, 'FX_RATE_UNAVAILABLE', 'No pudimos obtener la cotización para Mercado Pago'); }
    }
    const previewExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
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
      expiresAt: previewExpiresAt,
      mercadoPago: rate ? {
        rateSnapshotId: rate.id,
        source: DOLARAPI_SOURCE,
        rate: rate.rate,
        fetchedAt: rate.fetchedAt,
        expiresAt: rate.expiresAt < previewExpiresAt ? rate.expiresAt : previewExpiresAt,
        total: moneyDto({ amountMinor: usdMinorToArsMinor(quote.total, rate.rateMicros), currency: 'ARS' }),
      } : null,
    });
  });

  router.post('/orders', requireUser, async (req, res) => {
    const user = currentUser(req)!.user;
    if (!user.emailVerifiedAt) throw forbidden('Verify your email before checkout');
    const input = checkoutSchema.parse(req.body);
    const transferSettings = await getTransferSettings(prisma);
    if (input.paymentMethod === 'BANK_TRANSFER' && !transferSettingsConfigured(transferSettings)) throw new AppError(503, 'PAYMENT_METHOD_NOT_CONFIGURED', 'Bank transfer is not configured');
    if (input.paymentMethod === 'MERCADO_PAGO' && !mercadoPago) throw mercadoPagoConfigError();
    const key = req.get('idempotency-key');
    if (!key || !/^[A-Za-z0-9._:-]{16,120}$/.test(key)) throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'A valid Idempotency-Key header is required');
    const hash = sha256(canonical(input));
    const result = await writeCoordinator.run(async () => prisma.$transaction(async (tx) => {
      const currentTransferSettings = await getTransferSettings(tx);
      const previous = await tx.order.findUnique({ where: { userId_idempotencyKey: { userId: user.id, idempotencyKey: key } }, include: { items: true, payment: { include: { transfer: true, mercadoPago: { include: { exchangeRateSnapshot: true } } } } } });
      if (previous) {
        if (previous.idempotencyHash !== hash) throw conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used with a different request');
        return { order: previous, reused: true, notificationIds: [] as string[], transferSettings: currentTransferSettings };
      }
      if (input.paymentMethod === 'BANK_TRANSFER' && !transferSettingsConfigured(currentTransferSettings)) throw new AppError(503, 'PAYMENT_METHOD_NOT_CONFIGURED', 'Bank transfer is not configured');
       const quote = await calculateCheckout(tx, input, user.id);
       let providerAmountMinor: bigint | undefined;
       if (input.paymentMethod === 'MERCADO_PAGO') {
         if (!input.rateSnapshotId) throw badRequest('FX_QUOTE_REQUIRED', 'A current exchange-rate quote is required for Mercado Pago');
         const snapshot = await tx.exchangeRateSnapshot.findFirst({ where: { id: input.rateSnapshotId, source: DOLARAPI_SOURCE, baseCurrency: 'USD', quoteCurrency: 'ARS', expiresAt: { gt: new Date() } } });
         if (!snapshot) throw conflict('FX_QUOTE_EXPIRED', 'The exchange-rate quote has expired; request a new quote');
         providerAmountMinor = usdMinorToArsMinor(quote.total, snapshot.sellRateMicros);
         if (providerAmountMinor <= 0n) throw badRequest('INVALID_PAYMENT_AMOUNT', 'The Mercado Pago amount must be greater than zero');
       }
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
         payment: { create: { method: input.paymentMethod, amountMinor: quote.total, currency: BASE_CURRENCY, ...(input.paymentMethod === 'BANK_TRANSFER' ? { transfer: { create: { reference: publicOrderNumber() } } } : { mercadoPago: { create: { expiresAt, integrationMode: 'ORDER_V1', providerIdempotencyKey: randomUUID(), providerAmountMinor, providerCurrency: 'ARS', exchangeRateSnapshotId: input.rateSnapshotId } } }) } },
        statusHistory: { create: { toStatus: 'PENDING_PAYMENT', note: 'Order created' } },
      }, include: { items: true, payment: { include: { transfer: true, mercadoPago: { include: { exchangeRateSnapshot: true } } } } } });
      await reserveLoyaltyPoints(tx, user.id, quote.loyalty.pointsRedeemed);
      for (const { item, product } of quote.products) {
        const inventory = product.inventory!;
        const updated = await tx.inventory.updateMany({ where: { productId: product.id, version: inventory.version, reserved: { lte: inventory.onHand - item.quantity } }, data: { reserved: { increment: item.quantity }, version: { increment: 1 } } });
        if (updated.count !== 1) throw conflict('OUT_OF_STOCK', 'Stock changed while creating the order');
        await tx.inventoryReservation.create({ data: { orderId: order.id, productId: product.id, quantity: item.quantity, expiresAt } });
      }
      for (const [index, group] of quote.groups.entries()) {
        const sellerOrder = await tx.sellerOrder.create({ data: {
          orderId: order.id, number: `${order.number}-${String(index + 1).padStart(2, '0')}`, sellerType: group.sellerType, affiliateId: group.affiliateId, sellerName: group.sellerName, sellerContactPhone: group.products[0]?.product.affiliate?.contactPhone ?? null, status: 'PENDING_PAYMENT',
          subtotalMinor: group.subtotal, shippingMinor: group.shipping, commissionBps: group.commissionBps, commissionMinor: group.commission, sellerNetMinor: group.sellerNet,
          fulfillmentType: group.fulfillment.type, shippingRateId: group.snapshot.shippingRateId as string | undefined, shippingZoneName: group.snapshot.shippingZoneName as string | undefined, shippingRateName: group.snapshot.shippingRateName as string | undefined, shippingRatePriceMinor: group.snapshot.shippingRatePriceMinor as bigint | undefined,
          pickupPointId: group.snapshot.pickupPointId as string | undefined, pickupPointName: group.snapshot.pickupPointName as string | undefined, pickupPointAddress: group.snapshot.pickupPointAddress as string | undefined,
          ...(group.fulfillment.type === 'SHIPMENT' ? { recipientName: group.fulfillment.recipientName, recipientPhone: group.fulfillment.recipientPhone, addressLine1: group.fulfillment.addressLine1, addressLine2: group.fulfillment.addressLine2, city: group.fulfillment.city, province: group.fulfillment.province, postalCode: group.fulfillment.postalCode } : {}),
          statusHistory: { create: { toStatus: 'PENDING_PAYMENT', note: 'Seller order created' } },
        } });
        for (const entry of group.products) {
          await tx.orderItem.updateMany({ where: { orderId: order.id, productId: entry.product.id }, data: { sellerOrderId: sellerOrder.id } });
          await tx.inventoryReservation.updateMany({ where: { orderId: order.id, productId: entry.product.id }, data: { sellerOrderId: sellerOrder.id } });
        }
      }
      const adminNotifications = await createOrderCreatedNotifications(tx, order);
      return { order, reused: false, notificationIds: adminNotifications.map((row) => row.id), transferSettings: currentTransferSettings };
    }));

    if (!result.reused && realtime && result.notificationIds.length) await publishNotifications(prisma, realtime, result.notificationIds);

    let order: any = result.order;
    if (input.paymentMethod === 'MERCADO_PAGO') {
      try {
        order = await ensureMercadoCheckoutSession(prisma, order.id, user, mercadoPago);
      } catch (error) {
        logger.error({ err: error, orderId: order.id }, 'Mercado Pago order creation failed; session can be retried');
      }
    }
    order = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true, sellerOrders: { include: { items: true, statusHistory: { orderBy: { createdAt: 'asc' } }, issues: true } }, statusHistory: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }, transferReceipts: { orderBy: { createdAt: 'desc' }, take: 1 }, payment: { include: { transfer: true, mercadoPago: { include: { exchangeRateSnapshot: true } }, refunds: true } } } });
    return res.status(result.reused ? 200 : 201).json({ order: mapOrder(order, result.transferSettings), reused: result.reused });
  });

  router.post('/orders/:number/payment-session', requireUser, async (req, res) => {
    const user = currentUser(req)!.user;
    const existing = await prisma.order.findFirst({ where: { number: String(req.params.number), userId: user.id, paymentMethod: 'MERCADO_PAGO' } });
    if (!existing) throw notFound('Order not found');
    try {
      const order = await ensureMercadoCheckoutSession(prisma, existing.id, user, mercadoPago);
      const transferSettings = await getTransferSettings(prisma);
      const payment = order.payment?.mercadoPago;
      return res.json({ checkoutUrl: payment?.checkoutUrl ?? null, expiresAt: payment?.expiresAt ?? order.expiresAt, order: mapOrder(order, transferSettings) });
    } catch (error) {
      if (error instanceof AppError) throw error;
      logger.error({ err: error, orderId: existing.id }, 'Mercado Pago checkout session retry failed');
      throw new AppError(503, 'PAYMENT_PROVIDER_UNAVAILABLE', 'Mercado Pago no está disponible; intentá nuevamente');
    }
  });

  router.post('/orders/:number/payment-status/refresh', requireUser, mercadoPagoRefreshLimit, async (req, res) => {
    const user = currentUser(req)!.user;
    const existing = await prisma.order.findFirst({
      where: { number: String(req.params.number), userId: user.id, paymentMethod: 'MERCADO_PAGO' },
      select: { id: true, payment: { select: { mercadoPago: { select: { providerOrderId: true } } } } },
    });
    if (!existing) throw notFound('Order not found');
    if (!mercadoPago) throw mercadoPagoConfigError();
    const providerOrderId = existing.payment?.mercadoPago?.providerOrderId;
    if (!providerOrderId) throw conflict('PAYMENT_STATUS_NOT_REFRESHABLE', 'Mercado Pago checkout has not been created for this order');

    try {
      await reconcileMercadoOrder(providerOrderId, realtime, mercadoPago);
    } catch (error) {
      if (error instanceof AppError) throw error;
      logger.error({ err: error, orderId: existing.id }, 'Mercado Pago payment status refresh failed');
      throw new AppError(503, 'PAYMENT_PROVIDER_UNAVAILABLE', 'Mercado Pago no está disponible; intentá nuevamente');
    }

    const [order, transferSettings] = await Promise.all([
      prisma.order.findUniqueOrThrow({ where: { id: existing.id }, include: { items: true, sellerOrders: { include: { items: true, statusHistory: { orderBy: { createdAt: 'asc' } }, issues: true } }, statusHistory: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }, transferReceipts: { orderBy: { createdAt: 'desc' }, take: 1 }, payment: { include: { transfer: true, mercadoPago: { include: { exchangeRateSnapshot: true } } } } } }),
      getTransferSettings(prisma),
    ]);
    logger.info({ orderId: existing.id, providerOrderId, orderStatus: order.status, paymentStatus: order.payment?.status ?? null }, 'Mercado Pago payment status refreshed');
    return res.json({ order: mapOrder(order, transferSettings) });
  });

  router.get('/orders', requireUser, async (req, res) => {
    const user = currentUser(req)!.user;
    const transferSettings = await getTransferSettings(prisma);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 20)));
    const orders = await prisma.order.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: limit + 1, ...(req.query.cursor ? { skip: 1, cursor: { id: String(req.query.cursor) } } : {}), include: { items: true, sellerOrders: { include: { items: true, statusHistory: { orderBy: { createdAt: 'asc' } }, issues: true } }, transferReceipts: { orderBy: { createdAt: 'desc' }, take: 1 }, payment: { include: { transfer: true, mercadoPago: { include: { exchangeRateSnapshot: true } } } } } });
    const hasMore = orders.length > limit;
    const page = hasMore ? orders.slice(0, limit) : orders;
    return res.json({ data: page.map((order) => mapOrder(order, transferSettings)), nextCursor: hasMore ? page.at(-1)?.id ?? null : null });
  });

  router.get('/orders/:number', requireUser, async (req, res) => {
    const user = currentUser(req)!.user;
    const transferSettings = await getTransferSettings(prisma);
    const order = await prisma.order.findFirst({ where: { number: String(req.params.number), userId: user.id }, include: { items: true, sellerOrders: { include: { items: true, statusHistory: { orderBy: { createdAt: 'asc' } }, issues: true } }, statusHistory: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }, transferReceipts: { orderBy: { createdAt: 'desc' }, take: 1 }, payment: { include: { transfer: true, mercadoPago: { include: { exchangeRateSnapshot: true } } } } } });
    if (!order) throw notFound('Order not found');
    return res.json({ order: mapOrder(order, transferSettings) });
  });

  router.post('/orders/:number/seller-orders/:sellerOrderId/confirm', requireUser, async (req, res) => {
    const user = currentUser(req)!.user;
    const sellerOrder = await prisma.sellerOrder.findFirst({ where: { id: String(req.params.sellerOrderId), order: { number: String(req.params.number), userId: user.id } } });
    if (!sellerOrder) throw notFound('Seller order not found');
    if (!['SHIPPED', 'PICKED_UP'].includes(sellerOrder.status)) throw conflict('SELLER_ORDER_NOT_CONFIRMABLE', 'This seller order is not ready to be completed');
    const input = z.object({ expectedVersion: z.number().int().min(1) }).parse(req.body);
    const completed = await writeCoordinator.run(() => prisma.$transaction(async (tx) => {
      await transitionSellerOrder(tx, { sellerOrderId: sellerOrder.id, expectedVersion: input.expectedVersion, nextStatus: 'COMPLETED', actor: 'BUYER', actorId: user.id, note: 'Receipt confirmed by buyer' });
      return tx.sellerOrder.findUniqueOrThrow({ where: { id: sellerOrder.id }, include: { order: { select: { number: true } } } });
    }));
    const notices = await createAdminNotifications(prisma, { type: NotificationType.AFFILIATE_ORDER_STATUS_CHANGED, title: 'Entrega confirmada por comprador', message: `La venta ${completed.order.number} fue confirmada como recibida.`, dedupeKey: `seller-order-confirmed:${completed.id}:${completed.version}`, sellerOrderId: completed.id });
    if (realtime) await publishNotifications(prisma, realtime, notices.map((notice) => notice.id));
    return res.json({ id: sellerOrder.id, status: 'COMPLETED', version: completed.version });
  });

  router.post('/orders/:number/seller-orders/:sellerOrderId/issues', requireUser, async (req, res) => {
    const user = currentUser(req)!.user;
    const input = z.object({ reason: z.string().trim().min(3).max(1000) }).parse(req.body);
    const issue = await writeCoordinator.run(() => prisma.$transaction((tx) => createBuyerIssue(tx, { sellerOrderId: String(req.params.sellerOrderId), userId: user.id, reason: input.reason })));
    const context = await prisma.sellerOrder.findUniqueOrThrow({ where: { id: issue.sellerOrderId }, include: { affiliate: true, order: { select: { number: true } } } });
    const notices = await createAdminNotifications(prisma, { type: NotificationType.AFFILIATE_ISSUE_OPENED, title: 'Nueva incidencia de comprador', message: `La venta ${context.order.number} tiene una incidencia abierta.`, dedupeKey: `affiliate-issue:${issue.id}`, sellerOrderId: issue.sellerOrderId });
    const affiliateNotice = context.affiliate ? await createSellerOrderStatusNotification(prisma, { id: context.id, orderNumber: context.order.number, affiliateUserId: context.affiliate.userId }, 'DISPUTED', `issue:${issue.id}`) : null;
    if (realtime) await publishNotifications(prisma, realtime, [ ...notices.map((notice) => notice.id), ...(affiliateNotice ? [affiliateNotice.id] : []) ]);
    return res.status(201).json({ id: issue.id, status: issue.status });
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
      await closeUnpaidSellerOrders(tx, current.id, 'CANCELLED', 'Parent order cancelled before payment');
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
    if (!mercadoPago || !env.MERCADOPAGO_WEBHOOK_SECRET) return res.status(503).json({ error: 'Webhook not configured' });
    const parsed = mercadoPagoWebhookSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid webhook payload' });
    const notificationId = String(parsed.data.id);
    const bodyResourceId = String(parsed.data.data.id);
    const queryResourceId = req.query['data.id'] ? String(req.query['data.id']) : bodyResourceId;
    const queryType = req.query.type ? String(req.query.type) : parsed.data.type;
    if (queryType !== parsed.data.type) return res.status(400).json({ error: 'Webhook type mismatch' });
    if (queryResourceId !== bodyResourceId) return res.status(400).json({ error: 'Webhook resource id mismatch' });
    try {
      mercadoPago.validateWebhook({ signature: req.get('x-signature') ?? undefined, requestId: req.get('x-request-id') ?? undefined, dataId: queryResourceId });
    } catch (error) {
      logger.warn({ err: error, notificationId, resourceId: bodyResourceId }, 'Invalid Mercado Pago webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }
    await prisma.webhookEvent.upsert({
      where: { notificationId },
      create: { provider: 'mercadopago', externalKey: notificationId, notificationId, resourceId: bodyResourceId, payload: JSON.stringify(req.body), nextAttemptAt: new Date() },
      update: { resourceId: bodyResourceId, payload: JSON.stringify(req.body), receivedAt: new Date(), nextAttemptAt: new Date(), lockedAt: null, failedAt: null },
    });
    logger.info({ notificationId, resourceId: bodyResourceId, type: parsed.data.type, action: parsed.data.action ?? null }, 'Mercado Pago webhook accepted');
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

/** Moves each affiliate seller order from payment-pending to paid exactly once and records pending earnings. */
export async function settleSellerOrdersOnPayment(tx: any, orderId: string) {
  const notificationIds: string[] = [];
  const sellerOrders = await tx.sellerOrder.findMany({ where: { orderId, status: 'PENDING_PAYMENT' }, include: { affiliate: true, order: { select: { number: true } } } });
  for (const sellerOrder of sellerOrders) {
    await tx.sellerOrder.update({ where: { id: sellerOrder.id }, data: { status: 'PAID', version: { increment: 1 } } });
    await tx.sellerOrderHistory.create({ data: { sellerOrderId: sellerOrder.id, fromStatus: 'PENDING_PAYMENT', toStatus: 'PAID', note: 'Payment accredited', changedByType: 'SYSTEM' } });
    if (sellerOrder.affiliateId) {
      const existing = await tx.affiliateLedgerEntry.findFirst({ where: { sellerOrderId: sellerOrder.id, type: 'SALE_PENDING' } });
      if (!existing) await tx.affiliateLedgerEntry.create({ data: { affiliateId: sellerOrder.affiliateId, sellerOrderId: sellerOrder.id, bucket: 'PENDING', type: 'SALE_PENDING', amountMinor: sellerOrder.sellerNetMinor, dedupeKey: `sale-pending:${sellerOrder.id}`, note: 'Payment accredited; available after completion' } });
      if (sellerOrder.affiliate) {
        notificationIds.push((await createSellerOrderStatusNotification(tx, { id: sellerOrder.id, orderNumber: sellerOrder.order.number, affiliateUserId: sellerOrder.affiliate.userId }, 'PAID', 'payment')).id);
      }
      notificationIds.push(...(await createSellerOrderAdminNotifications(tx, { id: sellerOrder.id, orderNumber: sellerOrder.order.number }, NotificationType.AFFILIATE_ORDER_CREATED, 'Nueva venta de afiliado', `La venta ${sellerOrder.order.number} fue acreditada y está lista para preparar.`, 'payment')).map((notice) => notice.id));
    }
  }
  await reconcileParentOrder(tx, orderId);
  return notificationIds;
}

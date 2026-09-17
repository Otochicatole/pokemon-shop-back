import type { Prisma, PrismaClient } from '@prisma/client';
import { AffiliateIssueStatus, AffiliateLedgerBucket, AffiliateLedgerType, AffiliatePayoutStatus, AffiliateStatus, FulfillmentType, OrderStatus, SellerOrderStatus } from '@prisma/client';
import { badRequest, conflict, notFound } from '../../shared/errors.js';
import { BASE_CURRENCY } from '../../shared/currency.js';

type Db = PrismaClient | Prisma.TransactionClient;

export type SellerOrderActor = 'AFFILIATE' | 'ADMIN' | 'BUYER' | 'SYSTEM';

export type SellerOrderAction =
  | 'START_PREPARING'
  | 'READY_FOR_PICKUP'
  | 'MARK_SHIPPED'
  | 'MARK_PICKED_UP'
  | 'CONFIRM_RECEIPT'
  | 'REQUEST_CANCELLATION'
  | 'OPEN_ISSUE'
  | 'COMPLETE'
  | 'CANCEL'
  | 'REFUND';

const affiliateTransitionMap: Record<SellerOrderStatus, SellerOrderStatus[]> = {
  PENDING_PAYMENT: [],
  PAID: [SellerOrderStatus.PREPARING],
  PREPARING: [SellerOrderStatus.READY_FOR_PICKUP, SellerOrderStatus.SHIPPED],
  READY_FOR_PICKUP: [SellerOrderStatus.PICKED_UP],
  PICKED_UP: [],
  SHIPPED: [],
  COMPLETED: [],
  CANCELLATION_REQUESTED: [],
  CANCELLED: [],
  DISPUTED: [],
  REFUNDED: [],
};

const closedStatuses = new Set<SellerOrderStatus>([SellerOrderStatus.COMPLETED, SellerOrderStatus.CANCELLED, SellerOrderStatus.REFUNDED]);

export function sellerOrderAllowedActions(order: { status: SellerOrderStatus; sellerType: string; fulfillmentType: FulfillmentType; affiliateId?: string | null; affiliate?: { status: AffiliateStatus } | null }, actor: SellerOrderActor): SellerOrderAction[] {
  if (actor === 'AFFILIATE' && order.affiliate?.status === AffiliateStatus.SUSPENDED) {
    return order.status === SellerOrderStatus.PAID || order.status === SellerOrderStatus.PREPARING || order.status === SellerOrderStatus.READY_FOR_PICKUP
      ? sellerOrderAllowedActions({ ...order, affiliate: { status: AffiliateStatus.ACTIVE } }, actor)
      : [];
  }
  const result: SellerOrderAction[] = [];
  if (actor === 'AFFILIATE' && order.affiliateId) {
    if (order.status === SellerOrderStatus.PAID) result.push('START_PREPARING');
    if (order.status === SellerOrderStatus.PREPARING) result.push(order.fulfillmentType === FulfillmentType.PICKUP ? 'READY_FOR_PICKUP' : 'MARK_SHIPPED');
    if (order.status === SellerOrderStatus.READY_FOR_PICKUP) result.push('MARK_PICKED_UP');
    if (!closedStatuses.has(order.status) && order.status !== SellerOrderStatus.CANCELLATION_REQUESTED && order.status !== SellerOrderStatus.DISPUTED) result.push('REQUEST_CANCELLATION');
    return result;
  }
  if (actor === 'BUYER') {
    if (order.status === SellerOrderStatus.SHIPPED || order.status === SellerOrderStatus.PICKED_UP) result.push('CONFIRM_RECEIPT');
    if (order.affiliateId && !closedStatuses.has(order.status) && order.status !== SellerOrderStatus.CANCELLATION_REQUESTED) result.push('OPEN_ISSUE');
    return result;
  }
  if (actor === 'ADMIN') {
    if (order.status === SellerOrderStatus.PAID) result.push('START_PREPARING');
    if (order.status === SellerOrderStatus.PREPARING) result.push(order.fulfillmentType === FulfillmentType.PICKUP ? 'READY_FOR_PICKUP' : 'MARK_SHIPPED');
    if (order.status === SellerOrderStatus.READY_FOR_PICKUP) result.push('MARK_PICKED_UP');
    if (order.status === SellerOrderStatus.SHIPPED || order.status === SellerOrderStatus.PICKED_UP) result.push('COMPLETE');
    if (order.status === SellerOrderStatus.PENDING_PAYMENT) result.push('CANCEL');
    if (order.status !== SellerOrderStatus.PENDING_PAYMENT && order.status !== SellerOrderStatus.CANCELLED && order.status !== SellerOrderStatus.REFUNDED) result.push('REFUND');
    return result;
  }
  if (actor === 'SYSTEM') {
    if (order.status === SellerOrderStatus.SHIPPED || order.status === SellerOrderStatus.PICKED_UP) result.push('COMPLETE');
    return result;
  }
  return result;
}

async function createLedgerEntry(tx: Db, data: {
  affiliateId: string;
  sellerOrderId?: string;
  payoutId?: string;
  bucket: AffiliateLedgerBucket;
  type: AffiliateLedgerType;
  amountMinor: bigint;
  dedupeKey: string;
  note?: string;
}) {
  return tx.affiliateLedgerEntry.upsert({
    where: { dedupeKey: data.dedupeKey },
    create: data,
    update: {},
  });
}

async function ledgerBucketBalance(tx: Db, affiliateId: string, bucket: AffiliateLedgerBucket, sellerOrderId?: string) {
  const aggregate = await tx.affiliateLedgerEntry.aggregate({
    _sum: { amountMinor: true },
    where: { affiliateId, bucket, ...(sellerOrderId ? { sellerOrderId } : {}) },
  });
  return aggregate._sum.amountMinor ?? 0n;
}

export async function affiliateBalance(tx: Db, affiliateId: string) {
  const buckets = await Promise.all(Object.values(AffiliateLedgerBucket).map(async (bucket) => [bucket, await ledgerBucketBalance(tx, affiliateId, bucket)] as const));
  return Object.fromEntries(buckets) as Record<AffiliateLedgerBucket, bigint>;
}

export async function releaseAffiliateEarnings(tx: Db, sellerOrder: { id: string; affiliateId: string | null; sellerNetMinor: bigint }, reason: string, dedupeSuffix: string) {
  if (!sellerOrder.affiliateId) return 0n;
  const pending = await ledgerBucketBalance(tx, sellerOrder.affiliateId, AffiliateLedgerBucket.PENDING, sellerOrder.id);
  const amount = pending > 0n ? pending : 0n;
  if (amount === 0n) return 0n;
  await createLedgerEntry(tx, { affiliateId: sellerOrder.affiliateId, sellerOrderId: sellerOrder.id, bucket: AffiliateLedgerBucket.PENDING, type: AffiliateLedgerType.SALE_RELEASED, amountMinor: -amount, dedupeKey: `sale-release:${sellerOrder.id}:${dedupeSuffix}`, note: reason });
  await createLedgerEntry(tx, { affiliateId: sellerOrder.affiliateId, sellerOrderId: sellerOrder.id, bucket: AffiliateLedgerBucket.AVAILABLE, type: AffiliateLedgerType.SALE_RELEASED, amountMinor: amount, dedupeKey: `sale-release-available:${sellerOrder.id}:${dedupeSuffix}`, note: reason });
  return amount;
}

export async function reverseAffiliateLiability(tx: Db, sellerOrder: { id: string; affiliateId: string | null }, sellerDebitMinor: bigint, reason: string, dedupeSuffix: string) {
  if (!sellerOrder.affiliateId || sellerDebitMinor <= 0n) return 0n;
  let remaining = sellerDebitMinor;
  const buckets = [AffiliateLedgerBucket.PENDING, AffiliateLedgerBucket.AVAILABLE, AffiliateLedgerBucket.RESERVED] as const;
  for (const bucket of buckets) {
    if (remaining <= 0n) break;
    const balance = await ledgerBucketBalance(tx, sellerOrder.affiliateId, bucket, sellerOrder.id);
    const covered = balance > 0n ? (balance < remaining ? balance : remaining) : 0n;
    if (covered <= 0n) continue;
    await createLedgerEntry(tx, { affiliateId: sellerOrder.affiliateId, sellerOrderId: sellerOrder.id, bucket, type: AffiliateLedgerType.SALE_REVERSED, amountMinor: -covered, dedupeKey: `sale-reversal:${sellerOrder.id}:${dedupeSuffix}:${bucket}`, note: reason });
    remaining -= covered;
  }
  if (remaining > 0n) {
    await createLedgerEntry(tx, { affiliateId: sellerOrder.affiliateId, sellerOrderId: sellerOrder.id, bucket: AffiliateLedgerBucket.AVAILABLE, type: AffiliateLedgerType.SALE_REVERSED, amountMinor: -remaining, dedupeKey: `sale-reversal-debt:${sellerOrder.id}:${dedupeSuffix}`, note: `${reason} (affiliate debt)` });
    remaining = 0n;
  }
  return sellerDebitMinor;
}

export async function reconcileParentOrder(tx: Db, orderId: string, note = 'Seller order status reconciled') {
  const order = await tx.order.findUnique({ where: { id: orderId }, include: { sellerOrders: { select: { status: true } } } });
  if (!order || order.sellerOrders.length === 0) return null;
  const statuses = order.sellerOrders.map((sellerOrder) => sellerOrder.status);
  const all = (values: SellerOrderStatus[]) => statuses.every((status) => values.includes(status));
  const any = (values: SellerOrderStatus[]) => statuses.some((status) => values.includes(status));
  let next: OrderStatus;
  if (any([SellerOrderStatus.DISPUTED, SellerOrderStatus.CANCELLATION_REQUESTED])) next = OrderStatus.ACTION_REQUIRED;
  else if (all([SellerOrderStatus.COMPLETED])) next = OrderStatus.COMPLETED;
  else if (all([SellerOrderStatus.CANCELLED, SellerOrderStatus.REFUNDED])) next = OrderStatus.CANCELLED;
  else if (any([SellerOrderStatus.COMPLETED]) && any([SellerOrderStatus.PAID, SellerOrderStatus.PREPARING, SellerOrderStatus.READY_FOR_PICKUP, SellerOrderStatus.PICKED_UP, SellerOrderStatus.SHIPPED])) next = OrderStatus.PARTIALLY_COMPLETED;
  else if (any([SellerOrderStatus.PREPARING, SellerOrderStatus.READY_FOR_PICKUP, SellerOrderStatus.PICKED_UP, SellerOrderStatus.SHIPPED])) next = OrderStatus.IN_FULFILLMENT;
  else if (all([SellerOrderStatus.PAID])) next = OrderStatus.PAID;
  else if (all([SellerOrderStatus.PENDING_PAYMENT])) next = OrderStatus.PENDING_PAYMENT;
  else next = OrderStatus.PAID;
  if (next === order.status) return order;
  const changed = await tx.order.updateMany({ where: { id: order.id, version: order.version }, data: { status: next, version: { increment: 1 } } });
  if (changed.count === 1) await tx.orderStatusHistory.create({ data: { orderId: order.id, fromStatus: order.status, toStatus: next, note } });
  return tx.order.findUnique({ where: { id: order.id } });
}

export async function transitionSellerOrder(tx: Db, args: {
  sellerOrderId: string;
  expectedVersion: number;
  nextStatus: SellerOrderStatus;
  actor: SellerOrderActor;
  actorId?: string;
  note?: string;
  autoCompleteDays?: number;
  carrier?: string | null;
  trackingCode?: string | null;
}) {
  const current = await tx.sellerOrder.findUnique({ where: { id: args.sellerOrderId }, include: { affiliate: true } });
  if (!current) throw notFound('Seller order not found');
  if (current.version !== args.expectedVersion) throw conflict('SELLER_ORDER_CHANGED', 'Seller order was modified by another request');
  if (args.actor === 'AFFILIATE') {
    if (!current.affiliateId) throw conflict('SELLER_ORDER_NOT_AFFILIATE', 'This seller order is operated by the store');
    const allowed = sellerOrderAllowedActions(current, 'AFFILIATE');
    const actionByStatus: Partial<Record<SellerOrderStatus, SellerOrderAction>> = { PREPARING: 'START_PREPARING', READY_FOR_PICKUP: 'READY_FOR_PICKUP', PICKED_UP: 'MARK_PICKED_UP', SHIPPED: 'MARK_SHIPPED' };
    const action = args.nextStatus === SellerOrderStatus.PREPARING ? 'START_PREPARING' : args.nextStatus === SellerOrderStatus.READY_FOR_PICKUP ? 'READY_FOR_PICKUP' : args.nextStatus === SellerOrderStatus.PICKED_UP ? 'MARK_PICKED_UP' : args.nextStatus === SellerOrderStatus.SHIPPED ? 'MARK_SHIPPED' : actionByStatus[args.nextStatus];
    if (!action || !allowed.includes(action)) throw conflict('INVALID_SELLER_ORDER_TRANSITION', 'The seller order cannot use this status transition');
  } else if (args.actor === 'BUYER') {
    if (args.nextStatus !== SellerOrderStatus.COMPLETED || !sellerOrderAllowedActions(current, 'BUYER').includes('CONFIRM_RECEIPT')) throw conflict('SELLER_ORDER_NOT_CONFIRMABLE', 'This seller order is not ready to be completed');
  } else if (args.actor === 'SYSTEM') {
    if (args.nextStatus !== SellerOrderStatus.COMPLETED || !(new Set<SellerOrderStatus>([SellerOrderStatus.SHIPPED, SellerOrderStatus.PICKED_UP])).has(current.status)) throw conflict('INVALID_SELLER_ORDER_TRANSITION', 'The seller order cannot be completed automatically');
  } else if (args.actor === 'ADMIN') {
    const allowed = sellerOrderAllowedActions(current, 'ADMIN');
    if (args.nextStatus === SellerOrderStatus.REFUNDED) throw conflict('USE_REFUND_FLOW', 'Use the audited refund action to close a seller order as refunded');
    if (args.nextStatus === SellerOrderStatus.CANCELLED && current.status !== SellerOrderStatus.PENDING_PAYMENT) throw conflict('USE_REFUND_FLOW', 'Paid seller orders must use the audited refund action');
    const actionByStatus: Partial<Record<SellerOrderStatus, SellerOrderAction>> = {
      PREPARING: 'START_PREPARING',
      READY_FOR_PICKUP: 'READY_FOR_PICKUP',
      PICKED_UP: 'MARK_PICKED_UP',
      SHIPPED: 'MARK_SHIPPED',
      COMPLETED: 'COMPLETE',
      CANCELLED: 'CANCEL',
    };
    const action = actionByStatus[args.nextStatus];
    if (!action || !allowed.includes(action)) throw conflict('INVALID_SELLER_ORDER_TRANSITION', 'The seller order cannot use this status transition');
  }
  const now = new Date();
  const autoCompleteAt = (new Set<SellerOrderStatus>([SellerOrderStatus.SHIPPED, SellerOrderStatus.PICKED_UP])).has(args.nextStatus)
    ? new Date(now.getTime() + Math.max(1, args.autoCompleteDays ?? 7) * 24 * 60 * 60 * 1000)
    : null;
  const changed = await tx.sellerOrder.updateMany({ where: { id: current.id, version: args.expectedVersion, status: current.status }, data: {
    status: args.nextStatus,
    version: { increment: 1 },
    autoCompleteAt,
    completedAt: args.nextStatus === SellerOrderStatus.COMPLETED ? now : null,
    ...(args.carrier !== undefined ? { carrier: args.carrier } : {}),
    ...(args.trackingCode !== undefined ? { trackingCode: args.trackingCode } : {}),
  } });
  if (changed.count !== 1) throw conflict('SELLER_ORDER_CHANGED', 'Seller order was modified by another request');
  await tx.sellerOrderHistory.create({ data: { sellerOrderId: current.id, fromStatus: current.status, toStatus: args.nextStatus, note: args.note, changedByType: args.actor, changedById: args.actorId } });
  if (args.nextStatus === SellerOrderStatus.COMPLETED && args.actor !== 'AFFILIATE') await releaseAffiliateEarnings(tx, current, args.note ?? 'Seller order completed', `${args.actor.toLowerCase()}:${args.expectedVersion}`);
  await reconcileParentOrder(tx, current.orderId);
  return tx.sellerOrder.findUniqueOrThrow({ where: { id: current.id }, include: { statusHistory: { orderBy: { createdAt: 'asc' } }, issues: { where: { status: AffiliateIssueStatus.OPEN } } } });
}

export async function requestSellerCancellation(tx: Db, args: { sellerOrderId: string; affiliateId: string; expectedVersion: number; reason: string; actorId: string }) {
  const current = await tx.sellerOrder.findFirst({ where: { id: args.sellerOrderId, affiliateId: args.affiliateId }, include: { cancellationRequests: { where: { status: 'REQUESTED' } } } });
  if (!current) throw notFound('Seller order not found');
  if (current.version !== args.expectedVersion) throw conflict('SELLER_ORDER_CHANGED', 'Seller order was modified by another request');
  if (current.cancellationRequests.length > 0 || closedStatuses.has(current.status) || current.status === SellerOrderStatus.PENDING_PAYMENT) throw conflict('SELLER_ORDER_NOT_CANCELLABLE', 'This seller order cannot request cancellation');
  const changed = await tx.sellerOrder.updateMany({ where: { id: current.id, version: args.expectedVersion }, data: { status: SellerOrderStatus.CANCELLATION_REQUESTED, version: { increment: 1 }, autoCompleteAt: null } });
  if (changed.count !== 1) throw conflict('SELLER_ORDER_CHANGED', 'Seller order was modified by another request');
  await tx.affiliateCancellationRequest.create({ data: { sellerOrderId: current.id, affiliateId: args.affiliateId, previousStatus: current.status, previousAutoCompleteAt: current.autoCompleteAt, reason: args.reason } });
  await tx.sellerOrderHistory.create({ data: { sellerOrderId: current.id, fromStatus: current.status, toStatus: SellerOrderStatus.CANCELLATION_REQUESTED, note: args.reason, changedByType: 'AFFILIATE', changedById: args.actorId } });
  await reconcileParentOrder(tx, current.orderId);
  return tx.sellerOrder.findUniqueOrThrow({ where: { id: current.id } });
}

export async function createBuyerIssue(tx: Db, args: { sellerOrderId: string; userId: string; reason: string }) {
  const current = await tx.sellerOrder.findFirst({ where: { id: args.sellerOrderId, order: { userId: args.userId } }, include: { order: true, issues: { where: { status: AffiliateIssueStatus.OPEN } } } });
  if (!current || !current.affiliateId) throw notFound('Seller order not found');
  if (current.issues.length > 0) throw conflict('ISSUE_ALREADY_OPEN', 'This seller order already has an open incident');
  if (closedStatuses.has(current.status)) throw conflict('SELLER_ORDER_CLOSED', 'Closed seller orders cannot receive incidents');
  await tx.affiliateIssue.create({ data: { sellerOrderId: current.id, affiliateId: current.affiliateId, openedByUserId: args.userId, reason: args.reason, previousStatus: current.status, previousAutoCompleteAt: current.autoCompleteAt } });
  await tx.sellerOrder.update({ where: { id: current.id }, data: { status: SellerOrderStatus.DISPUTED, version: { increment: 1 }, autoCompleteAt: null } });
  await tx.sellerOrderHistory.create({ data: { sellerOrderId: current.id, fromStatus: current.status, toStatus: SellerOrderStatus.DISPUTED, note: 'Buyer reported an issue', changedByType: 'USER', changedById: args.userId } });
  await reconcileParentOrder(tx, current.orderId);
  return tx.affiliateIssue.findFirstOrThrow({ where: { sellerOrderId: current.id, status: AffiliateIssueStatus.OPEN } });
}

export type RefundLineInput = { orderItemId: string; quantity: number; amountMinor: bigint };

export async function recordAffiliateRefund(tx: Db, args: { sellerOrderId: string; paymentId: string; amountMinor: bigint; subtotalMinor?: bigint; shippingMinor?: bigint; reason: string; externalReference: string; createdById: string; restock?: boolean; lines?: RefundLineInput[]; dedupeKey: string }) {
  if (args.amountMinor <= 0n) throw badRequest('REFUND_AMOUNT_INVALID', 'Refund amount must be positive');
  const sellerOrder = await tx.sellerOrder.findUnique({ where: { id: args.sellerOrderId } });
  if (!sellerOrder) throw notFound('Seller order not found');
  const already = await tx.refundRecord.findUnique({ where: { fullRefundKey: args.dedupeKey } });
  if (already) return already;
  const refundCap = sellerOrder.subtotalMinor + sellerOrder.shippingMinor;
  const previousRefunds = await tx.refundRecord.aggregate({ _sum: { amountMinor: true }, where: { sellerOrderId: sellerOrder.id } });
  const previousRefundMinor = previousRefunds._sum.amountMinor ?? 0n;
  if (previousRefundMinor + args.amountMinor > refundCap) throw conflict('REFUND_EXCEEDS_SELLER_ORDER', 'The cumulative refund exceeds this seller order total');
  const subtotalMinor = args.subtotalMinor ?? (args.amountMinor < sellerOrder.subtotalMinor ? args.amountMinor : sellerOrder.subtotalMinor);
  const shippingMinor = args.shippingMinor ?? (args.amountMinor > subtotalMinor ? args.amountMinor - subtotalMinor : 0n);
  if (subtotalMinor < 0n || subtotalMinor > sellerOrder.subtotalMinor || shippingMinor < 0n || shippingMinor > sellerOrder.shippingMinor || subtotalMinor + shippingMinor !== args.amountMinor) {
    throw badRequest('REFUND_BREAKDOWN_INVALID', 'Refund product and shipping amounts must match the seller order and refund total');
  }
  const commissionReversedMinor = sellerOrder.subtotalMinor > 0n
    ? ((subtotalMinor < sellerOrder.subtotalMinor ? subtotalMinor : sellerOrder.subtotalMinor) * sellerOrder.commissionMinor) / sellerOrder.subtotalMinor
    : 0n;
  const sellerDebitMinor = args.amountMinor > commissionReversedMinor ? args.amountMinor - commissionReversedMinor : 0n;
  const refund = await tx.refundRecord.create({ data: { paymentId: args.paymentId, sellerOrderId: sellerOrder.id, fullRefundKey: args.dedupeKey, amountMinor: args.amountMinor, currency: BASE_CURRENCY, subtotalMinor, shippingMinor, commissionReversedMinor, sellerDebitMinor, restocked: Boolean(args.restock), reason: args.reason, externalReference: args.externalReference, createdById: args.createdById, ...(args.lines?.length ? { refundLines: { create: args.lines.map((line) => ({ ...line, restocked: Boolean(args.restock) })) } } : {}) } });
  if (args.restock) {
    const lines: Array<{ orderItemId: string; quantity: number }> = args.lines?.length ? args.lines.map((line) => ({ orderItemId: line.orderItemId, quantity: line.quantity })) : (await tx.orderItem.findMany({ where: { sellerOrderId: sellerOrder.id }, select: { id: true, quantity: true } })).map((item) => ({ orderItemId: item.id, quantity: item.quantity }));
    for (const line of lines) {
      const item = await tx.orderItem.findUnique({ where: { id: line.orderItemId } });
      if (!item?.productId) continue;
      await tx.inventory.update({ where: { productId: item.productId }, data: { onHand: { increment: line.quantity } } });
      await tx.inventoryAdjustment.create({ data: { productId: item.productId, delta: line.quantity, reason: `Refund restock ${refund.id}`, createdById: args.createdById } });
    }
  }
  if (sellerOrder.affiliateId) await reverseAffiliateLiability(tx, sellerOrder, sellerDebitMinor, `Refund ${refund.id}`, args.dedupeKey);
  const paymentRefunds = await tx.refundRecord.aggregate({ _sum: { amountMinor: true }, where: { paymentId: args.paymentId } });
  const payment = await tx.payment.findUniqueOrThrow({ where: { id: args.paymentId } });
  await tx.payment.update({ where: { id: payment.id }, data: { status: (paymentRefunds._sum.amountMinor ?? 0n) >= payment.amountMinor ? 'REFUNDED' : 'PARTIALLY_REFUNDED' } });
  return refund;
}

export async function refundSellerOrder(tx: Db, args: { sellerOrderId: string; expectedVersion: number; amountMinor: bigint; subtotalMinor?: bigint; shippingMinor?: bigint; reason: string; externalReference: string; createdById: string; restock?: boolean; lines?: RefundLineInput[] }) {
  const current = await tx.sellerOrder.findUnique({ where: { id: args.sellerOrderId }, include: { order: { include: { payment: true } } } });
  if (!current) throw notFound('Seller order not found');
  if (current.version !== args.expectedVersion) throw conflict('SELLER_ORDER_CHANGED', 'Seller order was modified by another request');
  if (!current.order.payment || current.order.payment.status === 'PENDING') throw conflict('SELLER_ORDER_NOT_REFUNDABLE', 'A seller order can only be refunded after payment is accredited');
  if (current.status === SellerOrderStatus.PENDING_PAYMENT || current.status === SellerOrderStatus.CANCELLED || current.status === SellerOrderStatus.REFUNDED) throw conflict('SELLER_ORDER_NOT_REFUNDABLE', 'This seller order cannot be refunded in its current state');
  const refund = await recordAffiliateRefund(tx, { sellerOrderId: current.id, paymentId: current.order.payment.id, amountMinor: args.amountMinor, subtotalMinor: args.subtotalMinor, shippingMinor: args.shippingMinor, reason: args.reason, externalReference: args.externalReference, createdById: args.createdById, restock: args.restock, lines: args.lines, dedupeKey: `seller-order:${current.id}:refund:${current.version}` });
  await tx.sellerOrder.update({ where: { id: current.id }, data: { status: SellerOrderStatus.REFUNDED, completedAt: null, autoCompleteAt: null, version: { increment: 1 } } });
  await tx.sellerOrderHistory.create({ data: { sellerOrderId: current.id, fromStatus: current.status, toStatus: SellerOrderStatus.REFUNDED, note: args.reason, changedByType: 'ADMIN', changedById: args.createdById } });
  await reconcileParentOrder(tx, current.orderId);
  return { order: await tx.sellerOrder.findUniqueOrThrow({ where: { id: current.id } }), refund };
}

export async function resolveAffiliateIssue(tx: Db, args: { issueId: string; expectedVersion: number; decision: 'CONTINUE' | 'COMPLETE' | 'PARTIAL_REFUND' | 'FULL_REFUND'; note: string; adminId: string; refund?: { amountMinor: bigint; externalReference: string; subtotalMinor?: bigint; shippingMinor?: bigint; restock?: boolean; lines?: RefundLineInput[] } }) {
  const issue = await tx.affiliateIssue.findUnique({ where: { id: args.issueId }, include: { sellerOrder: { include: { order: { include: { payment: true } } } } } });
  if (!issue) throw notFound('Affiliate issue not found');
  if (issue.status !== AffiliateIssueStatus.OPEN || issue.sellerOrder.version !== args.expectedVersion) throw conflict('ISSUE_CHANGED', 'The incident was already resolved or the seller order changed');
  if (args.decision === 'PARTIAL_REFUND' && !args.refund) throw badRequest('REFUND_DATA_REQUIRED', 'A refund amount and external reference are required');
  if (args.decision === 'FULL_REFUND' && (!args.refund || !issue.sellerOrder.order.payment)) throw badRequest('REFUND_DATA_REQUIRED', 'A full refund requires amount, payment and external reference');
  const now = new Date();
  if (args.decision === 'CONTINUE') {
    await tx.sellerOrder.update({ where: { id: issue.sellerOrder.id }, data: { status: issue.previousStatus, autoCompleteAt: issue.previousAutoCompleteAt, version: { increment: 1 } } });
    await tx.sellerOrderHistory.create({ data: { sellerOrderId: issue.sellerOrder.id, fromStatus: SellerOrderStatus.DISPUTED, toStatus: issue.previousStatus, note: args.note, changedByType: 'ADMIN', changedById: args.adminId } });
    await tx.affiliateIssue.update({ where: { id: issue.id }, data: { status: AffiliateIssueStatus.RESOLVED_CONTINUED, resolutionNote: args.note, resolvedById: args.adminId, resolvedAt: now, version: { increment: 1 } } });
  } else if (args.decision === 'COMPLETE' || args.decision === 'PARTIAL_REFUND') {
    if (args.decision === 'PARTIAL_REFUND' && args.refund && issue.sellerOrder.order.payment) await recordAffiliateRefund(tx, { sellerOrderId: issue.sellerOrder.id, paymentId: issue.sellerOrder.order.payment.id, ...args.refund, reason: args.note, createdById: args.adminId, dedupeKey: `issue:${issue.id}:partial` });
    await tx.sellerOrder.update({ where: { id: issue.sellerOrder.id }, data: { status: SellerOrderStatus.COMPLETED, completedAt: now, autoCompleteAt: null, version: { increment: 1 } } });
    await tx.sellerOrderHistory.create({ data: { sellerOrderId: issue.sellerOrder.id, fromStatus: SellerOrderStatus.DISPUTED, toStatus: SellerOrderStatus.COMPLETED, note: args.note, changedByType: 'ADMIN', changedById: args.adminId } });
    await releaseAffiliateEarnings(tx, issue.sellerOrder, args.note, `issue:${issue.id}`);
    await tx.affiliateIssue.update({ where: { id: issue.id }, data: { status: args.decision === 'PARTIAL_REFUND' ? AffiliateIssueStatus.RESOLVED_PARTIAL_REFUND : AffiliateIssueStatus.RESOLVED_COMPLETED, resolutionNote: args.note, resolvedById: args.adminId, resolvedAt: now, version: { increment: 1 } } });
  } else {
    if (!args.refund || !issue.sellerOrder.order.payment) throw badRequest('REFUND_DATA_REQUIRED', 'A full refund requires amount, payment and external reference');
    await recordAffiliateRefund(tx, { sellerOrderId: issue.sellerOrder.id, paymentId: issue.sellerOrder.order.payment.id, ...args.refund, reason: args.note, createdById: args.adminId, dedupeKey: `issue:${issue.id}:full` });
    await tx.sellerOrder.update({ where: { id: issue.sellerOrder.id }, data: { status: SellerOrderStatus.REFUNDED, completedAt: null, autoCompleteAt: null, version: { increment: 1 } } });
    await tx.sellerOrderHistory.create({ data: { sellerOrderId: issue.sellerOrder.id, fromStatus: SellerOrderStatus.DISPUTED, toStatus: SellerOrderStatus.REFUNDED, note: args.note, changedByType: 'ADMIN', changedById: args.adminId } });
    await tx.affiliateIssue.update({ where: { id: issue.id }, data: { status: AffiliateIssueStatus.RESOLVED_FULL_REFUND, resolutionNote: args.note, resolvedById: args.adminId, resolvedAt: now, version: { increment: 1 } } });
  }
  await reconcileParentOrder(tx, issue.sellerOrder.orderId);
  return tx.affiliateIssue.findUniqueOrThrow({ where: { id: issue.id } });
}

export async function resolveCancellation(tx: Db, args: { requestId: string; expectedVersion: number; decision: 'APPROVED' | 'REJECTED'; note: string; adminId: string; refund?: { amountMinor: bigint; externalReference: string; restock?: boolean; lines?: RefundLineInput[] } }) {
  const request = await tx.affiliateCancellationRequest.findUnique({ where: { id: args.requestId }, include: { sellerOrder: { include: { order: { include: { payment: true } } } } } });
  if (!request) throw notFound('Cancellation request not found');
  if (request.status !== 'REQUESTED' || request.version !== args.expectedVersion) throw conflict('CANCELLATION_CHANGED', 'The cancellation request was modified');
  if (args.decision === 'APPROVED' && ['APPROVED', 'PARTIALLY_REFUNDED'].includes(request.sellerOrder.order.payment?.status ?? '') && !args.refund) throw badRequest('REFUND_DATA_REQUIRED', 'A paid cancellation requires an external refund reference');
  if (args.decision === 'REJECTED') {
    await tx.affiliateCancellationRequest.update({ where: { id: request.id }, data: { status: 'REJECTED', resolutionNote: args.note, resolvedById: args.adminId, resolvedAt: new Date(), version: { increment: 1 } } });
    await tx.sellerOrder.update({ where: { id: request.sellerOrder.id }, data: { status: request.previousStatus, autoCompleteAt: request.previousAutoCompleteAt, version: { increment: 1 } } });
    await tx.sellerOrderHistory.create({ data: { sellerOrderId: request.sellerOrder.id, fromStatus: SellerOrderStatus.CANCELLATION_REQUESTED, toStatus: request.previousStatus, note: args.note, changedByType: 'ADMIN', changedById: args.adminId } });
  } else {
    if (args.refund && request.sellerOrder.order.payment) await recordAffiliateRefund(tx, { sellerOrderId: request.sellerOrder.id, paymentId: request.sellerOrder.order.payment.id, ...args.refund, reason: args.note, createdById: args.adminId, dedupeKey: `cancellation:${request.id}` });
    await tx.affiliateCancellationRequest.update({ where: { id: request.id }, data: { status: 'APPROVED', resolutionNote: args.note, resolvedById: args.adminId, resolvedAt: new Date(), version: { increment: 1 } } });
    const next = args.refund ? SellerOrderStatus.REFUNDED : SellerOrderStatus.CANCELLED;
    await tx.sellerOrder.update({ where: { id: request.sellerOrder.id }, data: { status: next, autoCompleteAt: null, version: { increment: 1 } } });
    await tx.sellerOrderHistory.create({ data: { sellerOrderId: request.sellerOrder.id, fromStatus: SellerOrderStatus.CANCELLATION_REQUESTED, toStatus: next, note: args.note, changedByType: 'ADMIN', changedById: args.adminId } });
  }
  await reconcileParentOrder(tx, request.sellerOrder.orderId);
  return tx.affiliateCancellationRequest.findUniqueOrThrow({ where: { id: request.id } });
}

export async function closeUnpaidSellerOrders(tx: Db, orderId: string, status: SellerOrderStatus, note: string) {
  const children = await tx.sellerOrder.findMany({ where: { orderId, status: SellerOrderStatus.PENDING_PAYMENT } });
  for (const child of children) {
    await tx.sellerOrder.update({ where: { id: child.id }, data: { status, version: { increment: 1 } } });
    await tx.sellerOrderHistory.create({ data: { sellerOrderId: child.id, fromStatus: child.status, toStatus: status, note, changedByType: 'SYSTEM' } });
  }
  return children.length;
}

export async function closeAndReverseAffiliateSellerOrdersOnParentRefund(tx: Db, orderId: string, adminId: string, note: string) {
  const children = await tx.sellerOrder.findMany({ where: { orderId } });
  for (const child of children) {
    const alreadyClosed = new Set<SellerOrderStatus>([SellerOrderStatus.CANCELLED, SellerOrderStatus.REFUNDED]).has(child.status);
    if (alreadyClosed) continue;
    if (child.affiliateId) {
      await reverseAffiliateLiability(tx, child, child.sellerNetMinor, note, `parent:${orderId}`);
    }
    if (!(new Set<SellerOrderStatus>([SellerOrderStatus.CANCELLED, SellerOrderStatus.REFUNDED])).has(child.status)) {
      await tx.sellerOrder.update({ where: { id: child.id }, data: { status: SellerOrderStatus.REFUNDED, autoCompleteAt: null, version: { increment: 1 } } });
      await tx.sellerOrderHistory.create({ data: { sellerOrderId: child.id, fromStatus: child.status, toStatus: SellerOrderStatus.REFUNDED, note, changedByType: 'ADMIN', changedById: adminId } });
    }
  }
  return children.length;
}

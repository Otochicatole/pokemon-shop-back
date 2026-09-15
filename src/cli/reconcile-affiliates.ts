import { AffiliateLedgerBucket, AffiliateLedgerType, OrderStatus, SellerOrderStatus, PrismaClient } from '@prisma/client';
import { configureSqlite } from '../infrastructure/prisma.js';
import { releaseAffiliateEarnings, reconcileParentOrder } from '../modules/affiliates/affiliate-marketplace-service.js';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');
const activeFulfillmentStatuses = new Set<SellerOrderStatus>([
  SellerOrderStatus.PAID,
  SellerOrderStatus.PREPARING,
  SellerOrderStatus.READY_FOR_PICKUP,
  SellerOrderStatus.PICKED_UP,
  SellerOrderStatus.SHIPPED,
]);
const terminalStatuses = new Set<SellerOrderStatus>([
  SellerOrderStatus.CANCELLED,
  SellerOrderStatus.REFUNDED,
]);

function expectedParentStatus(statuses: SellerOrderStatus[]): OrderStatus | null {
  if (statuses.length === 0) return null;
  const all = (values: SellerOrderStatus[]) => statuses.every((status) => values.includes(status));
  const any = (values: SellerOrderStatus[]) => statuses.some((status) => values.includes(status));
  if (any([SellerOrderStatus.DISPUTED, SellerOrderStatus.CANCELLATION_REQUESTED])) return OrderStatus.ACTION_REQUIRED;
  if (all([SellerOrderStatus.COMPLETED])) return OrderStatus.COMPLETED;
  if (all([SellerOrderStatus.CANCELLED, SellerOrderStatus.REFUNDED])) return OrderStatus.CANCELLED;
  if (any([SellerOrderStatus.COMPLETED]) && any([...activeFulfillmentStatuses])) return OrderStatus.PARTIALLY_COMPLETED;
  if (any([...activeFulfillmentStatuses].filter((status) => status !== SellerOrderStatus.PAID))) return OrderStatus.IN_FULFILLMENT;
  if (all([SellerOrderStatus.PAID])) return OrderStatus.PAID;
  if (all([SellerOrderStatus.PENDING_PAYMENT])) return OrderStatus.PENDING_PAYMENT;
  return OrderStatus.PAID;
}

type Finding = { kind: string; id: string; detail: string };

async function main() {
  await configureSqlite();
  const findings: Finding[] = [];
  const [orders, sellerOrders, duplicateIssues] = await Promise.all([
    prisma.order.findMany({ select: { id: true, number: true, status: true, sellerOrders: { select: { status: true } } } }),
    prisma.sellerOrder.findMany({ where: { affiliateId: { not: null } }, include: { affiliate: true, order: { select: { number: true } } } }),
    prisma.affiliateIssue.groupBy({ by: ['sellerOrderId'], where: { status: 'OPEN' }, _count: { _all: true }, having: { sellerOrderId: { _count: { gt: 1 } } } }),
  ]);

  for (const order of orders) {
    const expected = expectedParentStatus(order.sellerOrders.map((child) => child.status));
    if (expected && expected !== order.status) {
      findings.push({ kind: 'PARENT_STATUS', id: order.id, detail: `${order.number}: ${order.status} -> ${expected}` });
      if (apply) await prisma.$transaction((tx) => reconcileParentOrder(tx, order.id, 'Affiliate reconciliation'));
    }
  }

  for (const sellerOrder of sellerOrders) {
    const ledger = await prisma.affiliateLedgerEntry.aggregate({
      _sum: { amountMinor: true },
      where: { affiliateId: sellerOrder.affiliateId!, sellerOrderId: sellerOrder.id, bucket: AffiliateLedgerBucket.PENDING },
    });
    const pending = ledger._sum.amountMinor ?? 0n;
    const needsPending = activeFulfillmentStatuses.has(sellerOrder.status) && pending <= 0n;
    const needsCompletedRelease = sellerOrder.status === SellerOrderStatus.COMPLETED && pending <= 0n && !(await prisma.affiliateLedgerEntry.findFirst({ where: { sellerOrderId: sellerOrder.id, type: AffiliateLedgerType.SALE_RELEASED } }));
    if (needsPending || needsCompletedRelease) {
      findings.push({ kind: 'MISSING_SALE_LEDGER', id: sellerOrder.id, detail: `${sellerOrder.order.number}: ${sellerOrder.status}, sellerNet=${sellerOrder.sellerNetMinor.toString()}` });
      if (apply) {
        await prisma.$transaction(async (tx) => {
          await tx.affiliateLedgerEntry.upsert({
            where: { dedupeKey: `reconcile:sale-pending:${sellerOrder.id}` },
            create: { affiliateId: sellerOrder.affiliateId!, sellerOrderId: sellerOrder.id, bucket: AffiliateLedgerBucket.PENDING, type: AffiliateLedgerType.SALE_PENDING, amountMinor: sellerOrder.sellerNetMinor, dedupeKey: `reconcile:sale-pending:${sellerOrder.id}`, note: 'Repaired by affiliate reconciliation' },
            update: {},
          });
          if (needsCompletedRelease) await releaseAffiliateEarnings(tx, sellerOrder, 'Repaired completed sale', 'reconcile');
        });
      }
    }

    if (terminalStatuses.has(sellerOrder.status)) {
      const positiveObligation = await prisma.affiliateLedgerEntry.aggregate({ _sum: { amountMinor: true }, where: { sellerOrderId: sellerOrder.id, bucket: { in: [AffiliateLedgerBucket.PENDING, AffiliateLedgerBucket.RESERVED] } } });
      if ((positiveObligation._sum.amountMinor ?? 0n) !== 0n) findings.push({ kind: 'CLOSED_ORDER_BALANCE', id: sellerOrder.id, detail: `${sellerOrder.order.number}: obligation=${(positiveObligation._sum.amountMinor ?? 0n).toString()}` });
    }
  }

  for (const duplicate of duplicateIssues) findings.push({ kind: 'DUPLICATE_OPEN_ISSUE', id: duplicate.sellerOrderId, detail: `open issues=${duplicate._count._all}` });

  const result = {
    mode: apply ? 'apply' : 'dry-run',
    scanned: { parentOrders: orders.length, affiliateSellerOrders: sellerOrders.length },
    findings: findings.length,
    repairs: apply ? findings.filter((finding) => finding.kind === 'PARENT_STATUS' || finding.kind === 'MISSING_SALE_LEDGER').length : 0,
    details: findings.slice(0, 100),
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect();
});

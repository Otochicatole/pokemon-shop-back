import type { PrismaClient } from '@prisma/client';

export async function completeDueSellerOrders(prisma: PrismaClient) {
  const due = await prisma.sellerOrder.findMany({ where: { status: { in: ['SHIPPED', 'PICKED_UP'] }, autoCompleteAt: { lte: new Date() }, issues: { none: { status: 'OPEN' } } }, take: 100 });
  let completed = 0;
  for (const sellerOrder of due) {
    await prisma.$transaction(async (tx) => {
      const changed = await tx.sellerOrder.updateMany({ where: { id: sellerOrder.id, version: sellerOrder.version, status: sellerOrder.status }, data: { status: 'COMPLETED', completedAt: new Date(), autoCompleteAt: null, version: { increment: 1 } } });
      if (changed.count !== 1) return;
      await tx.sellerOrderHistory.create({ data: { sellerOrderId: sellerOrder.id, fromStatus: sellerOrder.status, toStatus: 'COMPLETED', note: 'Automatically completed after the delivery window', changedByType: 'SYSTEM' } });
      if (!sellerOrder.affiliateId) return;
      const pending = await tx.affiliateLedgerEntry.findFirst({ where: { sellerOrderId: sellerOrder.id, type: 'SALE_PENDING', bucket: 'PENDING' } });
      if (!pending) return;
      await tx.affiliateLedgerEntry.create({ data: { affiliateId: sellerOrder.affiliateId, sellerOrderId: sellerOrder.id, bucket: 'PENDING', type: 'SALE_RELEASED', amountMinor: -sellerOrder.sellerNetMinor, note: 'Automatic completion' } });
      await tx.affiliateLedgerEntry.create({ data: { affiliateId: sellerOrder.affiliateId, sellerOrderId: sellerOrder.id, bucket: 'AVAILABLE', type: 'SALE_RELEASED', amountMinor: sellerOrder.sellerNetMinor, note: 'Automatic completion' } });
    });
    completed += 1;
  }
  return completed;
}

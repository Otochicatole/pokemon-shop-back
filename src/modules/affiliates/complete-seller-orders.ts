import type { PrismaClient } from '@prisma/client';
import { AffiliateIssueStatus, SellerOrderStatus } from '@prisma/client';
import { transitionSellerOrder } from './affiliate-marketplace-service.js';

export async function completeDueSellerOrders(prisma: PrismaClient) {
  const due = await prisma.sellerOrder.findMany({ where: { status: { in: [SellerOrderStatus.SHIPPED, SellerOrderStatus.PICKED_UP] }, autoCompleteAt: { lte: new Date() }, issues: { none: { status: AffiliateIssueStatus.OPEN } } }, take: 100 });
  let completed = 0;
  for (const sellerOrder of due) {
    await prisma.$transaction(async (tx) => {
      await transitionSellerOrder(tx, { sellerOrderId: sellerOrder.id, expectedVersion: sellerOrder.version, nextStatus: SellerOrderStatus.COMPLETED, actor: 'SYSTEM', note: 'Automatically completed after the delivery window' });
    });
    completed += 1;
  }
  return completed;
}

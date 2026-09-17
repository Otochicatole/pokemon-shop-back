import type { PrismaClient } from '@prisma/client';
import { AffiliateIssueStatus, SellerOrderStatus } from '@prisma/client';
import { transitionSellerOrder } from './affiliate-marketplace-service.js';
import {
  createBuyerSellerOrderStatusNotification,
  createSellerOrderStatusNotification,
  publishNotifications,
} from '../notifications/index.js';
import type { SupportRealtimeHub } from '../support/support-realtime.js';

export async function completeDueSellerOrders(prisma: PrismaClient, realtime?: SupportRealtimeHub) {
  const due = await prisma.sellerOrder.findMany({
    where: {
      status: { in: [SellerOrderStatus.SHIPPED, SellerOrderStatus.PICKED_UP] },
      autoCompleteAt: { lte: new Date() },
      issues: { none: { status: AffiliateIssueStatus.OPEN } },
    },
    take: 100,
  });
  let completed = 0;
  for (const sellerOrder of due) {
    await prisma.$transaction(async (tx) => {
      await transitionSellerOrder(tx, {
        sellerOrderId: sellerOrder.id,
        expectedVersion: sellerOrder.version,
        nextStatus: SellerOrderStatus.COMPLETED,
        actor: 'SYSTEM',
        note: 'Automatically completed after the delivery window',
      });
    });
    const context = await prisma.sellerOrder.findUniqueOrThrow({
      where: { id: sellerOrder.id },
      include: { affiliate: true, order: { select: { id: true, number: true, userId: true } } },
    });
    const noticeIds: string[] = [
      (await createBuyerSellerOrderStatusNotification(
        prisma,
        context.order,
        context.id,
        context.status,
        `auto-complete:${context.version}`,
      )).id,
    ];
    if (context.affiliate) {
      noticeIds.push((await createSellerOrderStatusNotification(
        prisma,
        { id: context.id, orderNumber: context.order.number, affiliateUserId: context.affiliate.userId },
        context.status,
        `auto-complete:${context.version}`,
      )).id);
    }
    if (realtime) await publishNotifications(prisma, realtime, noticeIds);
    completed += 1;
  }
  return completed;
}

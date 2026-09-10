import type { PrismaClient, Prisma } from '@prisma/client';
import { OrderStatus } from '@prisma/client';
import { releaseOrderLoyaltyReservation } from '../../loyalty/index.js';
import { createOrderStatusNotification, publishNotifications } from '../../notifications/index.js';
import type { SupportRealtimeHub } from '../../support/support-realtime.js';

export interface ReservationExpiryDependencies {
  prisma: PrismaClient;
  writeCoordinator: { run<T>(work: () => Promise<T>): Promise<T> };
  realtime?: SupportRealtimeHub;
}

export class ExpireReservations {
  public constructor(private readonly dependencies: ReservationExpiryDependencies) {}

  public async execute(now = new Date()): Promise<void> {
    const orders = await this.dependencies.prisma.order.findMany({ where: { expiresAt: { lt: now }, status: { in: [OrderStatus.PENDING_PAYMENT, OrderStatus.PAYMENT_REVIEW] } }, select: { id: true } });
    for (const order of orders) {
      const notificationIds = await this.dependencies.writeCoordinator.run(() => this.dependencies.prisma.$transaction(async (tx) => {
        const current = await tx.order.findUnique({ where: { id: order.id } });
        if (!current || (current.status !== OrderStatus.PENDING_PAYMENT && current.status !== OrderStatus.PAYMENT_REVIEW) || !current.expiresAt || current.expiresAt > now) return [] as string[];
        await tx.order.update({ where: { id: current.id }, data: { status: OrderStatus.EXPIRED, version: { increment: 1 } } });
        const history = await tx.orderStatusHistory.create({ data: { orderId: current.id, fromStatus: current.status, toStatus: OrderStatus.EXPIRED, note: 'Payment window expired' } });
        await releaseReservations(tx, current.id, now);
        await releaseOrderLoyaltyReservation(tx, current.id);
        return [(await createOrderStatusNotification(tx, current, history)).id];
      }));
      if (this.dependencies.realtime && notificationIds.length) await publishNotifications(this.dependencies.prisma, this.dependencies.realtime, notificationIds);
    }
  }
}

async function releaseReservations(tx: Prisma.TransactionClient, orderId: string, now: Date) {
  const reservations = await tx.inventoryReservation.findMany({ where: { orderId, releasedAt: null, consumedAt: null } });
  for (const reservation of reservations) {
    await tx.inventory.update({ where: { productId: reservation.productId }, data: { reserved: { decrement: reservation.quantity }, version: { increment: 1 } } });
    await tx.inventoryReservation.update({ where: { id: reservation.id }, data: { releasedAt: now } });
  }
}

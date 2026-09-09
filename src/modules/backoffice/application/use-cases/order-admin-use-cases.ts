import type { OrderAdminRepository } from '../ports.js';
import type { AdminActor, OrderListQuery, OrderStatusValue } from '../../domain/admin-cms.js';

export class OrderAdminUseCases {
  public constructor(private readonly orders: OrderAdminRepository) {}

  list(query: OrderListQuery) { return this.orders.listOrders(query); }
  get(number: string) { return this.orders.getOrder(number); }
  cancel(actor: AdminActor, number: string, expectedVersion: number, note?: string) {
    return this.orders.cancelOrder(actor, number, expectedVersion, note);
  }
  transition(actor: AdminActor, number: string, expectedVersion: number, status: OrderStatusValue, note?: string) {
    return this.orders.transitionOrder(actor, number, expectedVersion, status, note);
  }
}

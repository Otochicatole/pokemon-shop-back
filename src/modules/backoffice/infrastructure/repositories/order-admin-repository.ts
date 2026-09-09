import type { OrderAdminRepository } from '../../application/ports.js';
import type { AdminActor, OrderListQuery, OrderStatusValue } from '../../domain/admin-cms.js';

export class OrderAdminRepositoryAdapter implements OrderAdminRepository {
  public constructor(private readonly source: OrderAdminRepository) {}
  listOrders(query: OrderListQuery) { return this.source.listOrders(query); }
  getOrder(number: string) { return this.source.getOrder(number); }
  cancelOrder(actor: AdminActor, number: string, expectedVersion: number, note?: string) { return this.source.cancelOrder(actor, number, expectedVersion, note); }
  transitionOrder(actor: AdminActor, number: string, expectedVersion: number, status: OrderStatusValue, note?: string) { return this.source.transitionOrder(actor, number, expectedVersion, status, note); }
}

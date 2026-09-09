import type { InventoryAdminRepository } from '../ports.js';
import type { AdminActor, ProductListQuery } from '../../domain/admin-cms.js';

export class InventoryAdminUseCases {
  public constructor(private readonly inventory: InventoryAdminRepository) {}

  list(query: ProductListQuery) { return this.inventory.listInventory(query); }
  listAdjustments(productId: string, cursor: string | undefined, limit: number) {
    return this.inventory.listInventoryAdjustments(productId, cursor, limit);
  }
  adjust(actor: AdminActor, productId: string, delta: number, reason: string) {
    return this.inventory.adjustInventory(actor, productId, delta, reason);
  }
}

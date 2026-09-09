import type { InventoryAdminRepository } from '../../application/ports.js';
import type { AdminActor, ProductListQuery } from '../../domain/admin-cms.js';

export class InventoryAdminRepositoryAdapter implements InventoryAdminRepository {
  public constructor(private readonly source: InventoryAdminRepository) {}
  listInventory(query: ProductListQuery) { return this.source.listInventory(query); }
  listInventoryAdjustments(productId: string, cursor: string | undefined, limit: number) { return this.source.listInventoryAdjustments(productId, cursor, limit); }
  adjustInventory(actor: AdminActor, productId: string, delta: number, reason: string) { return this.source.adjustInventory(actor, productId, delta, reason); }
}

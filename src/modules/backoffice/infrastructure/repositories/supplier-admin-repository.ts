import type { SupplierAdminRepository } from '../../application/ports.js';
import type { AdminActor, SupplierListQuery, SupplierPatch, SupplierPurchaseWrite, SupplierWrite } from '../../domain/admin-cms.js';

export class SupplierAdminRepositoryAdapter implements SupplierAdminRepository {
  public constructor(private readonly source: SupplierAdminRepository) {}
  listSuppliers(query: SupplierListQuery) { return this.source.listSuppliers(query); }
  getSupplier(id: string) { return this.source.getSupplier(id); }
  createSupplier(actor: AdminActor, input: SupplierWrite) { return this.source.createSupplier(actor, input); }
  updateSupplier(actor: AdminActor, id: string, input: SupplierPatch) { return this.source.updateSupplier(actor, id, input); }
  setSupplierActive(actor: AdminActor, id: string, active: boolean, expectedVersion: number) { return this.source.setSupplierActive(actor, id, active, expectedVersion); }
  listSupplierPurchases(supplierId: string, cursor: string | undefined, limit: number) { return this.source.listSupplierPurchases(supplierId, cursor, limit); }
  getSupplierPurchase(supplierId: string, purchaseId: string) { return this.source.getSupplierPurchase(supplierId, purchaseId); }
  createSupplierPurchase(actor: AdminActor, supplierId: string, input: SupplierPurchaseWrite) { return this.source.createSupplierPurchase(actor, supplierId, input); }
  deleteSupplierPurchase(actor: AdminActor, supplierId: string, purchaseId: string) { return this.source.deleteSupplierPurchase(actor, supplierId, purchaseId); }
}

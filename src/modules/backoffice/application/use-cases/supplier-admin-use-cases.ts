import type { SupplierAdminRepository } from '../ports.js';
import type { AdminActor, SupplierListQuery, SupplierPatch, SupplierPurchaseWrite, SupplierWrite } from '../../domain/admin-cms.js';

export class SupplierAdminUseCases {
  public constructor(private readonly suppliers: SupplierAdminRepository) {}

  list(query: SupplierListQuery) { return this.suppliers.listSuppliers(query); }
  get(id: string) { return this.suppliers.getSupplier(id); }
  create(actor: AdminActor, input: SupplierWrite) { return this.suppliers.createSupplier(actor, input); }
  update(actor: AdminActor, id: string, input: SupplierPatch) { return this.suppliers.updateSupplier(actor, id, input); }
  setActive(actor: AdminActor, id: string, active: boolean, expectedVersion: number) {
    return this.suppliers.setSupplierActive(actor, id, active, expectedVersion);
  }
  listPurchases(supplierId: string, cursor: string | undefined, limit: number) {
    return this.suppliers.listSupplierPurchases(supplierId, cursor, limit);
  }
  getPurchase(supplierId: string, purchaseId: string) {
    return this.suppliers.getSupplierPurchase(supplierId, purchaseId);
  }
  createPurchase(actor: AdminActor, supplierId: string, input: SupplierPurchaseWrite) {
    return this.suppliers.createSupplierPurchase(actor, supplierId, input);
  }
  deletePurchase(actor: AdminActor, supplierId: string, purchaseId: string) {
    return this.suppliers.deleteSupplierPurchase(actor, supplierId, purchaseId);
  }
}

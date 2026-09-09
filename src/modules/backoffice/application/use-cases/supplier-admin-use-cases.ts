import type { SupplierAdminRepository } from '../ports.js';
import type { AdminActor, SupplierListQuery, SupplierPatch, SupplierWrite } from '../../domain/admin-cms.js';

export class SupplierAdminUseCases {
  public constructor(private readonly suppliers: SupplierAdminRepository) {}

  list(query: SupplierListQuery) { return this.suppliers.listSuppliers(query); }
  get(id: string) { return this.suppliers.getSupplier(id); }
  create(actor: AdminActor, input: SupplierWrite) { return this.suppliers.createSupplier(actor, input); }
  update(actor: AdminActor, id: string, input: SupplierPatch) { return this.suppliers.updateSupplier(actor, id, input); }
  setActive(actor: AdminActor, id: string, active: boolean, expectedVersion: number) {
    return this.suppliers.setSupplierActive(actor, id, active, expectedVersion);
  }
}

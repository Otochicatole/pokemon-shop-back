import type { SupplierAdminRepository } from '../../application/ports.js';
import type { AdminActor, SupplierListQuery, SupplierPatch, SupplierWrite } from '../../domain/admin-cms.js';

export class SupplierAdminRepositoryAdapter implements SupplierAdminRepository {
  public constructor(private readonly source: SupplierAdminRepository) {}
  listSuppliers(query: SupplierListQuery) { return this.source.listSuppliers(query); }
  getSupplier(id: string) { return this.source.getSupplier(id); }
  createSupplier(actor: AdminActor, input: SupplierWrite) { return this.source.createSupplier(actor, input); }
  updateSupplier(actor: AdminActor, id: string, input: SupplierPatch) { return this.source.updateSupplier(actor, id, input); }
  setSupplierActive(actor: AdminActor, id: string, active: boolean, expectedVersion: number) { return this.source.setSupplierActive(actor, id, active, expectedVersion); }
}

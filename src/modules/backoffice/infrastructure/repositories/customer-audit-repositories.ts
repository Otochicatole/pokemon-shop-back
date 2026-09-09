import type { AuditAdminRepository, CustomerAdminRepository } from '../../application/ports.js';
import type { AuditListQuery, CustomerListQuery } from '../../domain/admin-cms.js';

export class CustomerAdminRepositoryAdapter implements CustomerAdminRepository {
  public constructor(private readonly source: CustomerAdminRepository) {}
  listCustomers(query: CustomerListQuery) { return this.source.listCustomers(query); }
  getCustomer(id: string) { return this.source.getCustomer(id); }
  listCustomerOrders(id: string, cursor: string | undefined, limit: number) { return this.source.listCustomerOrders(id, cursor, limit); }
}

export class AuditAdminRepositoryAdapter implements AuditAdminRepository {
  public constructor(private readonly source: AuditAdminRepository) {}
  listAudit(query: AuditListQuery) { return this.source.listAudit(query); }
}

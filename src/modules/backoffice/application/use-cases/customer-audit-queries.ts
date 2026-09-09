import type { AuditAdminRepository, CustomerAdminRepository } from '../ports.js';
import type { AuditListQuery, CustomerListQuery } from '../../domain/admin-cms.js';

export class CustomerQueries {
  public constructor(private readonly customers: CustomerAdminRepository) {}
  list(query: CustomerListQuery) { return this.customers.listCustomers(query); }
  get(id: string) { return this.customers.getCustomer(id); }
  listOrders(id: string, cursor: string | undefined, limit: number) { return this.customers.listCustomerOrders(id, cursor, limit); }
}

export class AuditQueries {
  public constructor(private readonly audit: AuditAdminRepository) {}
  list(query: AuditListQuery) { return this.audit.listAudit(query); }
}

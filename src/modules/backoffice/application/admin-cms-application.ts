import type { AdminCmsRepositories } from './ports.js';
import type { DashboardDto } from './dtos.js';
import { AuditQueries, CustomerQueries } from './use-cases/customer-audit-queries.js';
import { DashboardQueries } from './use-cases/dashboard-queries.js';
import { FulfillmentAdminUseCases } from './use-cases/fulfillment-admin-use-cases.js';
import { InventoryAdminUseCases } from './use-cases/inventory-admin-use-cases.js';
import { OrderAdminUseCases } from './use-cases/order-admin-use-cases.js';
import { PaymentAdminUseCases } from './use-cases/payment-admin-use-cases.js';
import { ProductAdminUseCases } from './use-cases/product-admin-use-cases.js';
import { SupplierAdminUseCases } from './use-cases/supplier-admin-use-cases.js';
import { LoyaltyAdminUseCases } from './use-cases/loyalty-admin-use-cases.js';
import { TransferSettingsAdminUseCases } from './use-cases/transfer-settings-admin-use-cases.js';

export type AdminCmsApplication = {
  dashboard: DashboardQueries;
  products: ProductAdminUseCases;
  inventory: InventoryAdminUseCases;
  orders: OrderAdminUseCases;
  payments: PaymentAdminUseCases;
  fulfillment: FulfillmentAdminUseCases;
  customers: CustomerQueries;
  audit: AuditQueries;
  suppliers: SupplierAdminUseCases;
  loyalty: LoyaltyAdminUseCases;
  transferSettings: TransferSettingsAdminUseCases;
};

export type AdminCmsApplicationConfig = { integrations: DashboardDto['integrations'] | (() => Promise<DashboardDto['integrations']>) };

export function createAdminCmsApplication(repositories: AdminCmsRepositories, config: AdminCmsApplicationConfig): AdminCmsApplication {
  return {
    dashboard: new DashboardQueries(repositories.dashboard, config.integrations),
    products: new ProductAdminUseCases(repositories.products),
    inventory: new InventoryAdminUseCases(repositories.inventory),
    orders: new OrderAdminUseCases(repositories.orders),
    payments: new PaymentAdminUseCases(repositories.payments),
    fulfillment: new FulfillmentAdminUseCases(repositories.fulfillment),
    customers: new CustomerQueries(repositories.customers),
    audit: new AuditQueries(repositories.audit),
    suppliers: new SupplierAdminUseCases(repositories.suppliers),
    loyalty: new LoyaltyAdminUseCases(repositories.loyalty),
    transferSettings: new TransferSettingsAdminUseCases(repositories.transferSettings),
  };
}

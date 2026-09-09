import type { PrismaClient } from '@prisma/client';
import type { AdminCmsRepositories } from '../application/ports.js';
import { PrismaAdminCmsTransactionStore } from './prisma-admin-cms-transaction-store.js';
import { AuditAdminRepositoryAdapter, CustomerAdminRepositoryAdapter } from './repositories/customer-audit-repositories.js';
import { DashboardReaderAdapter } from './repositories/dashboard-reader.js';
import { FulfillmentAdminRepositoryAdapter } from './repositories/fulfillment-admin-repository.js';
import { InventoryAdminRepositoryAdapter } from './repositories/inventory-admin-repository.js';
import { OrderAdminRepositoryAdapter } from './repositories/order-admin-repository.js';
import { PaymentAdminRepositoryAdapter } from './repositories/payment-admin-repository.js';
import { ProductAdminRepositoryAdapter } from './repositories/product-admin-repository.js';

export type WriteCoordinator = { run<T>(operation: () => Promise<T>): Promise<T> };

/**
 * The transactional store is intentionally shared: order/payment/inventory mutations must
 * use the same SQLite coordinator and Prisma transaction. Narrow adapters keep every use
 * case dependent only on its own capability port.
 */
export function createPrismaAdminCmsRepositories(prisma: PrismaClient, coordinator: WriteCoordinator): AdminCmsRepositories {
  const store = new PrismaAdminCmsTransactionStore(prisma, coordinator);
  return {
    dashboard: new DashboardReaderAdapter(store),
    products: new ProductAdminRepositoryAdapter(store),
    inventory: new InventoryAdminRepositoryAdapter(store),
    orders: new OrderAdminRepositoryAdapter(store),
    payments: new PaymentAdminRepositoryAdapter(store),
    fulfillment: new FulfillmentAdminRepositoryAdapter(store),
    customers: new CustomerAdminRepositoryAdapter(store),
    audit: new AuditAdminRepositoryAdapter(store),
  };
}

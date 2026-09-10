import type {
  ActiveMutationDto, AuditEntryDto, CursorPageDto, CustomerDetailDto, CustomerSummaryDto,
  DashboardMetricsDto, FulfillmentDto, InventoryAdjustmentDto, InventoryMutationDto, OrderDetailDto,
  OrderDto, OrderStatusMutationDto, PickupPointResultDto, ProductDetailDto, ProductDto,
  ProductImageOrderDto, ProductImagesDto, ProductImageUpdateDto, ProductStatusDto, RefundDto,
  ShippingZoneResultDto, TransferReviewDto,
  SupplierActiveMutationDto, SupplierDetailDto, SupplierDto,
  LoyaltyProgramDto, TransferSettingsDto,
  NewsDetailDto, NewsDto,
} from './dtos.js';
import type {
  AdminActor, AuditListQuery, CustomerListQuery, OrderListQuery, OrderStatusValue,
  ProductListQuery, ProductPatch, ProductWrite, SupplierListQuery, SupplierPatch, SupplierWrite,
  LoyaltyProgramWrite, TransferSettingsWrite,
  NewsListQuery, NewsPatch, NewsWrite,
} from '../domain/admin-cms.js';

export interface DashboardReader {
  dashboard(range: 'TODAY' | '7D' | '30D'): Promise<DashboardMetricsDto>;
}

export interface ProductAdminRepository {
  listProducts(query: ProductListQuery): Promise<CursorPageDto<ProductDto>>;
  getProduct(id: string): Promise<ProductDetailDto>;
  createProduct(actor: AdminActor, input: ProductWrite): Promise<ProductDetailDto>;
  updateProduct(actor: AdminActor, id: string, input: ProductPatch): Promise<ProductDetailDto>;
  setProductStatus(actor: AdminActor, id: string, expectedVersion: number, status: 'PUBLISHED' | 'ARCHIVED'): Promise<ProductStatusDto>;
  addProductImages(actor: AdminActor, productId: string, expectedVersion: number, files: readonly { id: string; altText?: string }[], options?: { prepend?: boolean }): Promise<ProductImagesDto>;
  updateProductImage(actor: AdminActor, productId: string, imageId: string, expectedVersion: number, altText: string | null): Promise<ProductImageUpdateDto>;
  reorderProductImages(actor: AdminActor, productId: string, expectedVersion: number, imageIds: readonly string[]): Promise<ProductImageOrderDto>;
  retireProductImage(actor: AdminActor, productId: string, imageId: string, expectedVersion: number): Promise<void>;
}

export interface InventoryAdminRepository {
  listInventory(query: ProductListQuery): Promise<CursorPageDto<ProductDto>>;
  listInventoryAdjustments(productId: string, cursor: string | undefined, limit: number): Promise<CursorPageDto<InventoryAdjustmentDto>>;
  adjustInventory(actor: AdminActor, productId: string, delta: number, reason: string): Promise<InventoryMutationDto>;
}

export interface OrderAdminRepository {
  listOrders(query: OrderListQuery): Promise<CursorPageDto<OrderDto>>;
  getOrder(number: string): Promise<OrderDetailDto>;
  cancelOrder(actor: AdminActor, number: string, expectedVersion: number, note?: string): Promise<OrderStatusMutationDto>;
  transitionOrder(actor: AdminActor, number: string, expectedVersion: number, status: OrderStatusValue, note?: string): Promise<OrderStatusMutationDto>;
}

export interface PaymentAdminRepository {
  reviewTransfer(actor: AdminActor, number: string, receiptId: string, expectedVersion: number, decision: 'APPROVED' | 'REJECTED', note?: string): Promise<TransferReviewDto>;
  fulfillLatePayment(actor: AdminActor, number: string, expectedVersion: number): Promise<OrderStatusMutationDto>;
  recordFullRefund(actor: AdminActor, number: string, expectedVersion: number, reason: string, externalReference: string): Promise<RefundDto>;
  listPayments(query: OrderListQuery, queue?: 'TRANSFER_REVIEW' | 'MERCADO_PAGO_REVIEW'): Promise<CursorPageDto<OrderDto>>;
}

export interface FulfillmentAdminRepository {
  getFulfillment(): Promise<FulfillmentDto>;
  createShippingZone(actor: AdminActor, input: ShippingZoneWrite): Promise<ShippingZoneResultDto>;
  updateShippingZone(actor: AdminActor, id: string, input: ShippingZoneWrite): Promise<ShippingZoneResultDto>;
  setShippingZoneActive(actor: AdminActor, id: string, active: boolean): Promise<ActiveMutationDto>;
  createPickupPoint(actor: AdminActor, input: PickupPointWrite): Promise<PickupPointResultDto>;
  updatePickupPoint(actor: AdminActor, id: string, input: PickupPointWrite): Promise<PickupPointResultDto>;
  setPickupPointActive(actor: AdminActor, id: string, active: boolean): Promise<ActiveMutationDto>;
}

export interface CustomerAdminRepository {
  listCustomers(query: CustomerListQuery): Promise<CursorPageDto<CustomerSummaryDto>>;
  getCustomer(id: string): Promise<CustomerDetailDto>;
  listCustomerOrders(id: string, cursor: string | undefined, limit: number): Promise<CursorPageDto<OrderDto>>;
}

export interface AuditAdminRepository {
  listAudit(query: AuditListQuery): Promise<CursorPageDto<AuditEntryDto>>;
}

export interface SupplierAdminRepository {
  listSuppliers(query: SupplierListQuery): Promise<CursorPageDto<SupplierDto>>;
  getSupplier(id: string): Promise<SupplierDetailDto>;
  createSupplier(actor: AdminActor, input: SupplierWrite): Promise<SupplierDetailDto>;
  updateSupplier(actor: AdminActor, id: string, input: SupplierPatch): Promise<SupplierDetailDto>;
  setSupplierActive(actor: AdminActor, id: string, active: boolean, expectedVersion: number): Promise<SupplierActiveMutationDto>;
}

export interface LoyaltyAdminRepository {
  getLoyaltyProgram(): Promise<LoyaltyProgramDto>;
  updateLoyaltyProgram(actor: AdminActor, input: LoyaltyProgramWrite): Promise<LoyaltyProgramDto>;
}

export interface TransferSettingsAdminRepository {
  getTransferSettings(): Promise<TransferSettingsDto>;
  updateTransferSettings(actor: AdminActor, input: TransferSettingsWrite): Promise<TransferSettingsDto>;
}

export interface NewsAdminRepository {
  listNews(query: NewsListQuery): Promise<CursorPageDto<NewsDto>>;
  getNews(id: string): Promise<NewsDetailDto>;
  createNews(actor: AdminActor, input: NewsWrite): Promise<NewsDetailDto>;
  updateNews(actor: AdminActor, id: string, input: NewsPatch): Promise<NewsDetailDto>;
  deleteNews(actor: AdminActor, id: string, expectedVersion: number): Promise<void>;
}

export type AdminCmsRepositories = {
  dashboard: DashboardReader;
  products: ProductAdminRepository;
  inventory: InventoryAdminRepository;
  orders: OrderAdminRepository;
  payments: PaymentAdminRepository;
  fulfillment: FulfillmentAdminRepository;
  customers: CustomerAdminRepository;
  audit: AuditAdminRepository;
  suppliers: SupplierAdminRepository;
  loyalty: LoyaltyAdminRepository;
  transferSettings: TransferSettingsAdminRepository;
  news: NewsAdminRepository;
};

export type ShippingZoneWrite = {
  name: string;
  active: boolean;
  provinces: readonly string[];
  rates: readonly { id?: string; name: string; priceMinor: string; active: boolean }[];
};

export type PickupPointWrite = { name: string; address: string; active: boolean };

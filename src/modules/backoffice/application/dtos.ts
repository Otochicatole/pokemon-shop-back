import type {
  OrderStatusValue,
  PaymentMethodValue,
  PaymentStatusValue,
  PokemonTypeValue,
  ProductConditionValue,
  ProductKindValue,
  ProductStatusValue,
  StockModeValue,
} from '../domain/admin-cms.js';
import type { BaseCurrency } from '../../../shared/currency.js';

export type MoneyDto = { amountMinor: string; currency: BaseCurrency };
export type CursorPageDto<T> = { data: T[]; nextCursor: string | null };
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type LoyaltyProgramDto = {
  enabled: boolean;
  currency: BaseCurrency;
  spendPerPoint: MoneyDto;
  pointsPerStep: number;
  pointValue: MoneyDto;
  minimumRedemptionPoints: number;
  maximumRedemptionPercent: number;
  version: number;
  updatedAt: Date;
};

export type TransferSettingsDto = {
  enabled: boolean;
  bankName: string;
  accountHolder: string;
  cbu: string | null;
  alias: string | null;
  version: number;
  updatedAt: Date;
};

export type LoyaltyAccountDto = {
  balance: number;
  reserved: number;
  available: number;
  lifetimeEarned: number;
  lifetimeRedeemed: number;
};

export type DashboardDto = {
  range: 'TODAY' | '7D' | '30D';
  since: Date;
  revenue: { gross: MoneyDto; refunded: MoneyDto; net: MoneyDto; paidPayments: number; refunds: number };
  orders: { total: number; byStatus: Record<string, number> };
  products: { draft: number; published: number; archived: number; outOfStock: number; lowStock: number };
  attention: { transferReviews: number; mercadoPagoReviews: number };
  integrations: { bankTransfer: boolean; mercadoPago: boolean; smtp: boolean };
  recentOrders: Array<{ id: string; number: string; status: OrderStatusValue; total: MoneyDto; createdAt: Date }>;
  recentActivity: AuditEntryDto[];
};
export type DashboardMetricsDto = Omit<DashboardDto, 'integrations'>;

export type ProductImageDto = {
  id: string;
  fileId: string;
  url: string;
  altText: string | null;
  sortOrder: number;
  createdAt?: Date;
};

export type PokemonCardDto = {
  id: string;
  productId: string;
  pokemonType: PokemonTypeValue | null;
  setName: string;
  setCode: string | null;
  cardNumber: string;
  rarity: string;
  language: string;
  condition: ProductConditionValue;
  finish: string | null;
  edition: string | null;
  gradingCompany: string | null;
  grade: string | null;
  certificationNumber: string | null;
};

export type InventoryDto = { onHand: number; reserved: number; available: number; version: number };

export type ProductDto = {
  id: string;
  sku: string;
  slug: string;
  name: string;
  description: string;
  kind: ProductKindValue;
  stockMode: StockModeValue;
  status: ProductStatusValue;
  version: number;
  price: MoneyDto;
  inventory: InventoryDto | null;
  pokemonCard: PokemonCardDto | null;
  images: ProductImageDto[];
  publishedAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ProductDetailDto = { product: ProductDto };
export type ProductStatusDto = { id: string; status: 'PUBLISHED' | 'ARCHIVED'; version: number };
export type ProductImagesDto = { version: number; images: ProductImageDto[] };
export type ProductImageUpdateDto = { id: string; altText: string | null; version: number };
export type ProductImageOrderDto = { imageIds: readonly string[]; version: number };

export type InventoryAdjustmentDto = {
  id: string;
  productId: string;
  delta: number;
  reason: string;
  createdAt: Date;
  createdById: string;
  createdBy: { id: string; email: string; name: string | null };
};
export type InventoryMutationDto = { productId: string; onHand: number; reserved: number; available: number; version: number };

export type OrderCustomerDto = {
  id: string;
  email: string;
  name: string | null;
  status: 'ACTIVE' | 'SUSPENDED';
  emailVerifiedAt: Date | null;
  createdAt: Date;
};

export type ShipmentDto = {
  type: 'SHIPMENT';
  shippingRateId: string | null;
  zoneName: string | null;
  rateName: string | null;
  ratePrice: MoneyDto | null;
  recipientName: string | null;
  recipientPhone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
};

export type PickupDto = { type: 'PICKUP'; pickupPointId: string | null; name: string | null; address: string | null };

export type OrderDto = {
  id: string;
  number: string;
  version: number;
  status: OrderStatusValue;
  paymentMethod: PaymentMethodValue;
  fulfillmentType: 'SHIPMENT' | 'PICKUP';
  totals: { subtotal: MoneyDto; discount: MoneyDto; shipping: MoneyDto; total: MoneyDto };
  loyalty: {
    programVersion: number | null;
    pointsRedeemed: number;
    pointsDiscount: MoneyDto;
    pointsEarned: number;
    redemptionStatus: 'NONE' | 'RESERVED' | 'REDEEMED' | 'RELEASED' | 'RESTORED';
    spendPerPoint: MoneyDto | null;
    pointValue: MoneyDto | null;
  };
  customer: OrderCustomerDto;
  fulfillment: ShipmentDto | PickupDto;
  items: Array<{
    id: string;
    productId: string;
    sku: string;
    name: string;
    imageFileId: string | null;
    imageUrl: string | null;
    unitPrice: MoneyDto;
    quantity: number;
    lineTotal: MoneyDto;
    snapshot: JsonValue;
  }>;
  reservations: Array<{
    id: string;
    productId: string;
    quantity: number;
    expiresAt: Date;
    releasedAt: Date | null;
    consumedAt: Date | null;
  }>;
  payment: null | {
    id: string;
    method: PaymentMethodValue;
    status: PaymentStatusValue;
    amount: MoneyDto;
    providerReference: string | null;
    bankTransfer: null | { id: string; paymentId: string; reference: string; reviewStatus: 'PENDING' | 'APPROVED' | 'REJECTED'; reviewedAt: Date | null; reviewedById: string | null };
    mercadoPago: null | { id: string; paymentId: string; preferenceId: string | null; externalPaymentId: string | null; status: string | null; statusDetail: string | null; checkoutUrl: string | null; expiresAt: Date | null };
    refunds: Array<{ id: string; amount: MoneyDto; reason: string; externalReference: string; createdAt: Date }>;
  };
  receipts: Array<{ id: string; fileId: string; url: string; review: 'PENDING' | 'APPROVED' | 'REJECTED'; note: string | null; createdAt: Date; reviewedAt: Date | null; reviewedById: string | null }>;
  timeline: Array<{ id: string; orderId: string; fromStatus: OrderStatusValue | null; toStatus: OrderStatusValue; note: string | null; createdAt: Date; changedById: string | null }>;
  allowedActions: string[];
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type OrderDetailDto = { order: OrderDto };
export type OrderStatusMutationDto = { number: string; status: OrderStatusValue; version: number };
export type TransferReviewDto = { number: string; receiptId: string; decision: 'APPROVED' | 'REJECTED'; status: 'PAID' | 'CANCELLED'; version: number };
export type RefundDto = { refundId: string; number: string; status: 'REFUND_RECORDED'; amount: MoneyDto; version: number };

export type ShippingRateDto = { id: string; name: string; price: MoneyDto; active: boolean };
export type ShippingZoneDto = { id: string; name: string; active: boolean; provinces: string[]; rates: ShippingRateDto[]; createdAt: Date; updatedAt: Date };
export type PickupPointDto = { id: string; name: string; address: string; active: boolean; createdAt: Date; updatedAt: Date };
export type FulfillmentDto = { shippingZones: ShippingZoneDto[]; pickupPoints: PickupPointDto[] };
export type ShippingZoneResultDto = { shippingZone: ShippingZoneDto };
export type PickupPointResultDto = { pickupPoint: PickupPointDto };
export type ActiveMutationDto = { id: string; active: boolean };

export type SupplierDto = {
  id: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  active: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};
export type SupplierDetailDto = { supplier: SupplierDto };
export type SupplierActiveMutationDto = { id: string; active: boolean; version: number };

export type NewsDto = {
  id: string;
  title: string;
  summary: string;
  sortOrder: number;
  active: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};
export type NewsDetailDto = { news: NewsDto };

export type CustomerSummaryDto = OrderCustomerDto & { ordersCount: number; paidTotal: MoneyDto; loyalty: LoyaltyAccountDto };
export type CustomerDetailDto = {
  customer: OrderCustomerDto & { updatedAt: Date; ordersCount: number; paidTotal: MoneyDto; loyalty: LoyaltyAccountDto; orders: OrderDto[] };
};

export type AuditEntryDto = {
  id: string;
  actorType: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: JsonValue;
  requestId: string | null;
  createdAt: Date;
};

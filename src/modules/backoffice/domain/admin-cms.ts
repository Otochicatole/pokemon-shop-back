export const productStatuses = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export const productKinds = ['SINGLE_CARD', 'SEALED_PRODUCT', 'ACCESSORY'] as const;
export const stockModes = ['UNIQUE', 'QUANTITY'] as const;
export const pokemonTypes = ['COLORLESS', 'DARKNESS', 'DRAGON', 'FAIRY', 'FIGHTING', 'FIRE', 'GRASS', 'LIGHTNING', 'METAL', 'PSYCHIC', 'WATER'] as const;
export const productConditions = ['NM', 'EXCELLENT', 'GOOD', 'PLAYED', 'DAMAGED'] as const;
export const orderStatuses = ['PENDING_PAYMENT', 'PAYMENT_REVIEW', 'PAID', 'PREPARING', 'READY_FOR_PICKUP', 'SHIPPED', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'REFUND_RECORDED', 'PAYMENT_REQUIRES_REVIEW'] as const;
export const paymentMethods = ['BANK_TRANSFER', 'MERCADO_PAGO'] as const;
export const paymentStatuses = ['PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'FAILED', 'REFUNDED', 'DISPUTED', 'REQUIRES_REVIEW'] as const;

export type ProductStatusValue = typeof productStatuses[number];
export type ProductKindValue = typeof productKinds[number];
export type StockModeValue = typeof stockModes[number];
export type PokemonTypeValue = typeof pokemonTypes[number];
export type ProductConditionValue = typeof productConditions[number];
export type OrderStatusValue = typeof orderStatuses[number];
export type PaymentMethodValue = typeof paymentMethods[number];
export type PaymentStatusValue = typeof paymentStatuses[number];

export type AdminActor = { adminId: string; requestId?: string };
export type CursorPage = { cursor?: string; limit: number };

export type PokemonCardWrite = {
  pokemonType?: PokemonTypeValue | null;
  setName: string;
  setCode?: string | null;
  cardNumber: string;
  rarity: string;
  language: string;
  condition: ProductConditionValue;
  finish?: string | null;
  edition?: string | null;
  gradingCompany?: string | null;
  grade?: string | null;
  certificationNumber?: string | null;
};

export type ProductWrite = {
  sku: string;
  slug: string;
  name: string;
  description: string;
  kind: ProductKindValue;
  stockMode: StockModeValue;
  priceMinor: string;
  initialStock?: number;
  pokemonCard?: PokemonCardWrite | null;
};

export type ProductPatch = Partial<ProductWrite> & { expectedVersion: number };

export type ProductListQuery = CursorPage & {
  search?: string;
  status?: ProductStatusValue;
  kind?: ProductKindValue;
  stock?: 'AVAILABLE' | 'LOW' | 'OUT';
  pokemonType?: PokemonTypeValue;
  setName?: string;
};

export type OrderListQuery = CursorPage & {
  search?: string;
  status?: OrderStatusValue;
  paymentMethod?: PaymentMethodValue;
  paymentStatus?: PaymentStatusValue;
  fulfillmentType?: 'SHIPMENT' | 'PICKUP';
  from?: Date;
  to?: Date;
};

export type CustomerListQuery = CursorPage & { search?: string; status?: 'ACTIVE' | 'SUSPENDED'; verified?: boolean };
export type AuditListQuery = CursorPage & { actorId?: string; action?: string; entityType?: string; requestId?: string; from?: Date; to?: Date };

export const allowedOrderTransitions: Readonly<Record<OrderStatusValue, readonly OrderStatusValue[]>> = {
  PENDING_PAYMENT: [], PAYMENT_REVIEW: [],
  PAID: ['PREPARING'],
  PREPARING: ['READY_FOR_PICKUP', 'SHIPPED'],
  READY_FOR_PICKUP: ['COMPLETED'],
  SHIPPED: ['COMPLETED'],
  COMPLETED: [], CANCELLED: [], EXPIRED: [], REFUND_RECORDED: [], PAYMENT_REQUIRES_REVIEW: [],
};

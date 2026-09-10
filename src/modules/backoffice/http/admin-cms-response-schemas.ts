import { z } from 'zod';
import { BASE_CURRENCY } from '../../../shared/currency.js';
import {
  orderStatuses, paymentMethods, paymentStatuses, pokemonTypes, productConditions,
  productKinds, productStatuses, stockModes,
} from '../domain/admin-cms.js';

const dateTime = z.string().datetime();
const nullableDateTime = dateTime.nullable();

export const adminMoneySchema = z.object({ amountMinor: z.string().regex(/^\d+$/), currency: z.literal(BASE_CURRENCY) });
export const adminMetaSchema = z.object({ nextCursor: z.string().nullable().optional() });
export const adminEnvelopeSchema = <T extends z.ZodTypeAny>(data: T) => z.object({ data, meta: adminMetaSchema });

export const adminLoyaltyAccountSchema = z.object({
  balance: z.number().int(), reserved: z.number().int().nonnegative(), available: z.number().int().nonnegative(),
  lifetimeEarned: z.number().int().nonnegative(), lifetimeRedeemed: z.number().int().nonnegative(),
});
export const adminLoyaltyProgramSchema = z.object({
  enabled: z.boolean(), currency: z.literal(BASE_CURRENCY), spendPerPoint: adminMoneySchema,
  pointsPerStep: z.number().int().positive(), pointValue: adminMoneySchema,
  minimumRedemptionPoints: z.number().int().positive(), maximumRedemptionPercent: z.number().int().min(1).max(90),
  version: z.number().int().positive(), updatedAt: dateTime,
});

export const adminProductImageSchema = z.object({
  id: z.string().uuid(), fileId: z.string().uuid(), url: z.string(), altText: z.string().nullable(),
  sortOrder: z.number().int(), createdAt: dateTime.optional(),
});

export const adminPokemonCardSchema = z.object({
  id: z.string().uuid(), productId: z.string().uuid(), pokemonType: z.enum(pokemonTypes).nullable(),
  setName: z.string(), setCode: z.string().nullable(), cardNumber: z.string(), rarity: z.string(),
  language: z.string(), condition: z.enum(productConditions), finish: z.string().nullable(), edition: z.string().nullable(),
  gradingCompany: z.string().nullable(), grade: z.string().nullable(), certificationNumber: z.string().nullable(),
});

export const adminInventorySchema = z.object({
  onHand: z.number().int(), reserved: z.number().int(), available: z.number().int(), version: z.number().int(),
});

export const adminProductSchema = z.object({
  id: z.string().uuid(), sku: z.string(), slug: z.string(), name: z.string(), description: z.string(),
  kind: z.enum(productKinds), stockMode: z.enum(stockModes), status: z.enum(productStatuses), version: z.number().int(),
  price: adminMoneySchema, inventory: adminInventorySchema.nullable(), pokemonCard: adminPokemonCardSchema.nullable(),
  images: z.array(adminProductImageSchema), publishedAt: nullableDateTime, archivedAt: nullableDateTime,
  createdAt: dateTime, updatedAt: dateTime,
});

export const adminProductDetailDataSchema = z.object({ product: adminProductSchema });
export const adminProductStatusDataSchema = z.object({ id: z.string().uuid(), status: z.enum(['PUBLISHED', 'ARCHIVED']), version: z.number().int() });
export const adminProductImagesDataSchema = z.object({ version: z.number().int(), images: z.array(adminProductImageSchema) });
export const adminProductImageUpdateDataSchema = z.object({ id: z.string().uuid(), altText: z.string().nullable(), version: z.number().int() });
export const adminProductImageOrderDataSchema = z.object({ imageIds: z.array(z.string().uuid()), version: z.number().int() });

export const adminTcgdexCardSummarySchema = z.object({ id: z.string(), name: z.string(), localId: z.string(), setCode: z.string(), imageUrl: z.string().url().nullable(), setName: z.string().optional(), rarity: z.string().optional(), category: z.string().optional(), types: z.array(z.string()).optional(), firstEdition: z.boolean().optional(), holo: z.boolean().optional() });
export const adminTcgdexCardSchema = adminTcgdexCardSummarySchema.extend({ setName: z.string(), description: z.string(), rarity: z.string(), category: z.string(), types: z.array(z.string()), firstEdition: z.boolean(), holo: z.boolean(), effect: z.string(), language: z.literal('Español') });
export const adminTcgdexCardDataSchema = z.object({ card: adminTcgdexCardSchema });

export const adminInventoryAdjustmentSchema = z.object({
  id: z.string().uuid(), productId: z.string().uuid(), delta: z.number().int(), reason: z.string(),
  createdAt: dateTime, createdById: z.string().uuid(),
  createdBy: z.object({ id: z.string().uuid(), email: z.string().email(), name: z.string().nullable() }),
});
export const adminInventoryMutationDataSchema = z.object({
  productId: z.string().uuid(), onHand: z.number().int(), reserved: z.number().int(), available: z.number().int(), version: z.number().int(),
});

const adminOrderCustomerSchema = z.object({
  id: z.string().uuid(), email: z.string().email(), name: z.string().nullable(), status: z.enum(['ACTIVE', 'SUSPENDED']),
  emailVerifiedAt: nullableDateTime, createdAt: dateTime,
});
const adminShipmentSchema = z.object({
  type: z.literal('SHIPMENT'), shippingRateId: z.string().uuid().nullable(), zoneName: z.string().nullable(),
  rateName: z.string().nullable(), ratePrice: adminMoneySchema.nullable(), recipientName: z.string().nullable(),
  recipientPhone: z.string().nullable(), addressLine1: z.string().nullable(), addressLine2: z.string().nullable(),
  city: z.string().nullable(), province: z.string().nullable(), postalCode: z.string().nullable(),
});
const adminPickupSchema = z.object({
  type: z.literal('PICKUP'), pickupPointId: z.string().uuid().nullable(), name: z.string().nullable(), address: z.string().nullable(),
});
const adminOrderItemSchema = z.object({
  id: z.string().uuid(), productId: z.string().uuid(), sku: z.string(), name: z.string(),
  imageFileId: z.string().uuid().nullable(), imageUrl: z.string().nullable(), unitPrice: adminMoneySchema,
  quantity: z.number().int(), lineTotal: adminMoneySchema, snapshot: z.unknown(),
});
const adminReservationSchema = z.object({
  id: z.string().uuid(), productId: z.string().uuid(), quantity: z.number().int(), expiresAt: dateTime,
  releasedAt: nullableDateTime, consumedAt: nullableDateTime,
});
const adminBankTransferSchema = z.object({
  id: z.string().uuid(), paymentId: z.string().uuid(), reference: z.string(), reviewStatus: z.enum(['PENDING', 'APPROVED', 'REJECTED']),
  reviewedAt: nullableDateTime, reviewedById: z.string().uuid().nullable(),
});
const adminMercadoPagoSchema = z.object({
  id: z.string().uuid(), paymentId: z.string().uuid(), preferenceId: z.string().nullable(), externalPaymentId: z.string().nullable(),
  status: z.string().nullable(), statusDetail: z.string().nullable(), checkoutUrl: z.string().nullable(), expiresAt: nullableDateTime,
});
const adminRefundSchema = z.object({
  id: z.string().uuid(), amount: adminMoneySchema, reason: z.string(), externalReference: z.string(), createdAt: dateTime,
});
const adminPaymentSchema = z.object({
  id: z.string().uuid(), method: z.enum(paymentMethods), status: z.enum(paymentStatuses), amount: adminMoneySchema,
  providerReference: z.string().nullable(), bankTransfer: adminBankTransferSchema.nullable(),
  mercadoPago: adminMercadoPagoSchema.nullable(), refunds: z.array(adminRefundSchema),
});
const adminReceiptSchema = z.object({
  id: z.string().uuid(), fileId: z.string().uuid(), url: z.string(), review: z.enum(['PENDING', 'APPROVED', 'REJECTED']),
  note: z.string().nullable(), createdAt: dateTime, reviewedAt: nullableDateTime, reviewedById: z.string().uuid().nullable(),
});
const adminTimelineSchema = z.object({
  id: z.string().uuid(), orderId: z.string().uuid(), fromStatus: z.enum(orderStatuses).nullable(),
  toStatus: z.enum(orderStatuses), note: z.string().nullable(), createdAt: dateTime, changedById: z.string().uuid().nullable(),
});

export const adminOrderSchema = z.object({
  id: z.string().uuid(), number: z.string(), version: z.number().int(), status: z.enum(orderStatuses),
  paymentMethod: z.enum(paymentMethods), fulfillmentType: z.enum(['SHIPMENT', 'PICKUP']),
  totals: z.object({ subtotal: adminMoneySchema, discount: adminMoneySchema, shipping: adminMoneySchema, total: adminMoneySchema }),
  loyalty: z.object({
    programVersion: z.number().int().nullable(), pointsRedeemed: z.number().int().nonnegative(), pointsDiscount: adminMoneySchema,
    pointsEarned: z.number().int().nonnegative(), redemptionStatus: z.enum(['NONE', 'RESERVED', 'REDEEMED', 'RELEASED', 'RESTORED']),
    spendPerPoint: adminMoneySchema.nullable(), pointValue: adminMoneySchema.nullable(),
  }),
  customer: adminOrderCustomerSchema, fulfillment: z.discriminatedUnion('type', [adminShipmentSchema, adminPickupSchema]),
  items: z.array(adminOrderItemSchema), reservations: z.array(adminReservationSchema), payment: adminPaymentSchema.nullable(),
  receipts: z.array(adminReceiptSchema), timeline: z.array(adminTimelineSchema), allowedActions: z.array(z.string()),
  expiresAt: nullableDateTime, createdAt: dateTime, updatedAt: dateTime,
});
export const adminOrderDetailDataSchema = z.object({ order: adminOrderSchema });
export const adminOrderStatusDataSchema = z.object({ number: z.string(), status: z.enum(orderStatuses), version: z.number().int() });
export const adminTransferReviewDataSchema = z.object({
  number: z.string(), receiptId: z.string().uuid(), decision: z.enum(['APPROVED', 'REJECTED']),
  status: z.enum(['PAID', 'CANCELLED']), version: z.number().int(),
});
export const adminFullRefundDataSchema = z.object({
  refundId: z.string().uuid(), number: z.string(), status: z.literal('REFUND_RECORDED'), amount: adminMoneySchema, version: z.number().int(),
});

export const adminShippingRateSchema = z.object({ id: z.string().uuid(), name: z.string(), price: adminMoneySchema, active: z.boolean() });
export const adminShippingZoneSchema = z.object({
  id: z.string().uuid(), name: z.string(), active: z.boolean(), provinces: z.array(z.string()), rates: z.array(adminShippingRateSchema),
  createdAt: dateTime, updatedAt: dateTime,
});
export const adminPickupPointSchema = z.object({
  id: z.string().uuid(), name: z.string(), address: z.string(), active: z.boolean(), createdAt: dateTime, updatedAt: dateTime,
});
export const adminFulfillmentDataSchema = z.object({ shippingZones: z.array(adminShippingZoneSchema), pickupPoints: z.array(adminPickupPointSchema) });
export const adminShippingZoneResultDataSchema = z.object({ shippingZone: adminShippingZoneSchema });
export const adminPickupPointResultDataSchema = z.object({ pickupPoint: adminPickupPointSchema });
export const adminActiveMutationDataSchema = z.object({ id: z.string().uuid(), active: z.boolean() });

export const adminSupplierSchema = z.object({
  id: z.string().uuid(), name: z.string(), contactName: z.string().nullable(), email: z.string().email().nullable(),
  phone: z.string().nullable(), address: z.string().nullable(), notes: z.string().nullable(), active: z.boolean(),
  version: z.number().int(), createdAt: dateTime, updatedAt: dateTime,
});
export const adminSupplierDetailDataSchema = z.object({ supplier: adminSupplierSchema });
export const adminSupplierActiveMutationDataSchema = z.object({ id: z.string().uuid(), active: z.boolean(), version: z.number().int() });

export const adminCustomerSummarySchema = adminOrderCustomerSchema.extend({ ordersCount: z.number().int(), paidTotal: adminMoneySchema, loyalty: adminLoyaltyAccountSchema });
export const adminCustomerDetailDataSchema = z.object({
  customer: adminOrderCustomerSchema.extend({
    updatedAt: dateTime, ordersCount: z.number().int(), paidTotal: adminMoneySchema, loyalty: adminLoyaltyAccountSchema, orders: z.array(adminOrderSchema).max(20),
  }),
});
export const adminAuditEntrySchema = z.object({
  id: z.string().uuid(), actorType: z.string(), actorId: z.string().nullable(), action: z.string(), entityType: z.string(),
  entityId: z.string().nullable(), metadata: z.unknown(), requestId: z.string().nullable(), createdAt: dateTime,
});

export const adminDashboardDataSchema = z.object({
  range: z.enum(['TODAY', '7D', '30D']), since: dateTime,
  revenue: z.object({ gross: adminMoneySchema, refunded: adminMoneySchema, net: adminMoneySchema, paidPayments: z.number().int(), refunds: z.number().int() }),
  orders: z.object({ total: z.number().int(), byStatus: z.record(z.string(), z.number().int()) }),
  products: z.object({ draft: z.number().int(), published: z.number().int(), archived: z.number().int(), outOfStock: z.number().int(), lowStock: z.number().int() }),
  attention: z.object({ transferReviews: z.number().int(), mercadoPagoReviews: z.number().int() }),
  integrations: z.object({ bankTransfer: z.boolean(), mercadoPago: z.boolean(), smtp: z.boolean() }),
  recentOrders: z.array(z.object({ id: z.string().uuid(), number: z.string(), status: z.enum(orderStatuses), total: adminMoneySchema, createdAt: dateTime })),
  recentActivity: z.array(adminAuditEntrySchema),
});

import { z } from 'zod';
import {
  orderStatuses, paymentMethods, paymentStatuses, pokemonTypes, productConditions,
  productKinds, productStatuses, stockModes,
} from '../domain/admin-cms.js';

const emptyToUndefined = (value: unknown) => value === '' || value === null ? undefined : value;
const optionalText = (max: number) => z.preprocess(emptyToUndefined, z.string().trim().max(max).optional());
const nullableProductText = (max: number) => z.preprocess(
  (value) => value === '' ? null : value,
  z.string().trim().max(max).nullable().optional(),
);
const nullableTransferText = (max: number) => z.preprocess(
  (value) => value === '' || value === undefined ? null : value,
  z.string().trim().max(max).nullable(),
);
const booleanQuery = z.preprocess((value) => value === 'true' ? true : value === 'false' ? false : value, z.boolean().optional());
const cursorQuery = z.object({ cursor: optionalText(100), limit: z.coerce.number().int().min(1).max(100).default(20) });
const dateQuery = z.preprocess(emptyToUndefined, z.coerce.date().optional());

export const idParamsSchema = z.object({ id: z.string().uuid() });
export const productImageParamsSchema = z.object({ id: z.string().uuid(), imageId: z.string().uuid() });
export const tcgdexCardParamsSchema = z.object({ id: z.string().trim().min(2).max(120).regex(/^[A-Za-z0-9._-]+$/) });
export const tcgdexSearchQuerySchema = z.object({ q: z.string().trim().min(2).max(80) });
export const orderParamsSchema = z.object({ number: z.string().trim().min(5).max(40) });
export const transferReceiptParamsSchema = orderParamsSchema.extend({ receiptId: z.string().uuid() });

export const pokemonCardWriteSchema = z.object({
  pokemonType: z.enum(pokemonTypes).nullable().optional(), setName: z.string().trim().min(1).max(120), setCode: nullableProductText(40),
  cardNumber: z.string().trim().min(1).max(30), rarity: z.string().trim().min(1).max(80), language: z.string().trim().min(1).max(40),
  condition: z.enum(productConditions), finish: nullableProductText(50), edition: nullableProductText(80), gradingCompany: nullableProductText(80),
  grade: nullableProductText(30), certificationNumber: nullableProductText(100),
});

export const productWriteSchema = z.object({
  sku: z.string().trim().min(1).max(80), slug: z.string().trim().regex(/^[a-z0-9-]+$/).max(120),
  name: z.string().trim().min(1).max(180), description: z.string().trim().max(5000), kind: z.enum(productKinds),
  stockMode: z.enum(stockModes), priceMinor: z.string().regex(/^\d+$/), initialStock: z.number().int().min(0).max(1_000_000).optional(),
  stock: z.number().int().min(0).max(1_000_000).optional(), pokemonCard: pokemonCardWriteSchema.nullable().optional(),
});
export const productPatchSchema = productWriteSchema.omit({ initialStock: true, stock: true }).partial().extend({ expectedVersion: z.number().int().min(1) });
export const expectedVersionSchema = z.object({ expectedVersion: z.number().int().min(1) });
export const tcgdexImageImportSchema = expectedVersionSchema.extend({ imageUrl: z.string().url().max(500) });
export const productListQuerySchema = cursorQuery.extend({
  search: optionalText(180), status: z.enum(productStatuses).optional(), kind: z.enum(productKinds).optional(),
  stock: z.enum(['AVAILABLE', 'LOW', 'OUT']).optional(), pokemonType: z.enum(pokemonTypes).optional(), setName: optionalText(120),
});
export const imageUploadFieldsSchema = z.object({
  expectedVersion: z.coerce.number().int().min(1),
  altText: z.union([z.string().max(255), z.array(z.string().max(255))]).optional(),
});
export const imagePatchSchema = expectedVersionSchema.extend({ altText: z.string().trim().max(255).nullable() });
export const imageOrderSchema = expectedVersionSchema.extend({ imageIds: z.array(z.string().uuid()).max(8) });
export const inventoryAdjustmentSchema = z.object({ delta: z.number().int().min(-1_000_000).max(1_000_000).refine((value) => value !== 0, 'Delta cannot be zero'), reason: z.string().trim().min(3).max(500) });
export const cursorQuerySchema = cursorQuery;

export const orderListQuerySchema = cursorQuery.extend({
  search: optionalText(180), status: z.enum(orderStatuses).optional(), paymentMethod: z.enum(paymentMethods).optional(),
  paymentStatus: z.enum(paymentStatuses).optional(), fulfillmentType: z.enum(['SHIPMENT', 'PICKUP']).optional(), from: dateQuery, to: dateQuery,
});
export const orderActionSchema = expectedVersionSchema.extend({ note: optionalText(500) });
export const orderTransitionSchema = orderActionSchema.extend({ status: z.enum(orderStatuses) });
export const transferReviewSchema = orderActionSchema;
export const refundSchema = expectedVersionSchema.extend({ reason: z.string().trim().min(3).max(500), externalReference: z.string().trim().min(3).max(150) });
export const paymentsQuerySchema = orderListQuerySchema.extend({ queue: z.enum(['TRANSFER_REVIEW', 'MERCADO_PAGO_REVIEW']).optional() });

export const shippingRateWriteSchema = z.object({ id: z.string().uuid().optional(), name: z.string().trim().min(1).max(100), priceMinor: z.string().regex(/^\d+$/), active: z.boolean().default(true) });
export const shippingZoneWriteSchema = z.object({ name: z.string().trim().min(1).max(100), active: z.boolean().default(true), provinces: z.array(z.string().trim().min(1).max(100)).min(1).max(30), rates: z.array(shippingRateWriteSchema).min(1).max(20) });
export const pickupPointWriteSchema = z.object({ name: z.string().trim().min(1).max(100), address: z.string().trim().min(1).max(300), active: z.boolean().default(true) });
export const activeSchema = z.object({ active: z.boolean() });

const supplierOptionalText = (max: number) => z.preprocess(
  (value) => {
    if (value === null || value === undefined) return value;
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  },
  z.string().max(max).nullable().optional(),
);
export const supplierWriteSchema = z.object({
  name: z.string().trim().min(1).max(180),
  contactName: supplierOptionalText(120),
  email: z.preprocess(
    (value) => {
      if (value === null || value === undefined) return value;
      if (typeof value !== 'string') return value;
      const trimmed = value.trim();
      return trimmed === '' ? null : trimmed;
    },
    z.string().email().max(254).nullable().optional(),
  ),
  phone: supplierOptionalText(40),
  address: supplierOptionalText(300),
  notes: supplierOptionalText(2000),
});
export const supplierPatchSchema = supplierWriteSchema.partial().extend({ expectedVersion: z.number().int().min(1) });
export const supplierActiveSchema = activeSchema.extend({ expectedVersion: z.number().int().min(1) });
export const supplierListQuerySchema = cursorQuery.extend({ search: optionalText(180), active: booleanQuery });
const nullableNewsDate = z.preprocess(
  (value) => value === '' || value === undefined ? null : value,
  z.coerce.date().nullable(),
);
export const newsListQuerySchema = cursorQuery.extend({ search: optionalText(180), active: booleanQuery });
const newsFieldsSchema = z.object({
  title: z.string().trim().min(1).max(180),
  summary: z.string().trim().max(500),
  sortOrder: z.number().int().min(0).max(1_000_000),
  active: z.boolean().default(false),
  startsAt: nullableNewsDate,
  endsAt: nullableNewsDate,
});
export const newsWriteSchema = newsFieldsSchema.superRefine((value, context) => {
  if (value.startsAt && value.endsAt && value.startsAt >= value.endsAt) context.addIssue({ code: 'custom', path: ['endsAt'], message: 'La fecha de fin debe ser posterior al inicio' });
});
export const newsPatchSchema = newsFieldsSchema.partial().extend({ expectedVersion: z.number().int().min(1) }).superRefine((value, context) => {
  if (value.startsAt && value.endsAt && value.startsAt >= value.endsAt) context.addIssue({ code: 'custom', path: ['endsAt'], message: 'La fecha de fin debe ser posterior al inicio' });
});

export const customerListQuerySchema = cursorQuery.extend({ search: optionalText(180), status: z.enum(['ACTIVE', 'SUSPENDED']).optional(), verified: booleanQuery });
export const auditListQuerySchema = cursorQuery.extend({ actorId: z.string().uuid().optional(), action: optionalText(100), entityType: optionalText(100), requestId: optionalText(150), from: dateQuery, to: dateQuery });
export const dashboardQuerySchema = z.object({ range: z.enum(['TODAY', '7D', '30D']).default('7D') });

export const loyaltyProgramWriteSchema = z.object({
  enabled: z.boolean(),
  spendPerPointMinor: z.string().regex(/^[1-9]\d{0,14}$/),
  pointsPerStep: z.number().int().min(1).max(100),
  pointValueMinor: z.string().regex(/^[1-9]\d{0,14}$/),
  minimumRedemptionPoints: z.number().int().min(1).max(2_000_000_000),
  maximumRedemptionPercent: z.number().int().min(1).max(90),
  expectedVersion: z.number().int().min(1),
});

export const transferSettingsWriteSchema = z.object({
  enabled: z.boolean(),
  bankName: z.string().trim().max(120),
  accountHolder: z.string().trim().max(120),
  cbu: nullableTransferText(100),
  alias: nullableTransferText(100),
  expectedVersion: z.number().int().min(1),
}).superRefine((value, context) => {
  if (!value.enabled) return;
  if (!value.bankName || !value.accountHolder || (!value.cbu && !value.alias)) {
    context.addIssue({ code: 'custom', path: ['enabled'], message: 'Para activar la transferencia se requiere banco, titular y CBU o alias' });
  }
});

import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { z } from 'zod';
import { BASE_CURRENCY } from '../../shared/currency.js';
import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { env } from '../../config/env.js';
import { requireAdmin } from '../../infrastructure/sessions.js';
import {
  catalogFiltersSchema,
  catalogListQuerySchema,
  catalogMoneySchema,
  catalogProductSchema,
} from '../catalog/index.js';
import { adminLoginSchema, adminPrincipalSchema, csrfTokenSchema, profileUpdateSchema } from '../auth/index.js';
import { registerAdminCmsPaths } from './admin-docs.js';
import {
  createAdminSupportConversationSchema,
  createSupportMessageSchema,
  createUserSupportConversationSchema,
  markSupportReadSchema,
  supportStatusSchema,
  updateSupportStatusSchema,
} from '../support/index.js';
import { publicNewsItemSchema, publicNewsQuerySchema } from '../news/index.js';

extendZodWithOpenApi(z);
const moneySchema = catalogMoneySchema;
const providerMoneySchema = z.object({ amountMinor: z.string(), currency: z.literal('ARS') });
const problemSchema = z.object({
  type: z.string(),
  title: z.string(),
  detail: z.string().optional(),
  status: z.number().int(),
  code: z.string(),
  requestId: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
  issues: z.array(z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() })).optional(),
});
const dateTimeSchema = z.string().datetime();
const orderStatusSchema = z.enum(['PENDING_PAYMENT', 'PAYMENT_REVIEW', 'PAID', 'PREPARING', 'READY_FOR_PICKUP', 'SHIPPED', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'REFUND_RECORDED', 'PAYMENT_REQUIRES_REVIEW', 'IN_FULFILLMENT', 'PARTIALLY_COMPLETED', 'ACTION_REQUIRED']);
const paymentStatusSchema = z.enum(['PENDING', 'UNDER_REVIEW', 'APPROVED', 'PARTIALLY_REFUNDED', 'REJECTED', 'FAILED', 'REFUNDED', 'DISPUTED', 'REQUIRES_REVIEW']);
const loyaltyRedemptionStatusSchema = z.enum(['NONE', 'RESERVED', 'REDEEMED', 'RELEASED', 'RESTORED']);
const fulfillmentInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('PICKUP'), pickupPointId: z.string().uuid() }),
  z.object({
    type: z.literal('SHIPMENT'),
    shippingRateId: z.string().uuid(),
    recipientName: z.string().min(1).max(120),
    recipientPhone: z.string().min(6).max(40),
    addressLine1: z.string().min(1).max(180),
    addressLine2: z.string().max(180).optional(),
    city: z.string().min(1).max(100),
    province: z.string().min(1).max(100),
    postalCode: z.string().min(3).max(20),
  }),
]);
const orderInputSchema = z.object({
  items: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().int().min(1).max(100), productVersion: z.number().int().min(1) })).min(1).max(50),
  paymentMethod: z.enum(['BANK_TRANSFER', 'MERCADO_PAGO']),
  fulfillment: fulfillmentInputSchema,
  sellerFulfillments: z.array(z.object({ sellerKey: z.string(), fulfillment: fulfillmentInputSchema })).optional(),
  pointsToRedeem: z.number().int().min(0).max(2_000_000_000).default(0),
  rateSnapshotId: z.string().uuid().optional(),
});
const checkoutOptionsSchema = z.object({ fulfillment: z.object({ shippingZones: z.array(z.object({ id: z.string().uuid(), name: z.string(), provinces: z.array(z.string()), rates: z.array(z.object({ id: z.string().uuid(), name: z.string(), price: moneySchema })) })), pickupPoints: z.array(z.object({ id: z.string().uuid(), name: z.string(), address: z.string() })) }), sellers: z.array(z.object({ sellerKey: z.string(), seller: z.object({ type: z.enum(['STORE', 'AFFILIATE']), id: z.string().uuid().nullable(), name: z.string() }), shippingZones: z.array(z.unknown()), pickupPoints: z.array(z.unknown()) })).optional(), paymentMethods: z.object({ BANK_TRANSFER: z.boolean(), MERCADO_PAGO: z.boolean() }), paymentMethodUnavailableReasons: z.object({ MERCADO_PAGO: z.enum(['NOT_CONFIGURED', 'FX_UNAVAILABLE']).optional() }).optional() });
const loyaltyProgramSchema = z.object({
  enabled: z.boolean(),
  currency: z.literal(BASE_CURRENCY),
  spendPerPoint: moneySchema,
  pointsPerStep: z.number().int().positive(),
  pointValue: moneySchema,
  minimumRedemptionPoints: z.number().int().positive(),
  maximumRedemptionPercent: z.number().int().min(1).max(90),
  version: z.number().int().positive(),
  updatedAt: dateTimeSchema,
});
const loyaltyAccountSummarySchema = z.object({
  balance: z.number().int(),
  reserved: z.number().int().nonnegative(),
  available: z.number().int().nonnegative(),
  lifetimeEarned: z.number().int().nonnegative(),
  lifetimeRedeemed: z.number().int().nonnegative(),
});
const loyaltyTransactionSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(['EARN', 'REDEEM', 'EARN_REVERSAL', 'REDEEM_REVERSAL', 'ADJUSTMENT']),
  points: z.number().int(),
  balanceAfter: z.number().int(),
  description: z.string().nullable(),
  orderNumber: z.string().nullable(),
  createdAt: dateTimeSchema,
});
const checkoutLoyaltySchema = z.object({
  enabled: z.boolean(),
  balance: z.number().int(),
  reserved: z.number().int().nonnegative(),
  available: z.number().int().nonnegative(),
  pointsRedeemed: z.number().int().nonnegative(),
  maximumRedeemablePoints: z.number().int().nonnegative(),
  minimumRedemptionPoints: z.number().int().positive(),
  pointsToEarn: z.number().int().nonnegative(),
  pointValue: moneySchema,
});
const orderLoyaltySchema = z.object({
  programVersion: z.number().int().positive().nullable(),
  pointsRedeemed: z.number().int().nonnegative(),
  pointsDiscount: moneySchema,
  pointsEarned: z.number().int().nonnegative(),
  redemptionStatus: loyaltyRedemptionStatusSchema,
  spendPerPoint: moneySchema.nullable(),
  pointValue: moneySchema.nullable(),
});
const orderTimelineEventSchema = z.object({ id: z.string().uuid(), fromStatus: orderStatusSchema.nullable(), toStatus: orderStatusSchema, createdAt: dateTimeSchema });
const publicOrderSchema = z.object({
  id: z.string().uuid(),
  number: z.string(),
  version: z.number().int().positive(),
  status: orderStatusSchema,
  paymentMethod: z.enum(['BANK_TRANSFER', 'MERCADO_PAGO']),
  fulfillmentType: z.enum(['SHIPMENT', 'PICKUP']),
  totals: z.object({ subtotal: moneySchema, discount: moneySchema, shipping: moneySchema, total: moneySchema }),
  loyalty: orderLoyaltySchema,
  timeline: z.array(orderTimelineEventSchema),
  expiresAt: dateTimeSchema.nullable(),
  items: z.array(z.object({
    productId: z.string().uuid().nullable(), sku: z.string(), name: z.string(), imageFileId: z.string().uuid().nullable(), imageUrl: z.string().nullable(),
    quantity: z.number().int().positive(), unitPrice: moneySchema, lineTotal: moneySchema,
  })),
  fulfillment: z.union([
    z.object({
      type: z.literal('SHIPMENT'), recipientName: z.string().nullable(), recipientPhone: z.string().nullable(),
      addressLine1: z.string().nullable(), addressLine2: z.string().nullable(), city: z.string().nullable(), province: z.string().nullable(), postalCode: z.string().nullable(),
      shippingRateId: z.string().uuid().nullable(), shippingZoneName: z.string().nullable(), shippingRateName: z.string().nullable(), shippingRatePrice: moneySchema.nullable(),
    }),
    z.object({ type: z.literal('PICKUP'), pickupPointId: z.string().uuid().nullable(), pickupPointName: z.string().nullable(), pickupPointAddress: z.string().nullable() }),
  ]),
  payment: z.object({
    method: z.enum(['BANK_TRANSFER', 'MERCADO_PAGO']), status: paymentStatusSchema, bankReference: z.string().nullable(),
    bankInstructions: z.object({ bankName: z.string(), accountHolder: z.string(), cbu: z.string().nullable(), alias: z.string().nullable() }).nullable(),
    receipt: z.object({ fileId: z.string().uuid(), review: z.enum(['PENDING', 'APPROVED', 'REJECTED']), createdAt: dateTimeSchema }).nullable(),
    checkoutUrl: z.string().nullable(), paymentSessionStatus: z.enum(['READY', 'RETRY_REQUIRED', 'CLOSED']).nullable(),
    mercadoPago: z.object({ integrationMode: z.enum(['PREFERENCE_V1', 'ORDER_V1']), providerOrderId: z.string().nullable(), checkoutUrl: z.string().nullable(), checkoutStatus: z.enum(['READY', 'RETRY_REQUIRED', 'CLOSED']).nullable(), amount: providerMoneySchema.nullable(), rate: z.object({ source: z.string(), rate: z.string(), fetchedAt: dateTimeSchema, expiresAt: dateTimeSchema }).nullable(), expiresAt: dateTimeSchema.nullable() }).nullable().optional(),
  }).nullable(),
  createdAt: dateTimeSchema,
});
const supportMessageResponseSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  senderType: z.enum(['USER', 'ADMIN']),
  sender: z.object({ id: z.string(), name: z.string() }),
  content: z.string(),
  createdAt: dateTimeSchema,
});
const supportConversationSchema = z.object({
  id: z.string().uuid(),
  status: supportStatusSchema,
  subject: z.string(),
  user: z.object({ id: z.string().uuid(), name: z.string().nullable(), email: z.string().email() }),
  createdByType: z.enum(['USER', 'ADMIN']),
  lastMessageAt: dateTimeSchema,
  lastMessagePreview: z.string().nullable(),
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
  unreadCount: z.number().int().nonnegative(),
});
const publicUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string().nullable(),
  emailVerified: z.boolean(),
  affiliate: z.object({ id: z.string().uuid(), publicName: z.string(), status: z.enum(['ACTIVE', 'SUSPENDED']) }).nullable(),
});

export function buildOpenApi(): import('openapi3-ts/oas31').OpenAPIObject {
  const registry = new OpenAPIRegistry();
  registry.register('Money', moneySchema);
  registry.register('ProblemDetails', problemSchema);
  registry.register('Product', catalogProductSchema);
  registry.register('CatalogFilters', catalogFiltersSchema);
  registry.register('OrderInput', orderInputSchema);
  registry.register('Order', publicOrderSchema);
  registry.register('LoyaltyProgram', loyaltyProgramSchema);
  registry.register('LoyaltyAccount', loyaltyAccountSummarySchema);
  registry.register('LoyaltyTransaction', loyaltyTransactionSchema);
  registry.register('SupportConversation', supportConversationSchema);
  registry.register('SupportMessage', supportMessageResponseSchema);
  registry.register('NewsItem', publicNewsItemSchema);
  const affiliateProfileSchema = z.object({ id: z.string().uuid(), userId: z.string().uuid(), publicName: z.string(), contactPhone: z.string().nullable(), payoutAccountLast4: z.string().nullable(), status: z.enum(['ACTIVE', 'SUSPENDED']), version: z.number().int() }).passthrough();
  const affiliateSellerOrderStatusSchema = z.enum(['PENDING_PAYMENT', 'PAID', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'SHIPPED', 'COMPLETED', 'CANCELLATION_REQUESTED', 'CANCELLED', 'DISPUTED', 'REFUNDED']);
  const affiliateSellerOrderSchema = z.object({ id: z.string().uuid(), number: z.string(), sellerType: z.enum(['STORE', 'AFFILIATE']), affiliateId: z.string().uuid().nullable(), sellerName: z.string(), status: affiliateSellerOrderStatusSchema, version: z.number().int(), subtotalMinor: z.string(), shippingMinor: z.string(), commissionMinor: z.string(), sellerNetMinor: z.string(), fulfillmentType: z.enum(['SHIPMENT', 'PICKUP']), carrier: z.string().nullable().optional(), trackingCode: z.string().nullable().optional(), autoCompleteAt: dateTimeSchema.nullable().optional(), items: z.array(z.object({ id: z.string().uuid(), productId: z.string().uuid().nullable(), productName: z.string(), quantity: z.number().int(), unitPriceMinor: z.string(), lineTotalMinor: z.string() }).passthrough()), statusHistory: z.array(z.object({ id: z.string().uuid(), fromStatus: affiliateSellerOrderStatusSchema.nullable(), toStatus: affiliateSellerOrderStatusSchema, note: z.string().nullable(), createdAt: dateTimeSchema }).passthrough()).default([]), allowedActions: z.array(z.string()).default([]) }).passthrough();
  const affiliateListingSchema = z.object({ id: z.string().uuid(), status: z.enum(['DRAFT', 'PENDING_REVIEW', 'CHANGES_REQUESTED', 'REJECTED', 'APPROVED']), product: z.object({ id: z.string().uuid(), sku: z.string(), slug: z.string(), name: z.string(), description: z.string(), priceMinor: z.string(), status: z.string(), version: z.number().int(), inventory: z.record(z.string(), z.unknown()).nullable(), images: z.array(z.record(z.string(), z.unknown())) }).passthrough() }).passthrough();
  const affiliateBalanceSchema = z.object({ pendingMinor: z.string(), availableMinor: z.string(), reservedMinor: z.string(), paidMinor: z.string(), debtMinor: z.string(), entries: z.array(z.object({ id: z.string().uuid(), bucket: z.string(), type: z.string(), amountMinor: z.string(), createdAt: dateTimeSchema }).passthrough()), payouts: z.array(z.record(z.string(), z.unknown())), page: z.number().int(), pageSize: z.number().int(), total: z.number().int(), totalPages: z.number().int() });
  const envelope = (schema: z.ZodType) => z.object({ data: schema, meta: z.record(z.string(), z.unknown()).optional() });
  const adminSecurity = [{ adminCookie: [] }];
  const userSecurity = [{ userCookie: [] }];
  const csrfHeader = z.object({ 'x-csrf-token': z.string().min(32) });
  const publicErrors = {
    400: { description: 'Invalid request', content: { 'application/json': { schema: problemSchema } } },
    401: { description: 'Customer session missing or expired', content: { 'application/json': { schema: problemSchema } } },
    403: { description: 'Email verification or CSRF requirement not met', content: { 'application/json': { schema: problemSchema } } },
    409: { description: 'Product, stock or loyalty balance changed', content: { 'application/json': { schema: problemSchema } } },
    503: { description: 'Mercado Pago is not configured or the DolarAPI quote is temporarily unavailable', content: { 'application/json': { schema: problemSchema } } },
  };

  registry.registerPath({
    method: 'post',
    path: '/api/v2/admin/auth/login',
    tags: ['Admin authentication'],
    summary: 'Authenticate an administrator with email and password',
    request: { body: { required: true, content: { 'application/json': { schema: adminLoginSchema } } } },
    responses: {
      200: {
        description: 'Opaque admin session established; the CSRF token is also issued as a readable Strict cookie',
        content: { 'application/json': { schema: envelope(z.object({ admin: adminPrincipalSchema, csrfToken: z.string() })) } },
      },
      401: { description: 'Invalid credentials', content: { 'application/json': { schema: problemSchema } } },
      429: { description: 'Too many authentication attempts', content: { 'application/json': { schema: problemSchema } } },
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v2/admin/auth/csrf',
    tags: ['Admin authentication'],
    summary: 'Rotate the CSRF token for the active admin session',
    security: adminSecurity,
    responses: {
      200: { description: 'Fresh admin CSRF token', content: { 'application/json': { schema: envelope(csrfTokenSchema) } } },
      401: { description: 'Missing, expired or idle admin session', content: { 'application/json': { schema: problemSchema } } },
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v2/admin/auth/me',
    tags: ['Admin authentication'],
    summary: 'Read the current administrator',
    description: 'Validates the administrator session without extending its idle timeout. Safe-method admin reads are intentionally activity-neutral so polling cannot keep a session alive.',
    security: adminSecurity,
    responses: {
      200: { description: 'Current administrator', content: { 'application/json': { schema: envelope(z.object({ admin: adminPrincipalSchema })) } } },
      401: { description: 'Missing, expired or idle admin session', content: { 'application/json': { schema: problemSchema } } },
    },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/v2/admin/auth/logout',
    tags: ['Admin authentication'],
    summary: 'Revoke the current admin session',
    description: 'Requires the CSRF token associated with the admin namespace, even when a customer session also exists.',
    security: adminSecurity,
    request: { headers: csrfHeader },
    responses: {
      204: { description: 'Admin session revoked' },
      403: { description: 'Invalid admin CSRF token', content: { 'application/json': { schema: problemSchema } } },
    },
  });
  registry.registerPath({
    method: 'patch',
    path: '/api/v2/auth/profile',
    tags: ['Customer authentication'],
    summary: 'Update the current customer profile without changing the email address',
    security: userSecurity,
    request: { headers: csrfHeader, body: { required: true, content: { 'application/json': { schema: profileUpdateSchema } } } },
    responses: {
      200: { description: 'Profile updated', content: { 'application/json': { schema: envelope(z.object({ user: publicUserSchema, passwordChanged: z.boolean() })) } } },
      ...publicErrors,
    },
  });
  registry.registerPath({ method: 'get', path: '/api/v2/catalog/products', tags: ['Catalog'], request: { query: catalogListQuerySchema }, responses: { 200: { description: 'Published products filtered and sorted by the server', content: { 'application/json': { schema: z.object({ data: z.array(catalogProductSchema), meta: z.object({ nextCursor: z.string().nullable() }) }) } } } } });
  registry.registerPath({ method: 'get', path: '/api/v2/catalog/filters', tags: ['Catalog'], responses: { 200: { description: 'Available catalog facets and their published-product counts', content: { 'application/json': { schema: envelope(catalogFiltersSchema) } } } } });
  registry.registerPath({ method: 'get', path: '/api/v2/catalog/products/{slug}', tags: ['Catalog'], request: { params: z.object({ slug: z.string().min(1) }) }, responses: { 200: { description: 'Published product detail', content: { 'application/json': { schema: envelope(catalogProductSchema) } } }, 404: { description: 'Product not found', content: { 'application/json': { schema: problemSchema } } } } });
  registry.registerPath({ method: 'get', path: '/api/v2/news', tags: ['News'], summary: 'List active news items within their publication window', request: { query: publicNewsQuerySchema }, responses: { 200: { description: 'Public news carousel items', content: { 'application/json': { schema: envelope(z.array(publicNewsItemSchema)) } } }, 400: publicErrors[400] } });
  registry.registerPath({ method: 'get', path: '/api/v2/checkout/options', tags: ['Checkout'], responses: { 200: { description: 'Available fulfillment and payment methods', content: { 'application/json': { schema: envelope(checkoutOptionsSchema) } } } } });
  registry.registerPath({ method: 'post', path: '/api/v2/checkout/options', tags: ['Checkout'], security: userSecurity, request: { headers: csrfHeader, body: { required: true, content: { 'application/json': { schema: z.object({ items: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().int().min(1), productVersion: z.number().int().min(1) })) }) } } } }, responses: { 200: { description: 'Fulfillment options grouped by seller', content: { 'application/json': { schema: envelope(checkoutOptionsSchema) } } }, ...publicErrors } });
  registry.registerPath({ method: 'get', path: '/api/v2/affiliate/profile', tags: ['Affiliate portal'], security: userSecurity, responses: { 200: { description: 'Authenticated affiliate profile', content: { 'application/json': { schema: envelope(affiliateProfileSchema) } } }, 401: publicErrors[401], 403: publicErrors[403] } });
  registry.registerPath({ method: 'patch', path: '/api/v2/affiliate/profile', tags: ['Affiliate portal'], security: userSecurity, request: { headers: csrfHeader, body: { required: true, content: { 'application/json': { schema: z.object({ expectedVersion: z.number().int().min(1), publicName: z.string().max(120).optional(), contactPhone: z.string().nullable().optional(), payoutAccount: z.string().nullable().optional() }) } } } }, responses: { 200: { description: 'Affiliate profile updated', content: { 'application/json': { schema: envelope(affiliateProfileSchema) } } }, ...publicErrors } });
  registry.registerPath({ method: 'get', path: '/api/v2/affiliate/listings', tags: ['Affiliate portal'], security: userSecurity, responses: { 200: { description: 'Listings owned by the authenticated affiliate', content: { 'application/json': { schema: z.array(affiliateListingSchema) } } }, ...publicErrors } });
  registry.registerPath({ method: 'post', path: '/api/v2/affiliate/listings', tags: ['Affiliate portal'], security: userSecurity, request: { headers: csrfHeader }, responses: { 201: { description: 'Inactive draft listing created', content: { 'application/json': { schema: envelope(z.object({ id: z.string().uuid(), productId: z.string().uuid() })) } } }, ...publicErrors } });
  registry.registerPath({ method: 'post', path: '/api/v2/affiliate/listings/{id}/submit', tags: ['Affiliate portal'], security: userSecurity, request: { params: z.object({ id: z.string().uuid() }), headers: csrfHeader }, responses: { 200: { description: 'Listing sent to first administrative review', content: { 'application/json': { schema: envelope(z.object({ id: z.string().uuid(), status: z.string() })) } } }, ...publicErrors } });
  registry.registerPath({ method: 'post', path: '/api/v2/affiliate/listings/{id}/images', tags: ['Affiliate portal'], security: userSecurity, request: { params: z.object({ id: z.string().uuid() }), headers: csrfHeader }, responses: { 201: { description: 'Images attached through the public media pipeline', content: { 'application/json': { schema: envelope(z.object({ fileIds: z.array(z.string().uuid()) })) } } }, ...publicErrors } });
  registry.registerPath({ method: 'get', path: '/api/v2/affiliate/orders', tags: ['Affiliate portal'], security: userSecurity, request: { query: z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20), status: affiliateSellerOrderStatusSchema.optional() }) }, responses: { 200: { description: 'Seller orders owned by the authenticated affiliate', content: { 'application/json': { schema: z.object({ items: z.array(affiliateSellerOrderSchema), page: z.number().int(), pageSize: z.number().int(), total: z.number().int(), totalPages: z.number().int() }) } } }, ...publicErrors } });
  registry.registerPath({ method: 'get', path: '/api/v2/affiliate/orders/{id}', tags: ['Affiliate portal'], security: userSecurity, request: { params: z.object({ id: z.string().uuid() }) }, responses: { 200: { description: 'Affiliate seller-order detail with payment-gated delivery data', content: { 'application/json': { schema: envelope(z.object({ order: affiliateSellerOrderSchema })) } } }, ...publicErrors } });
  registry.registerPath({ method: 'post', path: '/api/v2/affiliate/orders/{id}/status', tags: ['Affiliate portal'], security: userSecurity, request: { params: z.object({ id: z.string().uuid() }), headers: csrfHeader, body: { required: true, content: { 'application/json': { schema: z.object({ expectedVersion: z.number().int().min(1), status: z.enum(['PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'SHIPPED']), note: z.string().max(500).optional(), carrier: z.string().max(100).nullable().optional(), trackingCode: z.string().max(120).nullable().optional() }) } } } }, responses: { 200: { description: 'Seller order transitioned', content: { 'application/json': { schema: envelope(z.object({ id: z.string().uuid(), status: affiliateSellerOrderStatusSchema, version: z.number().int(), allowedActions: z.array(z.string()) })) } } }, ...publicErrors } });
  registry.registerPath({ method: 'post', path: '/api/v2/affiliate/orders/{id}/cancellation-request', tags: ['Affiliate portal'], security: userSecurity, request: { params: z.object({ id: z.string().uuid() }), headers: csrfHeader, body: { required: true, content: { 'application/json': { schema: z.object({ expectedVersion: z.number().int().min(1), note: z.string().min(3).max(500) }) } } } }, responses: { 200: { description: 'Cancellation request submitted', content: { 'application/json': { schema: envelope(z.object({ id: z.string().uuid(), status: affiliateSellerOrderStatusSchema, version: z.number().int() })) } } }, ...publicErrors } });
  registry.registerPath({ method: 'get', path: '/api/v2/affiliate/balance', tags: ['Affiliate portal'], security: userSecurity, request: { query: z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50) }) }, responses: { 200: { description: 'Immutable ledger summary and movements', content: { 'application/json': { schema: envelope(affiliateBalanceSchema) } } }, ...publicErrors } });
  registry.registerPath({ method: 'get', path: '/api/v2/affiliate/payouts', tags: ['Affiliate portal'], security: userSecurity, request: { query: z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }) }, responses: { 200: { description: 'Paginated withdrawal history', content: { 'application/json': { schema: z.object({ items: z.array(z.record(z.string(), z.unknown())), page: z.number().int(), pageSize: z.number().int(), total: z.number().int(), totalPages: z.number().int() }) } } }, ...publicErrors } });
  registry.registerPath({ method: 'post', path: '/api/v2/affiliate/payouts', tags: ['Affiliate portal'], security: userSecurity, request: { headers: csrfHeader, body: { required: true, content: { 'application/json': { schema: z.object({ amountMinor: z.coerce.bigint().positive() }) } } } }, responses: { 201: { description: 'Withdrawal requested and balance reserved', content: { 'application/json': { schema: envelope(z.record(z.string(), z.unknown())) } } }, ...publicErrors } });
  registry.registerPath({ method: 'get', path: '/api/v2/affiliate/logistics', tags: ['Affiliate portal'], security: userSecurity, responses: { 200: { description: 'Configured shipping zones and pickup points', content: { 'application/json': { schema: envelope(z.object({ zones: z.array(z.record(z.string(), z.unknown())), pickupPoints: z.array(z.record(z.string(), z.unknown())) })) } } }, ...publicErrors } });
  registry.registerPath({
    method: 'get', path: '/api/v2/loyalty/program', tags: ['Loyalty'], summary: 'Read the active points and redemption rules',
    responses: { 200: { description: 'Current loyalty program', content: { 'application/json': { schema: envelope(z.object({ program: loyaltyProgramSchema })) } } } },
  });
  registry.registerPath({
    method: 'get', path: '/api/v2/loyalty/account', tags: ['Loyalty'], summary: 'Read the customer balance and transaction history', security: userSecurity,
    request: { query: z.object({ cursor: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }) },
    responses: {
      200: { description: 'Loyalty account and cursor page of movements', content: { 'application/json': { schema: envelope(z.object({ program: loyaltyProgramSchema, account: loyaltyAccountSummarySchema, transactions: z.array(loyaltyTransactionSchema), nextCursor: z.string().uuid().nullable() })) } } },
      401: publicErrors[401],
    },
  });
  registry.registerPath({
    method: 'post', path: '/api/v2/checkout/preview', tags: ['Checkout'], security: userSecurity,
    request: { headers: csrfHeader, body: { required: true, content: { 'application/json': { schema: orderInputSchema } } } },
    responses: {
      200: { description: 'Server-calculated quote, including the loyalty discount and Mercado Pago ARS conversion', content: { 'application/json': { schema: envelope(z.object({ subtotal: moneySchema, discount: moneySchema, shipping: moneySchema, total: moneySchema, loyalty: checkoutLoyaltySchema, expiresAt: dateTimeSchema, mercadoPago: z.object({ rateSnapshotId: z.string().uuid(), source: z.literal('DOLARAPI_BLUE_VENTA'), rate: z.string(), fetchedAt: dateTimeSchema, expiresAt: dateTimeSchema, total: providerMoneySchema }).nullable().optional() })) } } },
      ...publicErrors,
    },
  });
  registry.registerPath({
    method: 'post', path: '/api/v2/orders', tags: ['Orders'], security: userSecurity,
    request: { headers: csrfHeader.extend({ 'idempotency-key': z.string().regex(/^[A-Za-z0-9._:-]{16,120}$/) }), body: { required: true, content: { 'application/json': { schema: orderInputSchema } } } },
    responses: {
      200: { description: 'Existing order returned for an idempotent retry', content: { 'application/json': { schema: envelope(z.object({ order: publicOrderSchema, reused: z.literal(true) })) } } },
      201: { description: 'Order created and requested loyalty points reserved', content: { 'application/json': { schema: envelope(z.object({ order: publicOrderSchema, reused: z.literal(false) })) } } },
      ...publicErrors,
    },
  });
  registry.registerPath({
    method: 'get', path: '/api/v2/orders', tags: ['Orders'], security: userSecurity,
    request: { query: z.object({ cursor: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }) },
    responses: { 200: { description: 'Cursor page of the current customer orders', content: { 'application/json': { schema: z.object({ data: z.array(publicOrderSchema), meta: z.object({ nextCursor: z.string().uuid().nullable() }) }) } } }, 401: publicErrors[401] },
  });
  registry.registerPath({
    method: 'get', path: '/api/v2/orders/{number}', tags: ['Orders'], security: userSecurity,
    request: { params: z.object({ number: z.string().min(1) }) },
    responses: { 200: { description: 'Order detail with immutable loyalty snapshot', content: { 'application/json': { schema: envelope(z.object({ order: publicOrderSchema })) } } }, 401: publicErrors[401], 404: { description: 'Order not found', content: { 'application/json': { schema: problemSchema } } } },
  });
  registry.registerPath({
    method: 'post', path: '/api/v2/orders/{number}/payment-session', tags: ['Orders'], security: userSecurity,
    request: { params: z.object({ number: z.string().min(1) }), headers: csrfHeader },
    responses: { 200: { description: 'Existing or recovered Mercado Pago checkout session', content: { 'application/json': { schema: envelope(z.object({ checkoutUrl: z.string().url().nullable(), expiresAt: dateTimeSchema.nullable(), order: publicOrderSchema })) } } }, ...publicErrors },
  });
  registry.registerPath({
    method: 'post', path: '/api/v2/orders/{number}/payment-status/refresh', tags: ['Orders'], security: userSecurity,
    summary: 'Reconcile a customer order with Mercado Pago',
    description: 'Fetches the associated Checkout Pro Order from Mercado Pago and idempotently applies its authoritative payment state. The order must belong to the authenticated customer.',
    request: { params: z.object({ number: z.string().min(1) }), headers: csrfHeader },
    responses: {
      200: { description: 'Order status reconciled with Mercado Pago', content: { 'application/json': { schema: envelope(z.object({ order: publicOrderSchema })) } } },
      401: publicErrors[401],
      403: publicErrors[403],
      404: { description: 'Order not found for the authenticated customer', content: { 'application/json': { schema: problemSchema } } },
      409: { description: 'The Mercado Pago provider order has not been created yet', content: { 'application/json': { schema: problemSchema } } },
      429: { description: 'Too many refresh attempts', content: { 'application/json': { schema: problemSchema } } },
      503: publicErrors[503],
    },
  });
  registry.registerPath({
    method: 'post', path: '/api/v2/webhooks/mercado-pago', tags: ['Payments'],
    request: { query: z.object({ 'data.id': z.string().min(1).optional(), type: z.enum(['order', 'payment']).optional() }), headers: z.object({ 'x-signature': z.string(), 'x-request-id': z.string() }), body: { required: true, content: { 'application/json': { schema: z.object({ id: z.union([z.string(), z.number()]), type: z.enum(['order', 'payment']), action: z.string().optional(), data: z.object({ id: z.union([z.string(), z.number()]) }) }) } } } },
    responses: { 200: { description: 'Notification persisted for durable processing', content: { 'application/json': { schema: z.object({ received: z.literal(true) }) } } }, 400: publicErrors[400], 401: publicErrors[401], 503: publicErrors[503] },
  });
  const supportConversationQuery = z.object({
    status: supportStatusSchema.optional(),
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  });
  const supportMessageQuery = z.object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  });
  const supportConversationParams = z.object({ id: z.string().uuid() });
  const supportListResponse = z.object({ data: z.array(supportConversationSchema), meta: z.object({ nextCursor: z.string().uuid().nullable() }) });
  const supportDetailResponse = z.object({ data: z.object({ conversation: supportConversationSchema, messages: z.array(supportMessageResponseSchema) }), meta: z.object({ nextCursor: z.string().uuid().nullable() }) });
  const supportUnreadResponse = envelope(z.object({ count: z.number().int().nonnegative() }));
  const supportReadResponse = envelope(z.object({ conversationId: z.string().uuid(), readAt: dateTimeSchema, unreadCount: z.number().int().nonnegative() }));
  const supportConversationResponse = envelope(z.object({ conversation: supportConversationSchema }));
  const supportCreateResponse = supportConversationResponse;
  const supportMessageCreatedResponse = envelope(z.object({ message: supportMessageResponseSchema }));
  const notificationReferenceSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('ORDER'), orderNumber: z.string() }),
    z.object({ kind: z.literal('SUPPORT_CONVERSATION'), conversationId: z.string().uuid() }),
  ]);
  const notificationSchema = z.object({ id: z.string().uuid(), type: z.enum(['SUPPORT_MESSAGE', 'ORDER_STATUS_CHANGED', 'ORDER_CREATED', 'TRANSFER_RECEIPT_SUBMITTED', 'PAYMENT_REQUIRES_REVIEW', 'PAYMENT_APPROVED']), title: z.string(), message: z.string(), readAt: dateTimeSchema.nullable(), createdAt: dateTimeSchema, reference: notificationReferenceSchema });
  const notificationQuery = z.object({ cursor: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(50).default(20), unreadOnly: z.preprocess((value) => value === 'true' ? true : value === 'false' ? false : value, z.boolean().default(false)) });
  const notificationListResponse = z.object({ data: z.array(notificationSchema), meta: z.object({ nextCursor: z.string().uuid().nullable() }) });
  const notificationUnreadResponse = envelope(z.object({ count: z.number().int().nonnegative() }));
  const notificationReadResponse = envelope(z.object({ notification: notificationSchema, unreadCount: z.number().int().nonnegative() }));
  const notificationReadAllResponse = envelope(z.object({ updatedCount: z.number().int().nonnegative(), unreadCount: z.number().int().nonnegative() }));
  const supportErrors = {
    400: publicErrors[400],
    401: publicErrors[401],
    403: publicErrors[403],
    404: { description: 'Support conversation or message not found', content: { 'application/json': { schema: problemSchema } } },
    409: { description: 'Conversation is closed or message id was reused', content: { 'application/json': { schema: problemSchema } } },
  };
  registry.registerPath({ method: 'get', path: '/api/v2/support/conversations', tags: ['Support'], security: userSecurity, request: { query: supportConversationQuery }, responses: { 200: { description: 'Customer support conversations', content: { 'application/json': { schema: supportListResponse } } }, 401: publicErrors[401] } });
  registry.registerPath({ method: 'post', path: '/api/v2/support/conversations', tags: ['Support'], security: userSecurity, request: { headers: csrfHeader, body: { required: true, content: { 'application/json': { schema: createUserSupportConversationSchema } } } }, responses: { 200: { description: 'Idempotently reused support conversation', content: { 'application/json': { schema: supportCreateResponse } } }, 201: { description: 'Support conversation opened', content: { 'application/json': { schema: supportCreateResponse } } }, ...supportErrors } });
  registry.registerPath({ method: 'get', path: '/api/v2/support/unread-count', tags: ['Support'], security: userSecurity, responses: { 200: { description: 'Number of unread admin messages', content: { 'application/json': { schema: supportUnreadResponse } } }, 401: publicErrors[401] } });
  registry.registerPath({ method: 'get', path: '/api/v2/support/conversations/{id}', tags: ['Support'], security: userSecurity, request: { params: supportConversationParams, query: supportMessageQuery }, responses: { 200: { description: 'Conversation and one page of messages in chronological order', content: { 'application/json': { schema: supportDetailResponse } } }, 401: publicErrors[401], 404: supportErrors[404] } });
  registry.registerPath({ method: 'post', path: '/api/v2/support/conversations/{id}/messages', tags: ['Support'], security: userSecurity, request: { params: supportConversationParams, headers: csrfHeader, body: { required: true, content: { 'application/json': { schema: createSupportMessageSchema } } } }, responses: { 200: { description: 'Idempotently reused support message', content: { 'application/json': { schema: supportMessageCreatedResponse } } }, 201: { description: 'Support message sent', content: { 'application/json': { schema: supportMessageCreatedResponse } } }, ...supportErrors } });
  registry.registerPath({ method: 'post', path: '/api/v2/support/conversations/{id}/read', tags: ['Support'], security: userSecurity, request: { params: supportConversationParams, headers: csrfHeader, body: { content: { 'application/json': { schema: markSupportReadSchema } } } }, responses: { 200: { description: 'Conversation read position updated', content: { 'application/json': { schema: supportReadResponse } } }, ...supportErrors } });

  registry.registerPath({ method: 'get', path: '/api/v2/notifications', tags: ['Notifications'], security: userSecurity, request: { query: notificationQuery }, responses: { 200: { description: 'Customer notifications', content: { 'application/json': { schema: notificationListResponse } } }, 401: publicErrors[401] } });
  registry.registerPath({ method: 'get', path: '/api/v2/notifications/unread-count', tags: ['Notifications'], security: userSecurity, responses: { 200: { description: 'Customer unread notification count', content: { 'application/json': { schema: notificationUnreadResponse } } }, 401: publicErrors[401] } });
  registry.registerPath({ method: 'post', path: '/api/v2/notifications/{id}/read', tags: ['Notifications'], security: userSecurity, request: { params: z.object({ id: z.string().uuid() }), headers: csrfHeader }, responses: { 200: { description: 'Notification marked as read', content: { 'application/json': { schema: notificationReadResponse } } }, 401: publicErrors[401], 404: { description: 'Notification not found', content: { 'application/json': { schema: problemSchema } } } } });
  registry.registerPath({ method: 'post', path: '/api/v2/notifications/read-all', tags: ['Notifications'], security: userSecurity, request: { headers: csrfHeader }, responses: { 200: { description: 'All customer notifications marked as read', content: { 'application/json': { schema: notificationReadAllResponse } } }, 401: publicErrors[401] } });

  registry.registerPath({ method: 'get', path: '/api/v2/admin/support/conversations', tags: ['Admin support'], security: adminSecurity, request: { query: supportConversationQuery }, responses: { 200: { description: 'All customer support conversations', content: { 'application/json': { schema: supportListResponse } } }, 401: publicErrors[401] } });
  registry.registerPath({ method: 'post', path: '/api/v2/admin/support/conversations', tags: ['Admin support'], security: adminSecurity, request: { headers: csrfHeader, body: { required: true, content: { 'application/json': { schema: createAdminSupportConversationSchema } } } }, responses: { 200: { description: 'Idempotently reused administrator-opened conversation', content: { 'application/json': { schema: supportCreateResponse } } }, 201: { description: 'Administrator-opened support conversation', content: { 'application/json': { schema: supportCreateResponse } } }, ...supportErrors } });
  registry.registerPath({ method: 'get', path: '/api/v2/admin/support/unread-count', tags: ['Admin support'], security: adminSecurity, responses: { 200: { description: 'Number of unread customer messages for this administrator', content: { 'application/json': { schema: supportUnreadResponse } } }, 401: publicErrors[401] } });
  registry.registerPath({ method: 'get', path: '/api/v2/admin/support/conversations/{id}', tags: ['Admin support'], security: adminSecurity, request: { params: supportConversationParams, query: supportMessageQuery }, responses: { 200: { description: 'Conversation and one page of messages in chronological order', content: { 'application/json': { schema: supportDetailResponse } } }, 401: publicErrors[401], 404: supportErrors[404] } });
  registry.registerPath({ method: 'post', path: '/api/v2/admin/support/conversations/{id}/messages', tags: ['Admin support'], security: adminSecurity, request: { params: supportConversationParams, headers: csrfHeader, body: { required: true, content: { 'application/json': { schema: createSupportMessageSchema } } } }, responses: { 200: { description: 'Idempotently reused support message', content: { 'application/json': { schema: supportMessageCreatedResponse } } }, 201: { description: 'Administrator support message sent', content: { 'application/json': { schema: supportMessageCreatedResponse } } }, ...supportErrors } });
  registry.registerPath({ method: 'post', path: '/api/v2/admin/support/conversations/{id}/read', tags: ['Admin support'], security: adminSecurity, request: { params: supportConversationParams, headers: csrfHeader, body: { content: { 'application/json': { schema: markSupportReadSchema } } } }, responses: { 200: { description: 'Administrator read position updated', content: { 'application/json': { schema: supportReadResponse } } }, ...supportErrors } });
  registry.registerPath({ method: 'patch', path: '/api/v2/admin/support/conversations/{id}/status', tags: ['Admin support'], security: adminSecurity, request: { params: supportConversationParams, headers: csrfHeader, body: { required: true, content: { 'application/json': { schema: updateSupportStatusSchema } } } }, responses: { 200: { description: 'Support workflow status changed', content: { 'application/json': { schema: supportConversationResponse } } }, ...supportErrors } });
  registry.registerPath({ method: 'get', path: '/api/v2/admin/notifications', tags: ['Admin notifications'], security: adminSecurity, request: { query: notificationQuery }, responses: { 200: { description: 'Administrator notifications', content: { 'application/json': { schema: notificationListResponse } } }, 401: publicErrors[401] } });
  registry.registerPath({ method: 'get', path: '/api/v2/admin/notifications/unread-count', tags: ['Admin notifications'], security: adminSecurity, responses: { 200: { description: 'Administrator unread notification count', content: { 'application/json': { schema: notificationUnreadResponse } } }, 401: publicErrors[401] } });
  registry.registerPath({ method: 'post', path: '/api/v2/admin/notifications/{id}/read', tags: ['Admin notifications'], security: adminSecurity, request: { params: z.object({ id: z.string().uuid() }), headers: csrfHeader }, responses: { 200: { description: 'Notification marked as read', content: { 'application/json': { schema: notificationReadResponse } } }, 401: publicErrors[401], 404: { description: 'Notification not found', content: { 'application/json': { schema: problemSchema } } } } });
  registry.registerPath({ method: 'post', path: '/api/v2/admin/notifications/read-all', tags: ['Admin notifications'], security: adminSecurity, request: { headers: csrfHeader }, responses: { 200: { description: 'All administrator notifications marked as read', content: { 'application/json': { schema: notificationReadAllResponse } } }, 401: publicErrors[401] } });
  registerAdminCmsPaths(registry, { problemSchema, moneySchema });
  const document = new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'back-card-shop API',
      version: '0.2.0',
      description: 'Secure Pokemon card ecommerce backend. Admin mutations require both the opaque admin cookie and X-CSRF-Token. Only authenticated state-changing admin requests extend the 15-minute idle timeout; GET/HEAD/OPTIONS requests never do, so polling cannot keep a session alive. Admin sessions also expire after 8 hours absolutely. Every /api/v2/admin response is marked Cache-Control: no-store.',
    },
    servers: [{ url: '/' }],
    security: [],
    tags: [
      { name: 'Admin authentication', description: 'Independent administrator session, password authentication and CSRF lifecycle.' },
      { name: 'Admin dashboard' },
      { name: 'Admin products' },
      { name: 'Admin inventory' },
      { name: 'Admin suppliers', description: 'Supplier directory and lifecycle management.' },
      { name: 'Admin affiliates', description: 'Affiliate onboarding, editorial review, incidents and payouts.' },
      { name: 'Admin orders' },
      { name: 'Admin payments' },
      { name: 'Admin loyalty' },
      { name: 'Admin fulfillment' },
      { name: 'Admin customers' },
      { name: 'Admin audit' },
      { name: 'Catalog' },
      { name: 'Checkout' },
      { name: 'Affiliate portal', description: 'Authenticated affiliate publications, seller orders, logistics and balance.' },
      { name: 'Orders' },
      { name: 'Loyalty', description: 'Configurable purchase points, redemption limits and account movements.' },
      { name: 'Support', description: 'Customer support inbox. Realtime events use /api/v2/support/ws?role=user with the customer cookie.' },
      { name: 'Admin support', description: 'Administrator support inbox. Realtime events use /api/v2/support/ws?role=admin with the admin cookie.' },
      { name: 'Notifications', description: 'Persistent customer notifications for orders and support.' },
      { name: 'Admin notifications', description: 'Persistent administrator notifications for actionable orders and support.' },
    ],
  });
  (document as typeof document & { 'x-websocket'?: unknown })['x-websocket'] = {
    url: '/api/v2/support/ws?role={user|admin}',
    canonicalUrl: '/api/v2/notifications/ws?role={user|admin}',
    authentication: 'Opaque role-specific session cookie; Origin must be configured in FRONTEND_ORIGINS.',
    sessionLifecycle: 'Every socket is bound to the exact authenticated session and all tabs using that session are closed immediately when it is revoked or replaced at login.',
    closeCodes: { sessionRevoked: 4001, actorSocketLimitExceeded: 4008 },
    clientMessages: [{ type: 'ping' }],
    serverEvents: [
      'connection.ready',
      'notification.created',
      'notifications.unread_count',
      'support.conversation.created',
      'support.message.created',
      'support.conversation.read',
      'support.conversation.status_changed',
      'support.unread_count',
      'pong',
      'protocol.error',
    ],
    envelope: { type: 'string', payload: 'object', sentAt: 'ISO-8601 date-time' },
  };
  document.components = { ...(document.components ?? {}), securitySchemes: { userCookie: { type: 'apiKey', in: 'cookie', name: env.cookieSecure ? '__Host-bcs_user' : 'bcs_user' }, adminCookie: { type: 'apiKey', in: 'cookie', name: env.cookieSecure ? '__Host-bcs_admin' : 'bcs_admin' } } };
  return document;
}

export function createDocsRouter(): Router {
  const router = Router();
  if (!env.swaggerEnabled) return router;
  if (env.NODE_ENV === 'production') router.use(requireAdmin);
  const document = buildOpenApi();
  router.get('/openapi.json', (_req, res) => res.json(document));
  router.use('/docs', swaggerUi.serve, swaggerUi.setup(document, { customSiteTitle: 'back-card-shop API' }));
  return router;
}

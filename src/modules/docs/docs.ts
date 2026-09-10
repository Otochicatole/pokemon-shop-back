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
import { adminLoginSchema, adminPrincipalSchema, csrfTokenSchema } from '../auth/index.js';
import { registerAdminCmsPaths } from './admin-docs.js';

extendZodWithOpenApi(z);
const moneySchema = catalogMoneySchema;
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
const orderStatusSchema = z.enum(['PENDING_PAYMENT', 'PAYMENT_REVIEW', 'PAID', 'PREPARING', 'READY_FOR_PICKUP', 'SHIPPED', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'REFUND_RECORDED', 'PAYMENT_REQUIRES_REVIEW']);
const paymentStatusSchema = z.enum(['PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'FAILED', 'REFUNDED', 'DISPUTED', 'REQUIRES_REVIEW']);
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
  pointsToRedeem: z.number().int().min(0).max(2_000_000_000).default(0),
});
const checkoutOptionsSchema = z.object({ fulfillment: z.object({ shippingZones: z.array(z.object({ id: z.string().uuid(), name: z.string(), provinces: z.array(z.string()), rates: z.array(z.object({ id: z.string().uuid(), name: z.string(), price: moneySchema })) })), pickupPoints: z.array(z.object({ id: z.string().uuid(), name: z.string(), address: z.string() })) }), paymentMethods: z.object({ BANK_TRANSFER: z.boolean(), MERCADO_PAGO: z.boolean() }) });
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
const publicOrderSchema = z.object({
  id: z.string().uuid(),
  number: z.string(),
  version: z.number().int().positive(),
  status: orderStatusSchema,
  paymentMethod: z.enum(['BANK_TRANSFER', 'MERCADO_PAGO']),
  fulfillmentType: z.enum(['SHIPMENT', 'PICKUP']),
  totals: z.object({ subtotal: moneySchema, discount: moneySchema, shipping: moneySchema, total: moneySchema }),
  loyalty: orderLoyaltySchema,
  expiresAt: dateTimeSchema.nullable(),
  items: z.array(z.object({
    productId: z.string().uuid(), sku: z.string(), name: z.string(), imageFileId: z.string().uuid().nullable(), imageUrl: z.string().nullable(),
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
    checkoutUrl: z.string().nullable(), paymentSessionStatus: z.enum(['READY', 'RETRY_REQUIRED']),
  }).nullable(),
  createdAt: dateTimeSchema,
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
  const envelope = (schema: z.ZodType) => z.object({ data: schema, meta: z.record(z.string(), z.unknown()).optional() });
  const adminSecurity = [{ adminCookie: [] }];
  const userSecurity = [{ userCookie: [] }];
  const csrfHeader = z.object({ 'x-csrf-token': z.string().min(32) });
  const publicErrors = {
    400: { description: 'Invalid request', content: { 'application/json': { schema: problemSchema } } },
    401: { description: 'Customer session missing or expired', content: { 'application/json': { schema: problemSchema } } },
    403: { description: 'Email verification or CSRF requirement not met', content: { 'application/json': { schema: problemSchema } } },
    409: { description: 'Product, stock or loyalty balance changed', content: { 'application/json': { schema: problemSchema } } },
    503: { description: 'Payment provider is not configured or does not support USD', content: { 'application/json': { schema: problemSchema } } },
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
  registry.registerPath({ method: 'get', path: '/api/v2/catalog/products', tags: ['Catalog'], request: { query: catalogListQuerySchema }, responses: { 200: { description: 'Published products filtered and sorted by the server', content: { 'application/json': { schema: z.object({ data: z.array(catalogProductSchema), meta: z.object({ nextCursor: z.string().nullable() }) }) } } } } });
  registry.registerPath({ method: 'get', path: '/api/v2/catalog/filters', tags: ['Catalog'], responses: { 200: { description: 'Available catalog facets and their published-product counts', content: { 'application/json': { schema: envelope(catalogFiltersSchema) } } } } });
  registry.registerPath({ method: 'get', path: '/api/v2/catalog/products/{slug}', tags: ['Catalog'], request: { params: z.object({ slug: z.string().min(1) }) }, responses: { 200: { description: 'Published product detail', content: { 'application/json': { schema: envelope(catalogProductSchema) } } }, 404: { description: 'Product not found', content: { 'application/json': { schema: problemSchema } } } } });
  registry.registerPath({ method: 'get', path: '/api/v2/checkout/options', tags: ['Checkout'], responses: { 200: { description: 'Available fulfillment and payment methods', content: { 'application/json': { schema: envelope(checkoutOptionsSchema) } } } } });
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
      200: { description: 'Server-calculated quote, including the loyalty discount and points to earn', content: { 'application/json': { schema: envelope(z.object({ subtotal: moneySchema, discount: moneySchema, shipping: moneySchema, total: moneySchema, loyalty: checkoutLoyaltySchema, expiresAt: dateTimeSchema })) } } },
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
  registerAdminCmsPaths(registry, { problemSchema, moneySchema });
  const document = new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'back-card-shop API',
      version: '0.2.0',
      description: 'Secure Pokemon card ecommerce backend. Admin mutations require both the opaque admin cookie and X-CSRF-Token. Admin sessions expire after 15 minutes of inactivity and after 8 hours absolutely. Every /api/v2/admin response is marked Cache-Control: no-store.',
    },
    servers: [{ url: '/' }],
    security: [],
    tags: [
      { name: 'Admin authentication', description: 'Independent administrator session, password authentication and CSRF lifecycle.' },
      { name: 'Admin dashboard' },
      { name: 'Admin products' },
      { name: 'Admin inventory' },
      { name: 'Admin suppliers', description: 'Supplier directory and lifecycle management.' },
      { name: 'Admin orders' },
      { name: 'Admin payments' },
      { name: 'Admin loyalty' },
      { name: 'Admin fulfillment' },
      { name: 'Admin customers' },
      { name: 'Admin audit' },
      { name: 'Catalog' },
      { name: 'Checkout' },
      { name: 'Orders' },
      { name: 'Loyalty', description: 'Configurable purchase points, redemption limits and account movements.' },
    ],
  });
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

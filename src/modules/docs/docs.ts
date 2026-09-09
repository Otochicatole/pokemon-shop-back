import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { z } from 'zod';
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
const orderInputSchema = z.object({ items: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().int(), productVersion: z.number().int() })), paymentMethod: z.enum(['BANK_TRANSFER', 'MERCADO_PAGO']), fulfillment: z.object({ type: z.enum(['PICKUP', 'SHIPMENT']) }) });
const checkoutOptionsSchema = z.object({ fulfillment: z.object({ shippingZones: z.array(z.object({ id: z.string().uuid(), name: z.string(), provinces: z.array(z.string()), rates: z.array(z.object({ id: z.string().uuid(), name: z.string(), price: moneySchema })) })), pickupPoints: z.array(z.object({ id: z.string().uuid(), name: z.string(), address: z.string() })) }), paymentMethods: z.object({ BANK_TRANSFER: z.boolean(), MERCADO_PAGO: z.boolean() }) });

export function buildOpenApi(): import('openapi3-ts/oas31').OpenAPIObject {
  const registry = new OpenAPIRegistry();
  registry.register('Money', moneySchema);
  registry.register('ProblemDetails', problemSchema);
  registry.register('Product', catalogProductSchema);
  registry.register('CatalogFilters', catalogFiltersSchema);
  registry.register('OrderInput', orderInputSchema);
  const envelope = (schema: z.ZodType) => z.object({ data: schema, meta: z.record(z.string(), z.unknown()).optional() });
  const adminSecurity = [{ adminCookie: [] }];
  const csrfHeader = z.object({ 'x-csrf-token': z.string().min(32) });

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
  registry.registerPath({ method: 'post', path: '/api/v2/checkout/preview', tags: ['Checkout'], security: [{ userCookie: [] }], request: { body: { required: true, content: { 'application/json': { schema: orderInputSchema } } } }, responses: { 200: { description: 'Server-calculated quote', content: { 'application/json': { schema: envelope(z.object({ subtotal: moneySchema, shipping: moneySchema, total: moneySchema })) } } }, 409: { description: 'Product or stock changed', content: { 'application/json': { schema: problemSchema } } } } });
  registry.registerPath({ method: 'post', path: '/api/v2/orders', tags: ['Orders'], security: [{ userCookie: [] }], request: { headers: z.object({ 'idempotency-key': z.string() }), body: { required: true, content: { 'application/json': { schema: orderInputSchema } } } }, responses: { 201: { description: 'Order created' }, 409: { description: 'Conflict', content: { 'application/json': { schema: problemSchema } } } } });
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
      { name: 'Admin fulfillment' },
      { name: 'Admin customers' },
      { name: 'Admin audit' },
      { name: 'Catalog' },
      { name: 'Checkout' },
      { name: 'Orders' },
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

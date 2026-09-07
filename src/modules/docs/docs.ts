import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { z } from 'zod';
import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { env } from '../../config/env.js';
import { requireAdmin } from '../../infrastructure/sessions.js';

extendZodWithOpenApi(z);
const moneySchema = z.object({ amountMinor: z.string(), currency: z.literal('ARS') });
const problemSchema = z.object({ type: z.string(), title: z.string(), status: z.number(), code: z.string(), requestId: z.string() });
const productSchema = z.object({ id: z.string().uuid(), sku: z.string(), slug: z.string(), name: z.string(), price: moneySchema, available: z.number(), productVersion: z.number() });
const orderInputSchema = z.object({ items: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().int(), productVersion: z.number().int() })), paymentMethod: z.enum(['BANK_TRANSFER', 'MERCADO_PAGO']), fulfillment: z.object({ type: z.enum(['PICKUP', 'SHIPMENT']) }) });
const checkoutOptionsSchema = z.object({ fulfillment: z.object({ shippingZones: z.array(z.object({ id: z.string().uuid(), name: z.string(), provinces: z.array(z.string()), rates: z.array(z.object({ id: z.string().uuid(), name: z.string(), price: moneySchema })) })), pickupPoints: z.array(z.object({ id: z.string().uuid(), name: z.string(), address: z.string() })) }), paymentMethods: z.object({ BANK_TRANSFER: z.boolean(), MERCADO_PAGO: z.boolean() }) });

export function buildOpenApi(): import('openapi3-ts/oas31').OpenAPIObject {
  const registry = new OpenAPIRegistry();
  registry.register('Money', moneySchema);
  registry.register('ProblemDetails', problemSchema);
  registry.register('Product', productSchema);
  registry.register('OrderInput', orderInputSchema);
  const envelope = (schema: z.ZodType) => z.object({ data: schema, meta: z.record(z.string(), z.unknown()).optional() });
  registry.registerPath({ method: 'get', path: '/api/v2/catalog/products', tags: ['Catalog'], responses: { 200: { description: 'Published products', content: { 'application/json': { schema: z.object({ data: z.array(productSchema), meta: z.object({ nextCursor: z.string().nullable() }) }) } } } } });
  registry.registerPath({ method: 'get', path: '/api/v2/checkout/options', tags: ['Checkout'], responses: { 200: { description: 'Available fulfillment and payment methods', content: { 'application/json': { schema: envelope(checkoutOptionsSchema) } } } } });
  registry.registerPath({ method: 'post', path: '/api/v2/checkout/preview', tags: ['Checkout'], security: [{ userCookie: [] }], request: { body: { required: true, content: { 'application/json': { schema: orderInputSchema } } } }, responses: { 200: { description: 'Server-calculated quote', content: { 'application/json': { schema: envelope(z.object({ subtotal: moneySchema, shipping: moneySchema, total: moneySchema })) } } }, 409: { description: 'Product or stock changed', content: { 'application/json': { schema: problemSchema } } } } });
  registry.registerPath({ method: 'post', path: '/api/v2/orders', tags: ['Orders'], security: [{ userCookie: [] }], request: { headers: z.object({ 'idempotency-key': z.string() }), body: { required: true, content: { 'application/json': { schema: orderInputSchema } } } }, responses: { 201: { description: 'Order created' }, 409: { description: 'Conflict', content: { 'application/json': { schema: problemSchema } } } } });
  const document = new OpenApiGeneratorV31(registry.definitions).generateDocument({ openapi: '3.1.0', info: { title: 'back-card-shop API', version: '0.1.0', description: 'Secure Pokemon card ecommerce backend' }, servers: [{ url: '/' }], security: [], tags: [{ name: 'Catalog' }, { name: 'Checkout' }, { name: 'Orders' }] });
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

import { z } from 'zod';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  activeSchema, auditListQuerySchema, cursorQuerySchema, customerListQuerySchema, dashboardQuerySchema,
  expectedVersionSchema, idParamsSchema, imageOrderSchema, imagePatchSchema, imageUploadFieldsSchema, inventoryAdjustmentSchema,
  loyaltyProgramWriteSchema, orderActionSchema, orderListQuerySchema, orderParamsSchema, orderTransitionSchema, paymentsQuerySchema,
  pickupPointWriteSchema, productImageParamsSchema, productListQuerySchema, productPatchSchema,
  productWriteSchema, refundSchema, shippingZoneWriteSchema, supplierActiveSchema, supplierListQuerySchema,
  supplierPatchSchema, supplierWriteSchema, transferReceiptParamsSchema, transferReviewSchema,
  tcgdexCardParamsSchema, tcgdexImageImportSchema, tcgdexSearchQuerySchema,
  adminActiveMutationDataSchema, adminAuditEntrySchema, adminCustomerDetailDataSchema, adminCustomerSummarySchema,
  adminDashboardDataSchema, adminEnvelopeSchema, adminFulfillmentDataSchema, adminFullRefundDataSchema,
  adminInventoryAdjustmentSchema, adminInventoryMutationDataSchema, adminLoyaltyProgramSchema, adminOrderDetailDataSchema, adminOrderSchema,
  adminOrderStatusDataSchema, adminPickupPointResultDataSchema, adminProductDetailDataSchema, adminProductImageOrderDataSchema,
  adminProductImagesDataSchema, adminProductImageUpdateDataSchema, adminProductSchema, adminProductStatusDataSchema,
  adminShippingZoneResultDataSchema, adminTransferReviewDataSchema,
  adminSupplierActiveMutationDataSchema, adminSupplierDetailDataSchema, adminSupplierSchema, adminTcgdexCardDataSchema,
  adminTcgdexCardSummarySchema,
} from '../backoffice/index.js';

type Options = { problemSchema: z.ZodType; moneySchema: z.ZodType };

export function registerAdminCmsPaths(registry: OpenAPIRegistry, { problemSchema, moneySchema }: Options): void {
  const csrf = z.object({ 'x-csrf-token': z.string().min(32) });
  const security = [{ adminCookie: [] }];
  const envelope = adminEnvelopeSchema;
  const errors = {
    400: { description: 'Invalid request', content: { 'application/json': { schema: problemSchema } } },
    401: { description: 'Admin session missing, idle or expired', content: { 'application/json': { schema: problemSchema } } },
    403: { description: 'Invalid admin CSRF token', content: { 'application/json': { schema: problemSchema } } },
    404: { description: 'Resource not found', content: { 'application/json': { schema: problemSchema } } },
    409: { description: 'Version, state or inventory conflict', content: { 'application/json': { schema: problemSchema } } },
  };
  const ok = (description: string, data: z.ZodTypeAny) => ({ 200: { description, content: { 'application/json': { schema: envelope(data) } } }, ...errors });
  const created = (description: string, data: z.ZodTypeAny) => ({ 201: { description, content: { 'application/json': { schema: envelope(data) } } }, ...errors });
  const json = (schema: z.ZodType) => ({ required: true, content: { 'application/json': { schema } } });

  registry.register('AdminMoney', moneySchema);
  registry.register('AdminProductWrite', productWriteSchema);
  registry.register('AdminProductPatch', productPatchSchema);
  registry.register('AdminOrderTransition', orderTransitionSchema);
  registry.register('AdminShippingZoneWrite', shippingZoneWriteSchema);
  registry.register('AdminPickupPointWrite', pickupPointWriteSchema);
  registry.register('AdminSupplierWrite', supplierWriteSchema);
  registry.register('AdminSupplierPatch', supplierPatchSchema);
  registry.register('AdminLoyaltyProgramWrite', loyaltyProgramWriteSchema);
  registry.register('AdminLoyaltyProgram', adminLoyaltyProgramSchema);

  registry.registerPath({ method: 'get', path: '/api/v2/admin/dashboard', tags: ['Admin dashboard'], summary: 'Read operational and commercial metrics', security, request: { query: dashboardQuerySchema }, responses: ok('Dashboard for the selected date range', adminDashboardDataSchema) });
  registry.registerPath({ method: 'get', path: '/api/v2/admin/loyalty/config', tags: ['Admin loyalty'], summary: 'Read the configurable earning and redemption rules', security, responses: ok('Current loyalty program configuration', adminLoyaltyProgramSchema) });
  registry.registerPath({ method: 'patch', path: '/api/v2/admin/loyalty/config', tags: ['Admin loyalty'], summary: 'Update loyalty rules using optimistic concurrency', security, request: { headers: csrf, body: json(loyaltyProgramWriteSchema) }, responses: ok('Loyalty program configuration updated', adminLoyaltyProgramSchema) });

  registry.registerPath({ method: 'get', path: '/api/v2/admin/tcgdex/cards', tags: ['Admin products'], summary: 'Search the TCGdex card catalog for product autofill', security, request: { query: tcgdexSearchQuerySchema }, responses: ok('Matching TCGdex cards', z.array(adminTcgdexCardSummarySchema)) });
  registry.registerPath({ method: 'get', path: '/api/v2/admin/tcgdex/cards/{id}', tags: ['Admin products'], summary: 'Read a full TCGdex card for product autofill', security, request: { params: tcgdexCardParamsSchema }, responses: ok('TCGdex card details', adminTcgdexCardDataSchema) });

  registry.registerPath({ method: 'get', path: '/api/v2/admin/products', tags: ['Admin products'], summary: 'List products in every publication state', security, request: { query: productListQuerySchema }, responses: ok('Cursor page of products', z.array(adminProductSchema)) });
  registry.registerPath({ method: 'post', path: '/api/v2/admin/products', tags: ['Admin products'], summary: 'Create a draft product and initial inventory', security, request: { headers: csrf, body: json(productWriteSchema) }, responses: created('Draft product created', adminProductDetailDataSchema) });
  registry.registerPath({ method: 'get', path: '/api/v2/admin/products/{id}', tags: ['Admin products'], summary: 'Read complete administrative product data', security, request: { params: idParamsSchema }, responses: ok('Administrative product detail', adminProductDetailDataSchema) });
  registry.registerPath({ method: 'patch', path: '/api/v2/admin/products/{id}', tags: ['Admin products'], summary: 'Edit a product using optimistic concurrency', security, request: { params: idParamsSchema, headers: csrf, body: json(productPatchSchema) }, responses: ok('Product updated', adminProductDetailDataSchema) });
  for (const action of ['publish', 'archive'] as const) {
    registry.registerPath({ method: 'post', path: `/api/v2/admin/products/{id}/${action}`, tags: ['Admin products'], summary: `${action === 'publish' ? 'Publish' : 'Archive'} a product using optimistic concurrency`, security, request: { params: idParamsSchema, headers: csrf, body: json(expectedVersionSchema) }, responses: ok(`Product ${action === 'publish' ? 'published' : 'archived'}`, adminProductStatusDataSchema) });
  }
  registry.registerPath({
    method: 'post', path: '/api/v2/admin/products/{id}/images', tags: ['Admin products'], summary: 'Upload up to eight active product images', security,
    request: { params: idParamsSchema, headers: csrf, body: { required: true, content: { 'multipart/form-data': { schema: imageUploadFieldsSchema.extend({ images: z.array(z.string().openapi({ format: 'binary' })).min(1).max(8) }) } } } },
    responses: created('Images decoded, sanitized and attached', adminProductImagesDataSchema),
  });
  registry.registerPath({ method: 'post', path: '/api/v2/admin/products/{id}/tcgdex-image', tags: ['Admin products'], summary: 'Download, sanitize and attach an official TCGdex card image', security, request: { params: idParamsSchema, headers: csrf, body: json(tcgdexImageImportSchema) }, responses: created('TCGdex image attached', adminProductImagesDataSchema) });
  registry.registerPath({ method: 'patch', path: '/api/v2/admin/products/{id}/images/{imageId}', tags: ['Admin products'], summary: 'Update accessible image text', security, request: { params: productImageParamsSchema, headers: csrf, body: json(imagePatchSchema) }, responses: ok('Image metadata updated', adminProductImageUpdateDataSchema) });
  registry.registerPath({ method: 'put', path: '/api/v2/admin/products/{id}/images/order', tags: ['Admin products'], summary: 'Reorder all active images; position zero is the cover', security, request: { params: idParamsSchema, headers: csrf, body: json(imageOrderSchema) }, responses: ok('Images reordered', adminProductImageOrderDataSchema) });
  registry.registerPath({ method: 'delete', path: '/api/v2/admin/products/{id}/images/{imageId}', tags: ['Admin products'], summary: 'Retire an image using optimistic concurrency while retaining referenced order media', security, request: { params: productImageParamsSchema, headers: csrf, body: json(expectedVersionSchema) }, responses: { 204: { description: 'Image retired and durable cleanup scheduled' }, ...errors } });

  registry.registerPath({ method: 'get', path: '/api/v2/admin/inventory', tags: ['Admin inventory'], summary: 'List on-hand, reserved and available inventory', security, request: { query: productListQuerySchema }, responses: ok('Cursor page of inventory', z.array(adminProductSchema)) });
  registry.registerPath({ method: 'get', path: '/api/v2/admin/products/{id}/inventory-adjustments', tags: ['Admin inventory'], summary: 'List immutable stock adjustments', security, request: { params: idParamsSchema, query: cursorQuerySchema }, responses: ok('Cursor page of stock adjustments', z.array(adminInventoryAdjustmentSchema)) });
  registry.registerPath({ method: 'post', path: '/api/v2/admin/products/{id}/inventory-adjustment', tags: ['Admin inventory'], summary: 'Apply a reasoned stock delta without changing reservations', security, request: { params: idParamsSchema, headers: csrf, body: json(inventoryAdjustmentSchema) }, responses: ok('Inventory adjusted', adminInventoryMutationDataSchema) });

  registry.registerPath({ method: 'get', path: '/api/v2/admin/suppliers', tags: ['Admin suppliers'], summary: 'List supplier directory entries', security, request: { query: supplierListQuerySchema }, responses: ok('Cursor page of suppliers', z.array(adminSupplierSchema)) });
  registry.registerPath({ method: 'get', path: '/api/v2/admin/suppliers/{id}', tags: ['Admin suppliers'], summary: 'Read supplier details', security, request: { params: idParamsSchema }, responses: ok('Supplier detail', adminSupplierDetailDataSchema) });
  registry.registerPath({ method: 'post', path: '/api/v2/admin/suppliers', tags: ['Admin suppliers'], summary: 'Create an active supplier', security, request: { headers: csrf, body: json(supplierWriteSchema) }, responses: created('Supplier created', adminSupplierDetailDataSchema) });
  registry.registerPath({ method: 'patch', path: '/api/v2/admin/suppliers/{id}', tags: ['Admin suppliers'], summary: 'Edit a supplier using optimistic concurrency', security, request: { params: idParamsSchema, headers: csrf, body: json(supplierPatchSchema) }, responses: ok('Supplier updated', adminSupplierDetailDataSchema) });
  registry.registerPath({ method: 'patch', path: '/api/v2/admin/suppliers/{id}/active', tags: ['Admin suppliers'], summary: 'Activate or deactivate a supplier without deleting history', security, request: { params: idParamsSchema, headers: csrf, body: json(supplierActiveSchema) }, responses: ok('Supplier availability changed', adminSupplierActiveMutationDataSchema) });

  registry.registerPath({ method: 'get', path: '/api/v2/admin/orders', tags: ['Admin orders'], summary: 'List and filter orders', security, request: { query: orderListQuerySchema }, responses: ok('Cursor page of orders', z.array(adminOrderSchema)) });
  registry.registerPath({ method: 'get', path: '/api/v2/admin/orders/{number}', tags: ['Admin orders'], summary: 'Read immutable snapshots, timeline and allowed actions', security, request: { params: orderParamsSchema }, responses: ok('Administrative order detail', adminOrderDetailDataSchema) });
  registry.registerPath({ method: 'post', path: '/api/v2/admin/orders/{number}/cancel', tags: ['Admin orders'], summary: 'Cancel a pending order and release reservations exactly once', security, request: { params: orderParamsSchema, headers: csrf, body: json(orderActionSchema) }, responses: ok('Order cancelled', adminOrderStatusDataSchema) });
  registry.registerPath({ method: 'post', path: '/api/v2/admin/orders/{number}/transition', tags: ['Admin orders'], summary: 'Apply a permitted fulfillment transition', security, request: { params: orderParamsSchema, headers: csrf, body: json(orderTransitionSchema) }, responses: ok('Order status changed', adminOrderStatusDataSchema) });
  registry.registerPath({ method: 'patch', path: '/api/v2/admin/orders/{number}/status', tags: ['Admin orders'], summary: 'Compatibility alias for an order transition', deprecated: true, security, request: { params: orderParamsSchema, headers: csrf, body: json(orderTransitionSchema) }, responses: ok('Order status changed', adminOrderStatusDataSchema) });
  for (const decision of ['approve', 'reject'] as const) {
    registry.registerPath({ method: 'post', path: `/api/v2/admin/orders/{number}/transfer-receipts/{receiptId}/${decision}`, tags: ['Admin payments'], summary: `${decision === 'approve' ? 'Approve' : 'Reject'} a specific transfer receipt`, security, request: { params: transferReceiptParamsSchema, headers: csrf, body: json(transferReviewSchema) }, responses: ok(`Transfer receipt ${decision === 'approve' ? 'approved' : 'rejected'}`, adminTransferReviewDataSchema) });
  }
  registry.registerPath({ method: 'post', path: '/api/v2/admin/orders/{number}/late-payment/fulfill', tags: ['Admin payments'], summary: 'Accept a canonical late payment after atomically reacquiring stock', security, request: { params: orderParamsSchema, headers: csrf, body: json(expectedVersionSchema) }, responses: ok('Late payment accepted for fulfillment', adminOrderStatusDataSchema) });
  registry.registerPath({ method: 'post', path: '/api/v2/admin/orders/{number}/refund', tags: ['Admin payments'], summary: 'Record one external full refund without replenishing stock', security, request: { params: orderParamsSchema, headers: csrf, body: json(refundSchema) }, responses: created('Full refund recorded', adminFullRefundDataSchema) });
  registry.registerPath({ method: 'get', path: '/api/v2/admin/payments', tags: ['Admin payments'], summary: 'List payments or an operational review queue', security, request: { query: paymentsQuerySchema }, responses: ok('Cursor page of payments and orders', z.array(adminOrderSchema)) });

  registry.registerPath({ method: 'get', path: '/api/v2/admin/fulfillment', tags: ['Admin fulfillment'], summary: 'List all zones, rates and pickup points', security, responses: ok('Fulfillment configuration', adminFulfillmentDataSchema) });
  registry.registerPath({ method: 'post', path: '/api/v2/admin/fulfillment/shipping-zones', tags: ['Admin fulfillment'], summary: 'Create a shipping zone and rates', security, request: { headers: csrf, body: json(shippingZoneWriteSchema) }, responses: created('Shipping zone created', adminShippingZoneResultDataSchema) });
  registry.registerPath({ method: 'patch', path: '/api/v2/admin/fulfillment/shipping-zones/{id}', tags: ['Admin fulfillment'], summary: 'Replace a shipping zone configuration', security, request: { params: idParamsSchema, headers: csrf, body: json(shippingZoneWriteSchema) }, responses: ok('Shipping zone updated', adminShippingZoneResultDataSchema) });
  registry.registerPath({ method: 'patch', path: '/api/v2/admin/fulfillment/shipping-zones/{id}/active', tags: ['Admin fulfillment'], summary: 'Activate or deactivate a shipping zone', security, request: { params: idParamsSchema, headers: csrf, body: json(activeSchema) }, responses: ok('Shipping zone availability changed', adminActiveMutationDataSchema) });
  registry.registerPath({ method: 'post', path: '/api/v2/admin/fulfillment/pickup-points', tags: ['Admin fulfillment'], summary: 'Create a pickup point', security, request: { headers: csrf, body: json(pickupPointWriteSchema) }, responses: created('Pickup point created', adminPickupPointResultDataSchema) });
  registry.registerPath({ method: 'patch', path: '/api/v2/admin/fulfillment/pickup-points/{id}', tags: ['Admin fulfillment'], summary: 'Update a pickup point', security, request: { params: idParamsSchema, headers: csrf, body: json(pickupPointWriteSchema) }, responses: ok('Pickup point updated', adminPickupPointResultDataSchema) });
  registry.registerPath({ method: 'patch', path: '/api/v2/admin/fulfillment/pickup-points/{id}/active', tags: ['Admin fulfillment'], summary: 'Activate or deactivate a pickup point', security, request: { params: idParamsSchema, headers: csrf, body: json(activeSchema) }, responses: ok('Pickup point availability changed', adminActiveMutationDataSchema) });

  registry.registerPath({ method: 'get', path: '/api/v2/admin/customers', tags: ['Admin customers'], summary: 'List customers in read-only mode', security, request: { query: customerListQuerySchema }, responses: ok('Cursor page of customers', z.array(adminCustomerSummarySchema)) });
  registry.registerPath({ method: 'get', path: '/api/v2/admin/customers/{id}', tags: ['Admin customers'], summary: 'Read a customer and isolated order history', security, request: { params: idParamsSchema }, responses: ok('Customer detail', adminCustomerDetailDataSchema) });
  registry.registerPath({ method: 'get', path: '/api/v2/admin/customers/{id}/orders', tags: ['Admin customers'], summary: 'Read a cursor page of one customer orders', security, request: { params: idParamsSchema, query: cursorQuerySchema }, responses: ok('Cursor page of customer orders', z.array(adminOrderSchema)) });
  registry.registerPath({ method: 'get', path: '/api/v2/admin/audit', tags: ['Admin audit'], summary: 'List immutable redacted audit events', security, request: { query: auditListQuerySchema }, responses: ok('Cursor page of audit events', z.array(adminAuditEntrySchema)) });

  registry.registerPath({ method: 'post', path: '/api/v2/admin/shipping-zones', tags: ['Admin fulfillment'], summary: 'Compatibility alias for shipping-zone creation', deprecated: true, security, request: { headers: csrf, body: json(shippingZoneWriteSchema) }, responses: created('Shipping zone created', adminShippingZoneResultDataSchema) });
  registry.registerPath({ method: 'post', path: '/api/v2/admin/pickup-points', tags: ['Admin fulfillment'], summary: 'Compatibility alias for pickup-point creation', deprecated: true, security, request: { headers: csrf, body: json(pickupPointWriteSchema) }, responses: created('Pickup point created', adminPickupPointResultDataSchema) });
}

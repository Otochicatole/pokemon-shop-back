import { Router, type Request, type RequestHandler } from 'express';
import type multer from 'multer';
import { Readable } from 'node:stream';
import { AppError, badRequest } from '../../../shared/errors.js';
import type { AdminCmsApplication } from '../application/admin-cms-application.js';
import type { AdminActor } from '../domain/admin-cms.js';
import {
  activeSchema, auditListQuerySchema, cursorQuerySchema, customerListQuerySchema, dashboardQuerySchema,
  expectedVersionSchema, idParamsSchema, imageOrderSchema, imagePatchSchema, imageUploadFieldsSchema, inventoryAdjustmentSchema,
  orderActionSchema, orderListQuerySchema, orderParamsSchema, orderTransitionSchema, paymentsQuerySchema,
  pickupPointWriteSchema, productImageParamsSchema, productListQuerySchema, productPatchSchema,
  productWriteSchema, refundSchema, shippingZoneWriteSchema, supplierActiveSchema, supplierListQuerySchema,
  supplierPatchSchema, supplierWriteSchema, transferReceiptParamsSchema, transferReviewSchema,
  loyaltyProgramWriteSchema, tcgdexCardParamsSchema, tcgdexImageImportSchema, tcgdexSearchQuerySchema,
} from './admin-cms-schemas.js';
import { getCard, searchCards } from '../../tcgdex/index.js';

const noContent = (response: import('express').Response) => response.status(204).send();
const tcgdexImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

function tcgdexImageUrl(value: string) {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw badRequest('TCGDEX_IMAGE_URL_INVALID', 'La imagen de TCGdex no es válida'); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'assets.tcgdex.net') throw badRequest('TCGDEX_IMAGE_URL_INVALID', 'Solo se admiten imágenes oficiales de TCGdex');
  return parsed.toString();
}

async function downloadTcgdexImage(value: string): Promise<Express.Multer.File> {
  const url = tcgdexImageUrl(value);
  let response: Response;
  try { response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) }); } catch { throw new AppError(502, 'TCGDEX_IMAGE_UNAVAILABLE', 'No se pudo descargar la imagen de TCGdex'); }
  if (!response.ok) throw new AppError(502, 'TCGDEX_IMAGE_UNAVAILABLE', 'No se pudo descargar la imagen de TCGdex');
  const contentType = (response.headers.get('content-type') ?? '').split(';').at(0)?.trim() ?? '';
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (!tcgdexImageTypes.has(contentType) || contentLength > 10 * 1024 * 1024) throw badRequest('TCGDEX_IMAGE_INVALID', 'La imagen de TCGdex no tiene un formato admitido');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > 10 * 1024 * 1024) throw badRequest('TCGDEX_IMAGE_TOO_LARGE', 'La imagen de TCGdex supera el límite permitido');
  return {
    fieldname: 'image', originalname: 'tcgdex-card.webp', encoding: '7bit', mimetype: contentType,
    destination: '', filename: 'tcgdex-card.webp', path: '', size: buffer.byteLength, buffer, stream: Readable.from(buffer),
  };
}

export type AdminCmsHttpDependencies = {
  application: AdminCmsApplication;
  upload: multer.Multer;
  requireAdmin: RequestHandler;
  actorFromRequest(request: Request): AdminActor;
  media: {
    saveProductImage(file: Express.Multer.File): Promise<{ id: string }>;
    discardUnattachedFile(id: string): Promise<boolean>;
  };
};

export function createAdminCmsRouter({ application, upload, requireAdmin, actorFromRequest, media }: AdminCmsHttpDependencies): Router {
  const router = Router();
  router.use(requireAdmin);

  router.get('/dashboard', async (req, res) => res.json(await application.dashboard.get(dashboardQuerySchema.parse(req.query).range)));

  router.get('/loyalty/config', async (_req, res) => res.json(await application.loyalty.get()));
  router.patch('/loyalty/config', async (req, res) => res.json(await application.loyalty.update(actorFromRequest(req), loyaltyProgramWriteSchema.parse(req.body))));

  router.get('/tcgdex/cards', async (req, res) => {
    const query = tcgdexSearchQuerySchema.parse(req.query);
    return res.json({ data: await searchCards(query.q), meta: {} });
  });
  router.get('/tcgdex/cards/:id', async (req, res) => {
    const params = tcgdexCardParamsSchema.parse(req.params);
    return res.json({ data: { card: await getCard(params.id) }, meta: {} });
  });

  router.get('/products', async (req, res) => res.json(await application.products.list(productListQuerySchema.parse(req.query))));
  router.post('/products', async (req, res) => {
    const input = productWriteSchema.parse(req.body);
    const { stock, ...product } = input;
    return res.status(201).json(await application.products.create(actorFromRequest(req), { ...product, initialStock: input.initialStock ?? stock }));
  });
  router.get('/products/:id', async (req, res) => res.json(await application.products.get(idParamsSchema.parse(req.params).id)));
  router.patch('/products/:id', async (req, res) => res.json(await application.products.update(actorFromRequest(req), idParamsSchema.parse(req.params).id, productPatchSchema.parse(req.body))));
  router.post('/products/:id/publish', async (req, res) => res.json(await application.products.changeStatus(actorFromRequest(req), idParamsSchema.parse(req.params).id, expectedVersionSchema.parse(req.body).expectedVersion, 'PUBLISHED')));
  router.post('/products/:id/archive', async (req, res) => res.json(await application.products.changeStatus(actorFromRequest(req), idParamsSchema.parse(req.params).id, expectedVersionSchema.parse(req.body).expectedVersion, 'ARCHIVED')));
  router.post('/products/:id/images', upload.array('images', 8), async (req: Request, res) => {
    const productId = idParamsSchema.parse(req.params).id;
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) throw badRequest('IMAGES_REQUIRED', 'At least one image is required');
    const fields = imageUploadFieldsSchema.parse(req.body);
    const rawAlt = fields.altText;
    const altTexts = Array.isArray(rawAlt) ? rawAlt.map(String) : rawAlt === undefined ? [] : [String(rawAlt)];
    const stored: { id: string; altText?: string }[] = [];
    try {
      for (const [index, file] of files.entries()) {
        const value = await media.saveProductImage(file);
        stored.push({ id: value.id, ...(altTexts[index] || altTexts[0] ? { altText: String(altTexts[index] ?? altTexts[0]).slice(0, 255) } : {}) });
      }
      return res.status(201).json(await application.products.addImages(actorFromRequest(req), productId, fields.expectedVersion, stored));
    } catch (error) {
      await Promise.all(stored.map((file) => media.discardUnattachedFile(file.id).catch(() => false)));
      throw error;
    }
  });
  router.post('/products/:id/tcgdex-image', async (req, res) => {
    const productId = idParamsSchema.parse(req.params).id;
    const input = tcgdexImageImportSchema.parse(req.body);
    const file = await downloadTcgdexImage(input.imageUrl);
    const stored = await media.saveProductImage(file);
    try {
      return res.status(201).json(await application.products.addImages(actorFromRequest(req), productId, input.expectedVersion, [{ id: stored.id, altText: 'Imagen oficial de TCGdex' }], { prepend: true }));
    } catch (error) {
      await media.discardUnattachedFile(stored.id).catch(() => false);
      throw error;
    }
  });
  router.patch('/products/:id/images/:imageId', async (req, res) => {
    const params = productImageParamsSchema.parse(req.params);
    const input = imagePatchSchema.parse(req.body);
    return res.json(await application.products.updateImage(actorFromRequest(req), params.id, params.imageId, input.expectedVersion, input.altText));
  });
  router.put('/products/:id/images/order', async (req, res) => {
    const input = imageOrderSchema.parse(req.body);
    return res.json(await application.products.reorderImages(actorFromRequest(req), idParamsSchema.parse(req.params).id, input.expectedVersion, input.imageIds));
  });
  router.delete('/products/:id/images/:imageId', async (req, res) => {
    const params = productImageParamsSchema.parse(req.params);
    await application.products.retireImage(actorFromRequest(req), params.id, params.imageId, expectedVersionSchema.parse(req.body).expectedVersion);
    return noContent(res);
  });
  router.get('/products/:id/inventory-adjustments', async (req, res) => {
    const query = cursorQuerySchema.parse(req.query);
    return res.json(await application.inventory.listAdjustments(idParamsSchema.parse(req.params).id, query.cursor, query.limit));
  });
  router.post('/products/:id/inventory-adjustment', async (req, res) => {
    const input = inventoryAdjustmentSchema.parse(req.body);
    return res.json(await application.inventory.adjust(actorFromRequest(req), idParamsSchema.parse(req.params).id, input.delta, input.reason));
  });
  router.get('/inventory', async (req, res) => res.json(await application.inventory.list(productListQuerySchema.parse(req.query))));

  router.get('/suppliers', async (req, res) => res.json(await application.suppliers.list(supplierListQuerySchema.parse(req.query))));
  router.get('/suppliers/:id', async (req, res) => res.json(await application.suppliers.get(idParamsSchema.parse(req.params).id)));
  router.post('/suppliers', async (req, res) => res.status(201).json(await application.suppliers.create(actorFromRequest(req), supplierWriteSchema.parse(req.body))));
  router.patch('/suppliers/:id', async (req, res) => res.json(await application.suppliers.update(actorFromRequest(req), idParamsSchema.parse(req.params).id, supplierPatchSchema.parse(req.body))));
  router.patch('/suppliers/:id/active', async (req, res) => {
    const input = supplierActiveSchema.parse(req.body);
    return res.json(await application.suppliers.setActive(actorFromRequest(req), idParamsSchema.parse(req.params).id, input.active, input.expectedVersion));
  });

  router.get('/orders', async (req, res) => res.json(await application.orders.list(orderListQuerySchema.parse(req.query))));
  router.get('/orders/:number', async (req, res) => res.json(await application.orders.get(orderParamsSchema.parse(req.params).number)));
  router.post('/orders/:number/cancel', async (req, res) => {
    const input = orderActionSchema.parse(req.body);
    return res.json(await application.orders.cancel(actorFromRequest(req), orderParamsSchema.parse(req.params).number, input.expectedVersion, input.note));
  });
  router.post('/orders/:number/transition', async (req, res) => {
    const input = orderTransitionSchema.parse(req.body);
    return res.json(await application.orders.transition(actorFromRequest(req), orderParamsSchema.parse(req.params).number, input.expectedVersion, input.status, input.note));
  });
  router.patch('/orders/:number/status', async (req, res) => {
    const input = orderTransitionSchema.parse(req.body);
    return res.json(await application.orders.transition(actorFromRequest(req), orderParamsSchema.parse(req.params).number, input.expectedVersion, input.status, input.note));
  });
  router.post('/orders/:number/transfer-receipts/:receiptId/approve', async (req, res) => {
    const params = transferReceiptParamsSchema.parse(req.params); const input = transferReviewSchema.parse(req.body);
    return res.json(await application.payments.reviewTransfer(actorFromRequest(req), params.number, params.receiptId, input.expectedVersion, 'APPROVED', input.note));
  });
  router.post('/orders/:number/transfer-receipts/:receiptId/reject', async (req, res) => {
    const params = transferReceiptParamsSchema.parse(req.params); const input = transferReviewSchema.parse(req.body);
    return res.json(await application.payments.reviewTransfer(actorFromRequest(req), params.number, params.receiptId, input.expectedVersion, 'REJECTED', input.note));
  });
  router.post('/orders/:number/late-payment/fulfill', async (req, res) => res.json(await application.payments.fulfillLatePayment(actorFromRequest(req), orderParamsSchema.parse(req.params).number, expectedVersionSchema.parse(req.body).expectedVersion)));
  router.post('/orders/:number/refund', async (req, res) => {
    const input = refundSchema.parse(req.body);
    return res.status(201).json(await application.payments.recordFullRefund(actorFromRequest(req), orderParamsSchema.parse(req.params).number, input.expectedVersion, input.reason, input.externalReference));
  });
  router.get('/payments', async (req, res) => {
    const query = paymentsQuerySchema.parse(req.query);
    const { queue, ...orders } = query;
    return res.json(await application.payments.list(orders, queue));
  });

  router.get('/fulfillment', async (_req, res) => res.json(await application.fulfillment.get()));
  router.post('/fulfillment/shipping-zones', async (req, res) => res.status(201).json(await application.fulfillment.createShippingZone(actorFromRequest(req), shippingZoneWriteSchema.parse(req.body))));
  router.patch('/fulfillment/shipping-zones/:id', async (req, res) => res.json(await application.fulfillment.updateShippingZone(actorFromRequest(req), idParamsSchema.parse(req.params).id, shippingZoneWriteSchema.parse(req.body))));
  router.patch('/fulfillment/shipping-zones/:id/active', async (req, res) => res.json(await application.fulfillment.setShippingZoneActive(actorFromRequest(req), idParamsSchema.parse(req.params).id, activeSchema.parse(req.body).active)));
  router.post('/fulfillment/pickup-points', async (req, res) => res.status(201).json(await application.fulfillment.createPickupPoint(actorFromRequest(req), pickupPointWriteSchema.parse(req.body))));
  router.patch('/fulfillment/pickup-points/:id', async (req, res) => res.json(await application.fulfillment.updatePickupPoint(actorFromRequest(req), idParamsSchema.parse(req.params).id, pickupPointWriteSchema.parse(req.body))));
  router.patch('/fulfillment/pickup-points/:id/active', async (req, res) => res.json(await application.fulfillment.setPickupPointActive(actorFromRequest(req), idParamsSchema.parse(req.params).id, activeSchema.parse(req.body).active)));
  // Compatibility aliases retained for existing operational scripts.
  router.post('/shipping-zones', async (req, res) => res.status(201).json(await application.fulfillment.createShippingZone(actorFromRequest(req), shippingZoneWriteSchema.parse(req.body))));
  router.post('/pickup-points', async (req, res) => res.status(201).json(await application.fulfillment.createPickupPoint(actorFromRequest(req), pickupPointWriteSchema.parse(req.body))));

  router.get('/customers', async (req, res) => res.json(await application.customers.list(customerListQuerySchema.parse(req.query))));
  router.get('/customers/:id', async (req, res) => res.json(await application.customers.get(idParamsSchema.parse(req.params).id)));
  router.get('/customers/:id/orders', async (req, res) => {
    const query = cursorQuerySchema.parse(req.query);
    return res.json(await application.customers.listOrders(idParamsSchema.parse(req.params).id, query.cursor, query.limit));
  });
  router.get('/audit', async (req, res) => res.json(await application.audit.list(auditListQuerySchema.parse(req.query))));

  return router;
}

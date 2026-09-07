import { Router } from 'express';
import { z } from 'zod';
import { notFound } from '../../../shared/errors.js';
import { GetProduct, ListProducts, type CatalogRepository } from '../application/list-products.js';

const listSchema = z.object({ q: z.string().trim().max(100).optional(), kind: z.enum(['SINGLE_CARD', 'SEALED_PRODUCT']).optional(), setName: z.string().trim().max(100).optional(), rarity: z.string().trim().max(80).optional(), condition: z.enum(['NM', 'EXCELLENT', 'GOOD', 'PLAYED', 'DAMAGED']).optional(), language: z.string().trim().max(40).optional(), cursor: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(24) });

export function createCatalogV2Router(repository: CatalogRepository): Router {
  const router = Router();
  const list = new ListProducts(repository);
  const get = new GetProduct(repository);
  router.get('/products', async (req, res) => { const result = await list.execute(listSchema.parse(req.query)); return res.json({ data: result.products, meta: { nextCursor: result.nextCursor } }); });
  router.get('/products/:slug', async (req, res) => { const product = await get.execute(String(req.params.slug)); if (!product) throw notFound('Product not found'); return res.json({ data: product }); });
  return router;
}

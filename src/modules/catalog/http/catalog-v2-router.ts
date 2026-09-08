import { Router } from 'express';
import { notFound } from '../../../shared/errors.js';
import { GetCatalogFilters, GetProduct, ListProducts, type CatalogQuery, type CatalogRepository } from '../application/list-products.js';
import { catalogListQuerySchema } from './catalog-schemas.js';

const repeatedParameters = ['kind', 'pokemonType', 'setName', 'rarity', 'condition', 'language', 'finish', 'edition', 'gradingCompany'] as const;

function normalizeQuery(query: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...query };
  for (const key of repeatedParameters) {
    const value = query[key];
    if (value === undefined) continue;
    const values = (Array.isArray(value) ? value : [value])
      .map((item) => String(item).trim())
      .filter(Boolean);
    normalized[key] = [...new Set(values)];
  }
  for (const key of ['q', 'setCode', 'cursor', 'minPriceMinor', 'maxPriceMinor'] as const) {
    if (normalized[key] === '') delete normalized[key];
  }
  return normalized;
}

function toCatalogQuery(query: Record<string, unknown>): CatalogQuery {
  const parsed = catalogListQuerySchema.parse(normalizeQuery(query));
  return {
    ...parsed,
    graded: parsed.graded === undefined ? undefined : parsed.graded === 'true',
    inStock: parsed.inStock === undefined ? undefined : parsed.inStock === 'true',
  };
}

export function createCatalogV2Router(repository: CatalogRepository): Router {
  const router = Router();
  const list = new ListProducts(repository);
  const get = new GetProduct(repository);
  const getFilters = new GetCatalogFilters(repository);
  router.get('/filters', async (_req, res) => res.json({ data: await getFilters.execute(), meta: {} }));
  router.get('/products', async (req, res) => { const result = await list.execute(toCatalogQuery(req.query)); return res.json({ data: result.products, meta: { nextCursor: result.nextCursor } }); });
  router.get('/products/:slug', async (req, res) => { const product = await get.execute(String(req.params.slug)); if (!product) throw notFound('Product not found'); return res.json({ data: product }); });
  return router;
}

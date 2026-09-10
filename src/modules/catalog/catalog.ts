import { Router } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { ProductStatus } from '@prisma/client';
import { notFound } from '../../shared/errors.js';
import { BASE_CURRENCY } from '../../shared/currency.js';

const listSchema = z.object({
  q: z.string().trim().max(100).optional(),
  kind: z.enum(['SINGLE_CARD', 'SEALED_PRODUCT']).optional(),
  setName: z.string().trim().max(100).optional(),
  rarity: z.string().trim().max(80).optional(),
  condition: z.enum(['NM', 'EXCELLENT', 'GOOD', 'PLAYED', 'DAMAGED']).optional(),
  language: z.string().trim().max(40).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24),
});

function mapProduct(product: any) {
  const available = Math.max(0, (product.inventory?.onHand ?? 0) - (product.inventory?.reserved ?? 0));
  return {
    id: product.id,
    sku: product.sku,
    slug: product.slug,
    name: product.name,
    description: product.description,
    kind: product.kind,
    stockMode: product.stockMode,
    price: { amountMinor: product.priceMinor.toString(), currency: BASE_CURRENCY },
    available,
    productVersion: product.version,
    pokemonCard: product.pokemonCard,
    images: (product.images ?? []).map((image: any) => ({ id: image.id, url: `/media/public/${image.fileId}`, altText: image.altText, sortOrder: image.sortOrder })),
    updatedAt: product.updatedAt,
  };
}

const include = { pokemonCard: true, inventory: true, images: { where: { retiredAt: null }, orderBy: { sortOrder: 'asc' as const }, include: { file: true } } };

export function createCatalogRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.get('/products', async (req, res) => {
    const query = listSchema.parse(req.query);
    const where: any = { status: ProductStatus.PUBLISHED };
    if (query.kind) where.kind = query.kind;
    if (query.q) where.OR = [{ name: { contains: query.q } }, { description: { contains: query.q } }, { sku: { contains: query.q } }];
    const card: any = {};
    if (query.setName) card.setName = { contains: query.setName };
    if (query.rarity) card.rarity = query.rarity;
    if (query.condition) card.condition = query.condition;
    if (query.language) card.language = query.language;
    if (Object.keys(card).length) where.pokemonCard = card;
    const products = await prisma.product.findMany({ where, take: query.limit + 1, ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}), orderBy: { id: 'asc' }, include });
    const hasMore = products.length > query.limit;
    const page = hasMore ? products.slice(0, query.limit) : products;
    return res.json({ data: page.map(mapProduct), nextCursor: hasMore ? page.at(-1)?.id ?? null : null });
  });
  router.get('/products/:slug', async (req, res) => {
    const product = await prisma.product.findFirst({ where: { slug: req.params.slug, status: ProductStatus.PUBLISHED }, include });
    if (!product) throw notFound('Product not found');
    return res.json({ product: mapProduct(product) });
  });
  return router;
}

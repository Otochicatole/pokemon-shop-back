import type { PrismaClient, Prisma } from '@prisma/client';
import { ProductStatus } from '@prisma/client';
import type { CatalogProduct } from '../domain/product.js';
import type { CatalogQuery, CatalogRepository } from '../application/list-products.js';

const include = { pokemonCard: true, inventory: true, images: { orderBy: { sortOrder: 'asc' as const }, include: { file: true } } } satisfies Prisma.ProductInclude;
type ProductRecord = Prisma.ProductGetPayload<{ include: typeof include }>;

const mapProduct = (product: ProductRecord): CatalogProduct => ({
  id: product.id, sku: product.sku, slug: product.slug, name: product.name, description: product.description,
  kind: product.kind, stockMode: product.stockMode,
  price: { amountMinor: product.priceMinor.toString(), currency: product.currency },
  available: Math.max(0, (product.inventory?.onHand ?? 0) - (product.inventory?.reserved ?? 0)),
  productVersion: product.version, pokemonCard: product.pokemonCard,
  images: product.images.map((image) => ({ id: image.id, url: `/media/public/${image.fileId}`, altText: image.altText, sortOrder: image.sortOrder })),
  updatedAt: product.updatedAt,
});

export class PrismaCatalogRepository implements CatalogRepository {
  public constructor(private readonly prisma: PrismaClient) {}
  public async listPublished(query: CatalogQuery) {
    const where: Prisma.ProductWhereInput = { status: ProductStatus.PUBLISHED };
    if (query.kind) where.kind = query.kind;
    if (query.q) where.OR = [{ name: { contains: query.q } }, { description: { contains: query.q } }, { sku: { contains: query.q } }];
    const card: Prisma.PokemonCardDetailsWhereInput = {};
    if (query.setName) card.setName = { contains: query.setName };
    if (query.rarity) card.rarity = query.rarity;
    if (query.condition) card.condition = query.condition;
    if (query.language) card.language = query.language;
    if (Object.keys(card).length > 0) where.pokemonCard = card;
    const products = await this.prisma.product.findMany({ where, take: query.limit + 1, ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}), orderBy: { id: 'asc' }, include });
    const hasMore = products.length > query.limit;
    const page = hasMore ? products.slice(0, query.limit) : products;
    return { products: page.map(mapProduct), nextCursor: hasMore ? page.at(-1)?.id ?? null : null };
  }
  public async findPublishedBySlug(slug: string) {
    const product = await this.prisma.product.findFirst({ where: { slug, status: ProductStatus.PUBLISHED }, include });
    return product ? mapProduct(product) : null;
  }
}

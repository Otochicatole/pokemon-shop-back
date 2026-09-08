import type { PrismaClient, Prisma } from '@prisma/client';
import { ProductStatus } from '@prisma/client';
import { pokemonTypes, productConditions, type CatalogFacetOption, type CatalogProduct } from '../domain/product.js';
import type { CatalogQuery, CatalogRepository } from '../application/list-products.js';

const include = {
  pokemonCard: true,
  inventory: true,
  images: { orderBy: { sortOrder: 'asc' as const }, include: { file: true } },
} satisfies Prisma.ProductInclude;
type ProductRecord = Prisma.ProductGetPayload<{ include: typeof include }>;

const mapProduct = (product: ProductRecord): CatalogProduct => ({
  id: product.id,
  sku: product.sku,
  slug: product.slug,
  name: product.name,
  description: product.description,
  kind: product.kind,
  stockMode: product.stockMode,
  price: { amountMinor: product.priceMinor.toString(), currency: 'ARS' },
  available: Math.max(0, (product.inventory?.onHand ?? 0) - (product.inventory?.reserved ?? 0)),
  productVersion: product.version,
  pokemonCard: product.pokemonCard ? {
    setName: product.pokemonCard.setName,
    setCode: product.pokemonCard.setCode,
    cardNumber: product.pokemonCard.cardNumber,
    rarity: product.pokemonCard.rarity,
    language: product.pokemonCard.language,
    condition: product.pokemonCard.condition,
    pokemonType: product.pokemonCard.pokemonType,
    finish: product.pokemonCard.finish,
    edition: product.pokemonCard.edition,
    gradingCompany: product.pokemonCard.gradingCompany,
    grade: product.pokemonCard.grade,
    certificationNumber: product.pokemonCard.certificationNumber,
  } : null,
  images: product.images.map((image) => ({
    id: image.id,
    url: `/media/public/${image.fileId}`,
    altText: image.altText,
    sortOrder: image.sortOrder,
  })),
  updatedAt: product.updatedAt,
});

function countOptions(values: Array<string | null>): CatalogFacetOption[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized) continue;
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => left.value.localeCompare(right.value, 'es', { sensitivity: 'base' }));
}

function productOrder(sort: CatalogQuery['sort']): Prisma.ProductOrderByWithRelationInput[] {
  switch (sort) {
    case 'PRICE_ASC': return [{ priceMinor: 'asc' }, { id: 'asc' }];
    case 'PRICE_DESC': return [{ priceMinor: 'desc' }, { id: 'asc' }];
    case 'NAME_ASC': return [{ name: 'asc' }, { id: 'asc' }];
    case 'NEWEST': return [{ publishedAt: 'desc' }, { id: 'asc' }];
  }
}

export class PrismaCatalogRepository implements CatalogRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async listPublished(query: CatalogQuery) {
    const and: Prisma.ProductWhereInput[] = [{ status: ProductStatus.PUBLISHED }];

    if (query.kind?.length) and.push({ kind: { in: query.kind } });
    if (query.minPriceMinor || query.maxPriceMinor) {
      and.push({ priceMinor: {
        ...(query.minPriceMinor ? { gte: BigInt(query.minPriceMinor) } : {}),
        ...(query.maxPriceMinor ? { lte: BigInt(query.maxPriceMinor) } : {}),
      } });
    }

    if (query.q) {
      const q = query.q;
      const normalizedEnum = q.trim().toUpperCase().replace(/[ -]+/g, '_');
      const cardSearch: Prisma.PokemonCardDetailsWhereInput[] = [
        { setName: { contains: q } },
        { setCode: { contains: q } },
        { cardNumber: { contains: q } },
        { rarity: { contains: q } },
        { language: { contains: q } },
        { finish: { contains: q } },
        { edition: { contains: q } },
        { gradingCompany: { contains: q } },
        { grade: { contains: q } },
        { certificationNumber: { contains: q } },
      ];
      if ((pokemonTypes as readonly string[]).includes(normalizedEnum)) cardSearch.push({ pokemonType: normalizedEnum as typeof pokemonTypes[number] });
      if ((productConditions as readonly string[]).includes(normalizedEnum)) cardSearch.push({ condition: normalizedEnum as typeof productConditions[number] });
      and.push({ OR: [
        { name: { contains: q } },
        { description: { contains: q } },
        { sku: { contains: q } },
        { pokemonCard: { is: { OR: cardSearch } } },
      ] });
    }

    const card: Prisma.PokemonCardDetailsWhereInput = {};
    if (query.pokemonType?.length) card.pokemonType = { in: query.pokemonType };
    if (query.setName?.length) card.setName = { in: query.setName };
    if (query.setCode) card.setCode = query.setCode;
    if (query.rarity?.length) card.rarity = { in: query.rarity };
    if (query.condition?.length) card.condition = { in: query.condition };
    if (query.language?.length) card.language = { in: query.language };
    if (query.finish?.length) card.finish = { in: query.finish };
    if (query.edition?.length) card.edition = { in: query.edition };
    if (query.gradingCompany?.length) card.gradingCompany = { in: query.gradingCompany };
    if (query.graded === true) {
      card.AND = [{ gradingCompany: { not: null } }, { grade: { not: null } }];
    } else if (query.graded === false) {
      card.AND = [{ OR: [{ gradingCompany: null }, { grade: null }] }];
    }
    if (Object.keys(card).length > 0) and.push({ pokemonCard: { is: card } });

    if (query.inStock === true) {
      and.push({ inventory: { is: { reserved: { lt: this.prisma.inventory.fields.onHand } } } });
    } else if (query.inStock === false) {
      and.push({ OR: [
        { inventory: { is: null } },
        { inventory: { is: { reserved: { gte: this.prisma.inventory.fields.onHand } } } },
      ] });
    }

    const products = await this.prisma.product.findMany({
      where: { AND: and },
      take: query.limit + 1,
      ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}),
      orderBy: productOrder(query.sort),
      include,
    });
    const hasMore = products.length > query.limit;
    const page = hasMore ? products.slice(0, query.limit) : products;
    return { products: page.map(mapProduct), nextCursor: hasMore ? page.at(-1)?.id ?? null : null };
  }

  public async findPublishedBySlug(slug: string) {
    const product = await this.prisma.product.findFirst({ where: { slug, status: ProductStatus.PUBLISHED }, include });
    return product ? mapProduct(product) : null;
  }

  public async getFilters() {
    const products = await this.prisma.product.findMany({
      where: { status: ProductStatus.PUBLISHED },
      select: {
        kind: true,
        priceMinor: true,
        pokemonCard: { select: {
          pokemonType: true,
          setName: true,
          rarity: true,
          condition: true,
          language: true,
          finish: true,
          edition: true,
          gradingCompany: true,
        } },
      },
    });
    const cardDetails = products.flatMap((product) => product.pokemonCard ? [product.pokemonCard] : []);
    const prices = products.map((product) => product.priceMinor);
    const minPrice = prices.reduce<bigint | null>((minimum, price) => minimum === null || price < minimum ? price : minimum, null);
    const maxPrice = prices.reduce<bigint | null>((maximum, price) => maximum === null || price > maximum ? price : maximum, null);

    return {
      totalProducts: products.length,
      kinds: countOptions(products.map((product) => product.kind)),
      pokemonTypes: countOptions(cardDetails.map((card) => card.pokemonType)),
      sets: countOptions(cardDetails.map((card) => card.setName)),
      rarities: countOptions(cardDetails.map((card) => card.rarity)),
      conditions: countOptions(cardDetails.map((card) => card.condition)),
      languages: countOptions(cardDetails.map((card) => card.language)),
      finishes: countOptions(cardDetails.map((card) => card.finish)),
      editions: countOptions(cardDetails.map((card) => card.edition)),
      gradingCompanies: countOptions(cardDetails.map((card) => card.gradingCompany)),
      priceRange: { minMinor: minPrice?.toString() ?? null, maxMinor: maxPrice?.toString() ?? null },
    };
  }
}

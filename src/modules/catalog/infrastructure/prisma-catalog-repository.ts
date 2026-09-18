import type { PrismaClient, Prisma } from '@prisma/client';
import { ProductStatus } from '@prisma/client';
import { pokemonTypes, productConditions, type CatalogFacetOption, type CatalogProduct } from '../domain/product.js';
import type { CatalogFiltersQuery, CatalogQuery, CatalogRepository } from '../application/list-products.js';
import { BASE_CURRENCY } from '../../../shared/currency.js';

const include = {
  pokemonCard: true,
  inventory: true,
  images: { where: { retiredAt: null }, orderBy: { sortOrder: 'asc' as const }, include: { file: true } },
  affiliate: { select: { id: true, publicName: true, status: true } },
  affiliateListing: { select: { status: true } },
} satisfies Prisma.ProductInclude;
type ProductRecord = Prisma.ProductGetPayload<{ include: typeof include }>;

type FacetProduct = {
  kind: string;
  priceMinor: bigint;
  available: number;
  pokemonCard: {
    pokemonType: string | null;
    setName: string;
    setCode: string | null;
    rarity: string;
    condition: string;
    language: string;
    finish: string | null;
    edition: string | null;
    gradingCompany: string | null;
    grade: string | null;
  } | null;
};

const mapProduct = (product: ProductRecord): CatalogProduct => ({
  id: product.id,
  sku: product.sku,
  slug: product.slug,
  name: product.name,
  description: product.description,
  kind: product.kind,
  stockMode: product.stockMode,
  price: { amountMinor: product.priceMinor.toString(), currency: BASE_CURRENCY },
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
  seller: product.affiliate && product.affiliate.status === 'ACTIVE'
    ? { type: 'AFFILIATE', id: product.affiliate.id, name: product.affiliate.publicName }
    : { type: 'STORE', id: null, name: 'Card Shop' },
});

function countOptions(values: Array<string | null | undefined>): CatalogFacetOption[] {
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

function publishedVisibilityWhere(): Prisma.ProductWhereInput[] {
  return [
    { status: ProductStatus.PUBLISHED },
    { OR: [{ affiliateId: null }, { affiliate: { is: { status: 'ACTIVE' } } }] },
    { OR: [{ affiliateId: null }, { affiliateListing: { is: { status: 'APPROVED' } } }] },
  ];
}

function buildCatalogWhere(
  query: CatalogFiltersQuery,
  inventoryOnHand: Prisma.InventoryFieldRefs['onHand'],
): Prisma.ProductWhereInput {
  const and: Prisma.ProductWhereInput[] = publishedVisibilityWhere();

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
    and.push({ inventory: { is: { reserved: { lt: inventoryOnHand } } } });
  } else if (query.inStock === false) {
    and.push({ OR: [
      { inventory: { is: null } },
      { inventory: { is: { reserved: { gte: inventoryOnHand } } } },
    ] });
  }

  return { AND: and };
}

function matchesText(haystack: string | null | undefined, needle: string) {
  return (haystack ?? '').toLowerCase().includes(needle.toLowerCase());
}

function productMatchesQuery(product: FacetProduct & {
  name?: string;
  description?: string;
  sku?: string;
  pokemonCard: FacetProduct['pokemonCard'] & {
    cardNumber?: string;
    grade?: string | null;
    certificationNumber?: string | null;
  } | null;
}, query: CatalogFiltersQuery, omit?: keyof CatalogFiltersQuery | 'price') {
  if (omit !== 'kind' && query.kind?.length && !query.kind.includes(product.kind as never)) return false;
  if (omit !== 'price') {
    if (query.minPriceMinor && product.priceMinor < BigInt(query.minPriceMinor)) return false;
    if (query.maxPriceMinor && product.priceMinor > BigInt(query.maxPriceMinor)) return false;
  }
  if (omit !== 'inStock') {
    if (query.inStock === true && product.available <= 0) return false;
    if (query.inStock === false && product.available > 0) return false;
  }

  const card = product.pokemonCard;
  if (omit !== 'pokemonType' && query.pokemonType?.length) {
    if (!card?.pokemonType || !query.pokemonType.includes(card.pokemonType as never)) return false;
  }
  if (omit !== 'setName' && query.setName?.length) {
    if (!card || !query.setName.includes(card.setName)) return false;
  }
  if (omit !== 'setCode' && query.setCode) {
    if (!card?.setCode || card.setCode !== query.setCode) return false;
  }
  if (omit !== 'rarity' && query.rarity?.length) {
    if (!card || !query.rarity.includes(card.rarity)) return false;
  }
  if (omit !== 'condition' && query.condition?.length) {
    if (!card || !query.condition.includes(card.condition as never)) return false;
  }
  if (omit !== 'language' && query.language?.length) {
    if (!card || !query.language.includes(card.language)) return false;
  }
  if (omit !== 'finish' && query.finish?.length) {
    if (!card?.finish || !query.finish.includes(card.finish)) return false;
  }
  if (omit !== 'edition' && query.edition?.length) {
    if (!card?.edition || !query.edition.includes(card.edition)) return false;
  }
  if (omit !== 'gradingCompany' && query.gradingCompany?.length) {
    if (!card?.gradingCompany || !query.gradingCompany.includes(card.gradingCompany)) return false;
  }
  if (omit !== 'graded' && query.graded !== undefined) {
    const isGraded = Boolean(card?.gradingCompany?.trim() && card?.grade?.trim());
    if (query.graded !== isGraded) return false;
  }

  if (omit !== 'q' && query.q) {
    const q = query.q;
    const normalizedEnum = q.trim().toUpperCase().replace(/[ -]+/g, '_');
    const inProduct = matchesText(product.name, q) || matchesText(product.description, q) || matchesText(product.sku, q);
    const inCard = Boolean(card && (
      matchesText(card.setName, q)
      || matchesText(card.setCode, q)
      || matchesText(card.cardNumber, q)
      || matchesText(card.rarity, q)
      || matchesText(card.language, q)
      || matchesText(card.finish, q)
      || matchesText(card.edition, q)
      || matchesText(card.gradingCompany, q)
      || matchesText(card.grade, q)
      || matchesText(card.certificationNumber, q)
      || card.pokemonType === normalizedEnum
      || card.condition === normalizedEnum
    ));
    if (!inProduct && !inCard) return false;
  }

  return true;
}

export class PrismaCatalogRepository implements CatalogRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async listPublished(query: CatalogQuery) {
    const where = buildCatalogWhere(query, this.prisma.inventory.fields.onHand);
    const products = await this.prisma.product.findMany({
      where,
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
    const product = await this.prisma.product.findFirst({
      where: { slug, AND: publishedVisibilityWhere() },
      include,
    });
    return product ? mapProduct(product) : null;
  }

  public async getFilters(query: CatalogFiltersQuery = {}) {
    const rows = await this.prisma.product.findMany({
      where: { AND: publishedVisibilityWhere() },
      select: {
        kind: true,
        name: true,
        description: true,
        sku: true,
        priceMinor: true,
        inventory: { select: { onHand: true, reserved: true } },
        pokemonCard: { select: {
          pokemonType: true,
          setName: true,
          setCode: true,
          cardNumber: true,
          rarity: true,
          condition: true,
          language: true,
          finish: true,
          edition: true,
          gradingCompany: true,
          grade: true,
          certificationNumber: true,
        } },
      },
    });

    const products = rows.map((product) => ({
      kind: product.kind,
      name: product.name,
      description: product.description,
      sku: product.sku,
      priceMinor: product.priceMinor,
      available: Math.max(0, (product.inventory?.onHand ?? 0) - (product.inventory?.reserved ?? 0)),
      pokemonCard: product.pokemonCard,
    }));

    const scoped = products.filter((product) => productMatchesQuery(product, query));
    const cardsOf = (list: typeof products) => list.flatMap((product) => product.pokemonCard ? [product.pokemonCard] : []);
    const scopeOmitting = (omit: Parameters<typeof productMatchesQuery>[2]) => products.filter((product) => productMatchesQuery(product, query, omit));

    const prices = scoped.map((product) => product.priceMinor);
    const minPrice = prices.reduce<bigint | null>((minimum, price) => minimum === null || price < minimum ? price : minimum, null);
    const maxPrice = prices.reduce<bigint | null>((maximum, price) => maximum === null || price > maximum ? price : maximum, null);

    let inStock = 0;
    let outOfStock = 0;
    for (const product of scoped) {
      if (product.available > 0) inStock += 1;
      else outOfStock += 1;
    }
    const scopedCards = cardsOf(scoped);
    const graded = scopedCards.filter((card) => Boolean(card.gradingCompany?.trim() && card.grade?.trim())).length;
    const ungraded = scoped.length - graded;

    return {
      totalProducts: scoped.length,
      kinds: countOptions(scopeOmitting('kind').map((product) => product.kind)),
      pokemonTypes: countOptions(cardsOf(scopeOmitting('pokemonType')).map((card) => card.pokemonType)),
      sets: countOptions(cardsOf(scopeOmitting('setName')).map((card) => card.setName)),
      setCodes: countOptions(cardsOf(scopeOmitting('setCode')).map((card) => card.setCode)),
      rarities: countOptions(cardsOf(scopeOmitting('rarity')).map((card) => card.rarity)),
      conditions: countOptions(cardsOf(scopeOmitting('condition')).map((card) => card.condition)),
      languages: countOptions(cardsOf(scopeOmitting('language')).map((card) => card.language)),
      finishes: countOptions(cardsOf(scopeOmitting('finish')).map((card) => card.finish)),
      editions: countOptions(cardsOf(scopeOmitting('edition')).map((card) => card.edition)),
      gradingCompanies: countOptions(cardsOf(scopeOmitting('gradingCompany')).map((card) => card.gradingCompany)),
      availability: { inStock, outOfStock, graded, ungraded },
      priceRange: { minMinor: minPrice?.toString() ?? null, maxMinor: maxPrice?.toString() ?? null },
    };
  }
}

import type {
  CatalogFilters,
  CatalogPokemonType,
  CatalogProduct,
  CatalogProductCondition,
  CatalogProductKind,
  CatalogSort,
} from '../domain/product.js';

export interface CatalogQuery {
  q?: string;
  kind?: CatalogProductKind[];
  pokemonType?: CatalogPokemonType[];
  setName?: string[];
  setCode?: string;
  rarity?: string[];
  condition?: CatalogProductCondition[];
  language?: string[];
  finish?: string[];
  edition?: string[];
  gradingCompany?: string[];
  graded?: boolean;
  inStock?: boolean;
  minPriceMinor?: string;
  maxPriceMinor?: string;
  sort: CatalogSort;
  cursor?: string;
  limit: number;
}

export interface CatalogRepository {
  listPublished(query: CatalogQuery): Promise<{ products: CatalogProduct[]; nextCursor: string | null }>;
  findPublishedBySlug(slug: string): Promise<CatalogProduct | null>;
  getFilters(): Promise<CatalogFilters>;
}

export class ListProducts {
  public constructor(private readonly repository: CatalogRepository) {}
  public execute(query: CatalogQuery) { return this.repository.listPublished(query); }
}

export class GetProduct {
  public constructor(private readonly repository: CatalogRepository) {}
  public execute(slug: string) { return this.repository.findPublishedBySlug(slug); }
}

export class GetCatalogFilters {
  public constructor(private readonly repository: CatalogRepository) {}
  public execute() { return this.repository.getFilters(); }
}

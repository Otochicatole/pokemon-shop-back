import type { CatalogProduct } from '../domain/product.js';

export interface CatalogQuery {
  q?: string;
  kind?: 'SINGLE_CARD' | 'SEALED_PRODUCT';
  setName?: string;
  rarity?: string;
  condition?: 'NM' | 'EXCELLENT' | 'GOOD' | 'PLAYED' | 'DAMAGED';
  language?: string;
  cursor?: string;
  limit: number;
}

export interface CatalogRepository {
  listPublished(query: CatalogQuery): Promise<{ products: CatalogProduct[]; nextCursor: string | null }>;
  findPublishedBySlug(slug: string): Promise<CatalogProduct | null>;
}

export class ListProducts {
  public constructor(private readonly repository: CatalogRepository) {}
  public execute(query: CatalogQuery) { return this.repository.listPublished(query); }
}

export class GetProduct {
  public constructor(private readonly repository: CatalogRepository) {}
  public execute(slug: string) { return this.repository.findPublishedBySlug(slug); }
}

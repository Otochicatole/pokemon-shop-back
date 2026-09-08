export const productKinds = ['SINGLE_CARD', 'SEALED_PRODUCT', 'ACCESSORY'] as const;
export type CatalogProductKind = (typeof productKinds)[number];

export const productConditions = ['NM', 'EXCELLENT', 'GOOD', 'PLAYED', 'DAMAGED'] as const;
export type CatalogProductCondition = (typeof productConditions)[number];

export const pokemonTypes = [
  'COLORLESS',
  'DARKNESS',
  'DRAGON',
  'FAIRY',
  'FIGHTING',
  'FIRE',
  'GRASS',
  'LIGHTNING',
  'METAL',
  'PSYCHIC',
  'WATER',
] as const;
export type CatalogPokemonType = (typeof pokemonTypes)[number];

export const catalogSorts = ['NEWEST', 'PRICE_ASC', 'PRICE_DESC', 'NAME_ASC'] as const;
export type CatalogSort = (typeof catalogSorts)[number];

export interface CatalogPokemonCard {
  setName: string;
  setCode: string | null;
  cardNumber: string;
  rarity: string;
  language: string;
  condition: CatalogProductCondition;
  /** Nullable only for cards created before the additive pokemon-type migration. */
  pokemonType: CatalogPokemonType | null;
  finish: string | null;
  edition: string | null;
  gradingCompany: string | null;
  grade: string | null;
  certificationNumber: string | null;
}

export interface CatalogProduct {
  id: string;
  sku: string;
  slug: string;
  name: string;
  description: string;
  kind: CatalogProductKind;
  stockMode: 'UNIQUE' | 'QUANTITY';
  price: { amountMinor: string; currency: 'ARS' };
  available: number;
  productVersion: number;
  pokemonCard: CatalogPokemonCard | null;
  images: Array<{ id: string; url: string; altText: string | null; sortOrder: number }>;
  updatedAt: Date;
}

export interface CatalogFacetOption {
  value: string;
  count: number;
}

export interface CatalogFilters {
  totalProducts: number;
  kinds: CatalogFacetOption[];
  pokemonTypes: CatalogFacetOption[];
  sets: CatalogFacetOption[];
  rarities: CatalogFacetOption[];
  conditions: CatalogFacetOption[];
  languages: CatalogFacetOption[];
  finishes: CatalogFacetOption[];
  editions: CatalogFacetOption[];
  gradingCompanies: CatalogFacetOption[];
  priceRange: { minMinor: string | null; maxMinor: string | null };
}

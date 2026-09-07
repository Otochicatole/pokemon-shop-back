export interface CatalogProduct {
  id: string;
  sku: string;
  slug: string;
  name: string;
  description: string;
  kind: 'SINGLE_CARD' | 'SEALED_PRODUCT';
  stockMode: 'UNIQUE' | 'QUANTITY';
  price: { amountMinor: string; currency: string };
  available: number;
  productVersion: number;
  pokemonCard: unknown;
  images: Array<{ id: string; url: string; altText: string | null; sortOrder: number }>;
  updatedAt: Date;
}

import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { catalogSorts, pokemonTypes, productConditions, productKinds } from '../domain/product.js';

extendZodWithOpenApi(z);

const repeatedText = (maxLength: number) => z.array(z.string().trim().min(1).max(maxLength)).min(1).max(20).optional();
const priceMinorSchema = z.string().regex(/^\d{1,18}$/, 'Must be an integer in minor units');

export const catalogListQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  kind: z.array(z.enum(productKinds)).min(1).max(productKinds.length).optional(),
  pokemonType: z.array(z.enum(pokemonTypes)).min(1).max(pokemonTypes.length).optional(),
  setName: repeatedText(100),
  setCode: z.string().trim().min(1).max(40).optional(),
  rarity: repeatedText(80),
  condition: z.array(z.enum(productConditions)).min(1).max(productConditions.length).optional(),
  language: repeatedText(40),
  finish: repeatedText(50),
  edition: repeatedText(80),
  gradingCompany: repeatedText(80),
  graded: z.enum(['true', 'false']).optional(),
  inStock: z.enum(['true', 'false']).optional(),
  minPriceMinor: priceMinorSchema.optional(),
  maxPriceMinor: priceMinorSchema.optional(),
  sort: z.enum(catalogSorts).default('NEWEST'),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24),
}).superRefine((query, context) => {
  const validMin = query.minPriceMinor !== undefined && /^\d{1,18}$/.test(query.minPriceMinor);
  const validMax = query.maxPriceMinor !== undefined && /^\d{1,18}$/.test(query.maxPriceMinor);
  if (validMin && BigInt(query.minPriceMinor!) > 9_223_372_036_854_775_807n) {
    context.addIssue({ code: 'custom', path: ['minPriceMinor'], message: 'Price exceeds the supported range' });
  }
  if (validMax && BigInt(query.maxPriceMinor!) > 9_223_372_036_854_775_807n) {
    context.addIssue({ code: 'custom', path: ['maxPriceMinor'], message: 'Price exceeds the supported range' });
  }
  if (validMin && validMax && BigInt(query.minPriceMinor!) > BigInt(query.maxPriceMinor!)) {
    context.addIssue({ code: 'custom', path: ['maxPriceMinor'], message: 'Maximum price must be greater than or equal to minimum price' });
  }
});

export const catalogMoneySchema = z.object({
  amountMinor: z.string().regex(/^\d+$/),
  currency: z.literal('ARS'),
});

export const catalogPokemonCardSchema = z.object({
  setName: z.string(),
  setCode: z.string().nullable(),
  cardNumber: z.string(),
  rarity: z.string(),
  language: z.string(),
  condition: z.enum(productConditions),
  pokemonType: z.enum(pokemonTypes).nullable(),
  finish: z.string().nullable(),
  edition: z.string().nullable(),
  gradingCompany: z.string().nullable(),
  grade: z.string().nullable(),
  certificationNumber: z.string().nullable(),
});

export const catalogProductSchema = z.object({
  id: z.string().uuid(),
  sku: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  kind: z.enum(productKinds),
  stockMode: z.enum(['UNIQUE', 'QUANTITY']),
  price: catalogMoneySchema,
  available: z.number().int().min(0),
  productVersion: z.number().int().positive(),
  pokemonCard: catalogPokemonCardSchema.nullable(),
  images: z.array(z.object({
    id: z.string().uuid(),
    url: z.string(),
    altText: z.string().nullable(),
    sortOrder: z.number().int(),
  })),
  updatedAt: z.string().datetime(),
});

export const catalogFacetOptionSchema = z.object({
  value: z.string(),
  count: z.number().int().nonnegative(),
});

export const catalogFiltersSchema = z.object({
  totalProducts: z.number().int().nonnegative(),
  kinds: z.array(catalogFacetOptionSchema),
  pokemonTypes: z.array(catalogFacetOptionSchema),
  sets: z.array(catalogFacetOptionSchema),
  rarities: z.array(catalogFacetOptionSchema),
  conditions: z.array(catalogFacetOptionSchema),
  languages: z.array(catalogFacetOptionSchema),
  finishes: z.array(catalogFacetOptionSchema),
  editions: z.array(catalogFacetOptionSchema),
  gradingCompanies: z.array(catalogFacetOptionSchema),
  priceRange: z.object({ minMinor: z.string().nullable(), maxMinor: z.string().nullable() }),
});

export type CatalogListQueryInput = z.infer<typeof catalogListQuerySchema>;

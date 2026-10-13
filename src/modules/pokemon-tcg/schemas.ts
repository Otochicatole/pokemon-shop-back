import { z } from 'zod';

export const pokemonTcgSearchQuerySchema = z.object({
  q: z.string().trim().min(2).max(80),
  page: z.preprocess(
    (value) => typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value,
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(1),
  ),
});

export const pokemonTcgPaginationSchema = z.object({
  page: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  limit: z.number().int().min(1).max(100),
  total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  totalPages: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export const pokemonTcgPriceHistoryItemSchema = z.object({
  sourceId: z.string().min(1),
  source: z.string().min(1),
  currency: z.string().regex(/^[A-Z]{3}$/),
  variant: z.string().min(1),
  amountMinor: z.string().regex(/^[1-9]\d*$/),
  recordedAt: z.iso.date(),
  observedAt: z.iso.datetime().nullable(),
});

export const pokemonTcgPriceHistorySchema = z.object({
  cardId: z.string().regex(/^[1-9]\d*$/),
  prices: z.array(pokemonTcgPriceHistoryItemSchema),
});

export const pokemonTcgPriceHistoryEnvelopeSchema = z.object({ data: pokemonTcgPriceHistorySchema });

import { z } from 'zod';
import { env } from '../../config/env.js';
import { AppError, badRequest, notFound } from '../../shared/errors.js';
import { pokemonTcgPaginationSchema, type pokemonTcgPriceHistorySchema } from './schemas.js';

const API_URL = 'https://api.pokemon-tcg.dev/v1';
const CACHE_TTL = 5 * 60_000;
const MAX_CACHE_ENTRIES = 300;

export type PokemonTcgMarketPrice = {
  amountMinor: string;
  currency: 'USD';
  source: string;
  variant: string;
  updatedAt: string;
};

export type PokemonTcgPrice = {
  source: string;
  currency: string;
  variant: string;
  amountMinor: string;
  lowAmountMinor: string | null;
  highAmountMinor: string | null;
  updatedAt: string;
};

export type PokemonTcgCardSummary = {
  id: string;
  name: string;
  localId: string;
  setCode: string;
  imageUrl: string | null;
  setName: string;
  rarity: string;
  category: string;
  types: string[];
  firstEdition: boolean;
  holo: boolean;
  language: string;
  region: 'int' | 'jp';
  special: string | null;
  marketPrice: PokemonTcgMarketPrice | null;
  prices: PokemonTcgPrice[];
};

export type PokemonTcgCardDetails = PokemonTcgCardSummary & {
  description: string;
  effect: string;
};

export type PokemonTcgSetOption = { id: string; name: string };
export type PokemonTcgPagination = z.infer<typeof pokemonTcgPaginationSchema>;
export type PokemonTcgCardSearchResult = { data: PokemonTcgCardSummary[]; meta: PokemonTcgPagination };
export type PokemonTcgPriceHistory = z.infer<typeof pokemonTcgPriceHistorySchema>;

const priceSchema = z.object({
  source_id: z.string(), source_name: z.string().trim().min(1), currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  variant: z.string().trim().min(1), price: z.number().finite().positive(), updated_at: z.string(),
  low_price: z.unknown().optional(), high_price: z.unknown().optional(),
});
const cardSchema = z.object({
  id: z.number().int().positive(), name: z.string().min(1), number: z.string(),
  set_code: z.string(), set_name: z.string(), region: z.enum(['int', 'jp']),
  card_type: z.enum(['pokemon', 'trainer', 'energy']),
  types: z.array(z.string()).default([]),
  rarity: z.string().nullish(),
  special: z.string().nullish(),
  images: z.object({ lg: z.string().nullish(), original: z.string().nullish() }).nullish(),
  prices: z.array(z.unknown()).optional(),
});
type ProviderCard = z.infer<typeof cardSchema>;
const cardListSchema = z.object({
  status: z.literal('success'),
  data: z.array(cardSchema).max(20),
  meta: pokemonTcgPaginationSchema.omit({ totalPages: true }).extend({
    total_pages: pokemonTcgPaginationSchema.shape.totalPages,
    limit: z.literal(20),
  }),
}).refine(({ data, meta }) =>
  (meta.total === 0 ? meta.total_pages <= 1 : meta.total_pages === Math.ceil(meta.total / meta.limit)) &&
  data.length <= meta.total &&
  (meta.page <= meta.total_pages || data.length === 0));
const cardDetailSchema = z.object({ status: z.literal('success'), data: cardSchema });
const priceHistoryItemSchema = z.object({
  source_id: z.string().trim().min(1), source_name: z.string().trim().nullish(),
  currency: priceSchema.shape.currency, variant: priceSchema.shape.variant, price: priceSchema.shape.price,
  recorded_at: z.iso.date(), observed_at: z.unknown().optional(),
});
const priceHistorySchema = z.object({
  status: z.literal('success'), card_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), data: z.array(z.unknown()),
});
const setsSchema = z.object({ status: z.literal('success'), data: z.array(z.object({ code: z.string().min(1), name: z.string().min(1) })) });

const cache = new Map<string, { expiresAt: number; value: unknown }>();
const pending = new Map<string, Promise<unknown>>();
let retryAt = 0;

function unavailable() {
  return new AppError(502, 'POKEMON_TCG_UNAVAILABLE', 'No se pudo consultar Pokémon TCG. Intentá nuevamente.');
}

async function request<T>(path: string, schema: z.ZodType<T>, ttl = CACHE_TTL): Promise<T> {
  if (!env.POKEMON_TCG_API_KEY) throw new AppError(503, 'POKEMON_TCG_NOT_CONFIGURED', 'Falta configurar la clave de Pokémon TCG en el servidor.');
  const cached = cache.get(path);
  if (cached && cached.expiresAt > Date.now()) return cached.value as T;
  cache.delete(path);
  if (retryAt > Date.now()) throw new AppError(503, 'POKEMON_TCG_RATE_LIMITED', 'Pokémon TCG pidió esperar antes de volver a consultar.', { retryAfter: Math.ceil((retryAt - Date.now()) / 1000) });
  const existing = pending.get(path);
  if (existing) return existing as Promise<T>;
  const operation = (async () => {
    try {
      const response = await fetch(`${API_URL}${path}`, {
        headers: { Authorization: `Bearer ${env.POKEMON_TCG_API_KEY}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000), redirect: 'error',
      });
      if (response.status === 404) throw notFound('Carta no encontrada en Pokémon TCG');
      if (response.status === 401 || response.status === 403) throw new AppError(502, 'POKEMON_TCG_AUTH_FAILED', 'La clave de Pokémon TCG no fue aceptada. Revisá la configuración del servidor.');
      if (response.status === 429) {
        const retry = response.headers.get('retry-after');
        const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : null;
        const date = retry ? Date.parse(retry) : NaN;
        retryAt = Date.now() + (seconds !== null ? Math.max(1, seconds) * 1000 : Number.isFinite(date) ? Math.max(1000, date - Date.now()) : 60_000);
        throw new AppError(503, 'POKEMON_TCG_RATE_LIMITED', 'Pokémon TCG pidió esperar antes de volver a consultar.', { retryAfter: Math.ceil((retryAt - Date.now()) / 1000) });
      }
      if (!response.ok) throw unavailable();
      const value = schema.parse(await response.json());
      if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
      cache.set(path, { value, expiresAt: Date.now() + ttl });
      return value;
    } catch (error) {
      if (error instanceof AppError) throw error;
      // Never propagate provider bodies, request headers, or errors that could expose the key.
      throw unavailable();
    }
  })();
  pending.set(path, operation);
  try { return await operation; } finally { pending.delete(path); }
}

function safeImage(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'img.pokemon-tcg.dev' && !url.port && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}

function summary(card: ProviderCard): PokemonTcgCardSummary {
  const prices = cardPrices(card.prices);
  return {
    id: String(card.id), name: card.name, localId: card.number, setCode: card.set_code,
    setName: card.set_name, imageUrl: safeImage(card.images?.lg) ?? safeImage(card.images?.original),
    category: { pokemon: 'Pokemon', trainer: 'Trainer', energy: 'Energy' }[card.card_type],
    rarity: card.rarity ?? '', types: card.types,
    // Edition and finish are not card metadata fields in this API.
    firstEdition: false, holo: false,
    language: card.region === 'jp' ? 'Japonés' : 'Inglés', region: card.region,
    special: card.special?.trim() || null,
    marketPrice: marketPrice(prices),
    prices: prices.map(({ sourceId: _sourceId, ...price }) => price),
  };
}

function cents(value: number): string | null {
  const raw = String(value);
  if (!/^\d+(?:\.\d+)?$/.test(raw) || value > Number.MAX_SAFE_INTEGER / 100) return null;
  const [whole, fraction = ''] = raw.split('.');
  const minor = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2)) + (Number(fraction[2] ?? '0') >= 5 ? 1n : 0n);
  return minor > 0n ? minor.toString() : null;
}

const currenciesWithCents = new Set(Intl.supportedValuesOf('currency').filter((currency) =>
  new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits === 2));
type ProviderPrice = PokemonTcgPrice & { sourceId: string };

function optionalCents(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? cents(value) : null;
}

function normalizedVariant(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = value.trim().replace(' ', 'T');
  const parsed = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(date) ? date : `${date}Z`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function cardPrices(values: unknown[] = []): ProviderPrice[] {
  return values.flatMap((value) => {
    const parsed = priceSchema.safeParse(value);
    if (!parsed.success) return [];
    const price = parsed.data;
    const variant = normalizedVariant(price.variant);
    // The published USD/EUR prices use cents. Do not mislabel an unknown currency
    // or silently apply that scale to currencies with a different minor unit.
    if (!currenciesWithCents.has(price.currency)) return [];
    const amountMinor = cents(price.price);
    const updatedAt = timestamp(price.updated_at);
    if (!amountMinor || !updatedAt) return [];
    return [{
      amountMinor, currency: price.currency, source: price.source_name, variant,
      lowAmountMinor: optionalCents(price.low_price), highAmountMinor: optionalCents(price.high_price),
      updatedAt, sourceId: price.source_id,
    }];
  });
}

function marketPrice(prices: ProviderPrice[]): PokemonTcgMarketPrice | null {
  const variants = ['normal', 'holofoil', 'reverse-holofoil'];
  const candidates = prices.filter((price) => price.currency === 'USD' && variants.includes(price.variant));
  candidates.sort((left, right) =>
    Number(right.sourceId === 'tcgplayer') - Number(left.sourceId === 'tcgplayer') ||
    variants.indexOf(left.variant) - variants.indexOf(right.variant) || right.updatedAt.localeCompare(left.updatedAt));
  const selected = candidates[0];
  if (!selected) return null;
  return { amountMinor: selected.amountMinor, currency: 'USD', source: selected.source, variant: selected.variant, updatedAt: selected.updatedAt };
}

export async function searchCards(input: string, page = 1): Promise<PokemonTcgCardSearchResult> {
  const query = input.trim();
  if (query.length < 2 || query.length > 80) throw badRequest('POKEMON_TCG_QUERY_INVALID', 'Ingresá entre 2 y 80 caracteres.');
  if (!Number.isSafeInteger(page) || page < 1) throw badRequest('POKEMON_TCG_PAGE_INVALID', 'La página debe ser un número entero mayor a cero.');
  const params = new URLSearchParams({ name: query, lang: 'en', page: String(page), limit: '20', include_prices: 'true' });
  const result = await request(`/cards?${params}`, cardListSchema.refine((value) => value.meta.page === page));
  return {
    data: [...new Map(result.data.map((card) => [card.id, summary(card)])).values()],
    meta: { page: result.meta.page, limit: result.meta.limit, total: result.meta.total, totalPages: result.meta.total_pages },
  };
}

export async function getCard(id: string): Promise<PokemonTcgCardDetails> {
  if (!/^[1-9]\d*$/.test(id)) throw badRequest('POKEMON_TCG_ID_INVALID', 'El identificador de carta no es válido.');
  const params = new URLSearchParams({ lang: 'en', include_prices: 'true' });
  const { data: card } = await request(`/cards/${encodeURIComponent(id)}?${params}`, cardDetailSchema);
  return { ...summary(card), description: '', effect: '' };
}

export async function getCardPriceHistory(id: string): Promise<PokemonTcgPriceHistory> {
  if (!/^[1-9]\d{0,19}$/.test(id)) throw badRequest('POKEMON_TCG_ID_INVALID', 'El identificador de carta no es válido.');
  const result = await request(`/cards/${encodeURIComponent(id)}/prices/history`, priceHistorySchema.refine((value) => String(value.card_id) === id));
  const prices: PokemonTcgPriceHistory['prices'] = result.data.flatMap((value) => {
    const parsed = priceHistoryItemSchema.safeParse(value);
    if (!parsed.success || !currenciesWithCents.has(parsed.data.currency)) return [];
    const item = parsed.data;
    const amountMinor = cents(item.price);
    if (!amountMinor) return [];
    return [{
      sourceId: item.source_id, source: item.source_name || item.source_id, currency: item.currency,
      variant: normalizedVariant(item.variant), amountMinor, recordedAt: item.recorded_at,
      observedAt: timestamp(item.observed_at),
    }];
  });
  prices.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt) ||
    (left.observedAt ?? '').localeCompare(right.observedAt ?? '') ||
    left.sourceId.localeCompare(right.sourceId) || left.currency.localeCompare(right.currency) || left.variant.localeCompare(right.variant));
  return { cardId: id, prices };
}

export async function listSets(): Promise<PokemonTcgSetOption[]> {
  const result = await request('/sets', setsSchema, 24 * 60 * 60_000);
  return [...new Map(result.data.map((set) => [set.code, { id: set.code, name: set.name }])).values()]
    .sort((left, right) => left.name.localeCompare(right.name, 'en', { sensitivity: 'base' }));
}

export async function listRarities(): Promise<string[]> {
  // There is no rarity-list endpoint. Forms also include the selected card's exact rarity label.
  return ['Common', 'Uncommon', 'Rare', 'Rare Holo', 'Double Rare', 'Ultra Rare', 'Illustration Rare', 'Special Illustration Rare', 'Hyper Rare', 'Secret Rare', 'Promo', 'ACE SPEC Rare', 'Shiny Rare', 'Shiny Ultra Rare'];
}

import type { Prisma, PrismaClient, ExchangeRateSnapshot } from '@prisma/client';
import { z } from 'zod';
import { env } from '../../config/env.js';

export const DOLAR_CASAS = [
  'oficial',
  'blue',
  'bolsa',
  'contadoconliqui',
  'mayorista',
  'cripto',
  'tarjeta',
] as const;

export type DolarCasa = (typeof DOLAR_CASAS)[number];

type ExchangeRateSettingsDb = PrismaClient | Prisma.TransactionClient;

const SCALE = 1_000_000n;
const EXCHANGE_RATE_SETTINGS_ID = 'default';

const dolarApiSchema = z.object({
  venta: z.union([z.string(), z.number()]),
  fechaActualizacion: z.string().optional(),
  casa: z.string().optional(),
  moneda: z.string().optional(),
  nombre: z.string().optional(),
});

export type ExchangeRateQuote = {
  id: string;
  casa: DolarCasa;
  source: string;
  rateMicros: bigint;
  rate: string;
  fetchedAt: Date;
  expiresAt: Date;
};

export function isDolarCasa(value: string): value is DolarCasa {
  return (DOLAR_CASAS as readonly string[]).includes(value);
}

export function dolarApiSource(casa: DolarCasa) {
  return `DOLARAPI_${casa.toUpperCase()}_VENTA`;
}

export function dolarApiUrl(casa: DolarCasa) {
  const base = env.DOLARAPI_BASE_URL.replace(/\/+$/, '');
  return `${base}/${casa}`;
}

export function dolarApiListUrl() {
  return env.DOLARAPI_BASE_URL.replace(/\/+$/, '');
}

const dolarApiListSchema = z.array(dolarApiSchema.extend({
  casa: z.string(),
}));

/** Live venta quotes for the admin casa picker (not persisted as snapshots). */
export async function listDolarApiVentaRates(): Promise<Partial<Record<DolarCasa, string>>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.DOLARAPI_TIMEOUT_MS);
  try {
    const response = await fetch(dolarApiListUrl(), { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`DolarAPI responded with HTTP ${response.status}`);
    const rows = dolarApiListSchema.parse(await response.json());
    const rates: Partial<Record<DolarCasa, string>> = {};
    for (const row of rows) {
      if (!isDolarCasa(row.casa)) continue;
      try {
        rates[row.casa] = formatRate(parseRateMicros(row.venta));
      } catch {
        // skip invalid row
      }
    }
    return rates;
  } finally {
    clearTimeout(timer);
  }
}

export function parseRateMicros(value: unknown): bigint {
  const raw = typeof value === 'number' ? value.toString() : String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(raw)) throw new Error('DolarAPI returned an invalid venta rate');
  const [whole = '0', fraction = ''] = raw.split('.');
  const micros = BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0'));
  if (micros <= 0n) throw new Error('DolarAPI returned a non-positive venta rate');
  return micros;
}

export function usdMinorToArsMinor(usdMinor: bigint, rateMicros: bigint): bigint {
  if (usdMinor < 0n || rateMicros <= 0n) throw new Error('Money amounts cannot be negative');
  const numerator = usdMinor * rateMicros;
  return (numerator + SCALE / 2n) / SCALE;
}

export function formatRate(rateMicros: bigint): string {
  const whole = rateMicros / SCALE;
  const fraction = (rateMicros % SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export async function ensureExchangeRateSettings(prisma: ExchangeRateSettingsDb) {
  const existing = await prisma.exchangeRateSettings.findUnique({ where: { id: EXCHANGE_RATE_SETTINGS_ID } });
  if (existing) return existing;
  return prisma.exchangeRateSettings.create({
    data: { id: EXCHANGE_RATE_SETTINGS_ID, casa: 'blue', version: 1 },
  });
}

export async function getConfiguredDolarCasa(prisma: ExchangeRateSettingsDb): Promise<DolarCasa> {
  const settings = await ensureExchangeRateSettings(prisma);
  return isDolarCasa(settings.casa) ? settings.casa : 'blue';
}

function mapSnapshot(snapshot: ExchangeRateSnapshot, casa: DolarCasa): ExchangeRateQuote {
  return {
    id: snapshot.id,
    casa,
    source: snapshot.source,
    rateMicros: snapshot.sellRateMicros,
    rate: formatRate(snapshot.sellRateMicros),
    fetchedAt: snapshot.fetchedAt,
    expiresAt: snapshot.expiresAt,
  };
}

export async function getConfiguredUsdArsRate(prisma: PrismaClient, now = new Date()): Promise<ExchangeRateQuote> {
  const casa = await getConfiguredDolarCasa(prisma);
  const source = dolarApiSource(casa);
  const cached = await prisma.exchangeRateSnapshot.findFirst({
    where: { source, baseCurrency: 'USD', quoteCurrency: 'ARS', expiresAt: { gt: now } },
    orderBy: { fetchedAt: 'desc' },
  });
  if (cached) return mapSnapshot(cached, casa);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.DOLARAPI_TIMEOUT_MS);
  try {
    const response = await fetch(dolarApiUrl(casa), { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`DolarAPI responded with HTTP ${response.status}`);
    const data = dolarApiSchema.parse(await response.json());
    const rateMicros = parseRateMicros(data.venta);
    const providerUpdatedAt = data.fechaActualizacion ? new Date(data.fechaActualizacion) : null;
    const validProviderDate = providerUpdatedAt && !Number.isNaN(providerUpdatedAt.getTime()) ? providerUpdatedAt : null;
    const fetchedAt = now;
    const expiresAt = new Date(now.getTime() + env.DOLARAPI_CACHE_TTL_SECONDS * 1000);
    const snapshot = await prisma.exchangeRateSnapshot.create({
      data: {
        source,
        baseCurrency: 'USD',
        quoteCurrency: 'ARS',
        sellRateMicros: rateMicros,
        providerUpdatedAt: validProviderDate,
        fetchedAt,
        expiresAt,
      },
    });
    return mapSnapshot(snapshot, casa);
  } finally {
    clearTimeout(timer);
  }
}

/** @deprecated Use getConfiguredUsdArsRate */
export const getDolarBlueVenta = getConfiguredUsdArsRate;
/** @deprecated Source is now dynamic per configured casa */
export const DOLARAPI_SOURCE = 'DOLARAPI_BLUE_VENTA';

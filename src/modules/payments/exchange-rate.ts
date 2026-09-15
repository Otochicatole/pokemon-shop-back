import type { PrismaClient, ExchangeRateSnapshot } from '@prisma/client';
import { z } from 'zod';
import { env } from '../../config/env.js';

export const DOLARAPI_SOURCE = 'DOLARAPI_BLUE_VENTA';
const SCALE = 1_000_000n;
const dolarApiSchema = z.object({
  venta: z.union([z.string(), z.number()]),
  fechaActualizacion: z.string().optional(),
  casa: z.string().optional(),
  moneda: z.string().optional(),
});

export type ExchangeRateQuote = {
  id: string;
  source: typeof DOLARAPI_SOURCE;
  rateMicros: bigint;
  rate: string;
  fetchedAt: Date;
  expiresAt: Date;
};

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

function mapSnapshot(snapshot: ExchangeRateSnapshot): ExchangeRateQuote {
  return {
    id: snapshot.id,
    source: DOLARAPI_SOURCE,
    rateMicros: snapshot.sellRateMicros,
    rate: formatRate(snapshot.sellRateMicros),
    fetchedAt: snapshot.fetchedAt,
    expiresAt: snapshot.expiresAt,
  };
}

export async function getDolarBlueVenta(prisma: PrismaClient, now = new Date()): Promise<ExchangeRateQuote> {
  const cached = await prisma.exchangeRateSnapshot.findFirst({
    where: { source: DOLARAPI_SOURCE, baseCurrency: 'USD', quoteCurrency: 'ARS', expiresAt: { gt: now } },
    orderBy: { fetchedAt: 'desc' },
  });
  if (cached) return mapSnapshot(cached);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.DOLARAPI_TIMEOUT_MS);
  try {
    const response = await fetch(env.DOLARAPI_URL, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`DolarAPI responded with HTTP ${response.status}`);
    const data = dolarApiSchema.parse(await response.json());
    const rateMicros = parseRateMicros(data.venta);
    const providerUpdatedAt = data.fechaActualizacion ? new Date(data.fechaActualizacion) : null;
    const validProviderDate = providerUpdatedAt && !Number.isNaN(providerUpdatedAt.getTime()) ? providerUpdatedAt : null;
    const fetchedAt = now;
    const expiresAt = new Date(now.getTime() + env.DOLARAPI_CACHE_TTL_SECONDS * 1000);
    const snapshot = await prisma.exchangeRateSnapshot.create({ data: {
      source: DOLARAPI_SOURCE,
      baseCurrency: 'USD',
      quoteCurrency: 'ARS',
      sellRateMicros: rateMicros,
      providerUpdatedAt: validProviderDate,
      fetchedAt,
      expiresAt,
    } });
    return mapSnapshot(snapshot);
  } finally {
    clearTimeout(timer);
  }
}

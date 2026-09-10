export const BASE_CURRENCY = 'USD' as const;
export type BaseCurrency = typeof BASE_CURRENCY;

export const LEGACY_ARS_MINOR_PER_USD = 1520n;

/** Converts legacy ARS minor units to USD minor units using half-up rounding. */
export function legacyArsMinorToUsdMinor(amountMinor: bigint): bigint {
  if (amountMinor < 0n) throw new Error('Money amounts cannot be negative');
  if (amountMinor === 0n) return 0n;
  return ((amountMinor * 1n) + LEGACY_ARS_MINOR_PER_USD / 2n) / LEGACY_ARS_MINOR_PER_USD || 1n;
}

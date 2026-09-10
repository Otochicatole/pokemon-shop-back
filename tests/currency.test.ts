import { describe, expect, it } from 'vitest';
import { legacyArsMinorToUsdMinor } from '../src/shared/currency.js';

describe('legacy ARS to USD conversion', () => {
  it('rounds half-up at the fixed 1,520 ARS/USD rate', () => {
    expect(legacyArsMinorToUsdMinor(0n)).toBe(0n);
    expect(legacyArsMinorToUsdMinor(760n)).toBe(1n);
    expect(legacyArsMinorToUsdMinor(1520n)).toBe(1n);
    expect(legacyArsMinorToUsdMinor(2280n)).toBe(2n);
  });

  it('preserves a positive amount as at least one USD cent', () => {
    expect(legacyArsMinorToUsdMinor(1n)).toBe(1n);
  });
});

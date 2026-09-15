import { describe, expect, it } from 'vitest';
import { formatRate, parseRateMicros, usdMinorToArsMinor } from '../src/modules/payments/exchange-rate.js';
import { buildMercadoPagoCheckoutOrder, providerAmountDecimal, providerAmountToMinor } from '../src/modules/payments/mercado-pago.js';

describe('Mercado Pago FX and amount contracts', () => {
  it('parses and formats a DolarAPI venta rate at micro precision', () => {
    const micros = parseRateMicros('1234.567890');
    expect(micros).toBe(1_234_567_890n);
    expect(formatRate(micros)).toBe('1234.56789');
    expect(() => parseRateMicros('0')).toThrow();
    expect(() => parseRateMicros('1.2345678')).toThrow();
  });

  it('converts USD cents to ARS cents with one half-up rounding step', () => {
    const rate = parseRateMicros('100.005');
    expect(usdMinorToArsMinor(100n, rate)).toBe(10_001n);
    expect(usdMinorToArsMinor(1n, parseRateMicros('1.234'))).toBe(1n);
    expect(() => usdMinorToArsMinor(-1n, rate)).toThrow();
  });

  it('accepts exact provider amounts and rejects malformed values', () => {
    expect(providerAmountToMinor('1234.5')).toBe(123_450n);
    expect(providerAmountToMinor('1234.56')).toBe(123_456n);
    expect(providerAmountDecimal(123_456n)).toBe('1234.56');
    expect(providerAmountToMinor('1234.567')).toBe(-1n);
    expect(providerAmountToMinor('-1.00')).toBe(-1n);
  });

  it('builds a Checkout Pro order that accepts account and guest buyers', () => {
    const body = buildMercadoPagoCheckoutOrder({
      number: 'BCS-TEST-1',
      amountMinor: 123_456n,
      publicApiUrl: 'https://api.example.com/',
      publicWebUrl: 'https://shop.example.com/',
      payer: { email: 'buyer@example.com' },
    });

    expect(body.total_amount).toBe('1234.56');
    expect(body.items).toEqual([{ external_code: 'BCS-TEST-1', title: 'Compra BCS-TEST-1', quantity: 1, unit_price: '1234.56' }]);
    expect(body.config.online.callback_url).toBe('https://api.example.com/api/v2/webhooks/mercado-pago');
    expect(body.config.online).not.toHaveProperty('allowed_user_type');
    expect(body.config.online.auto_return).toBe('all');
    expect(body.config.payment_method.not_allowed_types).toEqual(['ticket', 'atm', 'bank_transfer', 'digital_currency']);
  });
});

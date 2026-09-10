import { badRequest } from './errors.js';
import { BASE_CURRENCY, type BaseCurrency } from './currency.js';

export type Money = { amountMinor: bigint; currency: BaseCurrency };
export type MoneyDto = { amountMinor: string; currency: BaseCurrency };

export const usd = (amountMinor: bigint): Money => ({ amountMinor, currency: BASE_CURRENCY });
export const moneyDto = (money: Money): MoneyDto => ({ amountMinor: money.amountMinor.toString(), currency: money.currency });
export const parseMinor = (value: string): bigint => {
  if (!/^\d+$/.test(value)) throw badRequest('INVALID_MONEY', 'amountMinor must be a non-negative integer string');
  return BigInt(value);
};

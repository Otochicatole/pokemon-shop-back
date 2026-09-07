import { badRequest } from './errors.js';

export type Money = { amountMinor: bigint; currency: 'ARS' };
export type MoneyDto = { amountMinor: string; currency: 'ARS' };

export const ars = (amountMinor: bigint): Money => ({ amountMinor, currency: 'ARS' });
export const moneyDto = (money: Money): MoneyDto => ({ amountMinor: money.amountMinor.toString(), currency: money.currency });
export const parseMinor = (value: string): bigint => {
  if (!/^\d+$/.test(value)) throw badRequest('INVALID_MONEY', 'amountMinor must be a non-negative integer string');
  return BigInt(value);
};

import { badRequest } from './errors.js';
import { BASE_CURRENCY, type Currency, type BaseCurrency, type ProviderCurrency } from './currency.js';

export type Money = { amountMinor: bigint; currency: Currency };
export type MoneyDto = { amountMinor: string; currency: BaseCurrency };
export type ProviderMoneyDto = { amountMinor: string; currency: ProviderCurrency };

export const usd = (amountMinor: bigint): Money => ({ amountMinor, currency: BASE_CURRENCY });
export function moneyDto(money: { amountMinor: bigint; currency: BaseCurrency }): MoneyDto;
export function moneyDto(money: { amountMinor: bigint; currency: ProviderCurrency }): ProviderMoneyDto;
export function moneyDto(money: Money): MoneyDto | ProviderMoneyDto {
  return { amountMinor: money.amountMinor.toString(), currency: money.currency } as MoneyDto | ProviderMoneyDto;
}
export const parseMinor = (value: string): bigint => {
  if (!/^\d+$/.test(value)) throw badRequest('INVALID_MONEY', 'amountMinor must be a non-negative integer string');
  return BigInt(value);
};

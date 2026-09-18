export interface PaymentsModule {
  createTransfer(input: unknown): Promise<unknown>;
  createMercadoPagoCheckout(input: unknown): Promise<unknown>;
  processWebhook(input: unknown): Promise<void>;
}

export { getTransferSettings, mapTransferInstructions, mapTransferSettings, transferSettingsConfigured, TRANSFER_SETTINGS_ID } from './transfer-settings.js';
export type { TransferSettingsRecord } from './transfer-settings.js';
export { buildMercadoPagoCheckoutOrder, createMercadoPagoGateway, providerAmountDecimal, providerAmountToMinor } from './mercado-pago.js';
export type { MercadoPagoCheckoutOrderInput, MercadoPagoGateway, MercadoPagoOrderBody } from './mercado-pago.js';
export { ensureExchangeRateSettings, DOLAR_CASAS, dolarApiSource, formatRate, getConfiguredDolarCasa, getConfiguredUsdArsRate, getDolarBlueVenta, isDolarCasa, listDolarApiVentaRates, parseRateMicros, usdMinorToArsMinor } from './exchange-rate.js';
export type { DolarCasa, ExchangeRateQuote } from './exchange-rate.js';

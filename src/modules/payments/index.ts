export interface PaymentsModule {
  createTransfer(input: unknown): Promise<unknown>;
  createMercadoPagoCheckout(input: unknown): Promise<unknown>;
  processWebhook(input: unknown): Promise<void>;
}

export { getTransferSettings, mapTransferInstructions, mapTransferSettings, transferSettingsConfigured, TRANSFER_SETTINGS_ID } from './transfer-settings.js';
export type { TransferSettingsRecord } from './transfer-settings.js';

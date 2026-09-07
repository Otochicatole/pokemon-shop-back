export interface PaymentsModule {
  createTransfer(input: unknown): Promise<unknown>;
  createMercadoPagoCheckout(input: unknown): Promise<unknown>;
  processWebhook(input: unknown): Promise<void>;
}

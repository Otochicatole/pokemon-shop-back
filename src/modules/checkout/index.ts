export interface CheckoutModule {
  preview(input: unknown): Promise<unknown>;
  createOrder(input: unknown): Promise<unknown>;
}

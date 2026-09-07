export interface FulfillmentModule {
  options(): Promise<unknown>;
  validate(input: unknown): Promise<void>;
}

export interface BackofficeModule {
  audit(input: unknown): Promise<void>;
}

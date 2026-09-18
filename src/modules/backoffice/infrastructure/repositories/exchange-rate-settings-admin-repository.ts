import type { ExchangeRateSettingsAdminRepository } from '../../application/ports.js';
import type { AdminActor, ExchangeRateSettingsWrite } from '../../domain/admin-cms.js';

export class ExchangeRateSettingsAdminRepositoryAdapter implements ExchangeRateSettingsAdminRepository {
  public constructor(private readonly source: ExchangeRateSettingsAdminRepository) {}
  getExchangeRateSettings() { return this.source.getExchangeRateSettings(); }
  updateExchangeRateSettings(actor: AdminActor, input: ExchangeRateSettingsWrite) { return this.source.updateExchangeRateSettings(actor, input); }
}

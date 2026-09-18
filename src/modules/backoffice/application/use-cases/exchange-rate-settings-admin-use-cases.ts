import type { ExchangeRateSettingsAdminRepository } from '../ports.js';
import type { AdminActor, ExchangeRateSettingsWrite } from '../../domain/admin-cms.js';

export class ExchangeRateSettingsAdminUseCases {
  public constructor(private readonly exchangeRateSettings: ExchangeRateSettingsAdminRepository) {}
  get() { return this.exchangeRateSettings.getExchangeRateSettings(); }
  update(actor: AdminActor, input: ExchangeRateSettingsWrite) { return this.exchangeRateSettings.updateExchangeRateSettings(actor, input); }
}

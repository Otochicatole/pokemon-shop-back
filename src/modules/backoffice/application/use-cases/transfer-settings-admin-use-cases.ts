import type { TransferSettingsAdminRepository } from '../ports.js';
import type { AdminActor, TransferSettingsWrite } from '../../domain/admin-cms.js';

export class TransferSettingsAdminUseCases {
  public constructor(private readonly transferSettings: TransferSettingsAdminRepository) {}
  get() { return this.transferSettings.getTransferSettings(); }
  update(actor: AdminActor, input: TransferSettingsWrite) { return this.transferSettings.updateTransferSettings(actor, input); }
}

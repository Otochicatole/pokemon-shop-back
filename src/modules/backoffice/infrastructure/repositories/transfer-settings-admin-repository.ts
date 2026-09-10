import type { TransferSettingsAdminRepository } from '../../application/ports.js';
import type { AdminActor, TransferSettingsWrite } from '../../domain/admin-cms.js';

export class TransferSettingsAdminRepositoryAdapter implements TransferSettingsAdminRepository {
  public constructor(private readonly source: TransferSettingsAdminRepository) {}
  getTransferSettings() { return this.source.getTransferSettings(); }
  updateTransferSettings(actor: AdminActor, input: TransferSettingsWrite) { return this.source.updateTransferSettings(actor, input); }
}

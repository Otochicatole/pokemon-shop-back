import type { LoyaltyAdminRepository } from '../../application/ports.js';
import type { AdminActor, LoyaltyProgramWrite } from '../../domain/admin-cms.js';

export class LoyaltyAdminRepositoryAdapter implements LoyaltyAdminRepository {
  public constructor(private readonly source: LoyaltyAdminRepository) {}
  getLoyaltyProgram() { return this.source.getLoyaltyProgram(); }
  updateLoyaltyProgram(actor: AdminActor, input: LoyaltyProgramWrite) { return this.source.updateLoyaltyProgram(actor, input); }
}

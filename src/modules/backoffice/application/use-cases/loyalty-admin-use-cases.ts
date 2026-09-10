import type { LoyaltyAdminRepository } from '../ports.js';
import type { AdminActor, LoyaltyProgramWrite } from '../../domain/admin-cms.js';

export class LoyaltyAdminUseCases {
  public constructor(private readonly loyalty: LoyaltyAdminRepository) {}
  get() { return this.loyalty.getLoyaltyProgram(); }
  update(actor: AdminActor, input: LoyaltyProgramWrite) { return this.loyalty.updateLoyaltyProgram(actor, input); }
}

import type { FulfillmentAdminRepository, PickupPointWrite, ShippingZoneWrite } from '../../application/ports.js';
import type { AdminActor } from '../../domain/admin-cms.js';

export class FulfillmentAdminRepositoryAdapter implements FulfillmentAdminRepository {
  public constructor(private readonly source: FulfillmentAdminRepository) {}
  getFulfillment() { return this.source.getFulfillment(); }
  createShippingZone(actor: AdminActor, input: ShippingZoneWrite) { return this.source.createShippingZone(actor, input); }
  updateShippingZone(actor: AdminActor, id: string, input: ShippingZoneWrite) { return this.source.updateShippingZone(actor, id, input); }
  setShippingZoneActive(actor: AdminActor, id: string, active: boolean) { return this.source.setShippingZoneActive(actor, id, active); }
  createPickupPoint(actor: AdminActor, input: PickupPointWrite) { return this.source.createPickupPoint(actor, input); }
  updatePickupPoint(actor: AdminActor, id: string, input: PickupPointWrite) { return this.source.updatePickupPoint(actor, id, input); }
  setPickupPointActive(actor: AdminActor, id: string, active: boolean) { return this.source.setPickupPointActive(actor, id, active); }
}

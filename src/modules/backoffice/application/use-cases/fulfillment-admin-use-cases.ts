import type { FulfillmentAdminRepository, PickupPointWrite, ShippingZoneWrite } from '../ports.js';
import type { AdminActor } from '../../domain/admin-cms.js';

export class FulfillmentAdminUseCases {
  public constructor(private readonly fulfillment: FulfillmentAdminRepository) {}

  get() { return this.fulfillment.getFulfillment(); }
  createShippingZone(actor: AdminActor, input: ShippingZoneWrite) { return this.fulfillment.createShippingZone(actor, input); }
  updateShippingZone(actor: AdminActor, id: string, input: ShippingZoneWrite) { return this.fulfillment.updateShippingZone(actor, id, input); }
  setShippingZoneActive(actor: AdminActor, id: string, active: boolean) { return this.fulfillment.setShippingZoneActive(actor, id, active); }
  createPickupPoint(actor: AdminActor, input: PickupPointWrite) { return this.fulfillment.createPickupPoint(actor, input); }
  updatePickupPoint(actor: AdminActor, id: string, input: PickupPointWrite) { return this.fulfillment.updatePickupPoint(actor, id, input); }
  setPickupPointActive(actor: AdminActor, id: string, active: boolean) { return this.fulfillment.setPickupPointActive(actor, id, active); }
}

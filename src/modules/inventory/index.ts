export interface InventoryModule {
  reserve(input: { productId: string; quantity: number; version: number; expiresAt: Date }): Promise<void>;
  release(orderId: string): Promise<void>;
}

export { ExpireReservations } from './application/expire-reservations.js';

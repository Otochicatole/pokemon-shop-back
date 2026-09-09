import type { PaymentAdminRepository } from '../../application/ports.js';
import type { AdminActor, OrderListQuery } from '../../domain/admin-cms.js';

export class PaymentAdminRepositoryAdapter implements PaymentAdminRepository {
  public constructor(private readonly source: PaymentAdminRepository) {}
  listPayments(query: OrderListQuery, queue?: 'TRANSFER_REVIEW' | 'MERCADO_PAGO_REVIEW') { return this.source.listPayments(query, queue); }
  reviewTransfer(actor: AdminActor, number: string, receiptId: string, expectedVersion: number, decision: 'APPROVED' | 'REJECTED', note?: string) {
    return this.source.reviewTransfer(actor, number, receiptId, expectedVersion, decision, note);
  }
  fulfillLatePayment(actor: AdminActor, number: string, expectedVersion: number) { return this.source.fulfillLatePayment(actor, number, expectedVersion); }
  recordFullRefund(actor: AdminActor, number: string, expectedVersion: number, reason: string, externalReference: string) {
    return this.source.recordFullRefund(actor, number, expectedVersion, reason, externalReference);
  }
}

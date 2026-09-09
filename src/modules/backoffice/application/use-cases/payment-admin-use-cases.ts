import type { PaymentAdminRepository } from '../ports.js';
import type { AdminActor, OrderListQuery } from '../../domain/admin-cms.js';

export class PaymentAdminUseCases {
  public constructor(private readonly payments: PaymentAdminRepository) {}

  list(query: OrderListQuery, queue?: 'TRANSFER_REVIEW' | 'MERCADO_PAGO_REVIEW') {
    return this.payments.listPayments(query, queue);
  }
  reviewTransfer(actor: AdminActor, number: string, receiptId: string, expectedVersion: number, decision: 'APPROVED' | 'REJECTED', note?: string) {
    return this.payments.reviewTransfer(actor, number, receiptId, expectedVersion, decision, note);
  }
  fulfillLatePayment(actor: AdminActor, number: string, expectedVersion: number) {
    return this.payments.fulfillLatePayment(actor, number, expectedVersion);
  }
  recordFullRefund(actor: AdminActor, number: string, expectedVersion: number, reason: string, externalReference: string) {
    return this.payments.recordFullRefund(actor, number, expectedVersion, reason, externalReference);
  }
}

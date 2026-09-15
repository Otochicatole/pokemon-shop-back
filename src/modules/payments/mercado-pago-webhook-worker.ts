import type { PrismaClient } from '@prisma/client';
import type { MercadoPagoGateway } from './mercado-pago.js';
import { logger } from '../../infrastructure/logger.js';
import { reconcileMercadoOrder, reconcileMercadoPayment } from '../orders/orders.js';
import type { SupportRealtimeHub } from '../support/support-realtime.js';

type WebhookPayload = { id?: string | number; type?: string; action?: string; data?: { id?: string | number } };

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/bearer\s+[a-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/(token|secret|password|authorization)[=:]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, 1000);
}

export class MercadoPagoWebhookWorker {
  private running = false;

  public constructor(private readonly dependencies: { prisma: PrismaClient; gateway: MercadoPagoGateway; realtime?: SupportRealtimeHub }) {}

  public async runOnce(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const events = await this.dependencies.prisma.webhookEvent.findMany({
        where: { provider: 'mercadopago', processedAt: null, failedAt: null, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
        orderBy: { receivedAt: 'asc' },
        take: 20,
      });
      for (const event of events) {
        const claimed = await this.dependencies.prisma.webhookEvent.updateMany({ where: { id: event.id, processedAt: null, failedAt: null, OR: [{ lockedAt: null }, { lockedAt: { lt: new Date(now.getTime() - 60_000) } }] }, data: { lockedAt: now, attemptCount: { increment: 1 } } });
        if (claimed.count !== 1) continue;
        const attempt = event.attemptCount + 1;
        try {
          const payload = JSON.parse(event.payload) as WebhookPayload;
          const resourceId = event.resourceId ?? String(payload.data?.id ?? event.externalKey ?? '');
          if (!resourceId) throw new Error('Webhook event has no resource id');
          // Rows written by the legacy IPN route predate `resourceId`/`type`; those
          // external keys are payment IDs and remain recoverable during migration.
          const eventType = payload.type ?? 'payment';
          if (eventType === 'order') await reconcileMercadoOrder(resourceId, this.dependencies.realtime, this.dependencies.gateway);
          else if (eventType === 'payment') await reconcileMercadoPayment(resourceId, this.dependencies.realtime, this.dependencies.gateway);
          else throw new Error(`Unsupported Mercado Pago event type: ${String(payload.type)}`);
          const payment = await this.dependencies.prisma.payment.findFirst({ where: eventType === 'order' ? { mercadoPago: { providerOrderId: resourceId } } : { mercadoPago: { externalPaymentId: resourceId } }, select: { id: true } });
          await this.dependencies.prisma.webhookEvent.update({ where: { id: event.id }, data: { processedAt: new Date(), lockedAt: null, nextAttemptAt: null, lastError: null, paymentId: payment?.id ?? null } });
        } catch (error) {
          const message = safeErrorMessage(error);
          const permanent = attempt >= 10;
          const nextAttemptAt = new Date(now.getTime() + Math.min(15 * 60_000, 5_000 * 2 ** Math.min(attempt - 1, 8)));
          await this.dependencies.prisma.webhookEvent.update({ where: { id: event.id }, data: { lockedAt: null, lastError: message.slice(0, 1000), nextAttemptAt: permanent ? null : nextAttemptAt, failedAt: permanent ? new Date() : null } });
          logger.error({ err: error, eventId: event.id, notificationId: event.notificationId, resourceId: event.resourceId, attempt, permanent }, 'Mercado Pago webhook processing failed');
        }
      }
    } finally {
      this.running = false;
    }
  }
}

import { MercadoPagoConfig, Order, Payment, WebhookSignatureValidator, type Order as OrderClient } from 'mercadopago';
import type { OrderResponse } from 'mercadopago/dist/clients/order/commonTypes.js';
import { env } from '../../config/env.js';

export type MercadoPagoOrderBody = {
  type: 'online';
  external_reference: string;
  total_amount: string;
  currency: 'ARS';
  capture_mode: 'automatic_async';
  processing_mode: 'manual';
  description: string;
  items: Array<{ external_code: string; title: string; quantity: number; unit_price: string }>;
  payer?: { email?: string; first_name?: string; last_name?: string };
  config: {
      online: {
        callback_url: string;
        success_url: string;
        failure_url: string;
        pending_url: string;
        auto_return: 'all';
      retries: { allowed: true };
    };
    payment_method: { not_allowed_types: string[] };
  };
  expiration_time: string;
};

export type MercadoPagoCheckoutOrderInput = {
  number: string;
  amountMinor: bigint;
  publicApiUrl: string;
  publicWebUrl: string;
  payer?: { email?: string; first_name?: string; last_name?: string };
};

export function buildMercadoPagoCheckoutOrder(input: MercadoPagoCheckoutOrderInput): MercadoPagoOrderBody {
  const amount = providerAmountDecimal(input.amountMinor);
  const publicApiUrl = input.publicApiUrl.replace(/\/+$/, '');
  const publicWebUrl = input.publicWebUrl.replace(/\/+$/, '');
  return {
    type: 'online',
    external_reference: input.number,
    total_amount: amount,
    currency: 'ARS',
    capture_mode: 'automatic_async',
    processing_mode: 'manual',
    description: `Compra ${input.number}`,
    items: [{ external_code: input.number, title: `Compra ${input.number}`, quantity: 1, unit_price: amount }],
    ...(input.payer ? { payer: input.payer } : {}),
    config: {
      online: {
        callback_url: `${publicApiUrl}/api/v2/webhooks/mercado-pago`,
        success_url: `${publicWebUrl}/account/orders/${encodeURIComponent(input.number)}?payment=success`,
        failure_url: `${publicWebUrl}/account/orders/${encodeURIComponent(input.number)}?payment=failure`,
        pending_url: `${publicWebUrl}/account/orders/${encodeURIComponent(input.number)}?payment=pending`,
        // Omitting allowed_user_type is how Checkout Pro accepts account and guest buyers.
        auto_return: 'all',
        retries: { allowed: true },
      },
      payment_method: { not_allowed_types: ['ticket', 'atm', 'bank_transfer', 'digital_currency'] },
    },
    expiration_time: 'PT30M',
  };
}

export type MercadoPagoGateway = {
  createOrder(body: MercadoPagoOrderBody, idempotencyKey: string): Promise<OrderResponse>;
  getOrder(providerOrderId: string): Promise<OrderResponse>;
  getPayment(providerPaymentId: string): Promise<Record<string, unknown>>;
  validateWebhook(input: { signature: string | undefined; requestId: string | undefined; dataId: string | undefined }): void;
};

export function createMercadoPagoGateway(allowDisabled = false): MercadoPagoGateway | null {
  if ((!env.mercadoPagoEnabled && !allowDisabled) || !env.MERCADOPAGO_ACCESS_TOKEN) return null;
  const client = new MercadoPagoConfig({ accessToken: env.MERCADOPAGO_ACCESS_TOKEN, options: { timeout: 5_000 } });
  const orderClient = new Order(client);
  const paymentClient = new Payment(client);
  return {
    createOrder: (body, idempotencyKey) => orderClient.create({ body: body as Parameters<OrderClient['create']>[0]['body'], requestOptions: { idempotencyKey, timeout: 5_000 } }),
    getOrder: (providerOrderId) => orderClient.get({ id: providerOrderId, requestOptions: { timeout: 5_000 } }),
    getPayment: async (providerPaymentId) => await paymentClient.get({ id: providerPaymentId, requestOptions: { timeout: 5_000 } }) as unknown as Record<string, unknown>,
    validateWebhook: ({ signature, requestId, dataId }) => {
      WebhookSignatureValidator.validate({ xSignature: signature, xRequestId: requestId, dataId, secret: env.MERCADOPAGO_WEBHOOK_SECRET!, toleranceSeconds: 300 });
    },
  };
}

export function providerAmountToMinor(value: unknown): bigint {
  const raw = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return -1n;
  const [whole = '0', fraction = ''] = raw.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

export function providerAmountDecimal(amountMinor: bigint): string {
  if (amountMinor < 0n) throw new Error('Provider amount cannot be negative');
  return `${amountMinor / 100n}.${(amountMinor % 100n).toString().padStart(2, '0')}`;
}

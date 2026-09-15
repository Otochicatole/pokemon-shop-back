-- Mercado Pago Orders API, durable webhook inbox and USD/ARS quote snapshots.
ALTER TABLE "MercadoPagoPayment" ADD COLUMN "integrationMode" TEXT NOT NULL DEFAULT 'PREFERENCE_V1';
ALTER TABLE "MercadoPagoPayment" ADD COLUMN "providerOrderId" TEXT;
ALTER TABLE "MercadoPagoPayment" ADD COLUMN "providerIdempotencyKey" TEXT;
ALTER TABLE "MercadoPagoPayment" ADD COLUMN "providerAmountMinor" BIGINT;
ALTER TABLE "MercadoPagoPayment" ADD COLUMN "providerCurrency" TEXT;
ALTER TABLE "MercadoPagoPayment" ADD COLUMN "exchangeRateSnapshotId" TEXT;

CREATE TABLE "ExchangeRateSnapshot" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "source" TEXT NOT NULL,
  "baseCurrency" TEXT NOT NULL,
  "quoteCurrency" TEXT NOT NULL,
  "sellRateMicros" BIGINT NOT NULL,
  "providerUpdatedAt" DATETIME,
  "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "MercadoPagoPaymentAttempt" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "mercadoPagoPaymentId" TEXT NOT NULL,
  "providerPaymentId" TEXT,
  "attemptNumber" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "statusDetail" TEXT,
  "amountMinor" BIGINT,
  "refundedAmountMinor" BIGINT,
  "currency" TEXT,
  "payload" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "MercadoPagoPaymentAttempt_mercadoPagoPaymentId_fkey" FOREIGN KEY ("mercadoPagoPaymentId") REFERENCES "MercadoPagoPayment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE "WebhookEvent" ADD COLUMN "notificationId" TEXT;
ALTER TABLE "WebhookEvent" ADD COLUMN "resourceId" TEXT;
ALTER TABLE "WebhookEvent" ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "WebhookEvent" ADD COLUMN "nextAttemptAt" DATETIME;
ALTER TABLE "WebhookEvent" ADD COLUMN "lockedAt" DATETIME;
ALTER TABLE "WebhookEvent" ADD COLUMN "lastError" TEXT;
ALTER TABLE "WebhookEvent" ADD COLUMN "failedAt" DATETIME;
ALTER TABLE "WebhookEvent" ADD COLUMN "updatedAt" DATETIME NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
UPDATE "WebhookEvent" SET "updatedAt" = "receivedAt" WHERE "updatedAt" = '1970-01-01T00:00:00.000Z';

CREATE UNIQUE INDEX "MercadoPagoPayment_providerOrderId_key" ON "MercadoPagoPayment" ("providerOrderId");
CREATE UNIQUE INDEX "MercadoPagoPayment_providerIdempotencyKey_key" ON "MercadoPagoPayment" ("providerIdempotencyKey");
CREATE INDEX "MercadoPagoPayment_providerOrderId_idx" ON "MercadoPagoPayment" ("providerOrderId");
CREATE INDEX "MercadoPagoPayment_status_expiresAt_idx" ON "MercadoPagoPayment" ("status", "expiresAt");
CREATE INDEX "ExchangeRateSnapshot_source_baseCurrency_quoteCurrency_fetchedAt_idx" ON "ExchangeRateSnapshot" ("source", "baseCurrency", "quoteCurrency", "fetchedAt");
CREATE INDEX "ExchangeRateSnapshot_expiresAt_idx" ON "ExchangeRateSnapshot" ("expiresAt");
CREATE UNIQUE INDEX "MercadoPagoPaymentAttempt_providerPaymentId_key" ON "MercadoPagoPaymentAttempt" ("providerPaymentId");
CREATE UNIQUE INDEX "MercadoPagoPaymentAttempt_mercadoPagoPaymentId_attemptNumber_key" ON "MercadoPagoPaymentAttempt" ("mercadoPagoPaymentId", "attemptNumber");
CREATE INDEX "MercadoPagoPaymentAttempt_status_updatedAt_idx" ON "MercadoPagoPaymentAttempt" ("status", "updatedAt");
CREATE UNIQUE INDEX "WebhookEvent_notificationId_key" ON "WebhookEvent" ("notificationId");
CREATE INDEX "WebhookEvent_processedAt_nextAttemptAt_idx" ON "WebhookEvent" ("processedAt", "nextAttemptAt");
CREATE INDEX "WebhookEvent_resourceId_processedAt_idx" ON "WebhookEvent" ("resourceId", "processedAt");

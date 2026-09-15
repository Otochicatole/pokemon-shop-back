import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { app } from '../src/app.js';
import { prisma } from '../src/infrastructure/prisma.js';
import { hashPassword } from '../src/shared/crypto.js';

const adminId = randomUUID();
const adminEmail = `payout-admin-${adminId}@example.test`;
const adminPassword = 'PayoutAdminPassword123!';
const userId = randomUUID();
const affiliateId = randomUUID();
const payoutId = randomUUID();

describe('admin affiliate payout detail', () => {
  beforeAll(async () => {
    await prisma.user.create({
      data: { id: userId, email: `payout-user-${userId}@example.test`, passwordHash: null, emailVerifiedAt: new Date() },
    });
    await prisma.affiliate.create({
      data: { id: affiliateId, userId, publicName: 'Payout Test Affiliate' },
    });
    await prisma.affiliatePayoutRequest.create({
      data: {
        id: payoutId,
        affiliateId,
        amountMinor: 1250n,
        destinationCipher: 'ciphertext',
        destinationLast4: '1234',
      },
    });
    await prisma.affiliateLedgerEntry.create({
      data: {
        affiliateId,
        payoutId,
        bucket: 'RESERVED',
        type: 'PAYOUT_RESERVED',
        amountMinor: 1250n,
        dedupeKey: `payout-detail-test:${payoutId}`,
      },
    });
    await prisma.affiliateLedgerEntry.create({
      data: {
        affiliateId,
        payoutId,
        bucket: 'AVAILABLE',
        type: 'SALE_RELEASED',
        amountMinor: 5000n,
        dedupeKey: `payout-detail-available-test:${payoutId}`,
      },
    });
    await prisma.admin.create({
      data: { id: adminId, email: adminEmail, passwordHash: await hashPassword(adminPassword) },
    });
  });

  afterAll(async () => {
    await prisma.affiliateLedgerEntry.deleteMany({ where: { payoutId } });
    await prisma.affiliatePayoutRequest.deleteMany({ where: { id: payoutId } });
    await prisma.affiliate.deleteMany({ where: { id: affiliateId } });
    await prisma.adminSession.deleteMany({ where: { adminId } });
    await prisma.admin.deleteMany({ where: { id: adminId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it('serializes payout and ledger BigInt amounts as strings', async () => {
    const agent = request.agent(app);
    const login = await agent.post('/api/v2/admin/auth/login').send({ email: adminEmail, password: adminPassword });
    expect(login.status).toBe(200);

    const response = await agent.get(`/api/v2/admin/affiliates/payouts/${payoutId}`);

    expect(response.status).toBe(200);
    expect(response.body.data.payout.amountMinor).toBe('1250');
    expect(response.body.data.availableMinor).toBe('5000');
    expect(response.body.data.ledger[0].amountMinor).toBe('1250');
    expect(response.body.data.payout).not.toHaveProperty('ledgerEntries');
  });
});

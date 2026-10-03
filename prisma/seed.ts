import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { BASE_CURRENCY } from '../src/shared/currency.js';

const prisma = new PrismaClient();
const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@cardshop.test';
const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'Admin123!seed-card-shop';
const loyaltyProgramId = 'default';

/** 1 punto = US$0.01; 1 punto por cada US$1; canje desde 1 punto hasta 50% del subtotal de tienda. */
const loyaltyProgramSeed = {
  enabled: true,
  currency: BASE_CURRENCY,
  spendPerPointMinor: 100n,
  pointsPerStep: 1,
  pointValueMinor: 1n,
  minimumRedemptionPoints: 1,
  maximumRedemptionPercent: 50,
} as const;

async function main() {
  if (adminPassword.length < 12) throw new Error('SEED_ADMIN_PASSWORD must have at least 12 characters');

  const admin = await prisma.admin.upsert({
    where: { email: adminEmail },
    update: {
      name: 'Store Admin',
      passwordHash: await argon2.hash(adminPassword, { type: argon2.argon2id }),
      status: 'ACTIVE',
      totpSecretCipher: null,
      totpEnabledAt: null,
    },
    create: {
      email: adminEmail,
      name: 'Store Admin',
      passwordHash: await argon2.hash(adminPassword, { type: argon2.argon2id }),
      status: 'ACTIVE',
    },
  });
  await prisma.adminRecoveryCode.deleteMany({ where: { adminId: admin.id } });

  await prisma.loyaltyProgram.upsert({
    where: { id: loyaltyProgramId },
    update: { ...loyaltyProgramSeed, updatedById: admin.id },
    create: { id: loyaltyProgramId, ...loyaltyProgramSeed, updatedById: admin.id },
  });

  await prisma.transferSettings.upsert({
    where: { id: 'default' },
    update: {
      enabled: false,
      bankName: '',
      accountHolder: '',
      cbu: null,
      alias: null,
      updatedById: admin.id,
    },
    create: {
      id: 'default',
      enabled: false,
      bankName: '',
      accountHolder: '',
      cbu: null,
      alias: null,
      updatedById: admin.id,
    },
  });

  await prisma.exchangeRateSettings.upsert({
    where: { id: 'default' },
    update: {},
    create: { id: 'default', casa: 'blue' },
  });

  await prisma.newsSettings.upsert({
    where: { id: 'default' },
    update: {},
    create: { id: 'default', rotationIntervalSeconds: 5 },
  });

  await prisma.affiliateProgramSettings.upsert({
    where: { id: 'default' },
    update: {},
    create: { id: 'default', commissionBps: 1000, autoCompleteDays: 7, updatedById: admin.id },
  });

  console.log(JSON.stringify({
    seed: 'ok',
    mode: 'empty-store',
    admin: { email: adminEmail },
    catalog: { products: 0, suppliers: 0, news: 0, orders: 0, affiliates: 0 },
    transferSettings: { enabled: false },
    loyalty: {
      enabled: loyaltyProgramSeed.enabled,
      spendPerPointMinor: loyaltyProgramSeed.spendPerPointMinor.toString(),
      pointValueMinor: loyaltyProgramSeed.pointValueMinor.toString(),
      minimumRedemptionPoints: loyaltyProgramSeed.minimumRedemptionPoints,
      maximumRedemptionPercent: loyaltyProgramSeed.maximumRedemptionPercent,
    },
  }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { await prisma.$disconnect(); });

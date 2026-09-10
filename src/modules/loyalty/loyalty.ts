import { Router } from 'express';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { badRequest, conflict } from '../../shared/errors.js';
import { currentUser, requireUser } from '../../infrastructure/sessions.js';
import { moneyDto } from '../../shared/money.js';
import { BASE_CURRENCY } from '../../shared/currency.js';

export const LOYALTY_PROGRAM_ID = 'default';

type LoyaltyDb = PrismaClient | Prisma.TransactionClient;

export type LoyaltyProgramRecord = {
  id: string;
  enabled: boolean;
  currency: typeof BASE_CURRENCY;
  spendPerPointMinor: bigint;
  pointsPerStep: number;
  pointValueMinor: bigint;
  minimumRedemptionPoints: number;
  maximumRedemptionPercent: number;
  version: number;
  updatedById: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const fallbackProgram = (): LoyaltyProgramRecord => ({
  id: LOYALTY_PROGRAM_ID,
  enabled: true,
  currency: BASE_CURRENCY,
  spendPerPointMinor: 300n,
  pointsPerStep: 1,
  pointValueMinor: 1n,
  minimumRedemptionPoints: 5,
  maximumRedemptionPercent: 25,
  version: 1,
  updatedById: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

export async function getLoyaltyProgram(db: LoyaltyDb): Promise<LoyaltyProgramRecord> {
  const program = await db.loyaltyProgram.findUnique({ where: { id: LOYALTY_PROGRAM_ID } });
  if (!program) return fallbackProgram();
  if (program.currency !== BASE_CURRENCY) throw conflict('LOYALTY_CURRENCY_INVALID', 'La moneda del programa no coincide con la tienda');
  return { ...program, currency: BASE_CURRENCY };
}

export function mapLoyaltyProgram(program: LoyaltyProgramRecord) {
  return {
    enabled: program.enabled,
    currency: program.currency,
    spendPerPoint: moneyDto({ amountMinor: program.spendPerPointMinor, currency: program.currency }),
    pointsPerStep: program.pointsPerStep,
    pointValue: moneyDto({ amountMinor: program.pointValueMinor, currency: program.currency }),
    minimumRedemptionPoints: program.minimumRedemptionPoints,
    maximumRedemptionPercent: program.maximumRedemptionPercent,
    version: program.version,
    updatedAt: program.updatedAt,
  };
}

export type LoyaltyQuote = {
  program: LoyaltyProgramRecord;
  balance: number;
  reserved: number;
  available: number;
  maximumRedeemablePoints: number;
  pointsRedeemed: number;
  discountMinor: bigint;
  pointsToEarn: number;
};

export async function calculateLoyaltyQuote(
  db: LoyaltyDb,
  userId: string,
  subtotalMinor: bigint,
  requestedPoints: number,
): Promise<LoyaltyQuote> {
  const program = await getLoyaltyProgram(db);
  const account = await db.loyaltyAccount.findUnique({ where: { userId } });
  const balance = account?.balance ?? 0;
  const reserved = account?.reserved ?? 0;
  const available = Math.max(0, balance - reserved);

  if (!program.enabled) {
    if (requestedPoints > 0) throw badRequest('LOYALTY_PROGRAM_DISABLED', 'El programa de puntos no está disponible');
    return { program, balance, reserved, available, maximumRedeemablePoints: 0, pointsRedeemed: 0, discountMinor: 0n, pointsToEarn: 0 };
  }

  const percentCapMinor = subtotalMinor * BigInt(program.maximumRedemptionPercent) / 100n;
  const monetaryCapMinor = percentCapMinor < subtotalMinor ? percentCapMinor : subtotalMinor;
  const maximumByMoney = program.pointValueMinor > 0n ? Number(monetaryCapMinor / program.pointValueMinor) : 0;
  const maximumRedeemablePoints = Math.max(0, Math.min(available, maximumByMoney));

  if (requestedPoints > 0 && requestedPoints < program.minimumRedemptionPoints) {
    throw badRequest('LOYALTY_MINIMUM_NOT_MET', `El canje mínimo es de ${program.minimumRedemptionPoints} puntos`, { minimumRedemptionPoints: program.minimumRedemptionPoints });
  }
  if (requestedPoints > maximumRedeemablePoints) {
    throw conflict('LOYALTY_POINTS_UNAVAILABLE', 'No hay suficientes puntos disponibles para este descuento', { availablePoints: available, maximumRedeemablePoints });
  }

  const discountMinor = BigInt(requestedPoints) * program.pointValueMinor;
  const eligibleSpendMinor = subtotalMinor - discountMinor;
  const pointsToEarn = program.spendPerPointMinor > 0n
    ? Number(eligibleSpendMinor / program.spendPerPointMinor) * program.pointsPerStep
    : 0;
  if (!Number.isSafeInteger(pointsToEarn) || pointsToEarn > 2_000_000_000) throw conflict('LOYALTY_POINTS_OVERFLOW', 'La compra excede el límite de puntos permitido');

  return { program, balance, reserved, available, maximumRedeemablePoints, pointsRedeemed: requestedPoints, discountMinor, pointsToEarn };
}

async function ensureAccount(tx: Prisma.TransactionClient, userId: string) {
  return tx.loyaltyAccount.upsert({ where: { userId }, update: {}, create: { userId } });
}

export async function reserveLoyaltyPoints(tx: Prisma.TransactionClient, userId: string, points: number): Promise<void> {
  if (points === 0) return;
  const account = await ensureAccount(tx, userId);
  if (Math.max(0, account.balance - account.reserved) < points) throw conflict('LOYALTY_POINTS_UNAVAILABLE', 'Los puntos disponibles cambiaron durante el checkout');
  const changed = await tx.loyaltyAccount.updateMany({
    where: { id: account.id, version: account.version },
    data: { reserved: { increment: points }, version: { increment: 1 } },
  });
  if (changed.count !== 1) throw conflict('LOYALTY_ACCOUNT_CHANGED', 'El saldo de puntos cambió durante el checkout');
}

export async function releaseOrderLoyaltyReservation(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { id: true, userId: true, pointsRedeemed: true, loyaltyRedemptionStatus: true } });
  if (!order || order.pointsRedeemed === 0 || order.loyaltyRedemptionStatus !== 'RESERVED') return;
  const account = await ensureAccount(tx, order.userId);
  if (account.reserved < order.pointsRedeemed) throw conflict('LOYALTY_RESERVATION_INVALID', 'La reserva de puntos es inconsistente');
  const changed = await tx.loyaltyAccount.updateMany({
    where: { id: account.id, version: account.version, reserved: { gte: order.pointsRedeemed } },
    data: { reserved: { decrement: order.pointsRedeemed }, version: { increment: 1 } },
  });
  if (changed.count !== 1) throw conflict('LOYALTY_ACCOUNT_CHANGED', 'El saldo de puntos cambió al liberar la reserva');
  await tx.order.update({ where: { id: order.id }, data: { loyaltyRedemptionStatus: 'RELEASED' } });
}

export async function settleOrderLoyalty(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { id: true, number: true, userId: true, pointsRedeemed: true, pointsEarned: true, loyaltyRedemptionStatus: true },
  });
  if (!order) return;
  let account = await ensureAccount(tx, order.userId);

  if (order.pointsRedeemed > 0 && order.loyaltyRedemptionStatus !== 'REDEEMED' && order.loyaltyRedemptionStatus !== 'RESTORED') {
    const alreadyRedeemed = await tx.loyaltyTransaction.findUnique({ where: { orderId_type: { orderId, type: 'REDEEM' } } });
    if (!alreadyRedeemed) {
      const wasReserved = order.loyaltyRedemptionStatus === 'RESERVED';
      const available = Math.max(0, account.balance - account.reserved);
      if (wasReserved ? account.reserved < order.pointsRedeemed : available < order.pointsRedeemed) {
        throw conflict('LOYALTY_POINTS_UNAVAILABLE', 'Los puntos del pedido ya no están disponibles');
      }
      account = await tx.loyaltyAccount.update({
        where: { id: account.id },
        data: {
          balance: { decrement: order.pointsRedeemed },
          ...(wasReserved ? { reserved: { decrement: order.pointsRedeemed } } : {}),
          lifetimeRedeemed: { increment: order.pointsRedeemed },
          version: { increment: 1 },
        },
      });
      await tx.loyaltyTransaction.create({ data: { accountId: account.id, userId: order.userId, orderId, type: 'REDEEM', points: -order.pointsRedeemed, balanceAfter: account.balance, description: `Canje en la orden ${order.number}` } });
    }
    await tx.order.update({ where: { id: order.id }, data: { loyaltyRedemptionStatus: 'REDEEMED' } });
  }

  if (order.pointsEarned > 0) {
    const alreadyEarned = await tx.loyaltyTransaction.findUnique({ where: { orderId_type: { orderId, type: 'EARN' } } });
    if (!alreadyEarned) {
      account = await tx.loyaltyAccount.update({ where: { id: account.id }, data: { balance: { increment: order.pointsEarned }, lifetimeEarned: { increment: order.pointsEarned }, version: { increment: 1 } } });
      await tx.loyaltyTransaction.create({ data: { accountId: account.id, userId: order.userId, orderId, type: 'EARN', points: order.pointsEarned, balanceAfter: account.balance, description: `Compra acreditada · ${order.number}` } });
    }
  }
}

export async function reverseOrderLoyalty(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { id: true, number: true, userId: true, pointsRedeemed: true, pointsEarned: true, loyaltyRedemptionStatus: true },
  });
  if (!order) return;
  let account = await ensureAccount(tx, order.userId);

  const earned = await tx.loyaltyTransaction.findUnique({ where: { orderId_type: { orderId, type: 'EARN' } } });
  const earnedReversal = await tx.loyaltyTransaction.findUnique({ where: { orderId_type: { orderId, type: 'EARN_REVERSAL' } } });
  if (earned && !earnedReversal && order.pointsEarned > 0) {
    account = await tx.loyaltyAccount.update({ where: { id: account.id }, data: { balance: { decrement: order.pointsEarned }, version: { increment: 1 } } });
    await tx.loyaltyTransaction.create({ data: { accountId: account.id, userId: order.userId, orderId, type: 'EARN_REVERSAL', points: -order.pointsEarned, balanceAfter: account.balance, description: `Puntos revertidos por reembolso · ${order.number}` } });
  }

  const redeemed = await tx.loyaltyTransaction.findUnique({ where: { orderId_type: { orderId, type: 'REDEEM' } } });
  const redemptionReversal = await tx.loyaltyTransaction.findUnique({ where: { orderId_type: { orderId, type: 'REDEEM_REVERSAL' } } });
  if (redeemed && !redemptionReversal && order.pointsRedeemed > 0) {
    account = await tx.loyaltyAccount.update({ where: { id: account.id }, data: { balance: { increment: order.pointsRedeemed }, version: { increment: 1 } } });
    await tx.loyaltyTransaction.create({ data: { accountId: account.id, userId: order.userId, orderId, type: 'REDEEM_REVERSAL', points: order.pointsRedeemed, balanceAfter: account.balance, description: `Canje devuelto por reembolso · ${order.number}` } });
    await tx.order.update({ where: { id: order.id }, data: { loyaltyRedemptionStatus: 'RESTORED' } });
  }
}

const accountQuerySchema = z.object({ cursor: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(50).default(20) });

export function createLoyaltyRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.get('/program', async (_req, res) => res.json({ program: mapLoyaltyProgram(await getLoyaltyProgram(prisma)) }));
  router.get('/account', requireUser, async (req, res) => {
    const user = currentUser(req)!.user;
    const query = accountQuerySchema.parse(req.query);
    const [program, account, rows] = await Promise.all([
      getLoyaltyProgram(prisma),
      prisma.loyaltyAccount.findUnique({ where: { userId: user.id } }),
      prisma.loyaltyTransaction.findMany({
        where: { userId: user.id },
        include: { order: { select: { number: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}),
      }),
    ]);
    const hasMore = rows.length > query.limit;
    const transactions = hasMore ? rows.slice(0, query.limit) : rows;
    const balance = account?.balance ?? 0;
    const reserved = account?.reserved ?? 0;
    return res.json({
      program: mapLoyaltyProgram(program),
      account: {
        balance,
        reserved,
        available: Math.max(0, balance - reserved),
        lifetimeEarned: account?.lifetimeEarned ?? 0,
        lifetimeRedeemed: account?.lifetimeRedeemed ?? 0,
      },
      transactions: transactions.map((entry) => ({ id: entry.id, type: entry.type, points: entry.points, balanceAfter: entry.balanceAfter, description: entry.description, orderNumber: entry.order?.number ?? null, createdAt: entry.createdAt })),
      nextCursor: hasMore ? transactions.at(-1)?.id ?? null : null,
    });
  });
  return router;
}

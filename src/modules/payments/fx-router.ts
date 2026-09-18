import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { AppError } from '../../shared/errors.js';
import { getConfiguredUsdArsRate } from '../payments/index.js';

export function createFxRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.get('/usd-ars', async (_req, res) => {
    try {
      const quote = await getConfiguredUsdArsRate(prisma);
      return res.json({
        casa: quote.casa,
        source: quote.source,
        rate: quote.rate,
        rateMicros: quote.rateMicros.toString(),
        fetchedAt: quote.fetchedAt,
        expiresAt: quote.expiresAt,
      });
    } catch (error) {
      throw new AppError(503, 'FX_RATE_UNAVAILABLE', 'No pudimos obtener la cotización USD/ARS');
    }
  });
  return router;
}

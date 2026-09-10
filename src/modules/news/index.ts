import { Router } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';

export const publicNewsQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(30).default(20) });
export const publicNewsItemSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  summary: z.string(),
});

function mapPublicNews(item: { id: string; title: string; summary: string }) {
  return { id: item.id, title: item.title, summary: item.summary };
}

export function createNewsRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.get('/', async (req, res) => {
    const { limit } = publicNewsQuerySchema.parse(req.query);
    const now = new Date();
    const rows = await prisma.newsItem.findMany({
      where: {
        active: true,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
        ],
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }],
      take: limit,
    });
    return res.json({ data: rows.map(mapPublicNews), meta: {} });
  });
  return router;
}

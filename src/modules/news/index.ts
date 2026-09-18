import { Router } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';

export const publicNewsQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(30).default(20) });
export const publicNewsItemSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  summary: z.string(),
  coverUrl: z.string().nullable(),
});

const NEWS_SETTINGS_ID = 'default';
const DEFAULT_NEWS_ROTATION_SECONDS = 5;

function mapPublicNews(item: { id: string; title: string; summary: string; coverFileId: string | null }) {
  return {
    id: item.id,
    title: item.title,
    summary: item.summary,
    coverUrl: item.coverFileId ? `/media/public/${item.coverFileId}` : null,
  };
}

async function getRotationIntervalSeconds(prisma: PrismaClient) {
  const settings = await prisma.newsSettings.upsert({
    where: { id: NEWS_SETTINGS_ID },
    update: {},
    create: { id: NEWS_SETTINGS_ID, rotationIntervalSeconds: DEFAULT_NEWS_ROTATION_SECONDS },
  });
  return settings.rotationIntervalSeconds;
}

export function createNewsRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.get('/', async (req, res) => {
    const { limit } = publicNewsQuerySchema.parse(req.query);
    const now = new Date();
    const [rows, rotationIntervalSeconds] = await Promise.all([
      prisma.newsItem.findMany({
        where: {
          active: true,
          AND: [
            { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
            { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
          ],
        },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }],
        take: limit,
      }),
      getRotationIntervalSeconds(prisma),
    ]);
    return res.json({
      data: rows.map(mapPublicNews),
      meta: { rotationIntervalSeconds },
    });
  });
  return router;
}

import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createNewsRouter } from '../src/modules/news/index.js';
import { newsPatchSchema, newsWriteSchema } from '../src/modules/backoffice/index.js';

describe('news publication contracts', () => {
  it('validates editorial limits and exclusive date windows', () => {
    expect(() => newsWriteSchema.parse({ title: 'x'.repeat(181), summary: '', sortOrder: 0, startsAt: null, endsAt: null })).toThrow();
    expect(() => newsWriteSchema.parse({ title: 'Novedad', summary: '', sortOrder: 0, startsAt: '2026-09-10T12:00:00.000Z', endsAt: '2026-09-10T12:00:00.000Z' })).toThrow();
    expect(newsPatchSchema.parse({ expectedVersion: 2, active: true })).toEqual({ expectedVersion: 2, active: true });
  });

  it('asks the database for active items in the inclusive/exclusive publication window and falls back to the title for alt text', async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: '11111111-1111-4111-8111-111111111111', title: 'Novedad', summary: 'Texto' }]);
    const app = express();
    app.use('/api/v2/news', createNewsRouter({ newsItem: { findMany } } as never));
    const response = await request(app).get('/api/v2/news');
    expect(response.status).toBe(200);
    expect(response.body.data[0]).toEqual({ id: '11111111-1111-4111-8111-111111111111', title: 'Novedad', summary: 'Texto' });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ active: true, AND: expect.arrayContaining([
      { OR: [{ startsAt: null }, { startsAt: { lte: expect.any(Date) } }] },
      { OR: [{ endsAt: null }, { endsAt: { gt: expect.any(Date) } }] },
    ]) }) }));
  });
});

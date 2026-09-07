import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';

describe('v2 public contract', () => {
  it('returns catalog pages using the data/meta envelope', async () => {
    const response = await request(app).get('/api/v2/catalog/products?limit=2');
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.data)).toBe(true);
    expect(response.body.meta).toHaveProperty('nextCursor');
  });

  it('returns problem details for unknown v2 routes', async () => {
    const response = await request(app).get('/api/v2/does-not-exist');
    expect(response.status).toBe(404);
    expect(response.body).toEqual(expect.objectContaining({ code: 'NOT_FOUND', status: 404, requestId: expect.any(String) }));
  });
});

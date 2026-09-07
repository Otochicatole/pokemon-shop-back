import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/app.js';

describe('health and public API', () => {
  it('reports liveness', async () => {
    const response = await request(app).get('/health/live');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('serves OpenAPI and Swagger in development', async () => {
    const openapi = await request(app).get('/openapi.json');
    expect(openapi.status).toBe(200);
    expect(openapi.body.openapi).toBe('3.1.0');
    const docs = await request(app).get('/docs/');
    expect(docs.status).toBe(200);
  });
});

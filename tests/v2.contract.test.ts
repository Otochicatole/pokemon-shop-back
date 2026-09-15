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

  it('documents catalog query filters, facets and product detail', async () => {
    const response = await request(app).get('/openapi.json');
    expect(response.status).toBe(200);
    expect(response.body.paths).toHaveProperty('/api/v2/catalog/filters');
    expect(response.body.paths).toHaveProperty('/api/v2/catalog/products/{slug}');
    const parameters = response.body.paths['/api/v2/catalog/products'].get.parameters as Array<{ name: string }>;
    expect(parameters.map((parameter) => parameter.name)).toEqual(expect.arrayContaining(['kind', 'pokemonType', 'inStock', 'minPriceMinor', 'sort']));
  });

  it('documents the supplier directory lifecycle endpoints', async () => {
    const response = await request(app).get('/openapi.json');
    expect(response.status).toBe(200);
    expect(response.body.paths).toEqual(expect.objectContaining({
      '/api/v2/admin/suppliers': expect.objectContaining({ get: expect.any(Object), post: expect.any(Object) }),
      '/api/v2/admin/suppliers/{id}': expect.objectContaining({ get: expect.any(Object), patch: expect.any(Object) }),
      '/api/v2/admin/suppliers/{id}/active': expect.objectContaining({ patch: expect.any(Object) }),
    }));
  });

  it('documents customer/admin support endpoints and the websocket protocol', async () => {
    const response = await request(app).get('/openapi.json');
    expect(response.status).toBe(200);
    expect(response.body.paths).toEqual(expect.objectContaining({
      '/api/v2/support/conversations': expect.objectContaining({ get: expect.any(Object), post: expect.any(Object) }),
      '/api/v2/support/conversations/{id}': expect.objectContaining({ get: expect.any(Object) }),
      '/api/v2/support/conversations/{id}/messages': expect.objectContaining({ post: expect.any(Object) }),
      '/api/v2/support/conversations/{id}/read': expect.objectContaining({ post: expect.any(Object) }),
      '/api/v2/support/unread-count': expect.objectContaining({ get: expect.any(Object) }),
      '/api/v2/admin/support/conversations': expect.objectContaining({ get: expect.any(Object), post: expect.any(Object) }),
      '/api/v2/admin/support/conversations/{id}/status': expect.objectContaining({ patch: expect.any(Object) }),
      '/api/v2/admin/support/unread-count': expect.objectContaining({ get: expect.any(Object) }),
    }));
    expect(response.body['x-websocket']).toEqual(expect.objectContaining({
      url: '/api/v2/support/ws?role={user|admin}',
      sessionLifecycle: expect.stringContaining('exact authenticated session'),
      closeCodes: { sessionRevoked: 4001, actorSocketLimitExceeded: 4008 },
      serverEvents: expect.arrayContaining(['connection.ready', 'support.message.created', 'support.unread_count']),
    }));
    expect(response.body.paths['/api/v2/support/conversations'].post.responses).toEqual(expect.objectContaining({
      200: expect.any(Object),
      201: expect.any(Object),
    }));
    expect(response.body.paths['/api/v2/admin/support/conversations'].post.responses).toEqual(expect.objectContaining({
      200: expect.any(Object),
      201: expect.any(Object),
    }));
  });

  it('documents the customer-owned Mercado Pago status refresh', async () => {
    const response = await request(app).get('/openapi.json');
    const operation = response.body.paths['/api/v2/orders/{number}/payment-status/refresh']?.post;

    expect(response.status).toBe(200);
    expect(operation).toEqual(expect.objectContaining({
      security: [{ userCookie: [] }],
      responses: expect.objectContaining({
        200: expect.any(Object),
        401: expect.any(Object),
        403: expect.any(Object),
        404: expect.any(Object),
        409: expect.any(Object),
        429: expect.any(Object),
        503: expect.any(Object),
      }),
    }));
    expect(operation.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'number', in: 'path', required: true }),
      expect.objectContaining({ name: 'x-csrf-token', in: 'header', required: true }),
    ]));
  });

  it('returns problem details for unknown v2 routes', async () => {
    const response = await request(app).get('/api/v2/does-not-exist');
    expect(response.status).toBe(404);
    expect(response.body).toEqual(expect.objectContaining({ code: 'NOT_FOUND', status: 404, requestId: expect.any(String) }));
  });
});

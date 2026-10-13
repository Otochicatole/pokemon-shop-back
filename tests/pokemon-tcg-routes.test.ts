import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { createAdminCmsRouter } from '../src/modules/backoffice/http/admin-cms-router.js';
import { createAffiliateRouter } from '../src/modules/affiliates/index.js';
import { adminPokemonTcgCardSchema } from '../src/modules/backoffice/http/admin-cms-response-schemas.js';

const provider = vi.hoisted(() => ({ getCard: vi.fn(), searchCards: vi.fn(), listRarities: vi.fn(), listSets: vi.fn(), downloadPokemonTcgImage: vi.fn() }));
vi.mock('../src/modules/pokemon-tcg/index.js', () => provider);
vi.mock('../src/config/env.js', () => ({ env: {} }));
vi.mock('../src/infrastructure/logger.js', () => ({ logger: {} }));
vi.mock('../src/modules/media/index.js', () => ({ discardUnattachedFile: vi.fn(), saveImage: vi.fn() }));
vi.mock('../src/modules/notifications/index.js', () => ({}));
vi.mock('../src/modules/affiliates/affiliate-marketplace-service.js', () => ({}));
vi.mock('../src/infrastructure/sessions.js', () => ({
  currentAdmin: vi.fn(), currentUser: vi.fn(), requireAdmin: vi.fn(),
  currentAffiliate: (req: express.Request) => req.get('x-test-auth') ? { id: 'affiliate', status: req.get('x-test-auth') } : null,
  requireAffiliate: ((req, res, next) => req.get('x-test-auth') ? next() : res.sendStatus(401)) satisfies RequestHandler,
}));

const pass: RequestHandler = (_req, _res, next) => next();
const card = {
  id: '1', name: 'Bulbasaur', localId: '1', setCode: 'BASE', imageUrl: null,
  setName: 'Base Set', description: '', rarity: 'Common', category: 'Pokemon', types: ['Grass'],
  firstEdition: false, holo: false, effect: '', language: 'English',
  marketPrice: { amountMinor: '153', currency: 'USD', source: 'TCGplayer', variant: 'Normal', updatedAt: '2026-10-12T00:00:00Z' },
};
const saveImage = vi.fn();
const discardImage = vi.fn();
const addImages = vi.fn();
const upload = { array: () => pass, single: () => pass };

function appFor(role: 'admin' | 'affiliate') {
  const app = express();
  app.use(express.json());
  if (role === 'admin') {
    app.use(createAdminCmsRouter({
      application: { products: { addImages } } as never,
      upload: upload as never,
      requireAdmin: (req, res, next) => req.get('x-test-auth') ? next() : res.sendStatus(401),
      actorFromRequest: () => ({ id: 'admin' }) as never,
      media: { saveProductImage: saveImage, saveNewsCover: saveImage, discardUnattachedFile: discardImage },
    }));
  } else {
    app.use(createAffiliateRouter({} as never, upload, saveImage, discardImage));
  }
  app.use(((error, _req, res, _next) => res.status(error instanceof ZodError ? 400 : error.status ?? 500).json({ code: error.code ?? 'VALIDATION' })) satisfies ErrorRequestHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  provider.getCard.mockResolvedValue(card);
  provider.searchCards.mockResolvedValue([{ id: '1', name: 'Bulbasaur' }]);
  provider.listRarities.mockResolvedValue(['Common']);
  provider.listSets.mockResolvedValue([{ id: 'BASE', name: 'Base Set' }]);
  saveImage.mockResolvedValue({ id: 'stored-image' });
  discardImage.mockResolvedValue(true);
});

describe.each(['admin', 'affiliate'] as const)('%s Pokémon TCG routes', (role) => {
  it('runs authentication before invoking the provider', async () => {
    const app = appFor(role);
    for (const endpoint of ['/pokemon-tcg/cards?q=Bulba', '/pokemon-tcg/cards/1', '/pokemon-tcg/sets', '/pokemon-tcg/rarities']) {
      expect((await request(app).get(endpoint)).status).toBe(401);
    }
    expect(provider.getCard).not.toHaveBeenCalled();
    expect(provider.searchCards).not.toHaveBeenCalled();
    expect(provider.listSets).not.toHaveBeenCalled();
    expect(provider.listRarities).not.toHaveBeenCalled();
  });

  it('accepts a one-digit provider ID and returns the market-price detail contract', async () => {
    const response = await request(appFor(role)).get('/pokemon-tcg/cards/1').set('x-test-auth', 'ACTIVE');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { card }, meta: {} });
    expect(adminPokemonTcgCardSchema.parse(response.body.data.card)).toEqual(card);
    expect(provider.getCard).toHaveBeenCalledWith('1');
  });

  it('rejects legacy and malformed IDs before contacting the provider', async () => {
    const app = appFor(role);
    for (const id of ['base1-1', '-1', '0', '01', '1.2', '1%2F2', 'a']) {
      expect((await request(app).get(`/pokemon-tcg/cards/${id}`).set('x-test-auth', 'ACTIVE')).status).toBe(400);
    }
    expect(provider.getCard).not.toHaveBeenCalled();
  });

  it('searches and lists provider options using the existing envelopes', async () => {
    const app = appFor(role);
    const result = await request(app).get('/pokemon-tcg/cards?q=Bulba').set('x-test-auth', 'ACTIVE');
    expect(result.body).toEqual({ data: [{ id: '1', name: 'Bulbasaur' }], meta: {} });
    expect(provider.searchCards).toHaveBeenCalledWith('Bulba');
    expect((await request(app).get('/pokemon-tcg/sets').set('x-test-auth', 'ACTIVE')).body.data).toEqual([{ id: 'BASE', name: 'Base Set' }]);
    expect((await request(app).get('/pokemon-tcg/rarities').set('x-test-auth', 'ACTIVE')).body.data).toEqual(['Common']);
  });

  it('removes the retired provider endpoints', async () => {
    expect((await request(appFor(role)).get('/tcgdex/cards?q=Bulba').set('x-test-auth', 'ACTIVE')).status).toBe(404);
    expect(provider.searchCards).not.toHaveBeenCalled();
  });
});

it('prevents suspended affiliates from invoking the provider', async () => {
  const result = await request(appFor('affiliate')).get('/pokemon-tcg/cards/1').set('x-test-auth', 'SUSPENDED');
  expect(result.status).toBe(403);
  expect(provider.getCard).not.toHaveBeenCalled();
});

it('discards the downloaded admin image when an optimistic-concurrency update fails', async () => {
  provider.downloadPokemonTcgImage.mockResolvedValue({ mimetype: 'image/png' });
  addImages.mockRejectedValue({ status: 409, code: 'PRODUCT_CHANGED' });
  const result = await request(appFor('admin')).post('/products/11111111-1111-4111-8111-111111111111/pokemon-tcg-image').set('x-test-auth', 'ACTIVE').send({ expectedVersion: 1, imageUrl: 'https://img.pokemon-tcg.dev/card.png' });
  expect(result.status).toBe(409);
  expect(discardImage).toHaveBeenCalledWith('stored-image');
});

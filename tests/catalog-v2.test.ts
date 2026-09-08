import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { app } from '../src/app.js';
import { prisma } from '../src/infrastructure/prisma.js';

describe('v2 catalog filters', () => {
  const marker = `CatalogFixture${Date.now()}`;
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

  beforeAll(async () => {
    await prisma.product.create({
      data: {
        id: ids[0], sku: `${marker}-FIRE`, slug: `${marker.toLowerCase()}-fire`, name: `${marker} Fire`, description: 'Graded catalog fixture',
        kind: 'SINGLE_CARD', stockMode: 'UNIQUE', priceMinor: 5000n, status: 'PUBLISHED', publishedAt: new Date('2025-01-01T00:00:00.000Z'),
        inventory: { create: { onHand: 1, reserved: 0 } },
        pokemonCard: { create: { pokemonType: 'FIRE', setName: `${marker} Set`, setCode: `${marker}CODE`, cardNumber: '001/003', rarity: `${marker} Rare`, language: 'ES', condition: 'NM', finish: `${marker} Holo`, edition: `${marker} First`, gradingCompany: `${marker} PSA`, grade: '10', certificationNumber: `${marker}-CERT` } },
      },
    });
    await prisma.product.create({
      data: {
        id: ids[1], sku: `${marker}-WATER`, slug: `${marker.toLowerCase()}-water`, name: `${marker} Water`, description: 'Reserved catalog fixture',
        kind: 'SINGLE_CARD', stockMode: 'UNIQUE', priceMinor: 1500n, status: 'PUBLISHED', publishedAt: new Date('2025-01-02T00:00:00.000Z'),
        inventory: { create: { onHand: 1, reserved: 1 } },
        pokemonCard: { create: { pokemonType: 'WATER', setName: `${marker} Set`, setCode: `${marker}WTR`, cardNumber: '002/003', rarity: `${marker} Common`, language: 'EN', condition: 'GOOD', finish: `${marker} Non-Holo`, edition: `${marker} Unlimited` } },
      },
    });
    await prisma.product.create({
      data: {
        id: ids[2], sku: `${marker}-DRAGON`, slug: `${marker.toLowerCase()}-dragon`, name: `${marker} Dragon`, description: 'Equal-price catalog fixture',
        kind: 'SINGLE_CARD', stockMode: 'UNIQUE', priceMinor: 5000n, status: 'PUBLISHED', publishedAt: new Date('2025-01-03T00:00:00.000Z'),
        inventory: { create: { onHand: 1, reserved: 0 } },
        pokemonCard: { create: { pokemonType: 'DRAGON', setName: `${marker} Other Set`, setCode: `${marker}DRG`, cardNumber: '003/003', rarity: `${marker} Rare`, language: 'JP', condition: 'EXCELLENT', finish: `${marker} Foil`, edition: `${marker} Unlimited` } },
      },
    });
    await prisma.product.create({
      data: {
        id: ids[3], sku: `${marker}-ARCHIVED`, slug: `${marker.toLowerCase()}-archived`, name: `${marker} Archived`, description: 'Must not be public',
        kind: 'ACCESSORY', stockMode: 'QUANTITY', priceMinor: 1n, status: 'ARCHIVED',
        inventory: { create: { onHand: 100, reserved: 0 } },
      },
    });
  });

  afterAll(async () => {
    await prisma.product.deleteMany({ where: { id: { in: ids } } });
  });

  it('combines every card facet with exact stock and price filters', async () => {
    const query = new URLSearchParams({
      q: marker,
      kind: 'SINGLE_CARD',
      pokemonType: 'FIRE',
      setName: `${marker} Set`,
      setCode: `${marker}CODE`,
      rarity: `${marker} Rare`,
      condition: 'NM',
      language: 'ES',
      finish: `${marker} Holo`,
      edition: `${marker} First`,
      gradingCompany: `${marker} PSA`,
      graded: 'true',
      inStock: 'true',
      minPriceMinor: '4000',
      maxPriceMinor: '6000',
      sort: 'PRICE_ASC',
    });
    const response = await request(app).get(`/api/v2/catalog/products?${query}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0]).toEqual(expect.objectContaining({
      id: ids[0],
      available: 1,
      pokemonCard: expect.objectContaining({ pokemonType: 'FIRE', setCode: `${marker}CODE`, grade: '10' }),
    }));
  });

  it('uses OR within repeated values and AND between filter families', async () => {
    const query = new URLSearchParams({ q: marker, language: 'ES' });
    query.append('pokemonType', 'FIRE');
    query.append('pokemonType', 'WATER');
    const response = await request(app).get(`/api/v2/catalog/products?${query}`);

    expect(response.status).toBe(200);
    expect(response.body.data.map((product: { id: string }) => product.id)).toEqual([ids[0]]);
  });

  it('calculates availability as onHand minus reserved', async () => {
    const response = await request(app).get(`/api/v2/catalog/products?q=${marker}&inStock=false`);

    expect(response.status).toBe(200);
    expect(response.body.data.map((product: { id: string }) => product.id)).toEqual([ids[1]]);
    expect(response.body.data[0].available).toBe(0);
  });

  it('searches card metadata, sorts stably and paginates with its cursor', async () => {
    const first = await request(app).get(`/api/v2/catalog/products?q=${marker}&sort=PRICE_ASC&limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.data[0].id).toBe(ids[1]);
    expect(first.body.meta.nextCursor).toBeTruthy();

    const second = await request(app).get(`/api/v2/catalog/products?q=${marker}&sort=PRICE_ASC&limit=2&cursor=${first.body.meta.nextCursor}`);
    expect(second.status).toBe(200);
    const combined = [...first.body.data, ...second.body.data];
    const equalPriceIds = combined.filter((product: { price: { amountMinor: string } }) => product.price.amountMinor === '5000').map((product: { id: string }) => product.id);
    expect(equalPriceIds).toEqual([...equalPriceIds].sort());
    expect(combined.map((product: { id: string }) => product.id)).toHaveLength(3);

    const metadataSearch = await request(app).get(`/api/v2/catalog/products?q=${marker}-CERT`);
    expect(metadataSearch.status).toBe(200);
    expect(metadataSearch.body.data.map((product: { id: string }) => product.id)).toEqual([ids[0]]);
  });

  it('publishes facet counts and a money range without archived products', async () => {
    const response = await request(app).get('/api/v2/catalog/filters');

    expect(response.status).toBe(200);
    expect(response.body.meta).toEqual({});
    expect(response.body.data.totalProducts).toBeGreaterThanOrEqual(3);
    expect(response.body.data.pokemonTypes).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'FIRE', count: expect.any(Number) }),
      expect.objectContaining({ value: 'WATER', count: expect.any(Number) }),
    ]));
    expect(response.body.data.sets).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: `${marker} Set`, count: 2 }),
    ]));
    expect(BigInt(response.body.data.priceRange.minMinor)).toBeGreaterThan(1n);
    expect(BigInt(response.body.data.priceRange.maxMinor)).toBeGreaterThanOrEqual(5000n);
  });

  it('rejects contradictory or malformed price ranges', async () => {
    const contradictory = await request(app).get('/api/v2/catalog/products?minPriceMinor=5000&maxPriceMinor=1000');
    const malformed = await request(app).get('/api/v2/catalog/products?minPriceMinor=12.50');
    expect(contradictory.status).toBe(400);
    expect(contradictory.body.code).toBe('VALIDATION_ERROR');
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe('VALIDATION_ERROR');
  });
});

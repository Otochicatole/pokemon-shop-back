import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/infrastructure/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const fetchMock = vi.fn<typeof fetch>();
const image = 'https://img.pokemon-tcg.dev/tpci/30C/30C_023_R_EN_LG.png';

function card(overrides: Record<string, unknown> = {}) {
  return {
    id: 19395,
    set_code: 'SSP',
    set_name: 'Surging Sparks',
    region: 'int',
    number: '023',
    card_type: 'pokemon',
    types: ['Lightning'],
    rarity: 'Double rare',
    special: null,
    name: 'Pikachu',
    images: { xs: image, sm: image, lg: image, original: image },
    ...overrides,
  };
}

function price(overrides: Record<string, unknown> = {}) {
  return {
    source_id: 'tcgplayer',
    source_name: 'TCGplayer',
    currency: 'USD',
    variant: 'normal',
    price: 12.34,
    updated_at: '2026-10-12T12:00:00.000Z',
    ...overrides,
  };
}

function success(data: unknown, meta?: Record<string, unknown>) {
  return new Response(JSON.stringify({ status: 'success', data, ...(meta ? { meta } : {}) }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function page(data: unknown[], pageNumber = 1, total = data.length) {
  return success(data, { page: pageNumber, limit: 20, total, total_pages: Math.max(1, Math.ceil(total / 20)) });
}

async function adapter(apiKey: string | null = 'unit-test-api-key') {
  vi.doMock('../src/config/env.js', () => ({ env: { POKEMON_TCG_API_KEY: apiKey ?? undefined } }));
  return import('../src/modules/pokemon-tcg/pokemon-tcg.js');
}

function requestedUrl(call = 0) {
  const input = fetchMock.mock.calls[call]?.[0];
  if (!input) throw new Error('Expected an upstream request');
  return new URL(input instanceof Request ? input.url : String(input));
}

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock('../src/config/env.js');
});

describe('Pokémon TCG catalog adapter', () => {
  it('authenticates on the server and encodes search text without allowing query injection', async () => {
    fetchMock.mockResolvedValue(page([card()]));
    const api = await adapter();
    const query = 'Pikachu & include_prices=true # rare';
    const results = await api.searchCards(query);
    const url = requestedUrl();
    expect(url.origin).toBe('https://api.pokemon-tcg.dev');
    expect(url.pathname).toBe('/v1/cards');
    expect(url.searchParams.get('name')).toBe(query);
    expect(url.searchParams.get('lang')).toBe('en');
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('limit')).toBe('20');
    expect(url.searchParams.get('include_prices')).toBe('true');
    expect(url.hash).toBe('');
    const options = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer unit-test-api-key');
    expect(options?.redirect).toBe('error');
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.meta).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
    expect(results.data).toEqual([{
      id: '19395', name: 'Pikachu', localId: '023', setCode: 'SSP', setName: 'Surging Sparks',
      imageUrl: image, category: 'Pokemon', rarity: 'Double rare', types: ['Lightning'],
      firstEdition: false, holo: false, language: 'Inglés', region: 'int', special: null, marketPrice: null, prices: [],
    }]);
  });

  it('loads selected-card prices and maps market USD to integer cents', async () => {
    fetchMock.mockResolvedValue(success(card({ prices: [price()] })));
    const api = await adapter();
    const detail = await api.getCard('19395');
    const url = requestedUrl();
    expect(url.pathname).toBe('/v1/cards/19395');
    expect(url.searchParams.get('lang')).toBe('en');
    expect(url.searchParams.get('include_prices')).toBe('true');
    expect(detail).toMatchObject({
      id: '19395', name: 'Pikachu', localId: '023', setCode: 'SSP', setName: 'Surging Sparks',
      imageUrl: image, category: 'Pokemon', rarity: 'Double rare', types: ['Lightning'],
      language: 'Inglés',
      marketPrice: { amountMinor: '1234', currency: 'USD', source: 'TCGplayer', variant: 'normal', updatedAt: '2026-10-12T12:00:00.000Z' },
    });
  });

  it('includes complete metadata and every valid market quote in one search request', async () => {
    const usdPrice = price({ price: 1147.27, low_price: 699.97, high_price: 1999.99, variant: 'holofoil' });
    const eurPrice = price({ source_id: 'cardmarket', source_name: 'Cardmarket', currency: 'EUR', price: 63.23, variant: 'holo', updated_at: '2026-10-11 00:44:21' });
    fetchMock.mockResolvedValue(page([
      card({ special: 'ucex', prices: [eurPrice, usdPrice] }),
      card({ id: 19396, region: 'jp', special: 'Supporter', prices: [price({ variant: 'psa-10', price: 999 })] }),
    ]));
    const api = await adapter();
    const { data: results } = await api.searchCards('Rayquaza');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestedUrl().searchParams.get('include_prices')).toBe('true');
    expect(results[0]).toMatchObject({
      language: 'Inglés', region: 'int', special: 'ucex',
      marketPrice: { currency: 'USD', amountMinor: '114727', variant: 'holofoil' },
      prices: [
        { source: 'Cardmarket', currency: 'EUR', variant: 'holo', amountMinor: '6323', lowAmountMinor: null, highAmountMinor: null, updatedAt: '2026-10-11T00:44:21.000Z' },
        { source: 'TCGplayer', currency: 'USD', variant: 'holofoil', amountMinor: '114727', lowAmountMinor: '69997', highAmountMinor: '199999', updatedAt: '2026-10-12T12:00:00.000Z' },
      ],
    });
    expect(results[0]?.prices.every((value) => !('sourceId' in value))).toBe(true);
    expect(results[1]).toMatchObject({ language: 'Japonés', region: 'jp', special: 'Supporter', marketPrice: null, prices: [{ variant: 'psa-10', amountMinor: '99900' }] });
  });

  it('uses the same price and metadata mapping for results and the selected card', async () => {
    const providerCard = card({ special: 'ex', prices: [price({ price: 1.005, low_price: 1.004, high_price: 1.015, updated_at: '2026-10-12T09:00:00-03:00' })] });
    fetchMock.mockResolvedValueOnce(page([providerCard])).mockResolvedValueOnce(success(providerCard));
    const api = await adapter();
    const { data: [result] } = await api.searchCards('Pikachu');
    const detail = await api.getCard('19395');
    expect(detail).toEqual({ ...result, description: '', effect: '' });
    expect(detail.prices).toEqual([{
      source: 'TCGplayer', currency: 'USD', variant: 'normal', amountMinor: '101', lowAmountMinor: '100', highAmountMinor: '102', updatedAt: '2026-10-12T12:00:00.000Z',
    }]);
  });

  it('omits malformed quotes and keeps a valid price when its optional range is unusable', async () => {
    fetchMock.mockResolvedValue(page([card({ prices: [
      price({ price: 0 }), price({ price: -1 }), price({ price: '12.34' }),
      price({ updated_at: 'not-a-date' }), price({ currency: 'ZZZ' }), price({ currency: 'JPY' }), price({ currency: 'DOLLARS' }),
      price({ source_name: ' ' }), price({ variant: ' ' }),
      price({ currency: ' eur ', variant: ' Reverse_Holofoil ', low_price: -1, high_price: '40', updated_at: '2026-10-12T12:00:00' }),
    ] })]));
    const api = await adapter();
    const { data: [result] } = await api.searchCards('Pikachu');
    expect(result?.marketPrice).toBeNull();
    expect(result?.prices).toEqual([{
      source: 'TCGplayer', currency: 'EUR', variant: 'reverse-holofoil', amountMinor: '1234', lowAmountMinor: null, highAmountMinor: null, updatedAt: '2026-10-12T12:00:00.000Z',
    }]);
  });

  it('preserves the provider rarity, elemental types and identical set code/name in search and detail', async () => {
    const providerCard = card({
      id: 248, name: 'Pikachu ex', set_code: '30C', set_name: '30C',
      types: ['Lightning'], rarity: 'Special illustration rare',
    });
    fetchMock.mockResolvedValueOnce(page([providerCard])).mockResolvedValueOnce(success(providerCard));
    const api = await adapter();
    const { data: [result] } = await api.searchCards('Pikachu ex');
    const detail = await api.getCard('248');
    const metadata = {
      id: '248', name: 'Pikachu ex', setCode: '30C', setName: '30C',
      types: ['Lightning'], rarity: 'Special illustration rare',
    };
    expect(result).toMatchObject(metadata);
    expect(detail).toMatchObject(metadata);
  });

  it('retains all elemental types without substituting the card category', async () => {
    fetchMock.mockResolvedValue(success(card({ types: ['Water', 'Darkness'], rarity: 'Rare Holo' })));
    const api = await adapter();
    expect(await api.getCard('19395')).toMatchObject({
      category: 'Pokemon', types: ['Water', 'Darkness'], rarity: 'Rare Holo',
    });
  });

  it.each([
    { types: [], rarity: null },
    { types: undefined, rarity: undefined },
  ])('keeps search and detail usable when elemental and rarity metadata are missing: %j', async (metadata) => {
    const providerCard = card({ ...metadata, card_type: 'trainer' });
    fetchMock.mockResolvedValueOnce(page([providerCard])).mockResolvedValueOnce(success(providerCard));
    const api = await adapter();
    expect((await api.searchCards('Pikachu')).data).toEqual([expect.objectContaining({ category: 'Trainer', types: [], rarity: '' })]);
    expect(await api.getCard('19395')).toMatchObject({ category: 'Trainer', types: [], rarity: '', marketPrice: null });
  });

  it('preserves the literal None rarity supplied by the provider', async () => {
    const providerCard = card({ card_type: 'energy', types: ['Fire'], rarity: 'None' });
    fetchMock.mockResolvedValueOnce(page([providerCard])).mockResolvedValueOnce(success(providerCard));
    const api = await adapter();
    expect((await api.searchCards('Energy')).data).toEqual([expect.objectContaining({ category: 'Energy', types: ['Fire'], rarity: 'None' })]);
    expect(await api.getCard('19395')).toMatchObject({ category: 'Energy', types: ['Fire'], rarity: 'None' });
  });

  it('prefers normal variants and TCGplayer among equivalent ungraded prices', async () => {
    fetchMock.mockResolvedValue(success(card({ prices: [
      price({ variant: 'holofoil', price: 80 }),
      price({ source_id: 'another', source_name: 'Other market', price: 14 }),
      price({ price: 12.34 }),
    ] })));
    const api = await adapter();
    expect((await api.getCard('19395')).marketPrice).toMatchObject({ amountMinor: '1234', source: 'TCGplayer', variant: 'normal' });
  });

  it('uses an available ungraded holo variant when no normal price exists', async () => {
    fetchMock.mockResolvedValue(success(card({ prices: [price({ variant: 'holofoil', price: 10.25 })] })));
    const api = await adapter();
    expect((await api.getCard('19395')).marketPrice).toMatchObject({ amountMinor: '1025', currency: 'USD', variant: 'holofoil' });
  });

  it('never treats EUR or graded prices as an ordinary USD sale price', async () => {
    fetchMock.mockResolvedValue(success(card({ prices: [
      price({ currency: 'EUR', price: 99 }),
      price({ variant: 'psa-10', price: 999 }),
      price({ variant: 'graded', price: 250 }),
    ] })));
    const api = await adapter();
    expect((await api.getCard('19395')).marketPrice).toBeNull();
  });

  it('rounds provider decimal prices to cents without floating-point truncation', async () => {
    fetchMock.mockResolvedValue(success(card({ prices: [price({ price: 1.005 })] })));
    const api = await adapter();
    expect((await api.getCard('19395')).marketPrice?.amountMinor).toBe('101');
  });

  it('keeps incomplete card metadata and missing prices usable for manual completion', async () => {
    fetchMock.mockResolvedValue(success(card({ region: 'jp', images: null })));
    const api = await adapter();
    expect(await api.getCard('19395')).toMatchObject({ imageUrl: null, marketPrice: null, language: 'Japonés' });
  });

  it('rejects deceptive remote image hosts while allowing an official fallback', async () => {
    fetchMock.mockResolvedValue(page([
      card({ images: { lg: 'https://img.pokemon-tcg.dev.attacker.test/card.png', original: image } }),
      card({ id: 19396, images: { lg: 'https://img.pokemon-tcg.dev@attacker.test/card.png' } }),
      card({ id: 19397, images: { lg: 'http://img.pokemon-tcg.dev/card.png' } }),
    ]));
    const api = await adapter();
    expect((await api.searchCards('Pikachu')).data.map((value) => value.imageUrl)).toEqual([image, null, null]);
  });

  it('shares an in-flight search and caches repeated queries for five minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-12T12:00:00.000Z'));
    let resolveResponse!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveResponse = resolve; }));
    const api = await adapter();
    const first = api.searchCards('Pikachu');
    const concurrent = api.searchCards('Pikachu');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    resolveResponse(page([card()]));
    expect(await first).toEqual(await concurrent);
    await api.searchCards('Pikachu');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-10-12T12:05:01.000Z'));
    fetchMock.mockResolvedValueOnce(page([card()]));
    await api.searchCards('Pikachu');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caches selected card details separately from search summaries', async () => {
    fetchMock.mockResolvedValueOnce(page([card()])).mockResolvedValueOnce(success(card({ prices: [price()] })));
    const api = await adapter();
    await api.searchCards('Pikachu');
    const detail = await api.getCard('19395');
    expect((await api.getCard('19395')).marketPrice).toEqual(detail.marketPrice);
    expect(detail.marketPrice?.amountMinor).toBe('1234');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('maps the official set codes and keeps a cached list', async () => {
    fetchMock.mockResolvedValue(page([
      { code: 'SSP', name: 'Surging Sparks', region: 'int', total_cards: 250 },
      { code: '30C', name: '30C', region: 'int', total_cards: 200 },
    ]));
    const api = await adapter();
    const expected = [{ id: '30C', name: '30C' }, { id: 'SSP', name: 'Surging Sparks' }];
    expect(await api.listSets()).toEqual(expected);
    expect(await api.listSets()).toEqual(expected);
    expect(requestedUrl().pathname).toBe('/v1/sets');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('requests and caches each page independently without loading other pages', async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => card({ id: index + 1 }));
    const secondPage = Array.from({ length: 20 }, (_, index) => card({ id: index + 21 }));
    fetchMock.mockResolvedValueOnce(page(firstPage, 1, 61)).mockResolvedValueOnce(page(secondPage, 2, 61));
    const api = await adapter();
    const first = await api.searchCards('Rayquaza');
    const second = await api.searchCards('Rayquaza', 2);
    expect(first.meta).toEqual({ page: 1, limit: 20, total: 61, totalPages: 4 });
    expect(second.meta).toEqual({ page: 2, limit: 20, total: 61, totalPages: 4 });
    expect(first.data[0]?.id).toBe('1');
    expect(second.data[0]?.id).toBe('21');
    expect(requestedUrl(1).searchParams.get('page')).toBe('2');
    expect(requestedUrl(1).searchParams.get('include_prices')).toBe('true');
    expect(await api.searchCards('Rayquaza', 1)).toEqual(first);
    expect(await api.searchCards('Rayquaza', 2)).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent requests only when both search and page match', async () => {
    const resolveResponses = new Map<string, (response: Response) => void>();
    fetchMock.mockImplementation((input) => new Promise<Response>((resolve) => {
      const url = new URL(String(input));
      resolveResponses.set(url.searchParams.get('page')!, resolve);
    }));
    const api = await adapter();
    const pageOne = api.searchCards('Rayquaza', 1);
    const pageTwo = api.searchCards('Rayquaza', 2);
    const duplicatePageTwo = api.searchCards('Rayquaza', 2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolveResponses.get('1')!(page([card({ id: 1 })], 1, 21));
    resolveResponses.get('2')!(page([card({ id: 2 })], 2, 21));
    expect((await pageOne).data[0]?.id).toBe('1');
    expect(await pageTwo).toEqual(await duplicatePageTwo);
    expect((await pageTwo).data[0]?.id).toBe('2');
  });

  it('returns the final partial page with the provider total instead of the page length', async () => {
    fetchMock.mockResolvedValue(page([card({ id: 13477 })], 4, 61));
    const api = await adapter();
    const result = await api.searchCards('Rayquaza', 4);
    expect(result.data).toHaveLength(1);
    expect(result.meta).toEqual({ page: 4, limit: 20, total: 61, totalPages: 4 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1])('retains an empty provider result with total_pages %i', async (totalPages) => {
    fetchMock.mockResolvedValue(success([], { page: 1, limit: 20, total: 0, total_pages: totalPages }));
    const api = await adapter();
    expect(await api.searchCards('No matching card')).toEqual({ data: [], meta: { page: 1, limit: 20, total: 0, totalPages } });
  });

  it('retains metadata when a requested page is beyond the last result', async () => {
    fetchMock.mockResolvedValue(page([], 5, 61));
    const api = await adapter();
    expect(await api.searchCards('Rayquaza', 5)).toEqual({ data: [], meta: { page: 5, limit: 20, total: 61, totalPages: 4 } });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('rejects invalid page %s before calling the provider', async (pageNumber) => {
    const api = await adapter();
    await expect(api.searchCards('Pikachu', pageNumber)).rejects.toMatchObject({ status: 400, code: 'POKEMON_TCG_PAGE_INVALID' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { page: 1, limit: 20, total: 1 },
    { page: 1, limit: 20, total: '1', total_pages: 1 },
    { page: 1, limit: 20, total: -1, total_pages: 1 },
    { page: 1, limit: 20, total: 1, total_pages: 0 },
    { page: 1, limit: 20, total: 1, total_pages: 1.5 },
    { page: 1, limit: 20, total: Number.MAX_SAFE_INTEGER + 1, total_pages: 1 },
    { page: 1, limit: 100, total: 1, total_pages: 1 },
    { page: 2, limit: 20, total: 61, total_pages: 4 },
  ])('rejects malformed or mismatched pagination without exposing provider data: %j', async (meta) => {
    fetchMock.mockResolvedValueOnce(success([card()], meta)).mockResolvedValueOnce(page([card()]));
    const api = await adapter();
    await expect(api.searchCards('Pikachu')).rejects.toMatchObject({ status: 502, code: 'POKEMON_TCG_UNAVAILABLE' });
    expect((await api.searchCards('Pikachu')).meta.total).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('provides manual rarity choices without calling a nonexistent upstream endpoint', async () => {
    const api = await adapter();
    const rarities = await api.listRarities();
    expect(rarities.length).toBeGreaterThan(0);
    expect(rarities.every((rarity) => typeof rarity === 'string' && rarity.trim().length > 0)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails clearly when the key is missing and never attempts an unauthenticated request', async () => {
    const api = await adapter(null);
    await expect(api.searchCards('Pikachu')).rejects.toMatchObject({ status: 503, code: 'POKEMON_TCG_NOT_CONFIGURED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 403])('maps upstream authentication failure %i without returning provider response content', async (status) => {
    fetchMock.mockResolvedValue(new Response('private upstream diagnostic', { status }));
    const api = await adapter();
    await expect(api.searchCards('Pikachu')).rejects.toMatchObject({ status: 502, code: 'POKEMON_TCG_AUTH_FAILED' });
    await expect(api.searchCards('Other card')).rejects.not.toThrow('private upstream diagnostic');
  });

  it.each(['../sets', '19395?include_prices=false', 'https://attacker.test', '0', '-1'])('rejects invalid card identifiers before making a request: %s', async (id) => {
    const api = await adapter();
    await expect(api.getCard(id)).rejects.toMatchObject({ status: 400, code: 'POKEMON_TCG_ID_INVALID' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('honors a rate-limit cooldown and resumes once Retry-After expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-12T12:00:00.000Z'));
    fetchMock.mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '30' } }));
    const api = await adapter();
    await expect(api.searchCards('Pikachu')).rejects.toMatchObject({ status: 503, code: 'POKEMON_TCG_RATE_LIMITED' });
    await expect(api.searchCards('Charizard')).rejects.toMatchObject({ status: 503, code: 'POKEMON_TCG_RATE_LIMITED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-10-12T12:00:31.000Z'));
    fetchMock.mockResolvedValueOnce(page([card()]));
    expect((await api.searchCards('Pikachu')).data).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('turns timeout failures into a controlled error and allows a later retry', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('Upstream timed out', 'TimeoutError')).mockResolvedValueOnce(page([card()]));
    const api = await adapter();
    await expect(api.searchCards('Pikachu')).rejects.toMatchObject({ status: 502, code: 'POKEMON_TCG_UNAVAILABLE' });
    expect((await api.searchCards('Pikachu')).data).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { status: 'success', data: { id: 'not-a-list' } },
    { status: 'success', data: [{ id: 10 }] },
    { status: 'error', data: [card()] },
  ])('rejects malformed provider envelopes instead of silently supplying corrupt card data', async (body) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } }));
    const api = await adapter();
    await expect(api.searchCards('Pikachu')).rejects.toMatchObject({ status: 502, code: 'POKEMON_TCG_UNAVAILABLE' });
  });
});

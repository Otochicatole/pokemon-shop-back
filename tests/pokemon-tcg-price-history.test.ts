import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pokemonTcgPriceHistoryEnvelopeSchema } from '../src/modules/pokemon-tcg/schemas.js';

const fetchMock = vi.fn<typeof fetch>();

function observation(overrides: Record<string, unknown> = {}) {
  return {
    source_id: 'tcgplayer', source_name: 'TCGPlayer', currency: 'USD', variant: 'holofoil',
    price: 109.28, recorded_at: '2026-10-06', observed_at: null,
    ...overrides,
  };
}

function response(data: unknown[] = [observation()], cardId = 15618) {
  return new Response(JSON.stringify({ status: 'success', card_id: cardId, data }), { status: 200 });
}

async function adapter() {
  vi.doMock('../src/config/env.js', () => ({ env: { POKEMON_TCG_API_KEY: 'unit-test-api-key' } }));
  return import('../src/modules/pokemon-tcg/pokemon-tcg.js');
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

describe('Pokémon TCG recorded price history', () => {
  it('loads only the authenticated history endpoint and preserves currencies, dates and variant series', async () => {
    fetchMock.mockResolvedValue(response([
      observation({ source_id: 'cardmarket', source_name: 'Cardmarket', currency: 'EUR', variant: 'holo', price: 41.79, recorded_at: '2026-10-11', observed_at: '2026-10-11T00:44:21Z' }),
      observation({ variant: 'reverse_holofoil', price: 72.31, recorded_at: '2026-10-10', observed_at: '2026-10-10T17:06:02-03:00' }),
      observation(),
      observation({ price: 17.99, recorded_at: '2022-12-09', observed_at: undefined }),
    ]));
    const api = await adapter();
    const history = await api.getCardPriceHistory('15618');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.pokemon-tcg.dev/v1/cards/15618/prices/history');
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe('Bearer unit-test-api-key');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
    expect(history).toEqual({
      cardId: '15618', prices: [
        { sourceId: 'tcgplayer', source: 'TCGPlayer', currency: 'USD', variant: 'holofoil', amountMinor: '1799', recordedAt: '2022-12-09', observedAt: null },
        { sourceId: 'tcgplayer', source: 'TCGPlayer', currency: 'USD', variant: 'holofoil', amountMinor: '10928', recordedAt: '2026-10-06', observedAt: null },
        { sourceId: 'tcgplayer', source: 'TCGPlayer', currency: 'USD', variant: 'reverse-holofoil', amountMinor: '7231', recordedAt: '2026-10-10', observedAt: '2026-10-10T20:06:02.000Z' },
        { sourceId: 'cardmarket', source: 'Cardmarket', currency: 'EUR', variant: 'holo', amountMinor: '4179', recordedAt: '2026-10-11', observedAt: '2026-10-11T00:44:21.000Z' },
      ],
    });
    expect(pokemonTcgPriceHistoryEnvelopeSchema.parse({ data: history })).toEqual({ data: history });
  });

  it('keeps absent history empty without creating prices or querying card details', async () => {
    fetchMock.mockResolvedValue(response([]));
    const api = await adapter();
    expect(await api.getCardPriceHistory('15618')).toEqual({ cardId: '15618', prices: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('omits invalid amounts, currencies and impossible recorded dates without discarding valid observations', async () => {
    fetchMock.mockResolvedValue(response([
      observation({ price: 0 }), observation({ price: -1 }), observation({ price: '100' }),
      observation({ price: Number.MAX_SAFE_INTEGER }), observation({ currency: 'ZZZ' }),
      observation({ currency: 'JPY' }), observation({ currency: undefined }),
      observation({ recorded_at: '2026-02-30' }), observation({ recorded_at: 'not-a-date' }),
      observation({ source_id: '' }), observation({ variant: ' ' }),
      observation({ source_name: undefined, currency: ' usd ', price: 1.005, observed_at: 'invalid timestamp' }),
    ]));
    const api = await adapter();
    expect((await api.getCardPriceHistory('15618')).prices).toEqual([
      { sourceId: 'tcgplayer', source: 'tcgplayer', currency: 'USD', variant: 'holofoil', amountMinor: '101', recordedAt: '2026-10-06', observedAt: null },
    ]);
  });

  it('retains multiple actual observations on the same date and orders them by their observation time', async () => {
    fetchMock.mockResolvedValue(response([
      observation({ price: 14, observed_at: '2026-10-06T18:00:00Z' }),
      observation({ price: 12, observed_at: '2026-10-06T09:00:00Z' }),
    ]));
    const api = await adapter();
    expect((await api.getCardPriceHistory('15618')).prices.map((item) => item.amountMinor)).toEqual(['1200', '1400']);
  });

  it('shares in-flight requests, caches each card independently and refreshes after five minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
    let resolve!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((complete) => { resolve = complete; }));
    const api = await adapter();
    const first = api.getCardPriceHistory('15618');
    const concurrent = api.getCardPriceHistory('15618');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolve(response());
    expect(await first).toEqual(await concurrent);
    expect(await api.getCardPriceHistory('15618')).toEqual(await first);
    fetchMock.mockResolvedValueOnce(response([], 1));
    expect(await api.getCardPriceHistory('1')).toEqual({ cardId: '1', prices: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date('2026-10-13T12:05:01Z'));
    fetchMock.mockResolvedValueOnce(response([observation({ price: 120 })]));
    expect((await api.getCardPriceHistory('15618')).prices[0]?.amountMinor).toBe('12000');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(['../sets', '15618?source=other', 'https://attacker.test', '0', '-1', '01', '1.2', '111111111111111111111'])('rejects invalid card ID %s before requesting history', async (id) => {
    const api = await adapter();
    await expect(api.getCardPriceHistory(id)).rejects.toMatchObject({ status: 400, code: 'POKEMON_TCG_ID_INVALID' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'success', card_id: 1, data: [] },
    { status: 'success', card_id: '15618', data: [] },
    { status: 'success', card_id: 15618, data: {} },
    { status: 'error', card_id: 15618, data: [] },
  ])('rejects malformed or mismatched provider envelopes and allows a subsequent retry', async (body) => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body))).mockResolvedValueOnce(response());
    const api = await adapter();
    await expect(api.getCardPriceHistory('15618')).rejects.toMatchObject({ status: 502, code: 'POKEMON_TCG_UNAVAILABLE' });
    expect((await api.getCardPriceHistory('15618')).prices).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps provider failures separate from an empty successful history', async () => {
    fetchMock.mockResolvedValueOnce(new Response('private provider information', { status: 500 }));
    const api = await adapter();
    await expect(api.getCardPriceHistory('15618')).rejects.toMatchObject({ status: 502, code: 'POKEMON_TCG_UNAVAILABLE' });
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    await expect(api.getCardPriceHistory('15618')).rejects.toMatchObject({ status: 404 });
  });
});

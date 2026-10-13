import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadPokemonTcgImage } from '../src/modules/pokemon-tcg/images.js';

const imageUrl = 'https://img.pokemon-tcg.dev/tpci/30C/30C_023_R_EN_LG.png';

afterEach(() => vi.unstubAllGlobals());

describe('Pokémon TCG image import', () => {
  it.each([
    'http://img.pokemon-tcg.dev/card.png',
    'https://img.pokemon-tcg.dev:8443/card.png',
    'https://user:secret@img.pokemon-tcg.dev/card.png',
    'https://img.pokemon-tcg.dev.evil.example/card.png',
    'https://img.pokemon-tcg.dev@127.0.0.1/card.png',
    'https://assets.tcgdex.net/en/base/base1/1/high.webp',
    'https://127.0.0.1/card.png',
    'file:///card.png',
    'invalid-url',
  ])('rejects disallowed URL %s before making a request', async (url) => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(downloadPokemonTcgImage(url)).rejects.toMatchObject({ status: 400, code: 'POKEMON_TCG_IMAGE_URL_INVALID' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp']])('preserves %s and derives its matching extension', async (contentType, extension) => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetcher = vi.fn().mockResolvedValue(new Response(bytes, { headers: { 'content-type': `${contentType}; charset=binary` } }));
    vi.stubGlobal('fetch', fetcher);
    const file = await downloadPokemonTcgImage(imageUrl);
    expect(file).toMatchObject({ mimetype: contentType, originalname: `pokemon-tcg-card.${extension}`, size: 3, buffer: Buffer.from(bytes) });
    expect(fetcher).toHaveBeenCalledWith(imageUrl, { redirect: 'error', signal: expect.any(AbortSignal) });
  });

  it('rejects failed downloads and redirects without exposing upstream errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('upstream details')));
    await expect(downloadPokemonTcgImage(imageUrl)).rejects.toMatchObject({ status: 502, code: 'POKEMON_TCG_IMAGE_UNAVAILABLE' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } })));
    await expect(downloadPokemonTcgImage(imageUrl)).rejects.toMatchObject({ status: 502, code: 'POKEMON_TCG_IMAGE_UNAVAILABLE' });
  });

  it('rejects unsupported and empty image bodies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } })));
    await expect(downloadPokemonTcgImage(imageUrl)).rejects.toMatchObject({ code: 'POKEMON_TCG_IMAGE_INVALID' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { headers: { 'content-type': 'image/png' } })));
    await expect(downloadPokemonTcgImage(imageUrl)).rejects.toMatchObject({ code: 'POKEMON_TCG_IMAGE_INVALID' });
  });

  it('cancels oversized downloads declared by the server without reading them', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ cancel });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { headers: { 'content-type': 'image/png', 'content-length': String(10 * 1024 * 1024 + 1) } })));
    await expect(downloadPokemonTcgImage(imageUrl)).rejects.toMatchObject({ code: 'POKEMON_TCG_IMAGE_TOO_LARGE' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([undefined, '1'])('limits streamed bytes even when content-length is %s', async (declaredLength) => {
    const cancel = vi.fn();
    let pulls = 0;
    const stream = new ReadableStream({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { headers: { 'content-type': 'image/png', ...(declaredLength ? { 'content-length': declaredLength } : {}) } })));
    await expect(downloadPokemonTcgImage(imageUrl)).rejects.toMatchObject({ code: 'POKEMON_TCG_IMAGE_TOO_LARGE' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(pulls).toBeLessThanOrEqual(12);
  });

  it('normalizes stream failures into a provider error', async () => {
    const stream = new ReadableStream({ pull(controller) { controller.error(new Error('connection reset')); } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, { headers: { 'content-type': 'image/png' } })));
    await expect(downloadPokemonTcgImage(imageUrl)).rejects.toMatchObject({ status: 502, code: 'POKEMON_TCG_IMAGE_UNAVAILABLE' });
  });
});

import { Readable } from 'node:stream';
import { AppError, badRequest } from '../../shared/errors.js';

const maximumImageBytes = 10 * 1024 * 1024;
const imageExtensions = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

function imageUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw badRequest('POKEMON_TCG_IMAGE_URL_INVALID', 'La imagen de Pokémon TCG no es válida');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'img.pokemon-tcg.dev' || parsed.port || parsed.username || parsed.password) {
    throw badRequest('POKEMON_TCG_IMAGE_URL_INVALID', 'Solo se admiten imágenes de img.pokemon-tcg.dev mediante HTTPS');
  }
  return parsed.toString();
}

/** Downloads public CDN assets without forwarding the private Pokémon TCG API key. */
export async function downloadPokemonTcgImage(value: string): Promise<Express.Multer.File> {
  const url = imageUrl(value);
  let response: Response;
  try {
    response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new AppError(502, 'POKEMON_TCG_IMAGE_UNAVAILABLE', 'No se pudo descargar la imagen de Pokémon TCG');
  }
  const cancelBody = () => response.body?.cancel().catch(() => undefined);
  if (!response.ok) {
    await cancelBody();
    throw new AppError(502, 'POKEMON_TCG_IMAGE_UNAVAILABLE', 'No se pudo descargar la imagen de Pokémon TCG');
  }
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const extension = imageExtensions.get(contentType);
  if (!extension || !response.body) {
    await cancelBody();
    throw badRequest('POKEMON_TCG_IMAGE_INVALID', 'La imagen de Pokémon TCG no tiene un formato admitido');
  }
  if (Number(response.headers.get('content-length') ?? 0) > maximumImageBytes) {
    await cancelBody();
    throw badRequest('POKEMON_TCG_IMAGE_TOO_LARGE', 'La imagen de Pokémon TCG supera el límite permitido');
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximumImageBytes) {
        await reader.cancel().catch(() => undefined);
        throw badRequest('POKEMON_TCG_IMAGE_TOO_LARGE', 'La imagen de Pokémon TCG supera el límite permitido');
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    await reader.cancel().catch(() => undefined);
    throw new AppError(502, 'POKEMON_TCG_IMAGE_UNAVAILABLE', 'No se pudo descargar la imagen de Pokémon TCG');
  } finally {
    reader.releaseLock();
  }
  if (!size) throw badRequest('POKEMON_TCG_IMAGE_INVALID', 'La imagen de Pokémon TCG está vacía');
  const buffer = Buffer.concat(chunks, size);
  const filename = `pokemon-tcg-card.${extension}`;
  return {
    fieldname: 'image', originalname: filename, encoding: '7bit', mimetype: contentType,
    destination: '', filename, path: '', size, buffer, stream: Readable.from(buffer),
  };
}

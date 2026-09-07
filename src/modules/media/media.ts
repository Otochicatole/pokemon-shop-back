import { Router } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Express, Request } from 'express';
import type { PrismaClient } from '@prisma/client';
import { env } from '../../config/env.js';
import { currentAdmin, currentUser } from '../../infrastructure/sessions.js';
import { notFound, forbidden, badRequest } from '../../shared/errors.js';

const root = path.resolve(env.STORAGE_ROOT);
const allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);

export async function ensureStorage() {
  await Promise.all([mkdir(path.join(root, 'db'), { recursive: true }), mkdir(path.join(root, 'public'), { recursive: true }), mkdir(path.join(root, 'private'), { recursive: true }), mkdir(path.join(root, 'tmp'), { recursive: true })]);
}

export async function saveImage(prisma: PrismaClient, file: Express.Multer.File, visibility: 'PUBLIC' | 'PRIVATE', folder: 'products' | 'receipts') {
  if (!file || !allowed.has(file.mimetype)) throw badRequest('INVALID_FILE_TYPE', 'Only JPEG, PNG and WebP images are accepted');
  if (folder === 'receipts' && file.size > 5 * 1024 * 1024) throw badRequest('FILE_TOO_LARGE', 'Transfer receipts are limited to 5 MB');
  const image = sharp(file.buffer, { limitInputPixels: 40_000_000 });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height || metadata.width > 8000 || metadata.height > 8000) throw badRequest('INVALID_IMAGE_DIMENSIONS', 'Image dimensions are not allowed');
  const output = await image.rotate().webp({ quality: 84 }).toBuffer();
  const fileId = randomUUID();
  const storageKey = `${visibility === 'PUBLIC' ? 'public' : 'private'}/${folder}/${fileId}.webp`;
  const absolute = safePath(storageKey);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, output, { flag: 'wx' });
  try {
    return await prisma.storedFile.create({ data: { id: fileId, storageKey, originalName: file.originalname?.slice(0, 255), mimeType: 'image/webp', sizeBytes: output.byteLength, sha256: createHash('sha256').update(output).digest('hex'), visibility } });
  } catch (error) {
    await unlink(absolute).catch(() => undefined);
    throw error;
  }
}

function safePath(storageKey: string): string {
  const absolute = path.resolve(root, storageKey);
  const prefix = `${root}${path.sep}`;
  if (!absolute.startsWith(prefix)) throw new Error('Unsafe storage path');
  return absolute;
}

export function createMediaRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.get('/public/:fileId', async (req, res) => {
    const file = await prisma.storedFile.findUnique({ where: { id: String(req.params.fileId) } });
    if (!file || file.visibility !== 'PUBLIC') throw notFound('Media not found');
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Length', file.sizeBytes);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.sendFile(safePath(file.storageKey));
  });
  router.get('/private/:fileId', async (req: Request, res) => {
    const file: any = await prisma.storedFile.findUnique({ where: { id: String(req.params.fileId) }, include: { transferReceipt: { include: { order: true } } } });
    if (!file || file.visibility !== 'PRIVATE') throw notFound('Media not found');
    const admin = currentAdmin(req);
    const user = currentUser(req);
    if (!admin && (!user || file.transferReceipt?.order.userId !== user.userId)) throw forbidden();
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.sendFile(safePath(file.storageKey));
  });
  return router;
}

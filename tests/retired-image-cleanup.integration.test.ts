import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { access, mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../src/config/env.js';
import { prisma, writeCoordinator } from '../src/infrastructure/prisma.js';
import { createAdminCmsApplication, createPrismaAdminCmsRepositories } from '../src/modules/backoffice/index.js';
import { createRetiredImageCleanup } from '../src/modules/media/index.js';
import { LocalRetiredImageQuarantine } from '../src/modules/media/infrastructure/local-retired-image-quarantine.js';

const fixture = randomUUID();
const adminId = randomUUID();
const userId = randomUUID();
const productIds = [randomUUID(), randomUUID()];
const fileIds = [randomUUID(), randomUUID()];
const storageKeys = fileIds.map((id) => `public/products/${id}.webp`);
const root = path.resolve(env.STORAGE_ROOT);
const originals = storageKeys.map((key) => path.resolve(root, key));
const quarantines = fileIds.map((id) => path.join(root, 'tmp', 'quarantine', 'retired-product-images', `${id}.webp`));
const orderId = randomUUID();

const cms = createAdminCmsApplication(createPrismaAdminCmsRepositories(prisma, writeCoordinator), {
  integrations: { bankTransfer: false, mercadoPago: false, smtp: false },
});

describe('durable retired product image cleanup', () => {
  beforeAll(async () => {
    await prisma.admin.create({ data: { id: adminId, email: `cleanup-${fixture}@example.test`, passwordHash: 'not-used', totpSecretCipher: 'not-used', totpEnabledAt: new Date() } });
    await prisma.user.create({ data: { id: userId, email: `cleanup-user-${fixture}@example.test`, emailVerifiedAt: new Date() } });
    for (const original of originals) {
      await mkdir(path.dirname(original), { recursive: true });
      await writeFile(original, 'safe-cleanup-fixture', { flag: 'wx' });
    }
    for (const [index, productId] of productIds.entries()) {
      const fileId = fileIds[index]!;
      await prisma.product.create({
        data: {
          id: productId,
          sku: `CLEAN-${index}-${fixture}`,
          slug: `clean-${index}-${fixture}`,
          name: `Cleanup ${index}`,
          description: 'Cleanup fixture',
          kind: 'ACCESSORY',
          stockMode: 'QUANTITY',
          priceMinor: 100n,
          images: {
            create: {
              file: {
                create: {
                  id: fileId,
                  storageKey: storageKeys[index]!,
                  mimeType: 'image/webp',
                  sizeBytes: 20,
                  sha256: String(index + 7).repeat(64),
                  visibility: 'PUBLIC',
                },
              },
              sortOrder: 0,
              createdBy: { connect: { id: adminId } },
            },
          },
        },
      });
    }
    await prisma.order.create({
      data: {
        id: orderId,
        userId,
        number: `BCS-CLEAN-${fixture}`,
        paymentMethod: 'BANK_TRANSFER',
        fulfillmentType: 'PICKUP',
        subtotalMinor: 100n,
        shippingMinor: 0n,
        totalMinor: 100n,
        idempotencyKey: fixture,
        idempotencyHash: fixture,
        items: {
          create: {
            productId: productIds[1]!,
            sku: `CLEAN-1-${fixture}`,
            productName: 'Retained snapshot',
            productSnapshot: '{}',
            imageFileId: fileIds[1]!,
            unitPriceMinor: 100n,
            quantity: 1,
            lineTotalMinor: 100n,
          },
        },
      },
    });
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { id: orderId } });
    await prisma.fileCleanupJob.deleteMany({ where: { fileId: { in: fileIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.storedFile.deleteMany({ where: { id: { in: fileIds } } });
    await prisma.auditLog.deleteMany({ where: { actorId: adminId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.admin.deleteMany({ where: { id: adminId } });
    await Promise.all([...originals, ...quarantines].map((file) => unlink(file).catch(() => undefined)));
  });

  it('purges unreferenced media and permanently retains order snapshots', async () => {
    const actor = { adminId, requestId: `cleanup-${fixture}` };
    const images = await prisma.productImage.findMany({ where: { productId: { in: productIds } }, orderBy: { productId: 'asc' } });
    for (const [index, productId] of productIds.entries()) {
      const image = images.find((entry) => entry.productId === productId)!;
      await cms.products.retireImage(actor, productId, image.id, 1);
    }
    await prisma.fileCleanupJob.updateMany({ where: { fileId: { in: fileIds } }, data: { availableAt: new Date(0) } });

    const cleanup = createRetiredImageCleanup(prisma, writeCoordinator, env.STORAGE_ROOT);
    const result = await cleanup.execute({ limit: 10, now: new Date() });
    expect(result).toEqual({ claimed: 2, completed: 1, retained: 1, failed: 0 });

    expect(await prisma.storedFile.findUnique({ where: { id: fileIds[0]! } })).toBeNull();
    expect(await prisma.productImage.findUnique({ where: { fileId: fileIds[0]! } })).toBeNull();
    await expect(access(originals[0]!)).rejects.toThrow();
    await expect(access(quarantines[0]!)).rejects.toThrow();

    expect(await prisma.storedFile.findUnique({ where: { id: fileIds[1]! } })).not.toBeNull();
    expect(await prisma.productImage.findUnique({ where: { fileId: fileIds[1]! } })).toEqual(expect.objectContaining({ retiredAt: expect.any(Date) }));
    await expect(access(originals[1]!)).resolves.toBeUndefined();
    expect((await prisma.fileCleanupJob.findUniqueOrThrow({ where: { fileId: fileIds[1]! } })).status).toBe('RETAINED');
  });

  it('rejects unsafe quarantine identifiers before touching the filesystem', async () => {
    const quarantine = new LocalRetiredImageQuarantine(env.STORAGE_ROOT);
    await expect(quarantine.quarantine({
      jobId: randomUUID(),
      fileId: '../escape',
      storageKey: 'public/products/does-not-exist.webp',
      attempts: 0,
    })).rejects.toThrow('Unsafe file identifier');
  });
});

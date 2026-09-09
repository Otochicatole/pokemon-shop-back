import type { PrismaClient } from '@prisma/client';
import { CleanupRetiredProductImages } from '../application/retired-product-image-cleanup.js';
import { LocalRetiredImageQuarantine } from './local-retired-image-quarantine.js';
import { PrismaRetiredImageCleanupRepository } from './prisma-retired-image-cleanup-repository.js';

type Coordinator = { run<T>(operation: () => Promise<T>): Promise<T> };

export function createRetiredImageCleanup(
  prisma: PrismaClient,
  coordinator: Coordinator,
  storageRoot: string,
): CleanupRetiredProductImages {
  return new CleanupRetiredProductImages(
    new PrismaRetiredImageCleanupRepository(prisma, coordinator),
    new LocalRetiredImageQuarantine(storageRoot),
  );
}

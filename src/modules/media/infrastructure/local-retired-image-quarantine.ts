import { access, mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { RetiredImageCleanupCandidate, RetiredImageQuarantine } from '../application/retired-product-image-cleanup.js';

async function exists(value: string): Promise<boolean> {
  try {
    await access(value);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

const SAFE_FILE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export class LocalRetiredImageQuarantine implements RetiredImageQuarantine {
  private readonly root: string;
  private readonly quarantineRoot: string;

  public constructor(storageRoot: string) {
    this.root = path.resolve(storageRoot);
    this.quarantineRoot = path.join(this.root, 'tmp', 'quarantine', 'retired-product-images');
  }

  async quarantine(candidate: RetiredImageCleanupCandidate): Promise<void> {
    const source = this.storagePath(candidate.storageKey);
    const target = this.quarantinePath(candidate);
    const [sourceExists, targetExists] = await Promise.all([exists(source), exists(target)]);
    if (sourceExists && targetExists) throw new Error(`Both source and quarantine copies exist for ${candidate.fileId}`);
    if (targetExists || !sourceExists) return;
    await mkdir(this.quarantineRoot, { recursive: true });
    await rename(source, target);
  }

  async restore(candidate: RetiredImageCleanupCandidate): Promise<void> {
    const source = this.storagePath(candidate.storageKey);
    const target = this.quarantinePath(candidate);
    const [sourceExists, targetExists] = await Promise.all([exists(source), exists(target)]);
    if (sourceExists && targetExists) throw new Error(`Cannot restore duplicate media ${candidate.fileId}`);
    if (!targetExists) return;
    await mkdir(path.dirname(source), { recursive: true });
    await rename(target, source);
  }

  async purge(candidate: RetiredImageCleanupCandidate): Promise<void> {
    await unlink(this.quarantinePath(candidate)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }

  private storagePath(storageKey: string): string {
    const absolute = path.resolve(this.root, storageKey);
    if (!absolute.startsWith(`${this.root}${path.sep}`)) throw new Error('Unsafe storage path');
    return absolute;
  }

  private quarantinePath(candidate: RetiredImageCleanupCandidate): string {
    if (!SAFE_FILE_ID.test(candidate.fileId)) throw new Error('Unsafe file identifier');
    const extension = /^\.[a-z0-9]+$/i.test(path.extname(candidate.storageKey)) ? path.extname(candidate.storageKey) : '.bin';
    const absolute = path.resolve(this.quarantineRoot, `${candidate.fileId}${extension}`);
    if (path.dirname(absolute) !== this.quarantineRoot) throw new Error('Unsafe quarantine path');
    return absolute;
  }
}

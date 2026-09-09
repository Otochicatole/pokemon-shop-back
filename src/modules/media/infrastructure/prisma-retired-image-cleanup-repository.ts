import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  CleanupDisposition,
  RetiredImageCleanupCandidate,
  RetiredImageCleanupRepository,
} from '../application/retired-product-image-cleanup.js';

type Coordinator = { run<T>(operation: () => Promise<T>): Promise<T> };
type Db = PrismaClient | Prisma.TransactionClient;

const candidateFrom = (job: { id: string; fileId: string; storageKey: string; attempts: number }): RetiredImageCleanupCandidate => ({
  jobId: job.id,
  fileId: job.fileId,
  storageKey: job.storageKey,
  attempts: job.attempts,
});

async function disposition(db: Db, candidate: RetiredImageCleanupCandidate): Promise<CleanupDisposition> {
  const [image, orderReferences, receiptReferences] = await Promise.all([
    db.productImage.findUnique({ where: { fileId: candidate.fileId }, select: { retiredAt: true } }),
    db.orderItem.count({ where: { imageFileId: candidate.fileId } }),
    db.transferReceipt.count({ where: { fileId: candidate.fileId } }),
  ]);
  if (orderReferences > 0 || receiptReferences > 0 || (image && image.retiredAt === null)) return 'RETAIN';
  return 'DELETE';
}

export class PrismaRetiredImageCleanupRepository implements RetiredImageCleanupRepository {
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly coordinator: Coordinator,
  ) {}

  claimNext(now: Date, staleBefore: Date): Promise<RetiredImageCleanupCandidate | null> {
    return this.coordinator.run(() => this.prisma.$transaction(async (tx) => {
      const job = await tx.fileCleanupJob.findFirst({
        where: {
          OR: [
            { status: 'PENDING', availableAt: { lte: now } },
            { status: 'PROCESSING', claimedAt: { lte: staleBefore } },
            { status: 'QUARANTINED' },
          ],
        },
        orderBy: [{ availableAt: 'asc' }, { id: 'asc' }],
      });
      if (!job) return null;
      const claimed = await tx.fileCleanupJob.updateMany({
        where: { id: job.id, status: job.status },
        data: { status: 'PROCESSING', claimedAt: now, attempts: { increment: 1 }, lastError: null },
      });
      if (claimed.count !== 1) return null;
      return candidateFrom({ ...job, attempts: job.attempts + 1 });
    }));
  }

  inspect(candidate: RetiredImageCleanupCandidate): Promise<CleanupDisposition> {
    return disposition(this.prisma, candidate);
  }

  detach(candidate: RetiredImageCleanupCandidate): Promise<CleanupDisposition> {
    return this.coordinator.run(() => this.prisma.$transaction(async (tx) => {
      if (await disposition(tx, candidate) === 'RETAIN') return 'RETAIN';
      await tx.productImage.deleteMany({ where: { fileId: candidate.fileId, retiredAt: { not: null } } });
      await tx.storedFile.deleteMany({ where: { id: candidate.fileId } });
      await tx.fileCleanupJob.updateMany({
        where: { id: candidate.jobId, status: 'PROCESSING' },
        data: { status: 'QUARANTINED' },
      });
      return 'DELETE';
    }));
  }

  markRetained(candidate: RetiredImageCleanupCandidate, reason: string): Promise<void> {
    return this.coordinator.run(async () => {
      await this.prisma.fileCleanupJob.updateMany({
        where: { id: candidate.jobId, status: { in: ['PENDING', 'PROCESSING', 'QUARANTINED'] } },
        data: { status: 'RETAINED', completedAt: new Date(), lastError: reason.slice(0, 1000) },
      });
    });
  }

  markCompleted(candidate: RetiredImageCleanupCandidate, completedAt: Date): Promise<void> {
    return this.coordinator.run(async () => {
      await this.prisma.fileCleanupJob.updateMany({
        where: { id: candidate.jobId, status: { in: ['PROCESSING', 'QUARANTINED'] } },
        data: { status: 'COMPLETED', completedAt, lastError: null },
      });
    });
  }

  retry(candidate: RetiredImageCleanupCandidate, error: string, availableAt: Date): Promise<void> {
    return this.coordinator.run(async () => {
      await this.prisma.fileCleanupJob.updateMany({
        where: { id: candidate.jobId, status: { in: ['PROCESSING', 'QUARANTINED'] } },
        data: { status: 'PENDING', availableAt, claimedAt: null, lastError: error.slice(0, 1000) },
      });
    });
  }
}

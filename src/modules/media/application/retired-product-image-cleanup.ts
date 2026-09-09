export type RetiredImageCleanupCandidate = {
  jobId: string;
  fileId: string;
  storageKey: string;
  attempts: number;
};

export type CleanupDisposition = 'DELETE' | 'RETAIN';

export interface RetiredImageCleanupRepository {
  claimNext(now: Date, staleBefore: Date): Promise<RetiredImageCleanupCandidate | null>;
  inspect(candidate: RetiredImageCleanupCandidate): Promise<CleanupDisposition>;
  detach(candidate: RetiredImageCleanupCandidate): Promise<CleanupDisposition>;
  markRetained(candidate: RetiredImageCleanupCandidate, reason: string): Promise<void>;
  markCompleted(candidate: RetiredImageCleanupCandidate, completedAt: Date): Promise<void>;
  retry(candidate: RetiredImageCleanupCandidate, error: string, availableAt: Date): Promise<void>;
}

export interface RetiredImageQuarantine {
  quarantine(candidate: RetiredImageCleanupCandidate): Promise<void>;
  restore(candidate: RetiredImageCleanupCandidate): Promise<void>;
  purge(candidate: RetiredImageCleanupCandidate): Promise<void>;
}

export type RetiredImageCleanupResult = {
  claimed: number;
  completed: number;
  retained: number;
  failed: number;
};

const PROCESSING_STALE_AFTER_MS = 15 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resumable two-phase cleanup. Database detachment and filesystem changes never
 * share a transaction, so every transition is deliberately idempotent.
 */
export class CleanupRetiredProductImages {
  public constructor(
    private readonly repository: RetiredImageCleanupRepository,
    private readonly quarantine: RetiredImageQuarantine,
  ) {}

  async execute(input: { limit?: number; now?: Date } = {}): Promise<RetiredImageCleanupResult> {
    const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
    const now = input.now ?? new Date();
    const result: RetiredImageCleanupResult = { claimed: 0, completed: 0, retained: 0, failed: 0 };

    for (let index = 0; index < limit; index += 1) {
      const candidate = await this.repository.claimNext(now, new Date(now.getTime() - PROCESSING_STALE_AFTER_MS));
      if (!candidate) break;
      result.claimed += 1;

      try {
        if (await this.repository.inspect(candidate) === 'RETAIN') {
          await this.quarantine.restore(candidate);
          await this.repository.markRetained(candidate, 'Referenced by an order or another active record');
          result.retained += 1;
          continue;
        }

        await this.quarantine.quarantine(candidate);
        if (await this.repository.detach(candidate) === 'RETAIN') {
          await this.quarantine.restore(candidate);
          await this.repository.markRetained(candidate, 'A reference appeared before database detachment');
          result.retained += 1;
          continue;
        }

        await this.quarantine.purge(candidate);
        await this.repository.markCompleted(candidate, now);
        result.completed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown retired-image cleanup failure';
        const delay = Math.min(2 ** Math.min(candidate.attempts, 10) * 60_000, MAX_RETRY_DELAY_MS);
        await this.repository.retry(candidate, message.slice(0, 1000), new Date(now.getTime() + delay));
        result.failed += 1;
      }
    }

    return result;
  }
}

import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../shared/errors.js';

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

export function rateLimit(max: number, windowMs: number, key: (request: Request) => string = (request) => request.ip ?? 'unknown') {
  return (request: Request, _response: Response, next: NextFunction) => {
    const now = Date.now();
    const bucketKey = `${key(request)}:${request.path}`;
    const bucket = buckets.get(bucketKey);
    if (!bucket || bucket.resetAt <= now) buckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
    else {
      bucket.count += 1;
      if (bucket.count > max) return next(new AppError(429, 'RATE_LIMITED', 'Too many requests'));
    }
    if (buckets.size > 20_000) for (const [entryKey, entry] of buckets) if (entry.resetAt <= now) buckets.delete(entryKey);
    return next();
  };
}

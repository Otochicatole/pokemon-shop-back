import type { RequestHandler } from 'express';

type JsonBody = Record<string, unknown> | unknown[] | string | number | boolean | null;

/** Normalizes legacy module adapters while the v2 application services are migrated. */
export const responseEnvelopeV2 = (): RequestHandler => (_req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = ((body: JsonBody) => {
    if (res.statusCode >= 400) return originalJson(body);
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const record = body as Record<string, unknown>;
      if ('data' in record && ('nextCursor' in record || !('meta' in record))) {
        const { data, nextCursor, ...rest } = record;
        return originalJson({ data, meta: { ...(nextCursor !== undefined ? { nextCursor } : {}), ...rest } });
      }
      if (!('data' in record)) return originalJson({ data: record, meta: {} });
    }
    return originalJson(body);
  }) as typeof res.json;
  next();
};

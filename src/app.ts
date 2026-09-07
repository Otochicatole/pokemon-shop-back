import express, { type Express, type NextFunction, type Request, type Response, type RequestHandler } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { ZodError } from 'zod';
import { prisma } from './infrastructure/prisma.js';
import { logger } from './infrastructure/logger.js';
import { env } from './config/env.js';
import { AppError } from './shared/errors.js';
import { ADMIN_COOKIE, csrfProtection, getAdminSession, getUserSession, USER_COOKIE } from './infrastructure/sessions.js';
import { rateLimit } from './infrastructure/rate-limit.js';
import { createCompositionRoot } from './app/composition-root.js';
import { createCatalogV2Router, PrismaCatalogRepository } from './modules/catalog/index.js';
import { responseEnvelopeV2 } from './app/http/middleware/response-envelope.js';

export function createApp(): Express {
  const app = express();
  app.set('trust proxy', env.NODE_ENV === 'production' ? 1 : false);
  app.disable('x-powered-by');
  const pinoHttpMiddleware = (pinoHttp as unknown as (options: { logger: typeof logger }) => RequestHandler)({ logger });
  app.use(pinoHttpMiddleware);
  app.use(helmet(env.NODE_ENV === 'production' ? {} : { contentSecurityPolicy: false }));
  app.use(cors({ origin: (origin, callback) => callback(null, !origin || env.frontendOrigins.includes(origin)), credentials: true, methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'Idempotency-Key'] }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(rateLimit(300, 60 * 1000));
  app.use(async (req, _res, next) => {
    try {
      const context: { userSession?: Awaited<ReturnType<typeof getUserSession>>; adminSession?: Awaited<ReturnType<typeof getAdminSession>> } = {};
      if (req.cookies?.[USER_COOKIE]) context.userSession = await getUserSession(req);
      if (req.cookies?.[ADMIN_COOKIE]) context.adminSession = await getAdminSession(req);
      (req as Request & { authLocals?: unknown }).authLocals = context;
      return next();
    } catch (error) { return next(error); }
  });
  app.use((req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (origin && !env.frontendOrigins.includes(origin)) return next(new AppError(403, 'ORIGIN_NOT_ALLOWED', 'Origin is not allowed'));
    return next();
  });
  app.use(csrfProtection);

  const composition = createCompositionRoot();

  app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get('/health/ready', async (_req, res, next) => { try { await prisma.$queryRawUnsafe('SELECT 1'); return res.json({ status: 'ready' }); } catch (error) { return next(error); } });
  const mount = (prefix: string) => {
    app.use(`${prefix}/auth`, composition.routers.customerAccess);
    app.use(`${prefix}/admin/auth`, composition.routers.adminAccess);
    app.use(`${prefix}/catalog`, composition.routers.catalog);
    app.use(prefix, composition.routers.commerce);
    app.use(`${prefix}/admin`, composition.routers.backoffice);
  };
  // v2 exposes the business capabilities through explicit module boundaries.
  app.use('/api/v2', responseEnvelopeV2());
  app.use('/api/v2/catalog', createCatalogV2Router(new PrismaCatalogRepository(prisma)));
  mount('/api/v2');
  app.use('/media', composition.routers.media);
  app.use(composition.routers.docs);

  app.use((_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Route not found')));
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = String(req.id ?? 'unknown');
    if (error instanceof ZodError) return res.status(400).json({ type: 'https://example.com/problems/validation', title: 'Validation error', detail: 'The request contains invalid fields', status: 400, code: 'VALIDATION_ERROR', requestId, issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })) });
    if (error instanceof AppError) return res.status(error.status).json({ type: `https://example.com/problems/${error.code.toLowerCase()}`, title: error.message, detail: error.message, status: error.status, code: error.code, requestId, ...(error.details ? { details: error.details } : {}) });
    logger.error({ err: error, requestId }, 'Unhandled request error');
    return res.status(500).json({ type: 'https://example.com/problems/internal', title: 'Internal server error', status: 500, code: 'INTERNAL_ERROR', requestId });
  });
  return app;
}

export const app = createApp();

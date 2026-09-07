import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import multer from 'multer';
import pinoHttpModule from 'pino-http';
import { ZodError } from 'zod';
import { prisma } from './infrastructure/prisma.js';
import { logger } from './infrastructure/logger.js';
import { env } from './config/env.js';
import { AppError } from './shared/errors.js';
import { ADMIN_COOKIE, csrfProtection, getAdminSession, getUserSession, USER_COOKIE } from './infrastructure/sessions.js';
import { createAuthRouter, createAdminAuthRouter } from './modules/auth/auth.js';
import { createCatalogRouter } from './modules/catalog/catalog.js';
import { createOrdersRouter } from './modules/orders/orders.js';
import { createAdminRouter } from './modules/admin/admin.js';
import { createMediaRouter } from './modules/media/media.js';
import { createDocsRouter } from './modules/docs/docs.js';
import { rateLimit } from './infrastructure/rate-limit.js';

const pinoHttp = (pinoHttpModule as unknown as { default?: typeof pinoHttpModule }).default ?? (pinoHttpModule as any);

export function createApp(): Express {
  const app = express();
  app.set('trust proxy', env.NODE_ENV === 'production' ? 1 : false);
  app.disable('x-powered-by');
  app.use(pinoHttp({ logger }));
  app.use(helmet(env.NODE_ENV === 'production' ? {} : { contentSecurityPolicy: false }));
  app.use(cors({ origin: (origin, callback) => callback(null, !origin || env.frontendOrigins.includes(origin)), credentials: true, methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'Idempotency-Key'] }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(rateLimit(300, 60 * 1000));
  app.use(async (req, _res, next) => {
    try {
      const context: any = {};
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

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 8, fields: 20, parts: 30, fieldNameSize: 100, fieldSize: 100_000 } });

  app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get('/health/ready', async (_req, res, next) => { try { await prisma.$queryRawUnsafe('SELECT 1'); return res.json({ status: 'ready' }); } catch (error) { return next(error); } });
  app.use('/api/v1/auth', createAuthRouter(prisma));
  app.use('/api/v1/admin/auth', createAdminAuthRouter(prisma));
  app.use('/api/v1/catalog', createCatalogRouter(prisma));
  app.use('/api/v1', createOrdersRouter(prisma, upload));
  app.use('/api/v1/admin', createAdminRouter(prisma, upload));
  app.use('/media', createMediaRouter(prisma));
  app.use(createDocsRouter());

  app.use((_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Route not found')));
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = req.id ?? 'unknown';
    if (error instanceof ZodError) return res.status(400).json({ type: 'https://example.com/problems/validation', title: 'Validation error', status: 400, code: 'VALIDATION_ERROR', requestId, errors: error.issues.map((issue) => ({ path: issue.path, message: issue.message })) });
    if (error instanceof AppError) return res.status(error.status).json({ type: `https://example.com/problems/${error.code.toLowerCase()}`, title: error.message, status: error.status, code: error.code, requestId, ...(error.details ? { details: error.details } : {}) });
    logger.error({ err: error, requestId }, 'Unhandled request error');
    return res.status(500).json({ type: 'https://example.com/problems/internal', title: 'Internal server error', status: 500, code: 'INTERNAL_ERROR', requestId });
  });
  return app;
}

export const app = createApp();

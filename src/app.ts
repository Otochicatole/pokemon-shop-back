import express, { type Express, type NextFunction, type Request, type Response, type RequestHandler } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import multer from 'multer';
import pinoHttp from 'pino-http';
import { ZodError } from 'zod';
import { prisma } from './infrastructure/prisma.js';
import { logger } from './infrastructure/logger.js';
import { env } from './config/env.js';
import { AppError } from './shared/errors.js';
import {
  ADMIN_COOKIE,
  csrfProtection,
  getAdminSession,
  getUserSession,
  LEGACY_ADMIN_COOKIE,
  LEGACY_USER_COOKIE,
  touchAdminSessionForMutation,
  USER_COOKIE,
} from './infrastructure/sessions.js';
import { rateLimit } from './infrastructure/rate-limit.js';
import { createCompositionRoot } from './app/composition-root.js';
import { responseEnvelopeV2 } from './app/http/middleware/response-envelope.js';
import { adminNoStore } from './app/http/middleware/admin-no-store.js';

export function createApp(composition = createCompositionRoot()): Express {
  const app = express();
  app.set('trust proxy', env.NODE_ENV === 'production' ? 1 : false);
  app.disable('x-powered-by');
  const pinoHttpMiddleware = (pinoHttp as unknown as (options: { logger: typeof logger }) => RequestHandler)({ logger });
  app.use(pinoHttpMiddleware);
  app.use(helmet(env.NODE_ENV === 'production' ? {} : { contentSecurityPolicy: false }));
  app.use('/api/v2/admin', adminNoStore);
  app.use(cors({ origin: (origin, callback) => callback(null, !origin || env.frontendOrigins.includes(origin)), credentials: true, methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'Idempotency-Key'] }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(rateLimit(300, 60 * 1000));
  app.use(async (req, _res, next) => {
    try {
      const context: { userSession?: Awaited<ReturnType<typeof getUserSession>>; adminSession?: Awaited<ReturnType<typeof getAdminSession>> } = {};
      const isAdminApi = /^\/api\/v\d+\/admin(?:\/|$)/.test(req.path);
      const isPrivateMedia = req.path.startsWith('/media/private');
      if ((!isAdminApi || isPrivateMedia) && (req.cookies?.[USER_COOKIE] || req.cookies?.[LEGACY_USER_COOKIE])) context.userSession = await getUserSession(req);
      const needsAdminContext = isAdminApi || isPrivateMedia;
      if (needsAdminContext && (req.cookies?.[ADMIN_COOKIE] || req.cookies?.[LEGACY_ADMIN_COOKIE])) {
        context.adminSession = await getAdminSession(req, {
          touch: false,
          onSessionRevoked: (revocation) => composition.realtime.support.closeSession(revocation.actorType, revocation.sessionId),
        });
      }
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
  app.use(touchAdminSessionForMutation);

  app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
  app.get('/health/ready', async (_req, res, next) => { try { await prisma.$queryRawUnsafe('SELECT 1'); return res.json({ status: 'ready' }); } catch (error) { return next(error); } });
  const mount = (prefix: string) => {
    app.use(`${prefix}/auth`, composition.routers.customerAccess);
    app.use(`${prefix}/admin/auth`, composition.routers.adminAccess);
    app.use(`${prefix}/loyalty`, composition.routers.loyalty);
    app.use(`${prefix}/support`, composition.routers.support);
    app.use(`${prefix}/admin/support`, composition.routers.adminSupport);
    app.use(`${prefix}/notifications`, composition.routers.notifications);
    app.use(`${prefix}/admin/notifications`, composition.routers.adminNotifications);
    app.use(prefix, composition.routers.commerce);
    app.use(`${prefix}/admin`, composition.routers.backoffice);
  };
  // v2 exposes the business capabilities through explicit module boundaries.
  app.use('/api/v2', responseEnvelopeV2());
  app.use('/api/v2/catalog', composition.routers.catalog);
  app.use('/api/v2/news', composition.routers.news);
  app.use('/api/v2/fx', composition.routers.fx);
  app.use('/api/v2/affiliate', composition.routers.affiliate);
  app.use('/api/v2/admin/affiliates', composition.routers.adminAffiliate);
  mount('/api/v2');
  app.use('/media', composition.routers.media);
  app.use(composition.routers.docs);

  app.use((_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Route not found')));
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = String(req.id ?? 'unknown');
    if (error instanceof multer.MulterError) {
      const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(status).json({ type: 'https://example.com/problems/upload', title: 'Invalid upload', detail: error.message, status, code: error.code, requestId });
    }
    if (error instanceof ZodError) {
      const fieldLabels: Record<string, string> = {
        'fulfillment.recipientName': 'nombre completo',
        'fulfillment.recipientPhone': 'teléfono',
        'fulfillment.addressLine1': 'dirección',
        'fulfillment.addressLine2': 'piso/departamento',
        'fulfillment.city': 'ciudad',
        'fulfillment.province': 'provincia',
        'fulfillment.postalCode': 'código postal',
        'fulfillment.shippingRateId': 'tarifa de envío',
        'fulfillment.pickupPointId': 'punto de retiro',
        paymentMethod: 'medio de pago',
        pointsToRedeem: 'puntos a canjear',
        items: 'productos del carrito',
      };
      const first = error.issues[0];
      const path = first?.path?.join('.') ?? '';
      const label = fieldLabels[path] ?? fieldLabels[path.replace(/\[\d+\]/g, '')] ?? (path || 'un campo');
      const tooSmall = first?.code === 'too_small';
      const invalidUuid = first?.code === 'invalid_format' && (first as { format?: string }).format === 'uuid';
      const detail = tooSmall
        ? `Revisá ${label}: el valor es demasiado corto o está incompleto`
        : invalidUuid
          ? `Revisá ${label}: la opción seleccionada no es válida`
          : `Revisá ${label}: los datos enviados no son válidos`;
      return res.status(400).json({
        type: 'https://example.com/problems/validation',
        title: detail,
        detail,
        status: 400,
        code: 'VALIDATION_ERROR',
        requestId,
        issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      });
    }
    if (error instanceof AppError) return res.status(error.status).json({ type: `https://example.com/problems/${error.code.toLowerCase()}`, title: error.message, detail: error.message, status: error.status, code: error.code, requestId, ...(error.details ? { details: error.details } : {}) });
    logger.error({ err: error, requestId }, 'Unhandled request error');
    return res.status(500).json({ type: 'https://example.com/problems/internal', title: 'Internal server error', status: 500, code: 'INTERNAL_ERROR', requestId });
  });
  return app;
}

export const composition = createCompositionRoot();
export const app = createApp(composition);

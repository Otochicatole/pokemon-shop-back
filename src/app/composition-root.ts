import type { Express, Request } from 'express';
import multer from 'multer';
import { env } from '../config/env.js';
import { prisma, writeCoordinator } from '../infrastructure/prisma.js';
import { currentAdmin, requireAdmin } from '../infrastructure/sessions.js';
import { createAuthRouter, createAdminAuthRouter } from '../modules/auth/index.js';
import { createCatalogV2Router, PrismaCatalogRepository } from '../modules/catalog/index.js';
import { createOrdersRouter } from '../modules/orders/index.js';
import {
  createAdminCmsApplication,
  createAdminCmsRouter,
  createPrismaAdminCmsRepositories,
  type AdminCmsApplication,
} from '../modules/backoffice/index.js';
import { createMediaRouter, createRetiredImageCleanup, discardUnattachedFile, saveImage, type CleanupRetiredProductImages } from '../modules/media/index.js';
import { createDocsRouter } from '../modules/docs/index.js';
import { createLoyaltyRouter } from '../modules/loyalty/index.js';
import { createSupportRouters, SupportRealtimeHub } from '../modules/support/index.js';
import { createNotificationsRouters } from '../modules/notifications/index.js';
import { PrismaUnitOfWork } from '../shared/infrastructure/prisma-unit-of-work.js';
import { getTransferSettings, transferSettingsConfigured } from '../modules/payments/index.js';

export interface CompositionRoot {
  prisma: typeof prisma;
  writeCoordinator: typeof writeCoordinator;
  unitOfWork: PrismaUnitOfWork;
  upload: multer.Multer;
  applications: { backoffice: AdminCmsApplication; retiredImageCleanup: CleanupRetiredProductImages };
  realtime: { support: SupportRealtimeHub };
  routers: {
    customerAccess: ReturnType<typeof createAuthRouter>;
    adminAccess: ReturnType<typeof createAdminAuthRouter>;
    catalog: ReturnType<typeof createCatalogV2Router>;
    commerce: ReturnType<typeof createOrdersRouter>;
    loyalty: ReturnType<typeof createLoyaltyRouter>;
    support: ReturnType<typeof createSupportRouters>['userRouter'];
    adminSupport: ReturnType<typeof createSupportRouters>['adminRouter'];
    notifications: ReturnType<typeof createNotificationsRouters>['userRouter'];
    adminNotifications: ReturnType<typeof createNotificationsRouters>['adminRouter'];
    backoffice: ReturnType<typeof createAdminCmsRouter>;
    media: ReturnType<typeof createMediaRouter>;
    docs: ReturnType<typeof createDocsRouter>;
  };
}

export function createCompositionRoot(): CompositionRoot {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 8, fields: 20, parts: 30, fieldNameSize: 100, fieldSize: 100_000 },
  });
  const supportRealtime = new SupportRealtimeHub();
  const backofficeRepositories = createPrismaAdminCmsRepositories(prisma, writeCoordinator, supportRealtime);
  const backofficeApplication = createAdminCmsApplication(backofficeRepositories, {
    integrations: async () => ({
      bankTransfer: transferSettingsConfigured(await getTransferSettings(prisma)),
      mercadoPago: Boolean(env.MERCADOPAGO_ACCESS_TOKEN),
      smtp: Boolean(env.SMTP_HOST),
    }),
  });
  const retiredImageCleanup = createRetiredImageCleanup(prisma, writeCoordinator, env.STORAGE_ROOT);
  const supportRouters = createSupportRouters(prisma, writeCoordinator, supportRealtime);
  const notificationRouters = createNotificationsRouters(prisma, supportRealtime);
  const onSessionRevoked = (revocation: { actorType: 'USER' | 'ADMIN'; sessionId: string }) => {
    supportRealtime.closeSession(revocation.actorType, revocation.sessionId);
  };
  const actorFromRequest = (request: Request) => {
    const session = currentAdmin(request);
    if (!session) throw new Error('Admin guard did not populate request context');
    return { adminId: session.admin.id, requestId: request.id === undefined ? undefined : String(request.id) };
  };
  const backofficeRouter = createAdminCmsRouter({
    application: backofficeApplication,
    upload,
    requireAdmin,
    actorFromRequest,
    media: {
      saveProductImage: (file) => saveImage(prisma, file, 'PUBLIC', 'products'),
      discardUnattachedFile: (id) => discardUnattachedFile(prisma, id),
    },
  });

  return {
    prisma,
    writeCoordinator,
    unitOfWork: new PrismaUnitOfWork(prisma),
    upload,
    applications: { backoffice: backofficeApplication, retiredImageCleanup },
    realtime: { support: supportRealtime },
    routers: {
      customerAccess: createAuthRouter(prisma, { onSessionRevoked }),
      adminAccess: createAdminAuthRouter(prisma, { onSessionRevoked }),
      catalog: createCatalogV2Router(new PrismaCatalogRepository(prisma)),
      commerce: createOrdersRouter(prisma, upload, supportRealtime),
      loyalty: createLoyaltyRouter(prisma),
      support: supportRouters.userRouter,
      adminSupport: supportRouters.adminRouter,
      notifications: notificationRouters.userRouter,
      adminNotifications: notificationRouters.adminRouter,
      backoffice: backofficeRouter,
      media: createMediaRouter(prisma),
      docs: createDocsRouter(),
    },
  };
}

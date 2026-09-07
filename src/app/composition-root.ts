import type { Express } from 'express';
import multer from 'multer';
import { prisma, writeCoordinator } from '../infrastructure/prisma.js';
import { createAuthRouter, createAdminAuthRouter } from '../modules/auth/index.js';
import { createCatalogRouter } from '../modules/catalog/index.js';
import { createOrdersRouter } from '../modules/orders/index.js';
import { createAdminRouter } from '../modules/admin/index.js';
import { createMediaRouter } from '../modules/media/index.js';
import { createDocsRouter } from '../modules/docs/index.js';
import { PrismaUnitOfWork } from '../shared/infrastructure/prisma-unit-of-work.js';

export interface CompositionRoot {
  prisma: typeof prisma;
  writeCoordinator: typeof writeCoordinator;
  unitOfWork: PrismaUnitOfWork;
  upload: multer.Multer;
  routers: {
    customerAccess: ReturnType<typeof createAuthRouter>;
    adminAccess: ReturnType<typeof createAdminAuthRouter>;
    catalog: ReturnType<typeof createCatalogRouter>;
    commerce: ReturnType<typeof createOrdersRouter>;
    backoffice: ReturnType<typeof createAdminRouter>;
    media: ReturnType<typeof createMediaRouter>;
    docs: ReturnType<typeof createDocsRouter>;
  };
}

export function createCompositionRoot(): CompositionRoot {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 8, fields: 20, parts: 30, fieldNameSize: 100, fieldSize: 100_000 },
  });

  return {
    prisma,
    writeCoordinator,
    unitOfWork: new PrismaUnitOfWork(prisma),
    upload,
    routers: {
      customerAccess: createAuthRouter(prisma),
      adminAccess: createAdminAuthRouter(prisma),
      catalog: createCatalogRouter(prisma),
      commerce: createOrdersRouter(prisma, upload),
      backoffice: createAdminRouter(prisma, upload),
      media: createMediaRouter(prisma),
      docs: createDocsRouter(),
    },
  };
}

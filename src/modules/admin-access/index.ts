/** Public API for administrative identity. */
export type AdminAccessModule = { readonly name: 'admin-access' };
export { PrismaAdminRepository } from './infrastructure/prisma-admin-repository.js';

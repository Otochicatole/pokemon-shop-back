/** Public API for customer identity. HTTP and persistence details stay private. */
export type CustomerAccessModule = { readonly name: 'customer-access' };
export { PrismaUserRepository } from './infrastructure/prisma-user-repository.js';

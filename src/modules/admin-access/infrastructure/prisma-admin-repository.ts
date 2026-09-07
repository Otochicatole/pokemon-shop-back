import type { PrismaClient } from '@prisma/client';
import type { AdminRepository } from '../../../shared/application/ports.js';

export class PrismaAdminRepository implements AdminRepository {
  public constructor(private readonly prisma: PrismaClient) {}
  public findById(id: string) { return this.prisma.admin.findUnique({ where: { id } }); }
  public findByEmail(email: string) { return this.prisma.admin.findUnique({ where: { email } }); }
}

import type { PrismaClient } from '@prisma/client';
import type { UserRepository } from '../../../shared/application/ports.js';

export class PrismaUserRepository implements UserRepository {
  public constructor(private readonly prisma: PrismaClient) {}
  public findById(id: string) { return this.prisma.user.findUnique({ where: { id } }); }
  public findByEmail(email: string) { return this.prisma.user.findUnique({ where: { email } }); }
}

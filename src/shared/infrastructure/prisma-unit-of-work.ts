import type { Prisma, PrismaClient } from '@prisma/client';
import type { UnitOfWork } from '../application/ports.js';

export class PrismaUnitOfWork implements UnitOfWork {
  public constructor(private readonly prisma: PrismaClient) {}
  public run<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }
}

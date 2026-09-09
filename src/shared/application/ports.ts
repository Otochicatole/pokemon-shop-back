import type { PrismaClient, Prisma } from '@prisma/client';

/** Ports consumed by application services. Implementations live in infrastructure. */
export interface UserRepository {
  findById(id: string): Promise<unknown | null>;
  findByEmail(email: string): Promise<unknown | null>;
}

export interface AdminRepository {
  findById(id: string): Promise<unknown | null>;
  findByEmail(email: string): Promise<unknown | null>;
}

export interface ProductRepository {
  listPublished(input: unknown): Promise<unknown>;
  findPublishedBySlug(slug: string): Promise<unknown | null>;
}

export interface InventoryRepository {
  getAvailability(productId: string): Promise<number>;
  reserve(productId: string, quantity: number, version: number, expiresAt: Date): Promise<void>;
  release(orderId: string): Promise<void>;
}

export interface OrderRepository {
  findByNumberForUser(number: string, userId: string): Promise<unknown | null>;
  listForUser(userId: string, cursor?: string, limit?: number): Promise<unknown>;
}

export interface SessionStore {
  revokeUser(sessionId: string): Promise<void>;
  revokeAdmin(sessionId: string): Promise<void>;
}

export interface PasswordHasher {
  hash(value: string): Promise<string>;
  verify(hash: string, value: string): Promise<boolean>;
}

export interface OAuthProvider {
  authorizationUrl(input: unknown): Promise<string>;
  exchangeCallback(input: unknown): Promise<unknown>;
}

export interface PaymentGateway {
  createCheckout(input: unknown): Promise<unknown>;
  reconcile(externalId: string): Promise<void>;
}

export interface MailPort {
  send(to: string, subject: string, text: string): Promise<void>;
}

export interface FileStorage {
  save(file: Express.Multer.File, visibility: 'PUBLIC' | 'PRIVATE', folder: 'products' | 'receipts'): Promise<{ id: string; storageKey: string }>;
  remove(storageKey: string): Promise<void>;
}

export interface AuditPort {
  record(input: { actorType: string; actorId?: string; action: string; entityType: string; entityId?: string; metadata?: unknown; requestId?: string }): Promise<void>;
}

export interface UnitOfWork {
  run<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
}

export interface IdGenerator {
  uuid(): string;
  publicOrderNumber(): string;
}

export interface WriteCoordinator {
  run<T>(work: () => Promise<T>): Promise<T>;
}

export interface InfrastructureDependencies {
  prisma: PrismaClient;
  unitOfWork: UnitOfWork;
  writeCoordinator: WriteCoordinator;
}

import type { Prisma, PrismaClient } from '@prisma/client';
import { badRequest, conflict, notFound } from '../../../shared/errors.js';
import { parseMinor } from '../../../shared/money.js';
import type { PickupPointWrite, ShippingZoneWrite } from '../application/ports.js';
import type { JsonValue, OrderDto, OrderStatusMutationDto, RefundDto, SupplierDto, TransferReviewDto } from '../application/dtos.js';
import type {
  AdminActor, AuditListQuery, CustomerListQuery, OrderListQuery, OrderStatusValue,
  ProductListQuery, ProductPatch, ProductWrite, SupplierListQuery, SupplierPatch, SupplierWrite, LoyaltyProgramWrite,
} from '../domain/admin-cms.js';
import { allowedOrderTransitions } from '../domain/admin-cms.js';
import { getLoyaltyProgram, mapLoyaltyProgram, releaseOrderLoyaltyReservation, reverseOrderLoyalty, settleOrderLoyalty } from '../../loyalty/index.js';

type Coordinator = { run<T>(operation: () => Promise<T>): Promise<T> };
type Db = PrismaClient | Prisma.TransactionClient;

const money = (amountMinor: bigint, currency = 'ARS') => ({ amountMinor: amountMinor.toString(), currency });
const RETIRED_IMAGE_GRACE_MS = 24 * 60 * 60 * 1000;
const page = <T>(rows: readonly T[], limit: number, id: (value: T) => string) => {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : [...rows];
  return { data, nextCursor: hasMore && data.length ? id(data[data.length - 1]!) : null };
};
const dateRange = (range: 'TODAY' | '7D' | '30D') => {
  const now = new Date();
  if (range === 'TODAY') return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return new Date(now.getTime() - (range === '7D' ? 7 : 30) * 24 * 60 * 60 * 1000);
};
const cleanOptional = (value: string | null | undefined) => value === undefined ? undefined : value === null || value.trim() === '' ? null : value.trim();
const emptyLoyaltyAccount = () => ({ balance: 0, reserved: 0, available: 0, lifetimeEarned: 0, lifetimeRedeemed: 0 });
const mapLoyaltyAccount = (account: { balance: number; reserved: number; lifetimeEarned: number; lifetimeRedeemed: number } | null | undefined) => account ? {
  balance: account.balance,
  reserved: account.reserved,
  available: Math.max(0, account.balance - account.reserved),
  lifetimeEarned: account.lifetimeEarned,
  lifetimeRedeemed: account.lifetimeRedeemed,
} : emptyLoyaltyAccount();

function validateProduct(input: ProductWrite | (ProductPatch & Partial<ProductWrite>), current?: { kind: string; stockMode: string; onHand: number; reserved: number }) {
  const kind = input.kind ?? current?.kind;
  const stockMode = input.stockMode ?? current?.stockMode;
  if (kind === 'SINGLE_CARD' && (input.pokemonCard === null || (!current && input.pokemonCard === undefined) || (current?.kind !== 'SINGLE_CARD' && input.kind === 'SINGLE_CARD' && input.pokemonCard === undefined))) throw badRequest('POKEMON_CARD_REQUIRED', 'Single cards require Pokémon card metadata');
  if (kind !== 'SINGLE_CARD' && input.pokemonCard) throw badRequest('POKEMON_CARD_NOT_ALLOWED', 'Only single cards can have Pokémon card metadata');
  if ((input.initialStock ?? 0) < 0) throw badRequest('INVALID_STOCK', 'Initial stock cannot be negative');
  if (stockMode === 'UNIQUE' && current && (current.onHand > 1 || current.reserved > 1)) throw conflict('UNIQUE_STOCK_INVALID', 'Unique products cannot have more than one unit');
  if (stockMode === 'UNIQUE' && (input.initialStock ?? 0) > 1) throw badRequest('UNIQUE_STOCK_INVALID', 'Unique products cannot have more than one unit');
}

function auditData(actor: AdminActor, action: string, entityType: string, entityId?: string, metadata?: unknown): Prisma.AuditLogCreateInput {
  return { actorType: 'ADMIN', actorId: actor.adminId, action, entityType, entityId, metadata: metadata === undefined ? undefined : JSON.stringify(metadata), requestId: actor.requestId };
}

const productInclude = {
  pokemonCard: true,
  inventory: true,
  images: { where: { retiredAt: null }, orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }] },
} satisfies Prisma.ProductInclude;

type ProductRecord = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

function mapProduct(value: ProductRecord) {
  const available = (value.inventory?.onHand ?? 0) - (value.inventory?.reserved ?? 0);
  return {
    id: value.id, sku: value.sku, slug: value.slug, name: value.name, description: value.description,
    kind: value.kind, stockMode: value.stockMode, status: value.status, version: value.version,
    price: money(value.priceMinor, value.currency),
    inventory: value.inventory ? { onHand: value.inventory.onHand, reserved: value.inventory.reserved, available, version: value.inventory.version } : null,
    pokemonCard: value.pokemonCard,
    images: value.images.map((image) => ({ id: image.id, fileId: image.fileId, url: `/media/public/${image.fileId}`, altText: image.altText, sortOrder: image.sortOrder, createdAt: image.createdAt })),
    publishedAt: value.publishedAt, archivedAt: value.archivedAt, createdAt: value.createdAt, updatedAt: value.updatedAt,
  };
}

function mapSupplier(value: { id: string; name: string; contactName: string | null; email: string | null; phone: string | null; address: string | null; notes: string | null; active: boolean; version: number; createdAt: Date; updatedAt: Date }): SupplierDto {
  return {
    id: value.id, name: value.name, contactName: value.contactName, email: value.email,
    phone: value.phone, address: value.address, notes: value.notes, active: value.active,
    version: value.version, createdAt: value.createdAt, updatedAt: value.updatedAt,
  };
}

const orderDetailInclude = {
  user: { select: { id: true, email: true, name: true, status: true, emailVerifiedAt: true, createdAt: true } },
  items: true,
  reservations: true,
  statusHistory: { orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }] },
  transferReceipts: { orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }] },
  payment: { include: { transfer: true, mercadoPago: true, refunds: true } },
} satisfies Prisma.OrderInclude;
type OrderRecord = Prisma.OrderGetPayload<{ include: typeof orderDetailInclude }>;

function actionsFor(order: OrderRecord) {
  const actions: string[] = [];
  const next = allowedOrderTransitions[order.status];
  if (next.length) actions.push(...next.map((status) => `TRANSITION_${status}`));
  if (['PENDING_PAYMENT', 'PAYMENT_REVIEW'].includes(order.status)) actions.push('CANCEL');
  if (order.paymentMethod === 'BANK_TRANSFER' && ['PENDING_PAYMENT', 'PAYMENT_REVIEW'].includes(order.status) && order.transferReceipts.some((receipt) => receipt.review === 'PENDING')) actions.push('REVIEW_TRANSFER');
  if (order.status === 'PAYMENT_REQUIRES_REVIEW' && order.payment?.status === 'APPROVED') actions.push('FULFILL_LATE_PAYMENT');
  if (order.payment && ['APPROVED', 'REQUIRES_REVIEW'].includes(order.payment.status) && !order.payment.refunds.length) actions.push('RECORD_FULL_REFUND');
  return actions;
}

function mapOrder(value: OrderRecord): OrderDto {
  return {
    id: value.id, number: value.number, version: value.version, status: value.status,
    paymentMethod: value.paymentMethod, fulfillmentType: value.fulfillmentType,
    totals: { subtotal: money(value.subtotalMinor, value.currency), discount: money(value.pointsDiscountMinor, value.currency), shipping: money(value.shippingMinor, value.currency), total: money(value.totalMinor, value.currency) },
    loyalty: {
      programVersion: value.loyaltyProgramVersion,
      pointsRedeemed: value.pointsRedeemed,
      pointsDiscount: money(value.pointsDiscountMinor, value.currency),
      pointsEarned: value.pointsEarned,
      redemptionStatus: value.loyaltyRedemptionStatus,
      spendPerPoint: value.loyaltySpendPerPointMinor === null ? null : money(value.loyaltySpendPerPointMinor, value.currency),
      pointValue: value.loyaltyPointValueMinor === null ? null : money(value.loyaltyPointValueMinor, value.currency),
    },
    customer: value.user,
    fulfillment: value.fulfillmentType === 'SHIPMENT' ? {
      type: 'SHIPMENT', shippingRateId: value.shippingRateId, zoneName: value.shippingZoneName,
      rateName: value.shippingRateName, ratePrice: value.shippingRatePriceMinor === null ? null : money(value.shippingRatePriceMinor, value.currency),
      recipientName: value.recipientName, recipientPhone: value.recipientPhone, addressLine1: value.addressLine1,
      addressLine2: value.addressLine2, city: value.city, province: value.province, postalCode: value.postalCode,
    } : { type: 'PICKUP', pickupPointId: value.pickupPointId, name: value.pickupPointName, address: value.pickupPointAddress },
    items: value.items.map((item) => ({ id: item.id, productId: item.productId, sku: item.sku, name: item.productName, imageFileId: item.imageFileId, imageUrl: item.imageFileId ? `/media/public/${item.imageFileId}` : null, unitPrice: money(item.unitPriceMinor, value.currency), quantity: item.quantity, lineTotal: money(item.lineTotalMinor, value.currency), snapshot: parseJson(item.productSnapshot) })),
    reservations: value.reservations.map((reservation) => ({ id: reservation.id, productId: reservation.productId, quantity: reservation.quantity, expiresAt: reservation.expiresAt, releasedAt: reservation.releasedAt, consumedAt: reservation.consumedAt })),
    payment: value.payment ? {
      id: value.payment.id, method: value.payment.method, status: value.payment.status, amount: money(value.payment.amountMinor, value.payment.currency), providerReference: value.payment.providerReference,
      bankTransfer: value.payment.transfer,
      mercadoPago: value.payment.mercadoPago,
      refunds: value.payment.refunds.map((refund) => ({ id: refund.id, amount: money(refund.amountMinor, refund.currency), reason: refund.reason, externalReference: refund.externalReference, createdAt: refund.createdAt })),
    } : null,
    receipts: value.transferReceipts.map((receipt) => ({ id: receipt.id, fileId: receipt.fileId, url: `/media/private/${receipt.fileId}`, review: receipt.review, note: receipt.note, createdAt: receipt.createdAt, reviewedAt: receipt.reviewedAt, reviewedById: receipt.reviewedById })),
    timeline: value.statusHistory,
    allowedActions: actionsFor(value), expiresAt: value.expiresAt, createdAt: value.createdAt, updatedAt: value.updatedAt,
  };
}

function parseJson(value: string): JsonValue {
  try { return JSON.parse(value) as JsonValue; } catch { return null; }
}

function throwCmsWriteError(error: unknown): never {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') throw conflict('DUPLICATE_RESOURCE', 'A unique value is already used by another record');
  throw error;
}

function redact(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  const result: { [key: string]: JsonValue } = {};
  for (const [key, nested] of Object.entries(value as { [key: string]: JsonValue })) {
    result[key] = /token|cookie|secret|password|authorization|cbu|alias|email|phone|address/i.test(key) ? '[REDACTED]' : redact(nested);
  }
  return result;
}

export class PrismaAdminCmsTransactionStore {
  public constructor(private readonly prisma: PrismaClient, private readonly coordinator: Coordinator) {}

  async dashboard(range: 'TODAY' | '7D' | '30D') {
    const since = dateRange(range);
    const [paidEvents, refunds, orderGroups, productGroups, inventories, pendingTransfers, mercadoReview, recentOrders, recentActivity] = await Promise.all([
      this.prisma.orderStatusHistory.findMany({ where: { toStatus: 'PAID', createdAt: { gte: since } }, select: { orderId: true, order: { select: { totalMinor: true, currency: true } } }, distinct: ['orderId'] }),
      this.prisma.refundRecord.aggregate({ where: { createdAt: { gte: since } }, _sum: { amountMinor: true }, _count: true }),
      this.prisma.order.groupBy({ by: ['status'], where: { createdAt: { gte: since } }, _count: true }),
      this.prisma.product.groupBy({ by: ['status'], _count: true }),
      this.prisma.inventory.findMany({ where: { product: { status: 'PUBLISHED' } }, select: { onHand: true, reserved: true } }),
      this.prisma.transferReceipt.count({ where: { review: 'PENDING' } }),
      this.prisma.payment.count({ where: { method: 'MERCADO_PAGO', status: 'REQUIRES_REVIEW' } }),
      this.prisma.order.findMany({ take: 8, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include: orderDetailInclude }),
      this.prisma.auditLog.findMany({ take: 10, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
    ]);
    const gross = paidEvents.reduce((total, event) => total + event.order.totalMinor, 0n);
    const refunded = refunds._sum.amountMinor ?? 0n;
    return {
      range, since,
      revenue: { gross: money(gross), refunded: money(refunded), net: money(gross - refunded), paidPayments: paidEvents.length, refunds: refunds._count },
      orders: { total: orderGroups.reduce((total, group) => total + group._count, 0), byStatus: Object.fromEntries(orderGroups.map((group) => [group.status, group._count])) },
      products: {
        draft: productGroups.find((group) => group.status === 'DRAFT')?._count ?? 0,
        published: productGroups.find((group) => group.status === 'PUBLISHED')?._count ?? 0,
        archived: productGroups.find((group) => group.status === 'ARCHIVED')?._count ?? 0,
        outOfStock: inventories.filter((value) => value.onHand - value.reserved <= 0).length,
        lowStock: inventories.filter((value) => value.onHand - value.reserved > 0 && value.onHand - value.reserved <= 5).length,
      },
      attention: { transferReviews: pendingTransfers, mercadoPagoReviews: mercadoReview },
      recentOrders: recentOrders.map((order) => ({ id: order.id, number: order.number, status: order.status, total: money(order.totalMinor, order.currency), createdAt: order.createdAt })),
      recentActivity: recentActivity.map((entry) => ({ ...entry, metadata: redact(parseJson(entry.metadata ?? 'null')) })),
    };
  }

  async listProducts(query: ProductListQuery) {
    const stockIds = query.stock === undefined ? undefined : await this.inventoryIdsForStock(query.stock);
    const where: Prisma.ProductWhereInput = { AND: [productWhere(query), ...(stockIds ? [{ id: { in: stockIds } }] : [])] };
    const rows = await this.prisma.product.findMany({ where, include: productInclude, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: query.limit + 1, ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}) });
    const result = page(rows, query.limit, (value) => value.id);
    return { data: result.data.map(mapProduct), nextCursor: result.nextCursor };
  }

  private async inventoryIdsForStock(stock: 'AVAILABLE' | 'LOW' | 'OUT'): Promise<string[]> {
    const rows = stock === 'OUT'
      ? await this.prisma.$queryRaw<Array<{ productId: string }>>`SELECT "productId" FROM "Inventory" WHERE ("onHand" - "reserved") <= 0`
      : stock === 'LOW'
        ? await this.prisma.$queryRaw<Array<{ productId: string }>>`SELECT "productId" FROM "Inventory" WHERE ("onHand" - "reserved") BETWEEN 1 AND 5`
        : await this.prisma.$queryRaw<Array<{ productId: string }>>`SELECT "productId" FROM "Inventory" WHERE ("onHand" - "reserved") > 0`;
    return rows.map((row) => row.productId);
  }

  async getProduct(id: string) {
    const product = await this.prisma.product.findUnique({ where: { id }, include: productInclude });
    if (!product) throw notFound('Product not found');
    return { product: mapProduct(product) };
  }

  createProduct(actor: AdminActor, input: ProductWrite) {
    validateProduct(input);
    return this.coordinator.run(() => this.prisma.$transaction(async (tx) => {
      const product = await tx.product.create({ data: {
        sku: input.sku.toUpperCase(), slug: input.slug, name: input.name, description: input.description,
        kind: input.kind, stockMode: input.stockMode, priceMinor: parseMinor(input.priceMinor), currency: 'ARS',
        inventory: { create: { onHand: input.initialStock ?? 0, reserved: 0 } },
        ...(input.pokemonCard ? { pokemonCard: { create: mapCardWrite(input.pokemonCard) } } : {}),
      }, include: productInclude });
      const initialStock = input.initialStock ?? 0;
      if (initialStock > 0) await tx.inventoryAdjustment.create({ data: { productId: product.id, delta: initialStock, reason: 'Initial stock', createdById: actor.adminId } });
      await tx.auditLog.create({ data: auditData(actor, 'PRODUCT_CREATED', 'Product', product.id, { sku: product.sku, version: product.version }) });
      return { product: mapProduct(product) };
    })).catch(throwCmsWriteError);
  }

  async updateProduct(actor: AdminActor, id: string, input: ProductPatch) {
    return this.coordinator.run(() => this.prisma.$transaction(async (tx) => {
      const existing = await tx.product.findUnique({ where: { id }, include: { inventory: true, pokemonCard: true } });
      if (!existing?.inventory) throw notFound('Product not found');
      validateProduct(input, { kind: existing.kind, stockMode: existing.stockMode, onHand: existing.inventory.onHand, reserved: existing.inventory.reserved });
      const updated = await tx.product.updateMany({ where: { id, version: input.expectedVersion }, data: {
        ...(input.sku !== undefined ? { sku: input.sku.toUpperCase() } : {}), ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}), ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}), ...(input.stockMode !== undefined ? { stockMode: input.stockMode } : {}),
        ...(input.priceMinor !== undefined ? { priceMinor: parseMinor(input.priceMinor) } : {}), version: { increment: 1 },
      } });
      if (updated.count !== 1) throw conflict('PRODUCT_CHANGED', 'Product was modified by another administrator');
      const finalKind = input.kind ?? existing.kind;
      if (finalKind !== 'SINGLE_CARD') await tx.pokemonCardDetails.deleteMany({ where: { productId: id } });
      else if (input.pokemonCard) await tx.pokemonCardDetails.upsert({ where: { productId: id }, create: { productId: id, ...mapCardWrite(input.pokemonCard) }, update: mapCardWrite(input.pokemonCard) });
      else if (!existing.pokemonCard) throw badRequest('POKEMON_CARD_REQUIRED', 'Single cards require Pokémon card metadata');
      await tx.auditLog.create({ data: auditData(actor, 'PRODUCT_UPDATED', 'Product', id, { fromVersion: input.expectedVersion, toVersion: input.expectedVersion + 1 }) });
      const product = await tx.product.findUniqueOrThrow({ where: { id }, include: productInclude });
      return { product: mapProduct(product) };
    })).catch(throwCmsWriteError);
  }

  setProductStatus(actor: AdminActor, id: string, expectedVersion: number, status: 'PUBLISHED' | 'ARCHIVED') {
    return this.coordinator.run(() => this.prisma.$transaction(async (tx) => {
      const existing = await tx.product.findUnique({ where: { id }, include: { inventory: true, pokemonCard: true, images: { where: { retiredAt: null } } } });
      if (!existing) throw notFound('Product not found');
      if (status === 'PUBLISHED' && (!existing.inventory || (existing.kind === 'SINGLE_CARD' && !existing.pokemonCard))) throw conflict('PRODUCT_INCOMPLETE', 'Product is missing required data');
      const result = await tx.product.updateMany({ where: { id, version: expectedVersion }, data: { status, publishedAt: status === 'PUBLISHED' ? new Date() : existing.publishedAt, archivedAt: status === 'ARCHIVED' ? new Date() : null, version: { increment: 1 } } });
      if (result.count !== 1) throw conflict('PRODUCT_CHANGED', 'Product was modified by another administrator');
      await tx.auditLog.create({ data: auditData(actor, status === 'PUBLISHED' ? 'PRODUCT_PUBLISHED' : 'PRODUCT_ARCHIVED', 'Product', id, { fromVersion: expectedVersion }) });
      return { id, status, version: expectedVersion + 1 };
    }));
  }

  addProductImages(actor: AdminActor, productId: string, expectedVersion: number, files: readonly { id: string; altText?: string }[]) {
    return this.coordinator.run(() => this.prisma.$transaction(async (tx) => {
      const version = await incrementProductVersion(tx, productId, expectedVersion);
      const existing = await tx.productImage.findMany({ where: { productId, retiredAt: null }, orderBy: { sortOrder: 'asc' } });
      if (existing.length + files.length > 8) throw badRequest('TOO_MANY_IMAGES', 'A product can have at most eight active images');
      const created = [];
      for (const [offset, file] of files.entries()) {
        created.push(await tx.productImage.create({ data: { productId, fileId: file.id, altText: file.altText, sortOrder: existing.length + offset, createdById: actor.adminId } }));
      }
      await tx.auditLog.create({ data: auditData(actor, 'PRODUCT_IMAGES_ADDED', 'Product', productId, { count: created.length, fromVersion: expectedVersion, toVersion: version }) });
      return { version, images: created.map((image) => ({ id: image.id, fileId: image.fileId, url: `/media/public/${image.fileId}`, altText: image.altText, sortOrder: image.sortOrder })) };
    }));
  }

  updateProductImage(actor: AdminActor, productId: string, imageId: string, expectedVersion: number, altText: string | null) {
    return this.coordinator.run(() => this.prisma.$transaction(async (tx) => {
      const version = await incrementProductVersion(tx, productId, expectedVersion);
      const result = await tx.productImage.updateMany({ where: { id: imageId, productId, retiredAt: null }, data: { altText } });
      if (result.count !== 1) throw notFound('Product image not found');
      await tx.auditLog.create({ data: auditData(actor, 'PRODUCT_IMAGE_UPDATED', 'ProductImage', imageId, { productId, fromVersion: expectedVersion, toVersion: version }) });
      return { id: imageId, altText, version };
    }));
  }

  reorderProductImages(actor: AdminActor, productId: string, expectedVersion: number, imageIds: readonly string[]) {
    return this.coordinator.run(() => this.prisma.$transaction(async (tx) => {
      const version = await incrementProductVersion(tx, productId, expectedVersion);
      const existing = await tx.productImage.findMany({ where: { productId, retiredAt: null }, select: { id: true } });
      const expected = existing.map((image) => image.id).sort();
      const received = [...new Set(imageIds)].sort();
      if (expected.length !== received.length || expected.some((id, index) => id !== received[index])) throw badRequest('INVALID_IMAGE_ORDER', 'Image order must contain every active image exactly once');
      for (const [sortOrder, id] of imageIds.entries()) await tx.productImage.update({ where: { id }, data: { sortOrder } });
      await tx.auditLog.create({ data: auditData(actor, 'PRODUCT_IMAGES_REORDERED', 'Product', productId, { imageIds, fromVersion: expectedVersion, toVersion: version }) });
      return { imageIds, version };
    }));
  }

  retireProductImage(actor: AdminActor, productId: string, imageId: string, expectedVersion: number): Promise<void> {
    return this.coordinator.run(() => this.prisma.$transaction(async (tx) => {
      const image = await tx.productImage.findFirst({
        where: { id: imageId, productId, retiredAt: null },
        include: { file: { select: { storageKey: true } } },
      });
      if (!image) throw notFound('Product image not found');
      const version = await incrementProductVersion(tx, productId, expectedVersion);
      const result = await tx.productImage.updateMany({ where: { id: imageId, productId, retiredAt: null }, data: { retiredAt: new Date() } });
      if (result.count !== 1) throw notFound('Product image not found');
      const remaining = await tx.productImage.findMany({ where: { productId, retiredAt: null }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
      for (const [sortOrder, image] of remaining.entries()) await tx.productImage.update({ where: { id: image.id }, data: { sortOrder } });
      await tx.fileCleanupJob.upsert({
        where: { fileId: image.fileId },
        create: { fileId: image.fileId, storageKey: image.file.storageKey, availableAt: new Date(Date.now() + RETIRED_IMAGE_GRACE_MS) },
        update: {
          storageKey: image.file.storageKey, status: 'PENDING', availableAt: new Date(Date.now() + RETIRED_IMAGE_GRACE_MS),
          claimedAt: null, completedAt: null, lastError: null,
        },
      });
      await tx.auditLog.create({ data: auditData(actor, 'PRODUCT_IMAGE_RETIRED', 'ProductImage', imageId, { productId, fromVersion: expectedVersion, toVersion: version }) });
    }));
  }

  listInventory(query: ProductListQuery) { return this.listProducts(query); }

  async listSuppliers(query: SupplierListQuery) {
    const where: Prisma.SupplierWhereInput = {
      ...(query.active === undefined ? {} : { active: query.active }),
      ...(query.search ? { OR: [
        { name: { contains: query.search } },
        { contactName: { contains: query.search } },
        { email: { contains: query.search } },
        { phone: { contains: query.search } },
      ] } : {}),
    };
    const rows = await this.prisma.supplier.findMany({ where, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: query.limit + 1, ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}) });
    const result = page(rows, query.limit, (value) => value.id);
    return { data: result.data.map(mapSupplier), nextCursor: result.nextCursor };
  }

  async getSupplier(id: string) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id } });
    if (!supplier) throw notFound('Supplier not found');
    return { supplier: mapSupplier(supplier) };
  }

  createSupplier(actor: AdminActor, input: SupplierWrite) {
    return this.coordinator.run(() => this.prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.create({ data: {
        name: input.name,
        contactName: cleanOptional(input.contactName),
        email: cleanOptional(input.email),
        phone: cleanOptional(input.phone),
        address: cleanOptional(input.address),
        notes: cleanOptional(input.notes),
      } });
      await tx.auditLog.create({ data: auditData(actor, 'SUPPLIER_CREATED', 'Supplier', supplier.id, { name: supplier.name }) });
      return { supplier: mapSupplier(supplier) };
    })).catch(throwCmsWriteError);
  }

  updateSupplier(actor: AdminActor, id: string, input: SupplierPatch) {
    return this.coordinator.run(() => this.prisma.$transaction(async (tx) => {
      const existing = await tx.supplier.findUnique({ where: { id } });
      if (!existing) throw notFound('Supplier not found');
      const changed = await tx.supplier.updateMany({ where: { id, version: input.expectedVersion }, data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.contactName !== undefined ? { contactName: cleanOptional(input.contactName) } : {}),
        ...(input.email !== undefined ? { email: cleanOptional(input.email) } : {}),
        ...(input.phone !== undefined ? { phone: cleanOptional(input.phone) } : {}),
        ...(input.address !== undefined ? { address: cleanOptional(input.address) } : {}),
        ...(input.notes !== undefined ? { notes: cleanOptional(input.notes) } : {}),
        version: { increment: 1 },
      } });
      if (changed.count !== 1) throw conflict('SUPPLIER_CHANGED', 'Supplier was modified by another administrator');
      await tx.auditLog.create({ data: auditData(actor, 'SUPPLIER_UPDATED', 'Supplier', id, { fromVersion: input.expectedVersion, toVersion: input.expectedVersion + 1, nameChanged: input.name !== undefined }) });
      const supplier = await tx.supplier.findUniqueOrThrow({ where: { id } });
      return { supplier: mapSupplier(supplier) };
    }));
  }

  setSupplierActive(actor: AdminActor, id: string, active: boolean, expectedVersion: number) {
    return this.coordinator.run(() => this.prisma.$transaction(async (tx) => {
      const existing = await tx.supplier.findUnique({ where: { id } });
      if (!existing) throw notFound('Supplier not found');
      if (existing.version !== expectedVersion) throw conflict('SUPPLIER_CHANGED', 'Supplier was modified by another administrator');
      if (existing.active === active) return { id, active, version: existing.version };
      const changed = await tx.supplier.updateMany({ where: { id, version: expectedVersion }, data: { active, version: { increment: 1 } } });
      if (changed.count !== 1) throw conflict('SUPPLIER_CHANGED', 'Supplier was modified by another administrator');
      await tx.auditLog.create({ data: auditData(actor, active ? 'SUPPLIER_REACTIVATED' : 'SUPPLIER_DEACTIVATED', 'Supplier', id) });
      return { id, active, version: expectedVersion + 1 };
    }));
  }

  async listInventoryAdjustments(productId: string, cursor: string | undefined, limit: number) {
    const exists = await this.prisma.product.count({ where: { id: productId } });
    if (!exists) throw notFound('Product not found');
    const rows = await this.prisma.inventoryAdjustment.findMany({ where: { productId }, include: { createdBy: { select: { id: true, email: true, name: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) });
    const result = page(rows, limit, (value) => value.id);
    return { data: result.data, nextCursor: result.nextCursor };
  }

  adjustInventory(actor: AdminActor, productId: string, delta: number, reason: string) {
    return this.coordinator.run(() => this.prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({ where: { id: productId }, include: { inventory: true } });
      if (!product?.inventory) throw notFound('Product not found');
      const next = product.inventory.onHand + delta;
      if (next < product.inventory.reserved) throw conflict('STOCK_BELOW_RESERVED', 'Adjustment would consume reserved stock');
      if (product.stockMode === 'UNIQUE' && next > 1) throw badRequest('UNIQUE_STOCK_INVALID', 'Unique products cannot have more than one unit');
      const changed = await tx.inventory.updateMany({ where: { productId, version: product.inventory.version }, data: { onHand: next, version: { increment: 1 } } });
      if (changed.count !== 1) throw conflict('INVENTORY_CHANGED', 'Inventory was modified concurrently');
      await tx.inventoryAdjustment.create({ data: { productId, delta, reason, createdById: actor.adminId } });
      await tx.auditLog.create({ data: auditData(actor, 'INVENTORY_ADJUSTED', 'Product', productId, { delta, reason, previousOnHand: product.inventory.onHand, onHand: next }) });
      return { productId, onHand: next, reserved: product.inventory.reserved, available: next - product.inventory.reserved, version: product.inventory.version + 1 };
    }));
  }

  async listOrders(query: OrderListQuery) {
    const rows = await this.prisma.order.findMany({ where: orderWhere(query), include: orderDetailInclude, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: query.limit + 1, ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}) });
    const result = page(rows, query.limit, (value) => value.id);
    return { data: result.data.map(mapOrder), nextCursor: result.nextCursor };
  }

  async getOrder(number: string) {
    const order = await this.prisma.order.findUnique({ where: { number }, include: orderDetailInclude });
    if (!order) throw notFound('Order not found');
    return { order: mapOrder(order) };
  }

  cancelOrder(actor: AdminActor, number: string, expectedVersion: number, note?: string): Promise<OrderStatusMutationDto> {
    return this.coordinator.run(() => this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { number } });
      if (!order) throw notFound('Order not found');
      if (!['PENDING_PAYMENT', 'PAYMENT_REVIEW'].includes(order.status)) throw conflict('ORDER_NOT_CANCELLABLE', 'Order cannot be cancelled');
      await updateOrderVersion(tx, order.id, expectedVersion, { status: 'CANCELLED' });
      await releaseReservations(tx, order.id);
      await releaseOrderLoyaltyReservation(tx, order.id);
      await tx.orderStatusHistory.create({ data: { orderId: order.id, fromStatus: order.status, toStatus: 'CANCELLED', note: note ?? 'Cancelled by administrator', changedById: actor.adminId } });
      await tx.auditLog.create({ data: auditData(actor, 'ORDER_CANCELLED', 'Order', order.id, { number, fromStatus: order.status }) });
      return { number, status: 'CANCELLED', version: expectedVersion + 1 };
    }));
  }

  transitionOrder(actor: AdminActor, number: string, expectedVersion: number, status: OrderStatusValue, note?: string) {
    return this.coordinator.run(() => this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { number } });
      if (!order) throw notFound('Order not found');
      if (!allowedOrderTransitions[order.status].includes(status)) throw conflict('INVALID_ORDER_TRANSITION', `Order cannot transition from ${order.status} to ${status}`);
      if (status === 'READY_FOR_PICKUP' && order.fulfillmentType !== 'PICKUP') throw conflict('INVALID_FULFILLMENT_TRANSITION', 'Only pickup orders can become ready for pickup');
      if (status === 'SHIPPED' && order.fulfillmentType !== 'SHIPMENT') throw conflict('INVALID_FULFILLMENT_TRANSITION', 'Only shipment orders can be shipped');
      await updateOrderVersion(tx, order.id, expectedVersion, { status });
      await tx.orderStatusHistory.create({ data: { orderId: order.id, fromStatus: order.status, toStatus: status, note, changedById: actor.adminId } });
      await tx.auditLog.create({ data: auditData(actor, 'ORDER_STATUS_CHANGED', 'Order', order.id, { number, fromStatus: order.status, toStatus: status }) });
      return { number, status, version: expectedVersion + 1 };
    }));
  }

  reviewTransfer(actor: AdminActor, number: string, receiptId: string, expectedVersion: number, decision: 'APPROVED' | 'REJECTED', note?: string): Promise<TransferReviewDto> {
    return this.coordinator.run(() => this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { number }, include: { payment: { include: { transfer: true } }, transferReceipts: true } });
      if (!order?.payment?.transfer || order.paymentMethod !== 'BANK_TRANSFER') throw notFound('Bank transfer order not found');
      const receipt = order.transferReceipts.find((value) => value.id === receiptId);
      if (!receipt) throw notFound('Transfer receipt not found');
      if (receipt.review !== 'PENDING' || !['PENDING_PAYMENT', 'PAYMENT_REVIEW'].includes(order.status)) throw conflict('TRANSFER_NOT_REVIEWABLE', 'Transfer receipt is no longer reviewable');
      const now = new Date();
      if (decision === 'APPROVED') {
        await consumeReservations(tx, order.id);
        await updateOrderVersion(tx, order.id, expectedVersion, { status: 'PAID' });
        await tx.payment.update({ where: { id: order.payment.id }, data: { status: 'APPROVED' } });
        await tx.bankTransfer.update({ where: { id: order.payment.transfer.id }, data: { reviewStatus: 'APPROVED', reviewedAt: now, reviewedById: actor.adminId } });
        await tx.transferReceipt.update({ where: { id: receiptId }, data: { review: 'APPROVED', note, reviewedAt: now, reviewedById: actor.adminId } });
        await tx.transferReceipt.updateMany({ where: { orderId: order.id, id: { not: receiptId }, review: 'PENDING' }, data: { review: 'REJECTED', note: 'Superseded by approved receipt', reviewedAt: now, reviewedById: actor.adminId } });
        await tx.orderStatusHistory.create({ data: { orderId: order.id, fromStatus: order.status, toStatus: 'PAID', note: note ?? 'Transfer approved', changedById: actor.adminId } });
        await settleOrderLoyalty(tx, order.id);
      } else {
        await updateOrderVersion(tx, order.id, expectedVersion, { status: 'CANCELLED' });
        await releaseReservations(tx, order.id);
        await tx.payment.update({ where: { id: order.payment.id }, data: { status: 'REJECTED' } });
        await tx.bankTransfer.update({ where: { id: order.payment.transfer.id }, data: { reviewStatus: 'REJECTED', reviewedAt: now, reviewedById: actor.adminId } });
        await tx.transferReceipt.update({ where: { id: receiptId }, data: { review: 'REJECTED', note, reviewedAt: now, reviewedById: actor.adminId } });
        await tx.transferReceipt.updateMany({
          where: { orderId: order.id, id: { not: receiptId }, review: 'PENDING' },
          data: {
            review: 'REJECTED',
            note: 'Superseded by rejected order',
            reviewedAt: now,
            reviewedById: actor.adminId,
          },
        });
        await tx.orderStatusHistory.create({ data: { orderId: order.id, fromStatus: order.status, toStatus: 'CANCELLED', note: note ?? 'Transfer rejected', changedById: actor.adminId } });
        await releaseOrderLoyaltyReservation(tx, order.id);
      }
      await tx.auditLog.create({ data: auditData(actor, `TRANSFER_${decision}`, 'TransferReceipt', receiptId, { orderId: order.id, number }) });
      return { number, receiptId, decision, status: decision === 'APPROVED' ? 'PAID' : 'CANCELLED', version: expectedVersion + 1 };
    }));
  }

  fulfillLatePayment(actor: AdminActor, number: string, expectedVersion: number): Promise<OrderStatusMutationDto> {
    return this.coordinator.run(() => this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { number }, include: { payment: true, reservations: true } });
      if (!order?.payment) throw notFound('Order not found');
      if (order.status !== 'PAYMENT_REQUIRES_REVIEW' || order.payment.status !== 'APPROVED') throw conflict('LATE_PAYMENT_NOT_FULFILLABLE', 'Payment is not an approved late payment');
      if (!order.reservations.length) throw conflict('RESERVATION_NOT_FOUND', 'Order has no stock reservation records');
      for (const reservation of order.reservations) {
        if (reservation.consumedAt) continue;
        const inventory = await tx.inventory.findUniqueOrThrow({ where: { productId: reservation.productId } });
        const isStillReserved = reservation.releasedAt === null;
        if (isStillReserved ? inventory.onHand < reservation.quantity || inventory.reserved < reservation.quantity : inventory.onHand - inventory.reserved < reservation.quantity) throw conflict('OUT_OF_STOCK', 'Stock is no longer available for the late payment', { productId: reservation.productId });
        const changed = await tx.inventory.updateMany({ where: { productId: reservation.productId, version: inventory.version }, data: { onHand: { decrement: reservation.quantity }, ...(isStillReserved ? { reserved: { decrement: reservation.quantity } } : {}), version: { increment: 1 } } });
        if (changed.count !== 1) throw conflict('INVENTORY_CHANGED', 'Inventory changed while fulfilling late payment');
        await tx.inventoryReservation.update({ where: { id: reservation.id }, data: { releasedAt: null, consumedAt: new Date() } });
      }
      await updateOrderVersion(tx, order.id, expectedVersion, { status: 'PAID' });
      await tx.orderStatusHistory.create({ data: { orderId: order.id, fromStatus: order.status, toStatus: 'PAID', note: 'Late payment manually accepted after stock validation', changedById: actor.adminId } });
      await settleOrderLoyalty(tx, order.id);
      await tx.auditLog.create({ data: auditData(actor, 'LATE_PAYMENT_FULFILLED', 'Order', order.id, { number }) });
      return { number, status: 'PAID', version: expectedVersion + 1 };
    }));
  }

  recordFullRefund(actor: AdminActor, number: string, expectedVersion: number, reason: string, externalReference: string): Promise<RefundDto> {
    return this.coordinator.run(() => this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { number }, include: { payment: { include: { refunds: true } } } });
      if (!order?.payment) throw notFound('Order not found');
      if (!['APPROVED', 'REQUIRES_REVIEW'].includes(order.payment.status) || order.payment.refunds.length) throw conflict('ORDER_NOT_REFUNDABLE', 'Order does not have a refundable payment');
      const refund = await tx.refundRecord.create({ data: { paymentId: order.payment.id, fullRefundKey: order.payment.id, amountMinor: order.payment.amountMinor, currency: order.payment.currency, reason, externalReference, createdById: actor.adminId } });
      await tx.payment.update({ where: { id: order.payment.id }, data: { status: 'REFUNDED' } });
      await updateOrderVersion(tx, order.id, expectedVersion, { status: 'REFUND_RECORDED' });
      await tx.orderStatusHistory.create({ data: { orderId: order.id, fromStatus: order.status, toStatus: 'REFUND_RECORDED', note: `Full refund recorded: ${reason}`, changedById: actor.adminId } });
      await reverseOrderLoyalty(tx, order.id);
      await tx.auditLog.create({ data: auditData(actor, 'FULL_REFUND_RECORDED', 'Order', order.id, { number, refundId: refund.id, externalReference }) });
      return { refundId: refund.id, number, status: 'REFUND_RECORDED', amount: money(refund.amountMinor, refund.currency), version: expectedVersion + 1 };
    }));
  }

  async listPayments(query: OrderListQuery, queue?: 'TRANSFER_REVIEW' | 'MERCADO_PAGO_REVIEW') {
    const adjusted: OrderListQuery = { ...query, ...(queue === 'TRANSFER_REVIEW' ? { paymentMethod: 'BANK_TRANSFER', paymentStatus: 'UNDER_REVIEW' } : {}), ...(queue === 'MERCADO_PAGO_REVIEW' ? { paymentMethod: 'MERCADO_PAGO', paymentStatus: 'REQUIRES_REVIEW' } : {}) };
    return this.listOrders(adjusted);
  }

  async getLoyaltyProgram() {
    return mapLoyaltyProgram(await getLoyaltyProgram(this.prisma));
  }

  updateLoyaltyProgram(actor: AdminActor, input: LoyaltyProgramWrite) {
    return this.coordinator.run(() => this.prisma.$transaction(async (tx) => {
      const spendPerPointMinor = parseMinor(input.spendPerPointMinor);
      const pointValueMinor = parseMinor(input.pointValueMinor);
      if (spendPerPointMinor <= 0n || pointValueMinor <= 0n) throw badRequest('INVALID_LOYALTY_RULE', 'Los importes de fidelidad deben ser mayores a cero');
      const changed = await tx.loyaltyProgram.updateMany({
        where: { id: 'default', version: input.expectedVersion },
        data: {
          enabled: input.enabled,
          spendPerPointMinor,
          pointsPerStep: input.pointsPerStep,
          pointValueMinor,
          minimumRedemptionPoints: input.minimumRedemptionPoints,
          maximumRedemptionPercent: input.maximumRedemptionPercent,
          updatedById: actor.adminId,
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1) {
        if (!await tx.loyaltyProgram.count({ where: { id: 'default' } })) throw notFound('Loyalty program not found');
        throw conflict('LOYALTY_PROGRAM_CHANGED', 'La configuración fue modificada por otro administrador');
      }
      const program = await getLoyaltyProgram(tx);
      await tx.auditLog.create({ data: auditData(actor, 'LOYALTY_PROGRAM_UPDATED', 'LoyaltyProgram', program.id, { enabled: program.enabled, version: program.version, spendPerPointMinor: program.spendPerPointMinor.toString(), pointsPerStep: program.pointsPerStep, pointValueMinor: program.pointValueMinor.toString(), minimumRedemptionPoints: program.minimumRedemptionPoints, maximumRedemptionPercent: program.maximumRedemptionPercent }) });
      return mapLoyaltyProgram(program);
    }));
  }

  async getFulfillment() {
    const [zones, pickupPoints] = await Promise.all([
      this.prisma.shippingZone.findMany({ include: { provinces: { orderBy: { province: 'asc' } }, rates: { orderBy: [{ active: 'desc' }, { name: 'asc' }] } }, orderBy: [{ active: 'desc' }, { name: 'asc' }] }),
      this.prisma.pickupPoint.findMany({ orderBy: [{ active: 'desc' }, { name: 'asc' }] }),
    ]);
    return { shippingZones: zones.map(mapZone), pickupPoints };
  }

  createShippingZone(actor: AdminActor, input: ShippingZoneWrite) {
    return this.coordinator.run(() => this.prisma.$transaction(async (tx) => {
      await assertProvincesAvailable(tx, input.provinces, undefined, input.active);
      const zone = await tx.shippingZone.create({ data: { name: input.name, active: input.active, provinces: { create: normalizedProvinces(input.provinces).map((province) => ({ province })) }, rates: { create: input.rates.map((rate) => ({ name: rate.name, priceMinor: parseMinor(rate.priceMinor), currency: 'ARS', active: rate.active })) } }, include: { provinces: true, rates: true } });
      await tx.auditLog.create({ data: auditData(actor, 'SHIPPING_ZONE_CREATED', 'ShippingZone', zone.id, { name: zone.name }) });
      return { shippingZone: mapZone(zone) };
    }));
  }

  updateShippingZone(actor: AdminActor, id: string, input: ShippingZoneWrite) {
    return this.coordinator.run(() => this.prisma.$transaction(async (tx) => {
      const existing = await tx.shippingZone.findUnique({ where: { id }, include: { rates: true } });
      if (!existing) throw notFound('Shipping zone not found');
      await assertProvincesAvailable(tx, input.provinces, id, input.active);
      await tx.shippingZone.update({ where: { id }, data: { name: input.name, active: input.active } });
      await tx.shippingZoneProvince.deleteMany({ where: { zoneId: id } });
      await tx.shippingZoneProvince.createMany({ data: normalizedProvinces(input.provinces).map((province) => ({ zoneId: id, province })) });
      const receivedIds = input.rates.flatMap((rate) => rate.id ? [rate.id] : []);
      await tx.shippingRate.updateMany({ where: { zoneId: id, id: { notIn: receivedIds } }, data: { active: false } });
      for (const rate of input.rates) {
        if (rate.id) {
          const changed = await tx.shippingRate.updateMany({ where: { id: rate.id, zoneId: id }, data: { name: rate.name, priceMinor: parseMinor(rate.priceMinor), active: rate.active } });
          if (changed.count !== 1) throw badRequest('INVALID_SHIPPING_RATE', 'Shipping rate does not belong to the zone');
        } else await tx.shippingRate.create({ data: { zoneId: id, name: rate.name, priceMinor: parseMinor(rate.priceMinor), currency: 'ARS', active: rate.active } });
      }
      await tx.auditLog.create({ data: auditData(actor, 'SHIPPING_ZONE_UPDATED', 'ShippingZone', id, { name: input.name, active: input.active }) });
      const zone = await tx.shippingZone.findUniqueOrThrow({ where: { id }, include: { provinces: true, rates: true } });
      return { shippingZone: mapZone(zone) };
    }));
  }

  setShippingZoneActive(actor: AdminActor, id: string, active: boolean) {
    return this.coordinator.run(() => this.prisma.$transaction(async (tx) => {
      const existing = await tx.shippingZone.findUnique({ where: { id }, include: { provinces: true } });
      if (!existing) throw notFound('Shipping zone not found');
      await assertProvincesAvailable(tx, existing.provinces.map((value) => value.province), id, active);
      await tx.shippingZone.update({ where: { id }, data: { active } });
      await tx.auditLog.create({ data: auditData(actor, active ? 'SHIPPING_ZONE_ACTIVATED' : 'SHIPPING_ZONE_DEACTIVATED', 'ShippingZone', id) });
      return { id, active };
    }));
  }

  createPickupPoint(actor: AdminActor, input: PickupPointWrite) {
    return this.coordinator.run(() => this.prisma.$transaction(async (tx) => {
      const point = await tx.pickupPoint.create({ data: input });
      await tx.auditLog.create({ data: auditData(actor, 'PICKUP_POINT_CREATED', 'PickupPoint', point.id, { name: point.name }) });
      return { pickupPoint: point };
    }));
  }

  updatePickupPoint(actor: AdminActor, id: string, input: PickupPointWrite) {
    return this.coordinator.run(() => this.prisma.$transaction(async (tx) => {
      const exists = await tx.pickupPoint.count({ where: { id } });
      if (!exists) throw notFound('Pickup point not found');
      const point = await tx.pickupPoint.update({ where: { id }, data: input });
      await tx.auditLog.create({ data: auditData(actor, 'PICKUP_POINT_UPDATED', 'PickupPoint', id, { name: point.name, active: point.active }) });
      return { pickupPoint: point };
    }));
  }

  setPickupPointActive(actor: AdminActor, id: string, active: boolean) {
    return this.coordinator.run(() => this.prisma.$transaction(async (tx) => {
      const exists = await tx.pickupPoint.count({ where: { id } });
      if (!exists) throw notFound('Pickup point not found');
      await tx.pickupPoint.update({ where: { id }, data: { active } });
      await tx.auditLog.create({ data: auditData(actor, active ? 'PICKUP_POINT_ACTIVATED' : 'PICKUP_POINT_DEACTIVATED', 'PickupPoint', id) });
      return { id, active };
    }));
  }

  async listCustomers(query: CustomerListQuery) {
    const where: Prisma.UserWhereInput = {
      ...(query.search ? { OR: [{ email: { contains: query.search } }, { name: { contains: query.search } }] } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.verified === undefined ? {} : query.verified ? { emailVerifiedAt: { not: null } } : { emailVerifiedAt: null }),
    };
    const rows = await this.prisma.user.findMany({ where, include: { _count: { select: { orders: true } }, loyaltyAccount: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: query.limit + 1, ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}) });
    const result = page(rows, query.limit, (value) => value.id);
    const paidTotals = result.data.length
      ? await this.prisma.order.groupBy({
        by: ['userId'],
        where: { userId: { in: result.data.map((user) => user.id) }, payment: { is: { status: { in: ['APPROVED', 'REFUNDED'] } } } },
        _sum: { totalMinor: true },
      })
      : [];
    const paidByUser = new Map(paidTotals.map((total) => [total.userId, total._sum.totalMinor ?? 0n]));
    return {
      data: result.data.map((user) => ({
        id: user.id, email: user.email, name: user.name, status: user.status, emailVerifiedAt: user.emailVerifiedAt,
        createdAt: user.createdAt, ordersCount: user._count.orders, paidTotal: money(paidByUser.get(user.id) ?? 0n), loyalty: mapLoyaltyAccount(user.loyaltyAccount),
      })),
      nextCursor: result.nextCursor,
    };
  }

  async getCustomer(id: string) {
    const [customer, paid] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id },
        include: {
          _count: { select: { orders: true } },
          loyaltyAccount: true,
          orders: { include: orderDetailInclude, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 20 },
        },
      }),
      this.prisma.order.aggregate({
        where: { userId: id, payment: { is: { status: { in: ['APPROVED', 'REFUNDED'] } } } },
        _sum: { totalMinor: true },
      }),
    ]);
    if (!customer) throw notFound('Customer not found');
    return {
      customer: {
        id: customer.id, email: customer.email, name: customer.name, status: customer.status,
        emailVerifiedAt: customer.emailVerifiedAt, createdAt: customer.createdAt, updatedAt: customer.updatedAt,
        ordersCount: customer._count.orders, paidTotal: money(paid._sum.totalMinor ?? 0n), loyalty: mapLoyaltyAccount(customer.loyaltyAccount),
        orders: customer.orders.map(mapOrder),
      },
    };
  }

  async listCustomerOrders(id: string, cursor: string | undefined, limit: number) {
    if (!await this.prisma.user.count({ where: { id } })) throw notFound('Customer not found');
    const rows = await this.prisma.order.findMany({
      where: { userId: id },
      include: orderDetailInclude,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    const result = page(rows, limit, (order) => order.id);
    return { data: result.data.map(mapOrder), nextCursor: result.nextCursor };
  }

  async listAudit(query: AuditListQuery) {
    const rows = await this.prisma.auditLog.findMany({ where: {
      ...(query.actorId ? { actorId: query.actorId } : {}), ...(query.action ? { action: query.action } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}), ...(query.requestId ? { requestId: query.requestId } : {}),
      ...(query.from || query.to ? { createdAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } } : {}),
    }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: query.limit + 1, ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}) });
    const result = page(rows, query.limit, (value) => value.id);
    return { data: result.data.map((entry) => ({ ...entry, metadata: redact(parseJson(entry.metadata ?? 'null')) })), nextCursor: result.nextCursor };
  }
}

function productWhere(query: ProductListQuery): Prisma.ProductWhereInput {
  return {
    ...(query.search ? { OR: [{ sku: { contains: query.search } }, { name: { contains: query.search } }, { slug: { contains: query.search } }] } : {}),
    ...(query.status ? { status: query.status } : {}), ...(query.kind ? { kind: query.kind } : {}),
    ...(query.pokemonType || query.setName ? { pokemonCard: { is: { ...(query.pokemonType ? { pokemonType: query.pokemonType } : {}), ...(query.setName ? { setName: query.setName } : {}) } } } : {}),
  };
}

function orderWhere(query: OrderListQuery): Prisma.OrderWhereInput {
  return {
    ...(query.search ? { OR: [{ number: { contains: query.search } }, { user: { is: { email: { contains: query.search } } } }] } : {}),
    ...(query.status ? { status: query.status } : {}), ...(query.paymentMethod ? { paymentMethod: query.paymentMethod } : {}),
    ...(query.paymentStatus ? { payment: { is: { status: query.paymentStatus } } } : {}), ...(query.fulfillmentType ? { fulfillmentType: query.fulfillmentType } : {}),
    ...(query.from || query.to ? { createdAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } } : {}),
  };
}

function mapCardWrite(input: NonNullable<ProductWrite['pokemonCard']>) {
  return {
    pokemonType: input.pokemonType ?? null, setName: input.setName, setCode: cleanOptional(input.setCode), cardNumber: input.cardNumber,
    rarity: input.rarity, language: input.language, condition: input.condition, finish: cleanOptional(input.finish), edition: cleanOptional(input.edition),
    gradingCompany: cleanOptional(input.gradingCompany), grade: cleanOptional(input.grade), certificationNumber: cleanOptional(input.certificationNumber),
  };
}

async function updateOrderVersion(tx: Prisma.TransactionClient, id: string, expectedVersion: number, data: Prisma.OrderUpdateManyMutationInput) {
  const changed = await tx.order.updateMany({ where: { id, version: expectedVersion }, data: { ...data, version: { increment: 1 } } });
  if (changed.count !== 1) throw conflict('ORDER_CHANGED', 'Order was modified by another administrator');
}

async function incrementProductVersion(tx: Prisma.TransactionClient, id: string, expectedVersion: number): Promise<number> {
  const changed = await tx.product.updateMany({ where: { id, version: expectedVersion }, data: { version: { increment: 1 } } });
  if (changed.count === 1) return expectedVersion + 1;
  if (await tx.product.count({ where: { id } }) === 0) throw notFound('Product not found');
  throw conflict('PRODUCT_CHANGED', 'Product was modified by another administrator');
}

async function releaseReservations(tx: Prisma.TransactionClient, orderId: string) {
  const reservations = await tx.inventoryReservation.findMany({ where: { orderId, releasedAt: null, consumedAt: null } });
  for (const reservation of reservations) {
    const changed = await tx.inventory.updateMany({ where: { productId: reservation.productId, reserved: { gte: reservation.quantity } }, data: { reserved: { decrement: reservation.quantity }, version: { increment: 1 } } });
    if (changed.count !== 1) throw conflict('INVENTORY_RESERVATION_INVALID', 'Reserved stock is inconsistent');
    await tx.inventoryReservation.update({ where: { id: reservation.id }, data: { releasedAt: new Date() } });
  }
}

async function consumeReservations(tx: Prisma.TransactionClient, orderId: string) {
  const reservations = await tx.inventoryReservation.findMany({ where: { orderId, releasedAt: null, consumedAt: null } });
  if (!reservations.length) throw conflict('RESERVATION_NOT_ACTIVE', 'Order no longer has an active stock reservation');
  for (const reservation of reservations) {
    const changed = await tx.inventory.updateMany({ where: { productId: reservation.productId, onHand: { gte: reservation.quantity }, reserved: { gte: reservation.quantity } }, data: { onHand: { decrement: reservation.quantity }, reserved: { decrement: reservation.quantity }, version: { increment: 1 } } });
    if (changed.count !== 1) throw conflict('INVENTORY_RESERVATION_INVALID', 'Reserved stock is inconsistent');
    await tx.inventoryReservation.update({ where: { id: reservation.id }, data: { consumedAt: new Date() } });
  }
}

const normalizedProvinces = (values: readonly string[]) => {
  const seen = new Set<string>();
  return values.map((value) => value.trim()).filter((value) => {
    const key = value.toLocaleLowerCase('es-AR');
    if (!value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

async function assertProvincesAvailable(tx: Db, provinces: readonly string[], excludingZoneId: string | undefined, active: boolean) {
  if (!active) return;
  const normalized = normalizedProvinces(provinces);
  if (!normalized.length) throw badRequest('PROVINCES_REQUIRED', 'At least one province is required');
  const assigned = await tx.shippingZoneProvince.findMany({ where: { zone: { active: true, ...(excludingZoneId ? { id: { not: excludingZoneId } } : {}) } }, include: { zone: true } });
  const requested = new Set(normalized.map((value) => value.toLocaleLowerCase('es-AR')));
  const duplicate = assigned.find((value) => requested.has(value.province.trim().toLocaleLowerCase('es-AR')));
  if (duplicate) throw conflict('PROVINCE_ALREADY_ASSIGNED', `${duplicate.province} already belongs to active zone ${duplicate.zone.name}`);
}

function mapZone<T extends { id: string; name: string; active: boolean; createdAt: Date; updatedAt: Date; provinces: readonly { province: string }[]; rates: readonly { id: string; name: string; priceMinor: bigint; currency: string; active: boolean }[] }>(zone: T) {
  return { id: zone.id, name: zone.name, active: zone.active, provinces: zone.provinces.map((value) => value.province), rates: zone.rates.map((rate) => ({ id: rate.id, name: rate.name, price: money(rate.priceMinor, rate.currency), active: rate.active })), createdAt: zone.createdAt, updatedAt: zone.updatedAt };
}

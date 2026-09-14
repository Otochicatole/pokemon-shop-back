import { Router, type Express, type RequestHandler } from 'express';
import { randomUUID, createCipheriv, createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { AffiliateListingStatus, AffiliatePayoutStatus, AffiliateStatus, ProductStatus } from '@prisma/client';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { currentAdmin, currentAffiliate, currentUser, requireAdmin, requireAffiliate } from '../../infrastructure/sessions.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { discardUnattachedFile, saveImage } from '../media/index.js';
import { BASE_CURRENCY } from '../../shared/currency.js';

const versionSchema = z.object({ expectedVersion: z.coerce.number().int().min(1) });
const baseProductFields = z.object({
  name: z.string().trim().min(2).max(180),
  description: z.string().trim().max(5000).default(''),
  kind: z.enum(['SINGLE_CARD', 'SEALED_PRODUCT', 'ACCESSORY']),
  stockMode: z.enum(['UNIQUE', 'QUANTITY']).default('QUANTITY'),
  priceMinor: z.coerce.bigint().nonnegative(),
  stock: z.coerce.number().int().nonnegative().max(1_000_000),
  pokemonCard: z.object({
    setName: z.string().trim().min(1).max(180), setCode: z.string().trim().max(30).optional(), cardNumber: z.string().trim().min(1).max(30),
    rarity: z.string().trim().min(1).max(100), language: z.string().trim().min(1).max(50), condition: z.enum(['NM', 'EXCELLENT', 'GOOD', 'PLAYED', 'DAMAGED']),
    pokemonType: z.enum(['COLORLESS', 'DARKNESS', 'DRAGON', 'FAIRY', 'FIGHTING', 'FIRE', 'GRASS', 'LIGHTNING', 'METAL', 'PSYCHIC', 'WATER']).optional(),
    finish: z.string().trim().max(50).optional(), edition: z.string().trim().max(100).optional(), gradingCompany: z.string().trim().max(100).optional(), grade: z.string().trim().max(30).optional(), certificationNumber: z.string().trim().max(100).optional(),
  }).optional(),
});
const productFields = baseProductFields.superRefine((value, context) => {
  if (value.kind === 'SINGLE_CARD' && !value.pokemonCard) context.addIssue({ code: 'custom', path: ['pokemonCard'], message: 'Card metadata is required for single cards' });
  if (value.kind !== 'SINGLE_CARD' && value.pokemonCard) context.addIssue({ code: 'custom', path: ['pokemonCard'], message: 'Card metadata is only valid for single cards' });
  if (value.stockMode === 'UNIQUE' && value.stock > 1) context.addIssue({ code: 'custom', path: ['stock'], message: 'Unique products can only have one unit' });
});

const updateProductFields = baseProductFields.partial().extend({ expectedVersion: z.coerce.number().int().min(1) });
const listingReviewSchema = versionSchema.extend({ decision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REJECTED']), note: z.string().trim().max(500).optional() });
const profilePatchSchema = versionSchema.extend({ publicName: z.string().trim().min(2).max(120).optional(), contactPhone: z.string().trim().max(50).nullable().optional(), payoutAccount: z.string().trim().min(4).max(500).nullable().optional() });
const zoneSchema = z.object({ name: z.string().trim().min(2).max(120), provinces: z.array(z.string().trim().min(2).max(120)).min(1).max(100) });
const rateSchema = z.object({ name: z.string().trim().min(2).max(120), priceMinor: z.coerce.bigint().nonnegative() });
const pickupSchema = z.object({ name: z.string().trim().min(2).max(120), address: z.string().trim().min(3).max(300) });
const payoutSchema = z.object({ amountMinor: z.coerce.bigint().positive() });
const statusSchema = versionSchema.extend({ status: z.enum(['PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'SHIPPED', 'COMPLETED']), note: z.string().trim().max(500).optional() });

const productInclude = {
  inventory: true,
  images: { where: { retiredAt: null }, orderBy: [{ sortOrder: 'asc' as const }, { id: 'asc' as const }], include: { file: true } },
  affiliateListing: true,
  pokemonCard: true,
} satisfies Prisma.ProductInclude;

type ProductRecord = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

function money(value: bigint) { return value.toString(); }
function productDto(product: ProductRecord) {
  return {
    id: product.id, sku: product.sku, slug: product.slug, name: product.name, description: product.description,
    kind: product.kind, stockMode: product.stockMode, priceMinor: money(product.priceMinor), status: product.status, version: product.version,
    inventory: product.inventory ? { onHand: product.inventory.onHand, reserved: product.inventory.reserved, available: product.inventory.onHand - product.inventory.reserved, version: product.inventory.version } : null,
    pokemonCard: product.pokemonCard,
    images: product.images.map((image) => ({ id: image.id, fileId: image.fileId, url: `/media/public/${image.fileId}`, altText: image.altText, sortOrder: image.sortOrder })),
    listing: product.affiliateListing ? { id: product.affiliateListing.id, status: product.affiliateListing.status, reviewNote: product.affiliateListing.reviewNote, submittedAt: product.affiliateListing.submittedAt, reviewedAt: product.affiliateListing.reviewedAt } : null,
    createdAt: product.createdAt, updatedAt: product.updatedAt,
  };
}

function listingDto(value: Prisma.AffiliateListingGetPayload<{ include: { product: { include: typeof productInclude } } }>) {
  return { id: value.id, status: value.status, reviewNote: value.reviewNote, submittedAt: value.submittedAt, reviewedAt: value.reviewedAt, product: productDto(value.product), createdAt: value.createdAt, updatedAt: value.updatedAt };
}

function auditData(actorType: 'USER' | 'ADMIN', actorId: string, action: string, entityType: string, entityId: string, metadata?: unknown): Prisma.AuditLogCreateInput {
  return { actorType, actorId, action, entityType, entityId, metadata: metadata === undefined ? undefined : JSON.stringify(metadata) };
}

function slugify(value: string) { return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'producto'; }
function encryptedKey() { return createHash('sha256').update(env.AFFILIATE_BANK_ENCRYPTION_KEY ?? env.SESSION_SECRET).digest(); }
function seal(value: string | null | undefined) {
  if (!value) return { cipher: null, last4: null };
  const iv = Buffer.from(randomUUID().replaceAll('-', '').slice(0, 24), 'hex');
  const cipher = createCipheriv('aes-256-gcm', encryptedKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { cipher: `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${ciphertext.toString('base64')}`, last4: value.slice(-4) };
}

function affiliateDto(value: { id: string; userId: string; publicName: string; contactPhone: string | null; payoutAccountLast4: string | null; status: AffiliateStatus; version: number; createdAt: Date; updatedAt: Date; user?: { id: string; email: string; name: string | null; emailVerifiedAt: Date | null } | null }) {
  return { id: value.id, userId: value.userId, publicName: value.publicName, contactPhone: value.contactPhone, payoutAccountLast4: value.payoutAccountLast4, status: value.status, version: value.version, user: value.user ? { id: value.user.id, email: value.user.email, name: value.user.name, emailVerified: Boolean(value.user.emailVerifiedAt) } : undefined, createdAt: value.createdAt, updatedAt: value.updatedAt };
}

function affiliateListingItems(items: Array<{ id: string; productId: string; productName: string; quantity: number; unitPriceMinor: bigint; lineTotalMinor: bigint }> | undefined) {
  return items?.map((item) => ({ ...item, unitPriceMinor: money(item.unitPriceMinor), lineTotalMinor: money(item.lineTotalMinor) })) ?? [];
}

function affiliateSellerOrderDto(order: { items?: Array<{ id: string; productId: string; productName: string; quantity: number; unitPriceMinor: bigint; lineTotalMinor: bigint }>; subtotalMinor: bigint; shippingMinor: bigint; commissionMinor: bigint; sellerNetMinor: bigint; [key: string]: unknown }) {
  const { items, subtotalMinor, shippingMinor, commissionMinor, sellerNetMinor, order: _order, ...rest } = order;
  return { ...rest, subtotalMinor: money(subtotalMinor), shippingMinor: money(shippingMinor), commissionMinor: money(commissionMinor), sellerNetMinor: money(sellerNetMinor), items: affiliateListingItems(items) };
}

function affiliateLogisticsDto(zone: { id: string; name: string; active: boolean; provinces: Array<{ province: string }>; rates: Array<{ id: string; name: string; priceMinor: bigint; active: boolean }> }) {
  return { id: zone.id, name: zone.name, active: zone.active, provinces: zone.provinces, rates: zone.rates.map((rate) => ({ ...rate, priceMinor: money(rate.priceMinor) })) };
}

function affiliateOrThrow(request: Parameters<typeof currentAffiliate>[0]) {
  const affiliate = currentAffiliate(request);
  if (!affiliate) throw forbidden('Affiliate access is not active');
  return affiliate;
}

export function createAffiliateRouter(prisma: PrismaClient, upload: { array(fieldname: string, maxCount?: number): RequestHandler }, saveAffiliateImage: (file: Express.Multer.File) => Promise<{ id: string }>, discardFile: (id: string) => Promise<boolean>) {
  const router = Router();
  router.use(requireAffiliate);

  router.get('/profile', async (req, res) => {
    const affiliate = affiliateOrThrow(req);
    return res.json(affiliateDto(await prisma.affiliate.findUniqueOrThrow({ where: { id: affiliate.id }, include: { user: true } })));
  });
  router.patch('/profile', async (req, res) => {
    const affiliate = affiliateOrThrow(req);
    const input = profilePatchSchema.parse(req.body);
    const account = seal(input.payoutAccount);
    const changed = await prisma.affiliate.updateMany({ where: { id: affiliate.id, version: input.expectedVersion }, data: { ...(input.publicName !== undefined ? { publicName: input.publicName } : {}), ...(input.contactPhone !== undefined ? { contactPhone: input.contactPhone } : {}), ...(input.payoutAccount !== undefined ? { payoutAccountCipher: account.cipher, payoutAccountLast4: account.last4 } : {}), version: { increment: 1 } } });
    if (changed.count !== 1) throw conflict('AFFILIATE_CHANGED', 'Affiliate profile was modified by another request');
    return res.json(affiliateDto(await prisma.affiliate.findUniqueOrThrow({ where: { id: affiliate.id } })));
  });

  router.get('/listings', async (req, res) => {
    const affiliate = affiliateOrThrow(req);
    const status = req.query.status ? z.nativeEnum(AffiliateListingStatus).parse(String(req.query.status)) : undefined;
    const rows = await prisma.affiliateListing.findMany({ where: { affiliateId: affiliate.id, ...(status ? { status } : {}) }, orderBy: { updatedAt: 'desc' }, include: { product: { include: productInclude } } });
    return res.json(rows.map(listingDto));
  });
  router.post('/listings', async (req, res) => {
    const affiliate = affiliateOrThrow(req);
    const input = productFields.parse(req.body);
    const product = await prisma.$transaction(async (tx) => {
      const suffix = randomUUID().slice(0, 8);
      const created = await tx.product.create({ data: { sku: `AFF-${suffix.toUpperCase()}`, slug: `${slugify(input.name)}-${suffix}`, name: input.name, description: input.description, kind: input.kind, stockMode: input.stockMode, priceMinor: input.priceMinor, affiliateId: affiliate.id, status: ProductStatus.DRAFT, inventory: { create: { onHand: input.stock } }, ...(input.pokemonCard ? { pokemonCard: { create: input.pokemonCard } } : {}), affiliateListing: { create: { affiliateId: affiliate.id, status: AffiliateListingStatus.DRAFT } } }, include: { affiliateListing: true } });
      const listingId = created.affiliateListing?.id;
      if (!listingId) throw new Error('Affiliate listing was not created');
      await tx.auditLog.create({ data: auditData('USER', affiliate.userId, 'AFFILIATE_LISTING_CREATED', 'AffiliateListing', listingId, { productId: created.id }) });
      return created;
    });
    return res.status(201).json({ id: product.affiliateListing?.id, productId: product.id });
  });
  router.put('/listings/:id', async (req, res) => {
    const affiliate = affiliateOrThrow(req);
    const input = updateProductFields.parse(req.body);
    const listing = await prisma.affiliateListing.findFirst({ where: { id: String(req.params.id), affiliateId: affiliate.id }, include: { product: { include: { inventory: true } } } });
    if (!listing) throw notFound('Affiliate listing not found');
    if (listing.product.status === ProductStatus.ARCHIVED) throw conflict('LISTING_ARCHIVED', 'Archived listings cannot be edited');
    const data: Prisma.ProductUpdateInput = {
      ...(input.name !== undefined ? { name: input.name } : {}), ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}), ...(input.stockMode !== undefined ? { stockMode: input.stockMode } : {}), ...(input.priceMinor !== undefined ? { priceMinor: input.priceMinor } : {}),
      version: { increment: 1 },
    };
    await prisma.$transaction(async (tx) => {
      const changed = await tx.product.updateMany({ where: { id: listing.productId, version: input.expectedVersion }, data });
      if (changed.count !== 1) throw conflict('PRODUCT_CHANGED', 'Listing was modified by another request');
      if (input.stock !== undefined) {
        const previousStock = listing.product.inventory?.onHand ?? 0;
        const inventory = await tx.inventory.updateMany({ where: { productId: listing.productId, version: listing.product.inventory?.version ?? 1 }, data: { onHand: input.stock, version: { increment: 1 } } });
        if (inventory.count !== 1) throw conflict('INVENTORY_CHANGED', 'Inventory was modified by another request');
        if (input.stock !== previousStock) await tx.inventoryAdjustment.create({ data: { productId: listing.productId, delta: input.stock - previousStock, reason: 'Affiliate inventory update', affiliateId: affiliate.id } });
      }
      if (input.pokemonCard !== undefined) {
        await tx.pokemonCardDetails.deleteMany({ where: { productId: listing.productId } });
        if (input.pokemonCard) await tx.pokemonCardDetails.create({ data: { productId: listing.productId, ...input.pokemonCard } });
      }
      await tx.product.update({ where: { id: listing.productId }, data: { status: ProductStatus.DRAFT, publishedAt: null } });
      await tx.affiliateListing.update({ where: { id: listing.id }, data: { status: AffiliateListingStatus.DRAFT, reviewNote: null, submittedAt: null, reviewedAt: null, reviewedById: null } });
      await tx.auditLog.create({ data: auditData('USER', affiliate.userId, 'AFFILIATE_LISTING_UPDATED', 'AffiliateListing', listing.id, { fromVersion: input.expectedVersion, toVersion: input.expectedVersion + 1 }) });
    });
    return res.json({ id: listing.id, version: input.expectedVersion + 1 });
  });
  router.post('/listings/:id/submit', async (req, res) => {
    const affiliate = affiliateOrThrow(req);
    const listing = await prisma.affiliateListing.findFirst({ where: { id: String(req.params.id), affiliateId: affiliate.id }, include: { product: { include: { inventory: true, images: { where: { retiredAt: null } } } } } });
    if (!listing) throw notFound('Affiliate listing not found');
    const logistics = await prisma.$transaction(async (tx) => ({ zones: await tx.shippingZone.count({ where: { affiliateId: affiliate.id, active: true } }), pickups: await tx.pickupPoint.count({ where: { affiliateId: affiliate.id, active: true } }) }));
    if (!listing.product.inventory || listing.product.inventory.onHand <= 0 || listing.product.images.length === 0 || (logistics.zones === 0 && logistics.pickups === 0)) throw badRequest('LISTING_INCOMPLETE', 'A listing requires valid inventory, at least one image and an active delivery option');
    const changed = await prisma.affiliateListing.updateMany({ where: { id: listing.id, status: { in: [AffiliateListingStatus.DRAFT, AffiliateListingStatus.CHANGES_REQUESTED, AffiliateListingStatus.REJECTED] } }, data: { status: AffiliateListingStatus.PENDING_REVIEW, submittedAt: new Date(), reviewNote: null } });
    if (changed.count !== 1) throw conflict('LISTING_REVIEW_STATE', 'The listing cannot be submitted from its current state');
    await prisma.auditLog.create({ data: auditData('USER', affiliate.userId, 'AFFILIATE_LISTING_SUBMITTED', 'AffiliateListing', listing.id) });
    return res.json({ id: listing.id, status: AffiliateListingStatus.PENDING_REVIEW });
  });
  router.post('/listings/:id/archive', async (req, res) => {
    const affiliate = affiliateOrThrow(req);
    const input = versionSchema.parse(req.body);
    const listing = await prisma.affiliateListing.findFirst({ where: { id: String(req.params.id), affiliateId: affiliate.id }, include: { product: { include: { inventory: true } } } });
    if (!listing) throw notFound('Affiliate listing not found');
    if ((listing.product.inventory?.reserved ?? 0) > 0) throw conflict('INVENTORY_RESERVED', 'A listing with reserved units cannot be archived');
    const changed = await prisma.product.updateMany({ where: { id: listing.productId, version: input.expectedVersion }, data: { status: ProductStatus.ARCHIVED, archivedAt: new Date(), version: { increment: 1 } } });
    if (changed.count !== 1) throw conflict('PRODUCT_CHANGED', 'Listing was modified by another request');
    return res.json({ id: listing.id, status: ProductStatus.ARCHIVED, version: input.expectedVersion + 1 });
  });
  router.delete('/listings/:id', async (req, res) => {
    const affiliate = affiliateOrThrow(req);
    const input = versionSchema.parse(req.body);
    const listing = await prisma.affiliateListing.findFirst({ where: { id: String(req.params.id), affiliateId: affiliate.id }, include: { product: { include: { inventory: true }, } } });
    if (!listing) throw notFound('Affiliate listing not found');
    if (!([AffiliateListingStatus.DRAFT, AffiliateListingStatus.REJECTED, AffiliateListingStatus.CHANGES_REQUESTED] as AffiliateListingStatus[]).includes(listing.status)) throw conflict('LISTING_NOT_DELETABLE', 'Only unpublished listings can be deleted');
    if ((listing.product.inventory?.reserved ?? 0) > 0) throw conflict('INVENTORY_RESERVED', 'Reserved listings cannot be deleted');
    const deleted = await prisma.product.deleteMany({ where: { id: listing.productId, version: input.expectedVersion } });
    if (deleted.count !== 1) throw conflict('PRODUCT_CHANGED', 'Listing was modified by another request');
    return res.status(204).send();
  });
  router.post('/listings/:id/images', upload.array('images', 8), async (req, res) => {
    const affiliate = affiliateOrThrow(req);
    const listing = await prisma.affiliateListing.findFirst({ where: { id: String(req.params.id), affiliateId: affiliate.id }, include: { product: { include: { images: { where: { retiredAt: null } } } } } });
    if (!listing) throw notFound('Affiliate listing not found');
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0 || listing.product.images.length + files.length > 8) throw badRequest('IMAGE_LIMIT', 'A listing can contain up to eight active images');
    const stored: string[] = [];
    try {
      for (const file of files) stored.push((await saveAffiliateImage(file)).id);
      await prisma.$transaction(async (tx) => {
        const versioned = await tx.product.updateMany({ where: { id: listing.productId, version: z.coerce.number().parse(req.body.expectedVersion) }, data: { status: ProductStatus.DRAFT, publishedAt: null, version: { increment: 1 } } });
        if (versioned.count !== 1) throw conflict('PRODUCT_CHANGED', 'Listing was modified by another request');
        for (const [index, fileId] of stored.entries()) await tx.productImage.create({ data: { productId: listing.productId, fileId, sortOrder: listing.product.images.length + index, altText: listing.product.name, createdByAffiliateId: affiliate.id } });
        await tx.affiliateListing.update({ where: { id: listing.id }, data: { status: AffiliateListingStatus.DRAFT, reviewNote: null, submittedAt: null, reviewedAt: null, reviewedById: null } });
      });
    } catch (error) { await Promise.all(stored.map((fileId) => discardFile(fileId))); throw error; }
    return res.status(201).json({ fileIds: stored });
  });
  router.patch('/listings/:id/images/:imageId', async (req, res) => {
    const affiliate = affiliateOrThrow(req);
    const input = versionSchema.extend({ altText: z.string().trim().max(255).nullable() }).parse(req.body);
    const listing = await prisma.affiliateListing.findFirst({ where: { id: String(req.params.id), affiliateId: affiliate.id } }); if (!listing) throw notFound('Affiliate listing not found');
    const changed = await prisma.$transaction(async (tx) => {
      const versioned = await tx.product.updateMany({ where: { id: listing.productId, version: input.expectedVersion }, data: { status: ProductStatus.DRAFT, publishedAt: null, version: { increment: 1 } } });
      if (versioned.count !== 1) throw conflict('PRODUCT_CHANGED', 'Listing was modified by another request');
      const image = await tx.productImage.updateMany({ where: { id: String(req.params.imageId), productId: listing.productId, retiredAt: null }, data: { altText: input.altText } });
      if (image.count !== 1) throw notFound('Affiliate image not found');
      await tx.affiliateListing.update({ where: { id: listing.id }, data: { status: AffiliateListingStatus.DRAFT, reviewNote: null, submittedAt: null, reviewedAt: null, reviewedById: null } });
      return image;
    });
    return res.json({ id: String(req.params.imageId), version: input.expectedVersion + 1, updated: changed.count === 1 });
  });
  router.delete('/listings/:id/images/:imageId', async (req, res) => {
    const affiliate = affiliateOrThrow(req); const input = versionSchema.parse(req.body);
    const listing = await prisma.affiliateListing.findFirst({ where: { id: String(req.params.id), affiliateId: affiliate.id } }); if (!listing) throw notFound('Affiliate listing not found');
    await prisma.$transaction(async (tx) => {
      const versioned = await tx.product.updateMany({ where: { id: listing.productId, version: input.expectedVersion }, data: { status: ProductStatus.DRAFT, publishedAt: null, version: { increment: 1 } } });
      if (versioned.count !== 1) throw conflict('PRODUCT_CHANGED', 'Listing was modified by another request');
      const image = await tx.productImage.updateMany({ where: { id: String(req.params.imageId), productId: listing.productId, retiredAt: null }, data: { retiredAt: new Date() } });
      if (image.count !== 1) throw notFound('Affiliate image not found');
      await tx.affiliateListing.update({ where: { id: listing.id }, data: { status: AffiliateListingStatus.DRAFT, reviewNote: null, submittedAt: null, reviewedAt: null, reviewedById: null } });
    });
    return res.status(204).send();
  });

  router.get('/logistics', async (req, res) => {
    const affiliate = affiliateOrThrow(req);
    const [zones, pickupPoints] = await Promise.all([
      prisma.shippingZone.findMany({ where: { affiliateId: affiliate.id }, include: { provinces: true, rates: true }, orderBy: { name: 'asc' } }),
      prisma.pickupPoint.findMany({ where: { affiliateId: affiliate.id }, orderBy: { name: 'asc' } }),
    ]);
    return res.json({ zones: zones.map(affiliateLogisticsDto), pickupPoints });
  });
  router.post('/shipping-zones', async (req, res) => {
    const affiliate = affiliateOrThrow(req); const input = zoneSchema.parse(req.body);
    const zone = await prisma.shippingZone.create({
      data: { affiliateId: affiliate.id, name: input.name, provinces: { create: input.provinces.map((province) => ({ province })) } },
    });
    return res.status(201).json(zone);
  });
  router.post('/shipping-zones/:id/rates', async (req, res) => {
    const affiliate = affiliateOrThrow(req); const input = rateSchema.parse(req.body);
    const zone = await prisma.shippingZone.findFirst({ where: { id: String(req.params.id), affiliateId: affiliate.id } }); if (!zone) throw notFound('Shipping zone not found');
    const rate = await prisma.shippingRate.create({ data: { zoneId: zone.id, name: input.name, priceMinor: input.priceMinor } });
    return res.status(201).json({ ...rate, priceMinor: money(rate.priceMinor) });
  });
  router.post('/pickup-points', async (req, res) => { const affiliate = affiliateOrThrow(req); return res.status(201).json(await prisma.pickupPoint.create({ data: { ...pickupSchema.parse(req.body), affiliateId: affiliate.id } })); });

  router.get('/orders', async (req, res) => {
    const affiliate = affiliateOrThrow(req);
    const orders = await prisma.sellerOrder.findMany({ where: { affiliateId: affiliate.id }, orderBy: { createdAt: 'desc' }, include: { items: true, statusHistory: { orderBy: { createdAt: 'asc' } }, issues: { where: { status: 'OPEN' } } } });
    return res.json(orders.map(affiliateSellerOrderDto));
  });
  router.post('/orders/:id/status', async (req, res) => {
    const affiliate = affiliateOrThrow(req); const input = statusSchema.parse(req.body);
    const order = await prisma.sellerOrder.findFirst({ where: { id: String(req.params.id), affiliateId: affiliate.id } }); if (!order) throw notFound('Seller order not found');
    const allowed: Record<string, string[]> = { PAID: ['PREPARING'], PREPARING: ['READY_FOR_PICKUP', 'SHIPPED'], READY_FOR_PICKUP: ['PICKED_UP'], SHIPPED: ['COMPLETED'] };
    if (!allowed[order.status]?.includes(input.status)) throw conflict('INVALID_SELLER_ORDER_TRANSITION', 'The seller order cannot use this status transition');
    const changed = await prisma.sellerOrder.updateMany({ where: { id: order.id, version: input.expectedVersion }, data: { status: input.status, version: { increment: 1 }, ...(['SHIPPED', 'PICKED_UP'].includes(input.status) ? { autoCompleteAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) } : {}) } });
    if (changed.count !== 1) throw conflict('SELLER_ORDER_CHANGED', 'Seller order was modified by another request');
    await prisma.sellerOrderHistory.create({ data: { sellerOrderId: order.id, fromStatus: order.status, toStatus: input.status, note: input.note, changedByType: 'AFFILIATE', changedById: affiliate.id } });
    return res.json({ id: order.id, status: input.status, version: input.expectedVersion + 1 });
  });
  router.post('/orders/:id/cancellation-request', async (req, res) => {
    const affiliate = affiliateOrThrow(req); const input = z.object({ note: z.string().trim().min(3).max(500) }).parse(req.body);
    const order = await prisma.sellerOrder.findFirst({ where: { id: String(req.params.id), affiliateId: affiliate.id } }); if (!order) throw notFound('Seller order not found');
    if (!['PAID', 'PREPARING', 'READY_FOR_PICKUP', 'SHIPPED', 'DISPUTED'].includes(order.status)) throw conflict('SELLER_ORDER_NOT_CANCELLABLE', 'This seller order cannot request cancellation');
    const changed = await prisma.sellerOrder.updateMany({ where: { id: order.id, version: z.coerce.number().parse(req.body.expectedVersion) }, data: { status: 'CANCELLATION_REQUESTED', version: { increment: 1 } } });
    if (changed.count !== 1) throw conflict('SELLER_ORDER_CHANGED', 'Seller order was modified by another request');
    await prisma.sellerOrderHistory.create({ data: { sellerOrderId: order.id, fromStatus: order.status, toStatus: 'CANCELLATION_REQUESTED', note: input.note, changedByType: 'AFFILIATE', changedById: affiliate.id } });
    return res.json({ id: order.id, status: 'CANCELLATION_REQUESTED', version: order.version + 1 });
  });

  router.get('/balance', async (req, res) => {
    const affiliate = affiliateOrThrow(req);
    const entries = await prisma.affiliateLedgerEntry.findMany({ where: { affiliateId: affiliate.id }, orderBy: { createdAt: 'desc' }, take: 200 });
    const totals = entries.reduce((acc, entry) => { acc[entry.bucket] = (acc[entry.bucket] ?? 0n) + entry.amountMinor; return acc; }, {} as Record<string, bigint>);
    return res.json({ pendingMinor: money(totals.PENDING ?? 0n), availableMinor: money(totals.AVAILABLE ?? 0n), reservedMinor: money(totals.RESERVED ?? 0n), paidMinor: money(totals.PAID ?? 0n), entries: entries.map((entry) => ({ ...entry, amountMinor: money(entry.amountMinor) })) });
  });
  router.post('/payouts', async (req, res) => {
    const affiliate = affiliateOrThrow(req); const input = payoutSchema.parse(req.body);
    const payout = await prisma.$transaction(async (tx) => {
      const available = await tx.affiliateLedgerEntry.aggregate({ _sum: { amountMinor: true }, where: { affiliateId: affiliate.id, bucket: 'AVAILABLE' } });
      if ((available._sum.amountMinor ?? 0n) < input.amountMinor) throw badRequest('INSUFFICIENT_BALANCE', 'The payout exceeds the available balance');
      const created = await tx.affiliatePayoutRequest.create({ data: { affiliateId: affiliate.id, amountMinor: input.amountMinor } });
      await tx.affiliateLedgerEntry.createMany({ data: [
        { affiliateId: affiliate.id, payoutId: created.id, bucket: 'AVAILABLE', type: 'PAYOUT_RESERVED', amountMinor: -input.amountMinor },
        { affiliateId: affiliate.id, payoutId: created.id, bucket: 'RESERVED', type: 'PAYOUT_RESERVED', amountMinor: input.amountMinor },
      ] });
      await tx.auditLog.create({ data: auditData('USER', affiliate.userId, 'AFFILIATE_PAYOUT_REQUESTED', 'AffiliatePayoutRequest', created.id, { amountMinor: input.amountMinor.toString() }) });
      return created;
    });
    return res.status(201).json({ ...payout, amountMinor: money(payout.amountMinor) });
  });
  return router;
}

export function createAdminAffiliateRouter(prisma: PrismaClient) {
  const router = Router(); router.use(requireAdmin);
  router.get('/', async (_req, res) => res.json((await prisma.affiliate.findMany({ include: { user: true, _count: { select: { listings: true, sellerOrders: true } } }, orderBy: { updatedAt: 'desc' } })).map((value) => ({ ...affiliateDto(value), counts: value._count }))));
  router.post('/', async (req, res) => {
    const admin = currentAdmin(req); if (!admin) throw forbidden();
    const input = z.object({ userId: z.string().uuid(), publicName: z.string().trim().min(2).max(120), contactPhone: z.string().trim().max(50).nullable().optional(), payoutAccount: z.string().trim().min(4).max(500).nullable().optional() }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: input.userId } }); if (!user || user.status !== 'ACTIVE') throw notFound('Active customer not found');
    const account = seal(input.payoutAccount);
    const affiliate = await prisma.affiliate.create({ data: { userId: user.id, publicName: input.publicName, contactPhone: input.contactPhone, payoutAccountCipher: account.cipher, payoutAccountLast4: account.last4 } });
    await prisma.auditLog.create({ data: auditData('ADMIN', admin.adminId, 'AFFILIATE_CREATED', 'Affiliate', affiliate.id, { userId: user.id }) });
    return res.status(201).json(affiliateDto(affiliate));
  });
  router.patch('/:id', async (req, res) => {
    const admin = currentAdmin(req); if (!admin) throw forbidden();
    const input = versionSchema.extend({ publicName: z.string().trim().min(2).max(120).optional(), status: z.nativeEnum(AffiliateStatus).optional() }).parse(req.body);
    const changed = await prisma.affiliate.updateMany({ where: { id: String(req.params.id), version: input.expectedVersion }, data: { ...(input.publicName !== undefined ? { publicName: input.publicName } : {}), ...(input.status !== undefined ? { status: input.status } : {}), version: { increment: 1 } } });
    if (changed.count !== 1) throw conflict('AFFILIATE_CHANGED', 'Affiliate was modified by another administrator');
    await prisma.auditLog.create({ data: auditData('ADMIN', admin.adminId, 'AFFILIATE_UPDATED', 'Affiliate', String(req.params.id), { status: input.status }) });
    return res.json(await prisma.affiliate.findUniqueOrThrow({ where: { id: String(req.params.id) } }));
  });
  router.get('/listings', async (req, res) => {
    const status = req.query.status ? z.nativeEnum(AffiliateListingStatus).parse(String(req.query.status)) : AffiliateListingStatus.PENDING_REVIEW;
    const rows = await prisma.affiliateListing.findMany({ where: { status }, orderBy: { submittedAt: 'asc' }, include: { affiliate: true, product: { include: productInclude } } });
    return res.json(rows.map((row) => ({ ...listingDto(row as never), affiliate: { id: row.affiliate.id, publicName: row.affiliate.publicName } })));
  });
  router.post('/listings/:id/review', async (req, res) => {
    const admin = currentAdmin(req); if (!admin) throw forbidden();
    const input = listingReviewSchema.parse(req.body);
    const listing = await prisma.affiliateListing.findUnique({ where: { id: String(req.params.id) }, include: { product: true } }); if (!listing) throw notFound('Affiliate listing not found');
    if (listing.product.version !== input.expectedVersion) throw conflict('PRODUCT_CHANGED', 'Listing was modified by another request');
    const productStatus = input.decision === 'APPROVED' ? ProductStatus.PUBLISHED : ProductStatus.DRAFT;
    await prisma.$transaction(async (tx) => {
      await tx.affiliateListing.update({ where: { id: listing.id }, data: { status: input.decision, reviewNote: input.note ?? null, reviewedAt: new Date(), reviewedById: admin.adminId } });
      await tx.product.update({ where: { id: listing.productId }, data: { status: productStatus, publishedAt: productStatus === ProductStatus.PUBLISHED ? new Date() : null, version: { increment: 1 } } });
      await tx.auditLog.create({ data: auditData('ADMIN', admin.adminId, `AFFILIATE_LISTING_${input.decision}`, 'AffiliateListing', listing.id, { productId: listing.productId, note: input.note }) });
    });
    return res.json({ id: listing.id, status: input.decision, productStatus, version: input.expectedVersion + 1 });
  });
  router.get('/payouts', async (_req, res) => res.json((await prisma.affiliatePayoutRequest.findMany({ include: { affiliate: true }, orderBy: { createdAt: 'desc' } })).map((payout) => ({ ...payout, amountMinor: payout.amountMinor.toString(), affiliate: { id: payout.affiliate.id, publicName: payout.affiliate.publicName } }))));
  router.get('/seller-orders', async (req, res) => {
    const status = req.query.status ? z.string().parse(String(req.query.status)) : undefined;
    const rows = await prisma.sellerOrder.findMany({ where: { affiliateId: { not: null }, ...(status ? { status: status as any } : {}) }, include: { affiliate: true, order: { select: { number: true, userId: true, payment: true } }, items: true }, orderBy: { updatedAt: 'desc' } });
    return res.json(rows.map((row) => ({ ...affiliateSellerOrderDto(row), affiliate: row.affiliate ? { id: row.affiliate.id, publicName: row.affiliate.publicName } : null, order: { number: row.order.number, userId: row.order.userId, paymentId: row.order.payment?.id ?? null } })));
  });
  router.get('/issues', async (_req, res) => {
    const rows = await prisma.affiliateIssue.findMany({ where: { status: 'OPEN' }, include: { affiliate: true, sellerOrder: { include: { order: { select: { number: true, payment: true } }, items: true } }, openedBy: { select: { id: true, email: true, name: true } } }, orderBy: { createdAt: 'asc' } });
    return res.json(rows.map((row) => ({ ...row, affiliate: { id: row.affiliate.id, publicName: row.affiliate.publicName }, sellerOrder: { ...affiliateSellerOrderDto(row.sellerOrder), order: { number: row.sellerOrder.order.number, paymentId: row.sellerOrder.order.payment?.id ?? null } } })));
  });
  router.post('/issues/:id/resolve', async (req, res) => {
    const admin = currentAdmin(req); if (!admin) throw forbidden();
    const input = z.object({ expectedVersion: z.coerce.number().int().min(1), decision: z.enum(['COMPLETED', 'REFUNDED']), note: z.string().trim().min(3).max(500), refundAmountMinor: z.coerce.bigint().positive().optional(), externalReference: z.string().trim().min(2).max(150).optional() }).parse(req.body);
    const issue = await prisma.affiliateIssue.findUnique({ where: { id: String(req.params.id) }, include: { sellerOrder: { include: { order: { include: { payment: true } } } } } }); if (!issue) throw notFound('Affiliate issue not found');
    if (issue.status !== 'OPEN' || issue.sellerOrder.version !== input.expectedVersion) throw conflict('ISSUE_CHANGED', 'The incident was already resolved or the seller order changed');
    if (input.decision === 'REFUNDED' && (!input.refundAmountMinor || !input.externalReference || !issue.sellerOrder.order.payment)) throw badRequest('REFUND_DATA_REQUIRED', 'A refund amount, payment and external reference are required');
    await prisma.$transaction(async (tx) => {
      await tx.affiliateIssue.update({ where: { id: issue.id }, data: { status: input.decision === 'REFUNDED' ? 'RESOLVED_REFUNDED' : 'RESOLVED_COMPLETED', resolutionNote: input.note, resolvedById: admin.adminId, resolvedAt: new Date() } });
      await tx.sellerOrder.update({ where: { id: issue.sellerOrder.id }, data: { status: input.decision, version: { increment: 1 }, completedAt: input.decision === 'COMPLETED' ? new Date() : null } });
      await tx.sellerOrderHistory.create({ data: { sellerOrderId: issue.sellerOrder.id, fromStatus: issue.sellerOrder.status, toStatus: input.decision, note: input.note, changedByType: 'ADMIN', changedById: admin.adminId } });
      if (input.decision !== 'REFUNDED' || !input.refundAmountMinor || !issue.sellerOrder.affiliateId || !issue.sellerOrder.order.payment) return;
      await tx.refundRecord.create({ data: { paymentId: issue.sellerOrder.order.payment.id, sellerOrderId: issue.sellerOrder.id, amountMinor: input.refundAmountMinor, currency: BASE_CURRENCY, reason: input.note, externalReference: input.externalReference!, createdById: admin.adminId } });
      const pending = await tx.affiliateLedgerEntry.findFirst({ where: { sellerOrderId: issue.sellerOrder.id, bucket: 'PENDING', type: 'SALE_PENDING' } });
      const bucket = pending ? 'PENDING' : 'AVAILABLE';
      const reversal = input.refundAmountMinor < issue.sellerOrder.sellerNetMinor ? input.refundAmountMinor : issue.sellerOrder.sellerNetMinor;
      await tx.affiliateLedgerEntry.create({ data: { affiliateId: issue.sellerOrder.affiliateId, sellerOrderId: issue.sellerOrder.id, bucket, type: 'SALE_REVERSED', amountMinor: -reversal, note: 'Affiliate balance reversed after refund' } });
      await tx.payment.update({ where: { id: issue.sellerOrder.order.payment.id }, data: { status: input.refundAmountMinor >= issue.sellerOrder.order.payment.amountMinor ? 'REFUNDED' : 'PARTIALLY_REFUNDED' } });
    });
    return res.json({ id: issue.id, status: input.decision === 'REFUNDED' ? 'RESOLVED_REFUNDED' : 'RESOLVED_COMPLETED' });
  });
  router.post('/payouts/:id/process', async (req, res) => {
    const admin = currentAdmin(req); if (!admin) throw forbidden();
    const input = versionSchema.extend({ status: z.enum(['PAID', 'REJECTED']), externalReference: z.string().trim().min(2).max(150), note: z.string().trim().max(500).optional() }).parse(req.body);
    const payout = await prisma.affiliatePayoutRequest.findUnique({ where: { id: String(req.params.id) } }); if (!payout) throw notFound('Payout request not found');
    const updated = await prisma.affiliatePayoutRequest.updateMany({ where: { id: payout.id, version: input.expectedVersion, status: AffiliatePayoutStatus.REQUESTED }, data: { status: input.status, externalReference: input.externalReference, note: input.note, processedById: admin.adminId, processedAt: new Date(), version: { increment: 1 } } });
    if (updated.count !== 1) throw conflict('PAYOUT_CHANGED', 'Payout was modified by another administrator');
    await prisma.affiliateLedgerEntry.createMany({ data: input.status === 'PAID' ? [
      { affiliateId: payout.affiliateId, payoutId: payout.id, bucket: 'RESERVED', type: 'PAYOUT_PAID', amountMinor: -payout.amountMinor },
      { affiliateId: payout.affiliateId, payoutId: payout.id, bucket: 'PAID', type: 'PAYOUT_PAID', amountMinor: payout.amountMinor },
    ] : [
      { affiliateId: payout.affiliateId, payoutId: payout.id, bucket: 'RESERVED', type: 'PAYOUT_RELEASED', amountMinor: -payout.amountMinor },
      { affiliateId: payout.affiliateId, payoutId: payout.id, bucket: 'AVAILABLE', type: 'PAYOUT_RELEASED', amountMinor: payout.amountMinor },
    ] });
    return res.json({ id: payout.id, status: input.status, version: input.expectedVersion + 1 });
  });
  router.get('/settings', async (_req, res) => res.json(await prisma.affiliateProgramSettings.upsert({ where: { id: 'default' }, create: {}, update: {} })));
  router.patch('/settings', async (req, res) => {
    const admin = currentAdmin(req); if (!admin) throw forbidden();
    const input = versionSchema.extend({ commissionBps: z.coerce.number().int().min(0).max(10000) }).parse(req.body);
    const changed = await prisma.affiliateProgramSettings.updateMany({ where: { id: 'default', version: input.expectedVersion }, data: { commissionBps: input.commissionBps, version: { increment: 1 }, updatedById: admin.adminId } });
    if (changed.count !== 1) throw conflict('AFFILIATE_SETTINGS_CHANGED', 'Affiliate settings were modified by another administrator');
    return res.json(await prisma.affiliateProgramSettings.findUniqueOrThrow({ where: { id: 'default' } }));
  });
  return router;
}

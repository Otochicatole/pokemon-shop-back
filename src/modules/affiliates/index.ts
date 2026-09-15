import { Router, type Express, type RequestHandler } from 'express';
import { randomUUID, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { AffiliateIssueStatus, AffiliateLedgerBucket, AffiliateListingStatus, AffiliatePayoutStatus, AffiliateStatus, NotificationType, ProductStatus, SellerOrderStatus } from '@prisma/client';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { currentAdmin, currentAffiliate, currentUser, requireAdmin, requireAffiliate } from '../../infrastructure/sessions.js';
import { badRequest, conflict, forbidden, notFound } from '../../shared/errors.js';
import { logger } from '../../infrastructure/logger.js';
import { discardUnattachedFile, saveImage } from '../media/index.js';
import { BASE_CURRENCY } from '../../shared/currency.js';
import { affiliateBalance, requestSellerCancellation, refundSellerOrder, resolveAffiliateIssue, resolveCancellation, sellerOrderAllowedActions, transitionSellerOrder } from './affiliate-marketplace-service.js';
import { createAdminNotifications, createAffiliateListingNotification, createAffiliatePayoutNotification, createSellerOrderAdminNotifications, createSellerOrderStatusNotification, publishNotifications } from '../notifications/index.js';
import type { SupportRealtimeHub } from '../support/support-realtime.js';

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
const zonePatchSchema = zoneSchema.partial().extend({ active: z.boolean().optional() });
const rateSchema = z.object({ name: z.string().trim().min(2).max(120), priceMinor: z.coerce.bigint().nonnegative() });
const ratePatchSchema = rateSchema.partial().extend({ active: z.boolean().optional() });
const pickupSchema = z.object({ name: z.string().trim().min(2).max(120), address: z.string().trim().min(3).max(300) });
const pickupPatchSchema = pickupSchema.partial().extend({ active: z.boolean().optional() });
const payoutSchema = z.object({ amountMinor: z.coerce.bigint().positive() });
const statusSchema = versionSchema.extend({ status: z.enum(['PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'SHIPPED']), note: z.string().trim().max(500).optional(), carrier: z.string().trim().max(100).nullable().optional(), trackingCode: z.string().trim().max(120).nullable().optional() });
const adminRefundSchema = versionSchema.extend({ amountMinor: z.coerce.bigint().positive(), subtotalMinor: z.coerce.bigint().nonnegative().optional(), shippingMinor: z.coerce.bigint().nonnegative().optional(), reason: z.string().trim().min(3).max(500), externalReference: z.string().trim().min(2).max(150), restock: z.boolean().optional(), lines: z.array(z.object({ orderItemId: z.string().uuid(), quantity: z.coerce.number().int().positive(), amountMinor: z.coerce.bigint().positive() })).max(100).optional() });

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

function unseal(value: string) {
  const [ivEncoded, tagEncoded, ciphertextEncoded] = value.split('.');
  if (!ivEncoded || !tagEncoded || !ciphertextEncoded) throw badRequest('PAYOUT_DESTINATION_INVALID', 'The payout destination could not be decrypted');
  const decipher = createDecipheriv('aes-256-gcm', encryptedKey(), Buffer.from(ivEncoded, 'base64'));
  decipher.setAuthTag(Buffer.from(tagEncoded, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextEncoded, 'base64')), decipher.final()]).toString('utf8');
}

function affiliateDto(value: { id: string; userId: string; publicName: string; contactPhone: string | null; payoutAccountLast4: string | null; commissionBpsOverride?: number | null; status: AffiliateStatus; version: number; createdAt: Date; updatedAt: Date; user?: { id: string; email: string; name: string | null; emailVerifiedAt: Date | null } | null }) {
  return { id: value.id, userId: value.userId, publicName: value.publicName, contactPhone: value.contactPhone, payoutAccountLast4: value.payoutAccountLast4, commissionBpsOverride: value.commissionBpsOverride ?? null, status: value.status, version: value.version, user: value.user ? { id: value.user.id, email: value.user.email, name: value.user.name, emailVerified: Boolean(value.user.emailVerifiedAt) } : undefined, createdAt: value.createdAt, updatedAt: value.updatedAt };
}

function affiliateListingItems(items: Array<{ id: string; productId: string; productName: string; quantity: number; unitPriceMinor: bigint; lineTotalMinor: bigint }> | undefined) {
  return items?.map((item) => ({ ...item, unitPriceMinor: money(item.unitPriceMinor), lineTotalMinor: money(item.lineTotalMinor) })) ?? [];
}

function serializeAffiliateValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(serializeAffiliateValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, serializeAffiliateValue(nested)]));
  return value;
}

function affiliateSellerOrderDto(order: { items?: Array<{ id: string; productId: string; productName: string; quantity: number; unitPriceMinor: bigint; lineTotalMinor: bigint }>; subtotalMinor: bigint; shippingMinor: bigint; commissionMinor: bigint; sellerNetMinor: bigint; [key: string]: unknown }, revealFulfillment = true) {
  const { items, subtotalMinor, shippingMinor, commissionMinor, sellerNetMinor, order: _order, ...rest } = order;
  if (!revealFulfillment) for (const key of ['recipientName', 'recipientPhone', 'addressLine1', 'addressLine2', 'city', 'province', 'postalCode', 'pickupPointAddress']) delete rest[key];
  return { ...serializeAffiliateValue(rest) as Record<string, unknown>, subtotalMinor: money(subtotalMinor), shippingMinor: money(shippingMinor), commissionMinor: money(commissionMinor), sellerNetMinor: money(sellerNetMinor), items: affiliateListingItems(items) };
}

function affiliateLogisticsDto(zone: { id: string; name: string; active: boolean; provinces: Array<{ province: string }>; rates: Array<{ id: string; name: string; priceMinor: bigint; active: boolean }> }) {
  return { id: zone.id, name: zone.name, active: zone.active, provinces: zone.provinces, rates: zone.rates.map((rate) => ({ ...rate, priceMinor: money(rate.priceMinor) })) };
}

function affiliateOrThrow(request: Parameters<typeof currentAffiliate>[0]) {
  const affiliate = currentAffiliate(request);
  if (!affiliate) throw forbidden('Affiliate access is not active');
  return affiliate;
}

function activeAffiliateOrThrow(request: Parameters<typeof currentAffiliate>[0]) {
  const affiliate = affiliateOrThrow(request);
  if (affiliate.status !== AffiliateStatus.ACTIVE) throw forbidden('Suspended affiliates cannot modify this resource');
  return affiliate;
}

export function createAffiliateRouter(prisma: PrismaClient, upload: { array(fieldname: string, maxCount?: number): RequestHandler }, saveAffiliateImage: (file: Express.Multer.File) => Promise<{ id: string }>, discardFile: (id: string) => Promise<boolean>, realtime?: SupportRealtimeHub) {
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
    const affiliate = activeAffiliateOrThrow(req);
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
    const affiliate = activeAffiliateOrThrow(req);
    const input = updateProductFields.parse(req.body);
    const listing = await prisma.affiliateListing.findFirst({ where: { id: String(req.params.id), affiliateId: affiliate.id }, include: { product: { include: { inventory: true } } } });
    if (!listing) throw notFound('Affiliate listing not found');
    if (listing.product.status === ProductStatus.ARCHIVED) throw conflict('LISTING_ARCHIVED', 'Archived listings cannot be edited');
    const automaticallySubmitted = listing.status === AffiliateListingStatus.APPROVED;
    const nextListingStatus = automaticallySubmitted ? AffiliateListingStatus.PENDING_REVIEW : AffiliateListingStatus.DRAFT;
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
      await tx.affiliateListing.update({ where: { id: listing.id }, data: { status: nextListingStatus, reviewNote: null, submittedAt: automaticallySubmitted ? new Date() : null, reviewedAt: null, reviewedById: null } });
      await tx.auditLog.create({ data: auditData('USER', affiliate.userId, 'AFFILIATE_LISTING_UPDATED', 'AffiliateListing', listing.id, { fromVersion: input.expectedVersion, toVersion: input.expectedVersion + 1 }) });
    });
    if (automaticallySubmitted) {
      try {
        const notices = await createAffiliateListingNotification(prisma, {}, { id: listing.id, productName: listing.product.name }, NotificationType.AFFILIATE_LISTING_SUBMITTED, 'Nueva publicación para revisar', `La publicación ${listing.product.name} espera revisión.`, `${input.expectedVersion + 1}`);
        if (realtime) await publishNotifications(prisma, realtime, notices.map((notice) => notice.id));
      } catch (error) {
        logger.error({ err: error, listingId: listing.id }, 'Affiliate listing resubmission notification failed after commit');
      }
    }
    return res.json({ id: listing.id, version: input.expectedVersion + 1, status: nextListingStatus });
  });
  router.post('/listings/:id/submit', async (req, res) => {
    const affiliate = activeAffiliateOrThrow(req);
    const listing = await prisma.affiliateListing.findFirst({ where: { id: String(req.params.id), affiliateId: affiliate.id }, include: { product: { include: { inventory: true, images: { where: { retiredAt: null } } } } } });
    if (!listing) throw notFound('Affiliate listing not found');
    const logistics = await prisma.$transaction(async (tx) => ({ zones: await tx.shippingZone.count({ where: { affiliateId: affiliate.id, active: true } }), pickups: await tx.pickupPoint.count({ where: { affiliateId: affiliate.id, active: true } }) }));
    if (!listing.product.inventory || listing.product.inventory.onHand <= 0 || listing.product.images.length === 0 || (logistics.zones === 0 && logistics.pickups === 0)) throw badRequest('LISTING_INCOMPLETE', 'A listing requires valid inventory, at least one image and an active delivery option');
    await prisma.$transaction(async (tx) => {
      const changed = await tx.affiliateListing.updateMany({ where: { id: listing.id, status: { in: [AffiliateListingStatus.DRAFT, AffiliateListingStatus.CHANGES_REQUESTED, AffiliateListingStatus.REJECTED] } }, data: { status: AffiliateListingStatus.PENDING_REVIEW, submittedAt: new Date(), reviewNote: null } });
      if (changed.count !== 1) throw conflict('LISTING_REVIEW_STATE', 'The listing cannot be submitted from its current state');
      await tx.auditLog.create({ data: auditData('USER', affiliate.userId, 'AFFILIATE_LISTING_SUBMITTED', 'AffiliateListing', listing.id) });
    });
    // El estado ya quedó confirmado. La notificación es posterior al commit y
    // no debe hacer que una publicación enviada correctamente responda 500.
    try {
      const notices = await prisma.$transaction((tx) => createAffiliateListingNotification(tx, {}, { id: listing.id, productName: listing.product.name }, NotificationType.AFFILIATE_LISTING_SUBMITTED, 'Nueva publicación para revisar', `La publicación ${listing.product.name} espera revisión.`, `${listing.product.version}`));
      if (realtime) await publishNotifications(prisma, realtime, notices.map((notice) => notice.id));
    } catch (error) {
      logger.error({ err: error, listingId: listing.id }, 'Affiliate listing submission notification failed after commit');
    }
    return res.json({ id: listing.id, status: AffiliateListingStatus.PENDING_REVIEW });
  });
  router.post('/listings/:id/archive', async (req, res) => {
    const affiliate = activeAffiliateOrThrow(req);
    const input = versionSchema.parse(req.body);
    const listing = await prisma.affiliateListing.findFirst({ where: { id: String(req.params.id), affiliateId: affiliate.id }, include: { product: { include: { inventory: true } } } });
    if (!listing) throw notFound('Affiliate listing not found');
    if ((listing.product.inventory?.reserved ?? 0) > 0) throw conflict('INVENTORY_RESERVED', 'A listing with reserved units cannot be archived');
    const changed = await prisma.product.updateMany({ where: { id: listing.productId, version: input.expectedVersion }, data: { status: ProductStatus.ARCHIVED, archivedAt: new Date(), version: { increment: 1 } } });
    if (changed.count !== 1) throw conflict('PRODUCT_CHANGED', 'Listing was modified by another request');
    return res.json({ id: listing.id, status: ProductStatus.ARCHIVED, version: input.expectedVersion + 1 });
  });
  router.delete('/listings/:id', async (req, res) => {
    const affiliate = activeAffiliateOrThrow(req);
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
    const affiliate = activeAffiliateOrThrow(req);
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
    const affiliate = activeAffiliateOrThrow(req);
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
    const affiliate = activeAffiliateOrThrow(req); const input = versionSchema.parse(req.body);
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
    const affiliate = activeAffiliateOrThrow(req); const input = zoneSchema.parse(req.body);
    const zone = await prisma.shippingZone.create({
      data: { affiliateId: affiliate.id, name: input.name, provinces: { create: input.provinces.map((province) => ({ province })) } },
    });
    return res.status(201).json(zone);
  });
  router.post('/shipping-zones/:id/rates', async (req, res) => {
    const affiliate = activeAffiliateOrThrow(req); const input = rateSchema.parse(req.body);
    const zone = await prisma.shippingZone.findFirst({ where: { id: String(req.params.id), affiliateId: affiliate.id } }); if (!zone) throw notFound('Shipping zone not found');
    const rate = await prisma.shippingRate.create({ data: { zoneId: zone.id, name: input.name, priceMinor: input.priceMinor } });
    return res.status(201).json({ ...rate, priceMinor: money(rate.priceMinor) });
  });
  router.patch('/shipping-zones/:id', async (req, res) => {
    const affiliate = activeAffiliateOrThrow(req); const input = zonePatchSchema.parse(req.body);
    const zone = await prisma.shippingZone.findFirst({ where: { id: String(req.params.id), affiliateId: affiliate.id } }); if (!zone) throw notFound('Shipping zone not found');
    await prisma.$transaction(async (tx) => {
      await tx.shippingZone.update({ where: { id: zone.id }, data: { ...(input.name !== undefined ? { name: input.name } : {}), ...(input.active !== undefined ? { active: input.active } : {}) } });
      if (input.provinces) { await tx.shippingZoneProvince.deleteMany({ where: { zoneId: zone.id } }); await tx.shippingZoneProvince.createMany({ data: input.provinces.map((province) => ({ zoneId: zone.id, province })) }); }
    });
    return res.json({ updated: true });
  });
  router.patch('/shipping-zones/:zoneId/rates/:rateId', async (req, res) => {
    const affiliate = activeAffiliateOrThrow(req); const input = ratePatchSchema.parse(req.body);
    const rate = await prisma.shippingRate.findFirst({ where: { id: String(req.params.rateId), zone: { id: String(req.params.zoneId), affiliateId: affiliate.id } } }); if (!rate) throw notFound('Shipping rate not found');
    const updated = await prisma.shippingRate.update({ where: { id: rate.id }, data: input });
    return res.json({ ...updated, priceMinor: money(updated.priceMinor) });
  });
  router.post('/pickup-points', async (req, res) => { const affiliate = activeAffiliateOrThrow(req); return res.status(201).json(await prisma.pickupPoint.create({ data: { ...pickupSchema.parse(req.body), affiliateId: affiliate.id } })); });
  router.patch('/pickup-points/:id', async (req, res) => {
    const affiliate = activeAffiliateOrThrow(req); const input = pickupPatchSchema.parse(req.body);
    const point = await prisma.pickupPoint.findFirst({ where: { id: String(req.params.id), affiliateId: affiliate.id } }); if (!point) throw notFound('Pickup point not found');
    return res.json(await prisma.pickupPoint.update({ where: { id: point.id }, data: input }));
  });

  router.get('/orders', async (req, res) => {
    const affiliate = affiliateOrThrow(req);
    const page = Math.max(1, z.coerce.number().int().default(1).parse(req.query.page));
    const pageSize = Math.min(100, Math.max(1, z.coerce.number().int().default(20).parse(req.query.pageSize)));
    const status = req.query.status ? z.nativeEnum(SellerOrderStatus).parse(String(req.query.status)) : undefined;
    const where = { affiliateId: affiliate.id, ...(status ? { status } : {}) };
    const [total, orders] = await Promise.all([
      prisma.sellerOrder.count({ where }),
      prisma.sellerOrder.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, include: { affiliate: true, order: { include: { payment: true } }, items: true, statusHistory: { orderBy: { createdAt: 'asc' } }, issues: { where: { status: 'OPEN' } } } }),
    ]);
    return res.json({ items: orders.map((order) => ({ ...affiliateSellerOrderDto(order, Boolean(['APPROVED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(order.order.payment?.status ?? ''))), allowedActions: sellerOrderAllowedActions(order, 'AFFILIATE') })), page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
  });
  router.get('/orders/:id', async (req, res) => {
    const affiliate = affiliateOrThrow(req);
    const order = await prisma.sellerOrder.findFirst({ where: { id: String(req.params.id), affiliateId: affiliate.id }, include: { affiliate: true, order: { include: { payment: true } }, items: true, statusHistory: { orderBy: { createdAt: 'asc' } }, issues: { orderBy: { createdAt: 'desc' } }, cancellationRequests: { orderBy: { createdAt: 'desc' } } } });
    if (!order) throw notFound('Seller order not found');
    const reveal = ['APPROVED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(order.order.payment?.status ?? '');
    return res.json({ order: { ...affiliateSellerOrderDto(order, reveal), allowedActions: sellerOrderAllowedActions(order, 'AFFILIATE') } });
  });
  router.post('/orders/:id/status', async (req, res) => {
    const affiliate = affiliateOrThrow(req); const input = statusSchema.parse(req.body);
    const settings = await prisma.affiliateProgramSettings.upsert({ where: { id: 'default' }, create: {}, update: {} });
    const order = await prisma.$transaction((tx) => transitionSellerOrder(tx, { sellerOrderId: String(req.params.id), expectedVersion: input.expectedVersion, nextStatus: input.status as SellerOrderStatus, actor: 'AFFILIATE', actorId: affiliate.id, note: input.note, autoCompleteDays: settings.autoCompleteDays, carrier: input.carrier, trackingCode: input.trackingCode }));
    const context = await prisma.sellerOrder.findUniqueOrThrow({ where: { id: order.id }, include: { affiliate: true, order: { select: { number: true } } } });
    const userNotice = context.affiliate ? await createSellerOrderStatusNotification(prisma, { id: context.id, orderNumber: context.order.number, affiliateUserId: context.affiliate.userId }, context.status, String(context.version)) : null;
    const adminNotices = await createSellerOrderAdminNotifications(prisma, { id: context.id, orderNumber: context.order.number }, NotificationType.AFFILIATE_ORDER_STATUS_CHANGED, 'Cambio en una venta de afiliado', `La venta ${context.order.number} ahora está ${context.status}.`, String(context.version));
    if (realtime) await publishNotifications(prisma, realtime, [ ...(userNotice ? [userNotice.id] : []), ...adminNotices.map((notice) => notice.id) ]);
    return res.json({ id: order.id, status: order.status, version: order.version, allowedActions: sellerOrderAllowedActions(order, 'AFFILIATE') });
  });
  router.post('/orders/:id/cancellation-request', async (req, res) => {
    const affiliate = affiliateOrThrow(req); const input = z.object({ note: z.string().trim().min(3).max(500) }).parse(req.body);
    const expectedVersion = z.coerce.number().int().min(1).parse(req.body.expectedVersion);
    const order = await prisma.$transaction((tx) => requestSellerCancellation(tx, { sellerOrderId: String(req.params.id), affiliateId: affiliate.id, expectedVersion, reason: input.note, actorId: affiliate.id }));
    const context = await prisma.sellerOrder.findUniqueOrThrow({ where: { id: order.id }, include: { order: { select: { number: true } } } });
    const notices = await createSellerOrderAdminNotifications(prisma, { id: context.id, orderNumber: context.order.number }, NotificationType.AFFILIATE_CANCELLATION_REQUESTED, 'Solicitud de cancelación', `La venta ${context.order.number} tiene una solicitud de cancelación.`, String(context.version));
    if (realtime) await publishNotifications(prisma, realtime, notices.map((notice) => notice.id));
    return res.json({ id: order.id, status: order.status, version: order.version });
  });

  router.get('/balance', async (req, res) => {
    const affiliate = affiliateOrThrow(req);
    const page = Math.max(1, z.coerce.number().int().default(1).parse(req.query.page));
    const pageSize = Math.min(100, Math.max(1, z.coerce.number().int().default(50).parse(req.query.pageSize)));
    const [totals, total, entries, payouts] = await Promise.all([
      affiliateBalance(prisma, affiliate.id),
      prisma.affiliateLedgerEntry.count({ where: { affiliateId: affiliate.id } }),
      prisma.affiliateLedgerEntry.findMany({ where: { affiliateId: affiliate.id }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      prisma.affiliatePayoutRequest.findMany({ where: { affiliateId: affiliate.id }, orderBy: { createdAt: 'desc' }, take: 100 }),
    ]);
    return res.json({ pendingMinor: money(totals.PENDING), availableMinor: money(totals.AVAILABLE), reservedMinor: money(totals.RESERVED), paidMinor: money(totals.PAID), debtMinor: money(totals.AVAILABLE < 0n ? -totals.AVAILABLE : 0n), entries: entries.map((entry) => ({ ...entry, amountMinor: money(entry.amountMinor) })), payouts: payouts.map((payout) => ({ ...payout, amountMinor: money(payout.amountMinor) })), page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
  });
  router.post('/payouts', async (req, res) => {
    const affiliate = activeAffiliateOrThrow(req); const input = payoutSchema.parse(req.body);
    const payout = await prisma.$transaction(async (tx) => {
      const current = await tx.affiliate.findUniqueOrThrow({ where: { id: affiliate.id } });
      if (!current.payoutAccountCipher) throw badRequest('PAYOUT_ACCOUNT_REQUIRED', 'Configure a payout account before requesting a withdrawal');
      const available = await tx.affiliateLedgerEntry.aggregate({ _sum: { amountMinor: true }, where: { affiliateId: affiliate.id, bucket: 'AVAILABLE' } });
      if ((available._sum.amountMinor ?? 0n) < input.amountMinor) throw badRequest('INSUFFICIENT_BALANCE', 'The payout exceeds the available balance');
      const created = await tx.affiliatePayoutRequest.create({ data: { affiliateId: affiliate.id, amountMinor: input.amountMinor, destinationCipher: current.payoutAccountCipher, destinationLast4: current.payoutAccountLast4 } });
      await tx.affiliateLedgerEntry.create({ data: { affiliateId: affiliate.id, payoutId: created.id, bucket: 'AVAILABLE', type: 'PAYOUT_RESERVED', amountMinor: -input.amountMinor, dedupeKey: `payout:${created.id}:available` } });
      await tx.affiliateLedgerEntry.create({ data: { affiliateId: affiliate.id, payoutId: created.id, bucket: 'RESERVED', type: 'PAYOUT_RESERVED', amountMinor: input.amountMinor, dedupeKey: `payout:${created.id}:reserved` } });
      await tx.auditLog.create({ data: auditData('USER', affiliate.userId, 'AFFILIATE_PAYOUT_REQUESTED', 'AffiliatePayoutRequest', created.id, { amountMinor: input.amountMinor.toString() }) });
      return created;
    });
    const notices = await createAffiliatePayoutNotification(prisma, {}, { id: payout.id, amountMinor: payout.amountMinor }, NotificationType.AFFILIATE_PAYOUT_REQUESTED, 'Nuevo retiro solicitado', `El afiliado solicitó un retiro de ${money(payout.amountMinor)} USD.`, payout.id);
    if (realtime) await publishNotifications(prisma, realtime, notices.map((notice) => notice.id));
    return res.status(201).json({ ...payout, amountMinor: money(payout.amountMinor) });
  });
  router.get('/payouts', async (req, res) => {
    const affiliate = affiliateOrThrow(req);
    const page = Math.max(1, z.coerce.number().int().default(1).parse(req.query.page));
    const pageSize = Math.min(100, Math.max(1, z.coerce.number().int().default(20).parse(req.query.pageSize)));
    const [total, items] = await Promise.all([
      prisma.affiliatePayoutRequest.count({ where: { affiliateId: affiliate.id } }),
      prisma.affiliatePayoutRequest.findMany({ where: { affiliateId: affiliate.id }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
    ]);
    return res.json({ items: items.map((item) => ({ ...item, amountMinor: money(item.amountMinor), destinationCipher: undefined })), page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
  });
  return router;
}

export function createAdminAffiliateRouter(prisma: PrismaClient, realtime?: SupportRealtimeHub) {
  const router = Router(); router.use(requireAdmin);
  router.get('/summary', async (_req, res) => {
    const [affiliates, listings, orders, issues, cancellations, payouts, ledger] = await Promise.all([
      prisma.affiliate.count(),
      prisma.affiliateListing.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.sellerOrder.groupBy({ by: ['status'], where: { affiliateId: { not: null } }, _count: { _all: true }, _sum: { sellerNetMinor: true } }),
      prisma.affiliateIssue.count({ where: { status: 'OPEN' } }),
      prisma.affiliateCancellationRequest.count({ where: { status: 'REQUESTED' } }),
      prisma.affiliatePayoutRequest.count({ where: { status: { in: ['REQUESTED', 'PROCESSING'] } } }),
      prisma.affiliateLedgerEntry.aggregate({ _sum: { amountMinor: true }, where: { bucket: { in: ['PENDING', 'AVAILABLE', 'RESERVED'] } } }),
    ]);
    return res.json({ affiliates, listings, orders, queues: { issues, cancellations, payouts }, obligationsMinor: money(ledger._sum.amountMinor ?? 0n) });
  });
  router.get('/', async (req, res) => {
    const page = Math.max(1, z.coerce.number().int().default(1).parse(req.query.page));
    const pageSize = Math.min(100, Math.max(1, z.coerce.number().int().default(25).parse(req.query.pageSize)));
    const search = req.query.search ? String(req.query.search).trim() : '';
    const status = req.query.status ? z.nativeEnum(AffiliateStatus).parse(String(req.query.status)) : undefined;
    const where = { ...(status ? { status } : {}), ...(search ? { OR: [{ publicName: { contains: search } }, { user: { email: { contains: search } } }, { user: { name: { contains: search } } }] } : {}) };
    const [total, rows] = await Promise.all([
      prisma.affiliate.count({ where }),
      prisma.affiliate.findMany({ where, include: { user: true, _count: { select: { listings: true, sellerOrders: true, issues: true, payoutRequests: true } } }, orderBy: { updatedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
    ]);
    return res.json({ items: rows.map((value) => ({ ...affiliateDto(value), counts: value._count })), page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
  });
  router.post('/', async (req, res) => {
    const admin = currentAdmin(req); if (!admin) throw forbidden();
    const input = z.object({ userId: z.string().uuid(), publicName: z.string().trim().min(2).max(120), contactPhone: z.string().trim().max(50).nullable().optional(), payoutAccount: z.string().trim().min(4).max(500).nullable().optional() }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: input.userId } }); if (!user || user.status !== 'ACTIVE') throw notFound('Active customer not found');
    const account = seal(input.payoutAccount);
    const affiliate = await prisma.affiliate.create({ data: { userId: user.id, publicName: input.publicName, contactPhone: input.contactPhone, payoutAccountCipher: account.cipher, payoutAccountLast4: account.last4 } });
    await prisma.auditLog.create({ data: auditData('ADMIN', admin.adminId, 'AFFILIATE_CREATED', 'Affiliate', affiliate.id, { userId: user.id }) });
    return res.status(201).json(affiliateDto(affiliate));
  });
  router.patch('/:id', async (req, res, next) => {
    if (req.params.id === 'settings') return next();
    const admin = currentAdmin(req); if (!admin) throw forbidden();
    const input = versionSchema.extend({ publicName: z.string().trim().min(2).max(120).optional(), status: z.nativeEnum(AffiliateStatus).optional(), commissionBpsOverride: z.coerce.number().int().min(0).max(10000).nullable().optional() }).parse(req.body);
    const changed = await prisma.affiliate.updateMany({ where: { id: String(req.params.id), version: input.expectedVersion }, data: { ...(input.publicName !== undefined ? { publicName: input.publicName } : {}), ...(input.status !== undefined ? { status: input.status } : {}), ...(input.commissionBpsOverride !== undefined ? { commissionBpsOverride: input.commissionBpsOverride } : {}), version: { increment: 1 } } });
    if (changed.count !== 1) throw conflict('AFFILIATE_CHANGED', 'Affiliate was modified by another administrator');
    await prisma.auditLog.create({ data: auditData('ADMIN', admin.adminId, 'AFFILIATE_UPDATED', 'Affiliate', String(req.params.id), { status: input.status }) });
    return res.json(await prisma.affiliate.findUniqueOrThrow({ where: { id: String(req.params.id) } }));
  });
  router.get('/:id', async (req, res, next) => {
    if (['listings', 'payouts', 'seller-orders', 'issues', 'cancellations', 'settings'].includes(req.params.id)) return next();
    const affiliate = await prisma.affiliate.findUnique({ where: { id: String(req.params.id) }, include: { user: true, listings: { include: { product: { include: productInclude } }, orderBy: { updatedAt: 'desc' } }, shippingZones: { include: { provinces: true, rates: true } }, pickupPoints: true, sellerOrders: { orderBy: { updatedAt: 'desc' }, take: 20, include: { items: true, order: { select: { number: true } } } }, payoutRequests: { orderBy: { createdAt: 'desc' }, take: 20 }, _count: { select: { listings: true, sellerOrders: true, issues: true, payoutRequests: true } } } });
    if (!affiliate) throw notFound('Affiliate not found');
    const balance = await affiliateBalance(prisma, affiliate.id);
    return res.json({ affiliate: affiliateDto(affiliate), counts: affiliate._count, balance: Object.fromEntries(Object.entries(balance).map(([key, value]) => [key, money(value)])), listings: affiliate.listings.map(listingDto), logistics: { zones: affiliate.shippingZones.map(affiliateLogisticsDto), pickupPoints: affiliate.pickupPoints }, orders: affiliate.sellerOrders.map((row) => ({ ...affiliateSellerOrderDto(row), orderNumber: row.order.number })), payouts: affiliate.payoutRequests.map((row) => ({ ...row, amountMinor: money(row.amountMinor), destinationCipher: undefined })) });
  });
  router.get('/listings', async (req, res) => {
    const page = Math.max(1, z.coerce.number().int().default(1).parse(req.query.page));
    const pageSize = Math.min(100, Math.max(1, z.coerce.number().int().default(25).parse(req.query.pageSize)));
    const status = req.query.status ? z.nativeEnum(AffiliateListingStatus).parse(String(req.query.status)) : undefined;
    const search = req.query.search ? String(req.query.search).trim() : '';
    const where = { ...(status ? { status } : {}), ...(search ? { OR: [{ product: { name: { contains: search } } }, { affiliate: { publicName: { contains: search } } }] } : {}) };
    const [total, rows] = await Promise.all([
      prisma.affiliateListing.count({ where }),
      prisma.affiliateListing.findMany({ where, orderBy: [{ submittedAt: 'asc' }, { updatedAt: 'desc' }], skip: (page - 1) * pageSize, take: pageSize, include: { affiliate: true, product: { include: productInclude } } }),
    ]);
    return res.json({ items: rows.map((row) => ({ ...listingDto(row as never), affiliate: { id: row.affiliate.id, publicName: row.affiliate.publicName, status: row.affiliate.status } })), page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
  });
  router.get('/listings/:id', async (req, res) => {
    const row = await prisma.affiliateListing.findUnique({ where: { id: String(req.params.id) }, include: { affiliate: true, product: { include: productInclude } } });
    if (!row) throw notFound('Affiliate listing not found');
    return res.json({ listing: { ...listingDto(row as never), affiliate: { id: row.affiliate.id, publicName: row.affiliate.publicName, status: row.affiliate.status } } });
  });
  router.post('/listings/:id/review', async (req, res) => {
    const admin = currentAdmin(req); if (!admin) throw forbidden();
    const input = listingReviewSchema.parse(req.body);
    const listing = await prisma.affiliateListing.findUnique({ where: { id: String(req.params.id) }, include: { affiliate: true, product: true } }); if (!listing) throw notFound('Affiliate listing not found');
    if (listing.product.version !== input.expectedVersion) throw conflict('PRODUCT_CHANGED', 'Listing was modified by another request');
    const productStatus = input.decision === 'APPROVED' ? ProductStatus.PUBLISHED : ProductStatus.DRAFT;
    await prisma.$transaction(async (tx) => {
      await tx.affiliateListing.update({ where: { id: listing.id }, data: { status: input.decision, reviewNote: input.note ?? null, reviewedAt: new Date(), reviewedById: admin.adminId } });
      await tx.product.update({ where: { id: listing.productId }, data: { status: productStatus, publishedAt: productStatus === ProductStatus.PUBLISHED ? new Date() : null, version: { increment: 1 } } });
      await tx.auditLog.create({ data: auditData('ADMIN', admin.adminId, `AFFILIATE_LISTING_${input.decision}`, 'AffiliateListing', listing.id, { productId: listing.productId, note: input.note }) });
    });
    // La revisión ya fue confirmada dentro de la transacción. Las notificaciones
    // se ejecutan después del commit y no deben convertir una aprobación válida
    // en un error 500 si falla el canal de avisos o su persistencia.
    try {
      const notices = await createAffiliateListingNotification(prisma, { userId: listing.affiliate.userId }, { id: listing.id, productName: listing.product.name }, NotificationType.AFFILIATE_LISTING_REVIEWED, 'Tu publicación fue revisada', `La publicación ${listing.product.name} fue marcada como ${input.decision.toLowerCase()}.`, `review:${input.decision}:${input.expectedVersion}`);
      if (realtime) await publishNotifications(prisma, realtime, notices.map((notice) => notice.id));
    } catch (error) {
      logger.error({ err: error, listingId: listing.id, decision: input.decision }, 'Affiliate listing review notification failed after commit');
    }
    return res.json({ id: listing.id, status: input.decision, productStatus, version: input.expectedVersion + 1 });
  });
  router.get('/payouts', async (req, res) => {
    const page = Math.max(1, z.coerce.number().int().default(1).parse(req.query.page));
    const pageSize = Math.min(100, Math.max(1, z.coerce.number().int().default(25).parse(req.query.pageSize)));
    const status = req.query.status ? z.nativeEnum(AffiliatePayoutStatus).parse(String(req.query.status)) : undefined;
    const where = status ? { status } : {};
    const [total, rows] = await Promise.all([
      prisma.affiliatePayoutRequest.count({ where }),
      prisma.affiliatePayoutRequest.findMany({ where, include: { affiliate: true }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
    ]);
    return res.json({ items: rows.map((payout) => ({ ...payout, amountMinor: payout.amountMinor.toString(), destinationCipher: undefined, affiliate: { id: payout.affiliate.id, publicName: payout.affiliate.publicName } })), page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
  });
  router.get('/payouts/:id', async (req, res) => {
    const payout = await prisma.affiliatePayoutRequest.findUnique({ where: { id: String(req.params.id) }, include: { affiliate: true, ledgerEntries: true } });
    if (!payout) throw notFound('Payout request not found');
    const { ledgerEntries, ...payoutData } = payout;
    const available = await prisma.affiliateLedgerEntry.aggregate({ _sum: { amountMinor: true }, where: { affiliateId: payout.affiliateId, bucket: AffiliateLedgerBucket.AVAILABLE } });
    return res.json({ payout: { ...payoutData, amountMinor: money(payout.amountMinor), destinationCipher: undefined, destinationLast4: payout.destinationLast4, affiliate: { id: payout.affiliate.id, publicName: payout.affiliate.publicName } }, availableMinor: money(available._sum.amountMinor ?? 0n), ledger: ledgerEntries.map((entry) => ({ ...entry, amountMinor: money(entry.amountMinor) })) });
  });
  router.post('/payouts/:id/reveal-destination', async (req, res) => {
    const admin = currentAdmin(req); if (!admin) throw forbidden();
    const payout = await prisma.affiliatePayoutRequest.findUnique({ where: { id: String(req.params.id) } });
    if (!payout?.destinationCipher) throw notFound('Payout destination not available');
    const revealed = unseal(payout.destinationCipher);
    await prisma.auditLog.create({ data: auditData('ADMIN', admin.adminId, 'AFFILIATE_PAYOUT_DESTINATION_REVEALED', 'AffiliatePayoutRequest', payout.id) });
    return res.json({ destination: revealed, expiresInSeconds: 60 });
  });
  router.get('/seller-orders', async (req, res) => {
    const page = Math.max(1, z.coerce.number().int().default(1).parse(req.query.page));
    const pageSize = Math.min(100, Math.max(1, z.coerce.number().int().default(25).parse(req.query.pageSize)));
    const status = req.query.status ? z.nativeEnum(SellerOrderStatus).parse(String(req.query.status)) : undefined;
    const search = req.query.search ? String(req.query.search).trim() : '';
    const where = { sellerType: 'AFFILIATE' as const, affiliateId: { not: null }, ...(status ? { status } : {}), ...(search ? { OR: [{ number: { contains: search } }, { sellerName: { contains: search } }, { order: { number: { contains: search } } }] } : {}) };
    const [total, rows] = await Promise.all([
      prisma.sellerOrder.count({ where }),
      prisma.sellerOrder.findMany({ where, include: { affiliate: true, order: { select: { number: true, userId: true, payment: true } }, items: true, statusHistory: { orderBy: { createdAt: 'asc' } }, issues: { where: { status: 'OPEN' } } }, orderBy: { updatedAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
    ]);
    return res.json({ items: rows.map((row) => ({ ...affiliateSellerOrderDto(row), allowedActions: sellerOrderAllowedActions(row, 'ADMIN'), affiliate: row.affiliate ? { id: row.affiliate.id, publicName: row.affiliate.publicName } : null, order: { number: row.order.number, userId: row.order.userId, paymentId: row.order.payment?.id ?? null } })), page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
  });
  router.get('/seller-orders/:id', async (req, res) => {
    const row = await prisma.sellerOrder.findFirst({ where: { id: String(req.params.id), sellerType: 'AFFILIATE', affiliateId: { not: null } }, include: { affiliate: true, order: { include: { payment: true } }, items: true, statusHistory: { orderBy: { createdAt: 'asc' } }, issues: { orderBy: { createdAt: 'desc' } }, cancellationRequests: { orderBy: { createdAt: 'desc' } }, refunds: { include: { refundLines: true }, orderBy: { createdAt: 'desc' } } } });
    if (!row) throw notFound('Seller order not found');
    return res.json({ order: { ...affiliateSellerOrderDto(row), allowedActions: sellerOrderAllowedActions(row, 'ADMIN'), affiliate: row.affiliate ? { id: row.affiliate.id, publicName: row.affiliate.publicName } : null, parentOrder: { id: row.order.id, number: row.order.number, status: row.order.status, paymentStatus: row.order.payment?.status ?? null } } });
  });
  router.post('/seller-orders/:id/status', async (req, res) => {
    const admin = currentAdmin(req); if (!admin) throw forbidden();
    const input = versionSchema.extend({ status: z.nativeEnum(SellerOrderStatus), note: z.string().trim().min(3).max(500), carrier: z.string().trim().max(100).nullable().optional(), trackingCode: z.string().trim().max(120).nullable().optional() }).parse(req.body);
    const settings = await prisma.affiliateProgramSettings.upsert({ where: { id: 'default' }, create: {}, update: {} });
    const order = await prisma.$transaction((tx) => transitionSellerOrder(tx, { sellerOrderId: String(req.params.id), expectedVersion: input.expectedVersion, nextStatus: input.status, actor: 'ADMIN', actorId: admin.adminId, note: input.note, autoCompleteDays: settings.autoCompleteDays, carrier: input.carrier, trackingCode: input.trackingCode }));
    const context = await prisma.sellerOrder.findUniqueOrThrow({ where: { id: order.id }, include: { affiliate: true, order: { select: { number: true } } } });
    const notice = context.affiliate ? await createSellerOrderStatusNotification(prisma, { id: context.id, orderNumber: context.order.number, affiliateUserId: context.affiliate.userId }, context.status, `admin:${context.version}`) : null;
    if (realtime && notice) await publishNotifications(prisma, realtime, [notice.id]);
    return res.json({ id: order.id, status: order.status, version: order.version, allowedActions: sellerOrderAllowedActions(order, 'ADMIN') });
  });
  router.post('/seller-orders/:id/refund', async (req, res) => {
    const admin = currentAdmin(req); if (!admin) throw forbidden();
    const input = adminRefundSchema.parse(req.body);
    const result = await prisma.$transaction((tx) => refundSellerOrder(tx, { sellerOrderId: String(req.params.id), expectedVersion: input.expectedVersion, amountMinor: input.amountMinor, subtotalMinor: input.subtotalMinor, shippingMinor: input.shippingMinor, reason: input.reason, externalReference: input.externalReference, createdById: admin.adminId, restock: input.restock, lines: input.lines }));
    const context = await prisma.sellerOrder.findUniqueOrThrow({ where: { id: result.order.id }, include: { affiliate: true, order: { select: { number: true } } } });
    const notice = context.affiliate ? await createSellerOrderStatusNotification(prisma, { id: context.id, orderNumber: context.order.number, affiliateUserId: context.affiliate.userId }, context.status, `refund:${context.version}`) : null;
    if (realtime && notice) await publishNotifications(prisma, realtime, [notice.id]);
    return res.json({ id: result.order.id, status: result.order.status, version: result.order.version, refundId: result.refund.id, allowedActions: sellerOrderAllowedActions(result.order, 'ADMIN') });
  });
  router.get('/issues', async (request, res) => {
    const page = Math.max(1, z.coerce.number().int().default(1).parse(request.query.page));
    const pageSize = Math.min(100, Math.max(1, z.coerce.number().int().default(25).parse(request.query.pageSize)));
    const status = request.query.status ? z.nativeEnum(AffiliateIssueStatus).parse(String(request.query.status)) : undefined;
    const where = status ? { status } : {};
    const [total, rows] = await Promise.all([
      prisma.affiliateIssue.count({ where }),
      prisma.affiliateIssue.findMany({ where, include: { affiliate: true, sellerOrder: { include: { order: { select: { number: true, payment: true } }, items: true } }, openedBy: { select: { id: true, email: true, name: true } } }, orderBy: { createdAt: 'asc' }, skip: (page - 1) * pageSize, take: pageSize }),
    ]);
    return res.json({ items: rows.map((row) => ({ ...row, affiliate: { id: row.affiliate.id, publicName: row.affiliate.publicName }, sellerOrder: { ...affiliateSellerOrderDto(row.sellerOrder), order: { number: row.sellerOrder.order.number, paymentId: row.sellerOrder.order.payment?.id ?? null } } })), page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
  });
  router.get('/issues/:id', async (req, res) => {
    const issue = await prisma.affiliateIssue.findUnique({ where: { id: String(req.params.id) }, include: { affiliate: true, openedBy: { select: { id: true, email: true, name: true } }, sellerOrder: { include: { order: { include: { payment: true } }, items: true, statusHistory: { orderBy: { createdAt: 'asc' } }, issues: true } } } });
    if (!issue) throw notFound('Affiliate issue not found');
    return res.json({ issue: { ...issue, affiliate: { id: issue.affiliate.id, publicName: issue.affiliate.publicName }, sellerOrder: affiliateSellerOrderDto(issue.sellerOrder) } });
  });
  router.post('/issues/:id/resolve', async (req, res) => {
    const admin = currentAdmin(req); if (!admin) throw forbidden();
    const input = z.object({ expectedVersion: z.coerce.number().int().min(1), decision: z.enum(['CONTINUE', 'COMPLETE', 'PARTIAL_REFUND', 'FULL_REFUND', 'COMPLETED', 'REFUNDED']), note: z.string().trim().min(3).max(500), refundAmountMinor: z.coerce.bigint().positive().optional(), refundSubtotalMinor: z.coerce.bigint().nonnegative().optional(), refundShippingMinor: z.coerce.bigint().nonnegative().optional(), externalReference: z.string().trim().min(2).max(150).optional(), restock: z.boolean().optional() }).parse(req.body);
    const decision = input.decision === 'COMPLETED' ? 'COMPLETE' : input.decision === 'REFUNDED' ? 'FULL_REFUND' : input.decision;
    const issue = await prisma.affiliateIssue.findUnique({ where: { id: String(req.params.id) }, include: { sellerOrder: { include: { order: { include: { payment: true } } } } } });
    if (!issue) throw notFound('Affiliate issue not found');
    if (input.refundAmountMinor && !input.externalReference) throw badRequest('REFUND_DATA_REQUIRED', 'An external refund reference is required');
    const refund = input.refundAmountMinor ? { amountMinor: input.refundAmountMinor, subtotalMinor: input.refundSubtotalMinor, shippingMinor: input.refundShippingMinor, externalReference: input.externalReference!, restock: input.restock, lines: undefined } : undefined;
    const resolved = await prisma.$transaction((tx) => resolveAffiliateIssue(tx, { issueId: issue.id, expectedVersion: input.expectedVersion, decision, note: input.note, adminId: admin.adminId, refund }));
    const affiliate = await prisma.affiliate.findUniqueOrThrow({ where: { id: issue.affiliateId } });
    const sellerOrder = await prisma.sellerOrder.findUniqueOrThrow({ where: { id: issue.sellerOrderId }, include: { order: { select: { number: true } } } });
    const notice = await createSellerOrderStatusNotification(prisma, { id: sellerOrder.id, orderNumber: sellerOrder.order.number, affiliateUserId: affiliate.userId }, sellerOrder.status, `issue:${resolved.version}`);
    if (realtime) await publishNotifications(prisma, realtime, [notice.id]);
    return res.json({ id: resolved.id, status: resolved.status });
  });
  router.get('/cancellations', async (req, res) => {
    const page = Math.max(1, z.coerce.number().int().default(1).parse(req.query.page));
    const pageSize = Math.min(100, Math.max(1, z.coerce.number().int().default(25).parse(req.query.pageSize)));
    const status = req.query.status ? z.enum(['REQUESTED', 'APPROVED', 'REJECTED']).parse(String(req.query.status)) : undefined;
    const where = status ? { status } : {};
    const [total, items] = await Promise.all([
      prisma.affiliateCancellationRequest.count({ where }),
      prisma.affiliateCancellationRequest.findMany({ where, include: { affiliate: true, sellerOrder: { include: { order: { select: { number: true } }, items: true } } }, orderBy: { createdAt: 'asc' }, skip: (page - 1) * pageSize, take: pageSize }),
    ]);
    return res.json({ items: items.map((item) => ({ ...item, affiliate: { id: item.affiliate.id, publicName: item.affiliate.publicName }, sellerOrder: affiliateSellerOrderDto(item.sellerOrder), orderNumber: item.sellerOrder.order.number })), page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
  });
  router.get('/cancellations/:id', async (req, res) => {
    const item = await prisma.affiliateCancellationRequest.findUnique({ where: { id: String(req.params.id) }, include: { affiliate: true, sellerOrder: { include: { order: { include: { payment: true } }, items: true, statusHistory: { orderBy: { createdAt: 'asc' } } } } } });
    if (!item) throw notFound('Cancellation request not found');
    return res.json({ cancellation: { ...item, affiliate: { id: item.affiliate.id, publicName: item.affiliate.publicName }, sellerOrder: affiliateSellerOrderDto(item.sellerOrder) } });
  });
  router.post('/cancellations/:id/resolve', async (req, res) => {
    const admin = currentAdmin(req); if (!admin) throw forbidden();
    const input = z.object({ expectedVersion: z.coerce.number().int().min(1), decision: z.enum(['APPROVED', 'REJECTED']), note: z.string().trim().min(3).max(500), refundAmountMinor: z.coerce.bigint().positive().optional(), externalReference: z.string().trim().min(2).max(150).optional(), restock: z.boolean().optional() }).parse(req.body);
    if (input.decision === 'APPROVED' && input.refundAmountMinor && !input.externalReference) throw badRequest('REFUND_DATA_REQUIRED', 'An external refund reference is required');
    const request = await prisma.$transaction((tx) => resolveCancellation(tx, { requestId: String(req.params.id), expectedVersion: input.expectedVersion, decision: input.decision, note: input.note, adminId: admin.adminId, refund: input.refundAmountMinor ? { amountMinor: input.refundAmountMinor, externalReference: input.externalReference!, restock: input.restock, lines: undefined } : undefined }));
    const context = await prisma.affiliateCancellationRequest.findUniqueOrThrow({ where: { id: request.id }, include: { affiliate: true, sellerOrder: { include: { order: { select: { number: true } } } } } });
    const notice = await createSellerOrderStatusNotification(prisma, { id: context.sellerOrder.id, orderNumber: context.sellerOrder.order.number, affiliateUserId: context.affiliate.userId }, context.sellerOrder.status, `cancellation:${context.version}`);
    if (realtime) await publishNotifications(prisma, realtime, [notice.id]);
    return res.json({ id: request.id, status: request.status, version: request.version });
  });
  router.post('/payouts/:id/process', async (req, res) => {
    const admin = currentAdmin(req); if (!admin) throw forbidden();
    const input = versionSchema.extend({ status: z.enum(['PROCESSING', 'PAID', 'REJECTED']), externalReference: z.string().trim().min(2).max(150), note: z.string().trim().max(500).optional() }).parse(req.body);
    const result = await prisma.$transaction(async (tx) => {
      const payout = await tx.affiliatePayoutRequest.findUnique({ where: { id: String(req.params.id) } }); if (!payout) throw notFound('Payout request not found');
      if (input.status === 'PROCESSING') {
        if (payout.status !== AffiliatePayoutStatus.REQUESTED || payout.version !== input.expectedVersion) throw conflict('PAYOUT_CHANGED', 'Payout was modified by another administrator');
        const updated = await tx.affiliatePayoutRequest.updateMany({ where: { id: payout.id, version: input.expectedVersion, status: AffiliatePayoutStatus.REQUESTED }, data: { status: AffiliatePayoutStatus.PROCESSING, externalReference: input.externalReference, note: input.note, processedById: admin.adminId, version: { increment: 1 } } });
        if (updated.count !== 1) throw conflict('PAYOUT_CHANGED', 'Payout was modified by another administrator');
        await tx.auditLog.create({ data: auditData('ADMIN', admin.adminId, 'AFFILIATE_PAYOUT_PROCESSING', 'AffiliatePayoutRequest', payout.id) });
        return { id: payout.id, status: 'PROCESSING', version: input.expectedVersion + 1 };
      }
      if (payout.status !== AffiliatePayoutStatus.PROCESSING || payout.version !== input.expectedVersion) throw conflict('PAYOUT_CHANGED', 'Payout must be in processing before it can be closed');
      const updated = await tx.affiliatePayoutRequest.updateMany({ where: { id: payout.id, version: input.expectedVersion, status: AffiliatePayoutStatus.PROCESSING }, data: { status: input.status, externalReference: input.externalReference, note: input.note, processedById: admin.adminId, processedAt: new Date(), version: { increment: 1 } } });
      if (updated.count !== 1) throw conflict('PAYOUT_CHANGED', 'Payout was modified by another administrator');
      if (input.status === 'PAID') {
        await tx.affiliateLedgerEntry.create({ data: { affiliateId: payout.affiliateId, payoutId: payout.id, bucket: 'RESERVED', type: 'PAYOUT_PAID', amountMinor: -payout.amountMinor, dedupeKey: `payout:${payout.id}:paid-reserved` } });
        await tx.affiliateLedgerEntry.create({ data: { affiliateId: payout.affiliateId, payoutId: payout.id, bucket: 'PAID', type: 'PAYOUT_PAID', amountMinor: payout.amountMinor, dedupeKey: `payout:${payout.id}:paid` } });
      } else {
        await tx.affiliateLedgerEntry.create({ data: { affiliateId: payout.affiliateId, payoutId: payout.id, bucket: 'RESERVED', type: 'PAYOUT_RELEASED', amountMinor: -payout.amountMinor, dedupeKey: `payout:${payout.id}:rejected-reserved` } });
        await tx.affiliateLedgerEntry.create({ data: { affiliateId: payout.affiliateId, payoutId: payout.id, bucket: 'AVAILABLE', type: 'PAYOUT_RELEASED', amountMinor: payout.amountMinor, dedupeKey: `payout:${payout.id}:rejected-available` } });
      }
      await tx.auditLog.create({ data: auditData('ADMIN', admin.adminId, `AFFILIATE_PAYOUT_${input.status}`, 'AffiliatePayoutRequest', payout.id, { externalReference: input.externalReference }) });
      return { id: payout.id, status: input.status, version: input.expectedVersion + 1 };
    });
    const context = await prisma.affiliatePayoutRequest.findUniqueOrThrow({ where: { id: result.id }, include: { affiliate: true } });
    const notices = await createAffiliatePayoutNotification(prisma, { userId: context.affiliate.userId }, { id: context.id, amountMinor: context.amountMinor }, NotificationType.AFFILIATE_PAYOUT_UPDATED, 'Actualización de retiro', `Tu retiro de ${money(context.amountMinor)} USD ahora está ${context.status.toLowerCase()}.`, `status:${context.version}`);
    if (realtime) await publishNotifications(prisma, realtime, notices.map((notice) => notice.id));
    return res.json(result);
  });
  router.get('/settings', async (_req, res) => res.json(await prisma.affiliateProgramSettings.upsert({ where: { id: 'default' }, create: {}, update: {} })));
  router.patch('/settings', async (req, res) => {
    const admin = currentAdmin(req); if (!admin) throw forbidden();
    const input = versionSchema.extend({ commissionBps: z.coerce.number().int().min(0).max(10000), autoCompleteDays: z.coerce.number().int().min(1).max(90) }).parse(req.body);
    const changed = await prisma.affiliateProgramSettings.updateMany({ where: { id: 'default', version: input.expectedVersion }, data: { commissionBps: input.commissionBps, autoCompleteDays: input.autoCompleteDays, version: { increment: 1 }, updatedById: admin.adminId } });
    if (changed.count !== 1) throw conflict('AFFILIATE_SETTINGS_CHANGED', 'Affiliate settings were modified by another administrator');
    return res.json(await prisma.affiliateProgramSettings.findUniqueOrThrow({ where: { id: 'default' } }));
  });
  router.post('/ledger-adjustments', async (req, res) => {
    const admin = currentAdmin(req); if (!admin) throw forbidden();
    const input = z.object({ affiliateId: z.string().uuid(), bucket: z.nativeEnum(AffiliateLedgerBucket), amountMinor: z.coerce.bigint().refine((value) => value !== 0n, 'Amount cannot be zero'), note: z.string().trim().min(3).max(500) }).parse(req.body);
    const affiliate = await prisma.affiliate.findUnique({ where: { id: input.affiliateId } }); if (!affiliate) throw notFound('Affiliate not found');
    const entry = await prisma.$transaction(async (tx) => {
      const created = await tx.affiliateLedgerEntry.create({ data: { affiliateId: affiliate.id, bucket: input.bucket, type: 'ADJUSTMENT', amountMinor: input.amountMinor, note: input.note, dedupeKey: `adjustment:${randomUUID()}` } });
      await tx.auditLog.create({ data: auditData('ADMIN', admin.adminId, 'AFFILIATE_LEDGER_ADJUSTMENT', 'AffiliateLedgerEntry', created.id, { affiliateId: affiliate.id, bucket: input.bucket, amountMinor: input.amountMinor.toString(), note: input.note }) });
      return created;
    });
    return res.status(201).json({ ...entry, amountMinor: money(entry.amountMinor) });
  });
  return router;
}

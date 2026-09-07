import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { Secret, TOTP } from 'otpauth';
import { encrypt } from '../src/shared/crypto.js';

const prisma = new PrismaClient();
const storageRoot = path.resolve(process.env.STORAGE_ROOT ?? './storage');
const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@cardshop.test';
const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'Admin123!seed-card-shop';
const userEmail = process.env.SEED_USER_EMAIL ?? 'user@cardshop.test';
const userPassword = process.env.SEED_USER_PASSWORD ?? 'User123!seed-card-shop';
const totpSecret = process.env.SEED_ADMIN_TOTP_SECRET ?? 'JBSWY3DPEHPK3PXP';

const products = [
  { id: '11111111-1111-4111-8111-111111111111', sku: 'CARD-BASE-001', slug: 'aurora-dragon', name: 'Aurora Dragon', description: 'Una pieza holográfica de presencia luminosa, seleccionada por su estado y acabado.', priceMinor: 185000n, stock: 1, setName: 'Aurora Origins', cardNumber: '001/120', rarity: 'Ultra Rare', condition: 'NM' as const, language: 'ES', finish: 'Holo' },
  { id: '22222222-2222-4222-8222-222222222222', sku: 'CARD-BASE-014', slug: 'forest-guardian', name: 'Forest Guardian', description: 'Carta individual con ilustración de bosque y una textura foil delicada.', priceMinor: 76000n, stock: 1, setName: 'Verdant Clash', cardNumber: '014/098', rarity: 'Rare Holo', condition: 'NM' as const, language: 'EN', finish: 'Foil' },
  { id: '33333333-3333-4333-8333-333333333333', sku: 'CARD-BASE-027', slug: 'volcanic-spark', name: 'Volcanic Spark', description: 'Una carta intensa para quienes buscan color y carácter en su binder.', priceMinor: 42000n, stock: 1, setName: 'Ember Rise', cardNumber: '027/110', rarity: 'Illustration Rare', condition: 'EXCELLENT' as const, language: 'ES', finish: 'Reverse Holo' },
  { id: '44444444-4444-4444-8444-444444444444', sku: 'CARD-BASE-039', slug: 'moonlit-fox', name: 'Moonlit Fox', description: 'Edición especial de tirada corta, protegida y lista para exhibir.', priceMinor: 99000n, stock: 1, setName: 'Nocturne Set', cardNumber: '039/088', rarity: 'Special Rare', condition: 'NM' as const, language: 'JP', finish: 'Holo' },
  { id: '55555555-5555-4555-8555-555555555555', sku: 'SEALED-BASE-001', slug: 'aurora-booster-box', name: 'Aurora Origins Booster Box', description: 'Caja sellada de 36 sobres para abrir, guardar o regalar.', priceMinor: 1250000n, stock: 12, setName: null },
  { id: '66666666-6666-4666-8666-666666666666', sku: 'SEALED-BASE-002', slug: 'verdant-elite-trainer', name: 'Verdant Clash Elite Trainer Box', description: 'Caja de entrenador con accesorios y sobres de la expansión.', priceMinor: 780000n, stock: 8, setName: null },
  { id: '77777777-7777-4777-8777-777777777777', sku: 'SEALED-BASE-003', slug: 'ember-rise-bundle', name: 'Ember Rise Bundle', description: 'Bundle sellado para comenzar una nueva búsqueda sin perder el ritual.', priceMinor: 315000n, stock: 15, setName: null },
  { id: '88888888-8888-4888-8888-888888888888', sku: 'SEALED-BASE-004', slug: 'collector-protector-kit', name: 'Collector Protector Kit', description: 'Kit de sleeves y protectores rígidos para cuidar tu colección.', priceMinor: 68000n, stock: 30, setName: null },
];

function svgFor(index: number, label: string) { const colors = ['#2b4939', '#799650', '#d77c61', '#edc96d', '#7589a5']; const color = colors[index % colors.length]; return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1100" viewBox="0 0 900 1100"><rect width="900" height="1100" rx="44" fill="#edf0e8"/><rect x="35" y="35" width="830" height="1030" rx="32" fill="${color}"/><circle cx="450" cy="440" r="210" fill="#ffffff22"/><path d="M450 195l32 170 166 45-166 45-32 170-32-170-166-45 166-45z" fill="#ffffff77"/><text x="80" y="900" fill="white" font-family="Arial" font-size="42" font-weight="700">${label}</text><text x="80" y="958" fill="#ffffffaa" font-family="Arial" font-size="20" letter-spacing="4">CARD SHOP / CURATED</text></svg>`; }

async function seedImage(productId: string, index: number, name: string) {
  const fileId = `a${String(index + 1).padStart(2, '0')}00000-0000-4000-8000-000000000000`;
  const relative = `public/products/${fileId}.webp`;
  const absolute = path.join(storageRoot, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  const output = await sharp(Buffer.from(svgFor(index, name))).webp({ quality: 84 }).toBuffer();
  await writeFile(absolute, output);
  await prisma.storedFile.upsert({ where: { id: fileId }, update: { storageKey: relative, mimeType: 'image/webp', sizeBytes: output.byteLength, sha256: createHash('sha256').update(output).digest('hex'), visibility: 'PUBLIC' }, create: { id: fileId, storageKey: relative, mimeType: 'image/webp', sizeBytes: output.byteLength, sha256: createHash('sha256').update(output).digest('hex'), visibility: 'PUBLIC' } });
  await prisma.productImage.upsert({ where: { fileId }, update: { productId, sortOrder: 0, altText: name }, create: { productId, fileId, sortOrder: 0, altText: name } });
}

async function main() {
  if (adminPassword.length < 12 || userPassword.length < 12) throw new Error('Seed passwords must have at least 12 characters');
  const admin = await prisma.admin.upsert({ where: { email: adminEmail }, update: { name: 'Store Admin', passwordHash: await argon2.hash(adminPassword, { type: argon2.argon2id }), status: 'ACTIVE', totpSecretCipher: encrypt(totpSecret), totpEnabledAt: new Date() }, create: { email: adminEmail, name: 'Store Admin', passwordHash: await argon2.hash(adminPassword, { type: argon2.argon2id }), status: 'ACTIVE', totpSecretCipher: encrypt(totpSecret), totpEnabledAt: new Date() } });
  await prisma.user.upsert({ where: { email: userEmail }, update: { name: 'Demo Collector', passwordHash: await argon2.hash(userPassword, { type: argon2.argon2id }), status: 'ACTIVE', emailVerifiedAt: new Date() }, create: { email: userEmail, name: 'Demo Collector', passwordHash: await argon2.hash(userPassword, { type: argon2.argon2id }), status: 'ACTIVE', emailVerifiedAt: new Date() } });
  await prisma.adminRecoveryCode.deleteMany({ where: { adminId: admin.id } });
  for (const product of products) {
    await prisma.product.upsert({ where: { id: product.id }, update: { sku: product.sku, slug: product.slug, name: product.name, description: product.description, kind: product.setName ? 'SINGLE_CARD' : 'SEALED_PRODUCT', stockMode: product.setName ? 'UNIQUE' : 'QUANTITY', priceMinor: product.priceMinor, currency: 'ARS', status: 'PUBLISHED', publishedAt: new Date(), archivedAt: null, version: 1 }, create: { id: product.id, sku: product.sku, slug: product.slug, name: product.name, description: product.description, kind: product.setName ? 'SINGLE_CARD' : 'SEALED_PRODUCT', stockMode: product.setName ? 'UNIQUE' : 'QUANTITY', priceMinor: product.priceMinor, currency: 'ARS', status: 'PUBLISHED', publishedAt: new Date(), version: 1 } });
    const currentInventory = await prisma.inventory.findUnique({ where: { productId: product.id } });
    if (!currentInventory) await prisma.inventory.create({ data: { productId: product.id, onHand: product.stock, reserved: 0, version: 1 } });
    else if (currentInventory.reserved === 0) await prisma.inventory.update({ where: { productId: product.id }, data: { onHand: product.stock } });
    if (product.setName) await prisma.pokemonCardDetails.upsert({ where: { productId: product.id }, update: { setName: product.setName, cardNumber: product.cardNumber, rarity: product.rarity, condition: product.condition, language: product.language, finish: product.finish }, create: { productId: product.id, setName: product.setName, cardNumber: product.cardNumber, rarity: product.rarity, condition: product.condition, language: product.language, finish: product.finish } });
    await seedImage(product.id, products.indexOf(product), product.name);
  }
  const zone = await prisma.shippingZone.upsert({ where: { id: '99999999-9999-4999-8999-999999999999' }, update: { name: 'Argentina', active: true }, create: { id: '99999999-9999-4999-8999-999999999999', name: 'Argentina', active: true } });
  await prisma.shippingZoneProvince.deleteMany({ where: { zoneId: zone.id } });
  await prisma.shippingZoneProvince.createMany({ data: ['Buenos Aires', 'CABA', 'Córdoba', 'Santa Fe', 'Mendoza'].map((province) => ({ zoneId: zone.id, province })) });
  await prisma.shippingRate.upsert({ where: { id: 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1' }, update: { zoneId: zone.id, name: 'Envío estándar', priceMinor: 65000n, currency: 'ARS', active: true }, create: { id: 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1', zoneId: zone.id, name: 'Envío estándar', priceMinor: 65000n, currency: 'ARS', active: true } });
  await prisma.shippingRate.upsert({ where: { id: 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2' }, update: { zoneId: zone.id, name: 'Envío express', priceMinor: 120000n, currency: 'ARS', active: true }, create: { id: 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2', zoneId: zone.id, name: 'Envío express', priceMinor: 120000n, currency: 'ARS', active: true } });
  await prisma.pickupPoint.upsert({ where: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, update: { name: 'Card Shop · Palermo', address: 'Av. Santa Fe 1234, CABA', active: true }, create: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Card Shop · Palermo', address: 'Av. Santa Fe 1234, CABA', active: true } });
  const otp = new TOTP({ issuer: 'back-card-shop', label: adminEmail, secret: Secret.fromBase32(totpSecret) }).generate();
  console.log(JSON.stringify({ seed: 'ok', admin: { email: adminEmail, password: adminPassword, totpSecret, currentOtp: otp }, user: { email: userEmail, password: userPassword }, products: products.length, pickupPointId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', shippingRateIds: ['aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2'] }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { await prisma.$disconnect(); });

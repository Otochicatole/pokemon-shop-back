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

type SeedPokemonType = 'COLORLESS' | 'DARKNESS' | 'DRAGON' | 'FAIRY' | 'FIGHTING' | 'FIRE' | 'GRASS' | 'LIGHTNING' | 'METAL' | 'PSYCHIC' | 'WATER';
type SeedCondition = 'NM' | 'EXCELLENT' | 'GOOD' | 'PLAYED' | 'DAMAGED';

type SeedPokemonCard = {
  pokemonType: SeedPokemonType;
  setName: string;
  setCode: string;
  cardNumber: string;
  rarity: string;
  language: string;
  condition: SeedCondition;
  finish: string;
  edition: string | null;
  gradingCompany: string | null;
  grade: string | null;
  certificationNumber: string | null;
};

type SeedProduct = {
  id: string;
  sku: string;
  slug: string;
  name: string;
  description: string;
  kind: 'SINGLE_CARD' | 'SEALED_PRODUCT' | 'ACCESSORY';
  stockMode: 'UNIQUE' | 'QUANTITY';
  priceMinor: bigint;
  stock: number;
  pokemonCard: SeedPokemonCard | null;
};

const products: SeedProduct[] = [
  { id: '11111111-1111-4111-8111-111111111111', sku: 'CARD-BASE-001', slug: 'aurora-dragon', name: 'Aurora Dragon', description: 'Una pieza holográfica de presencia luminosa, seleccionada por su estado y acabado.', kind: 'SINGLE_CARD', stockMode: 'UNIQUE', priceMinor: 185000n, stock: 1, pokemonCard: { pokemonType: 'DRAGON', setName: 'Aurora Origins', setCode: 'AOR', cardNumber: '001/120', rarity: 'Ultra Rare', language: 'ES', condition: 'NM', finish: 'Holo', edition: 'Primera edición', gradingCompany: 'PSA', grade: '10', certificationNumber: 'AOR-000001' } },
  { id: '22222222-2222-4222-8222-222222222222', sku: 'CARD-BASE-014', slug: 'forest-guardian', name: 'Forest Guardian', description: 'Carta individual con ilustración de bosque y una textura foil delicada.', kind: 'SINGLE_CARD', stockMode: 'UNIQUE', priceMinor: 76000n, stock: 1, pokemonCard: { pokemonType: 'GRASS', setName: 'Verdant Clash', setCode: 'VCL', cardNumber: '014/098', rarity: 'Rare Holo', language: 'EN', condition: 'NM', finish: 'Foil', edition: 'Unlimited', gradingCompany: null, grade: null, certificationNumber: null } },
  { id: '33333333-3333-4333-8333-333333333333', sku: 'CARD-BASE-027', slug: 'volcanic-spark', name: 'Volcanic Spark', description: 'Una carta intensa para quienes buscan color y carácter en su binder.', kind: 'SINGLE_CARD', stockMode: 'UNIQUE', priceMinor: 42000n, stock: 1, pokemonCard: { pokemonType: 'FIRE', setName: 'Ember Rise', setCode: 'EMR', cardNumber: '027/110', rarity: 'Illustration Rare', language: 'ES', condition: 'EXCELLENT', finish: 'Reverse Holo', edition: 'Unlimited', gradingCompany: null, grade: null, certificationNumber: null } },
  { id: '44444444-4444-4444-8444-444444444444', sku: 'CARD-BASE-039', slug: 'moonlit-fox', name: 'Moonlit Fox', description: 'Edición especial de tirada corta, protegida y lista para exhibir.', kind: 'SINGLE_CARD', stockMode: 'UNIQUE', priceMinor: 99000n, stock: 1, pokemonCard: { pokemonType: 'DARKNESS', setName: 'Nocturne Set', setCode: 'NOC', cardNumber: '039/088', rarity: 'Special Rare', language: 'JP', condition: 'NM', finish: 'Holo', edition: 'Promo', gradingCompany: null, grade: null, certificationNumber: null } },
  { id: '55555555-5555-4555-8555-555555555555', sku: 'SEALED-BASE-001', slug: 'aurora-booster-box', name: 'Aurora Origins Booster Box', description: 'Caja sellada de 36 sobres para abrir, guardar o regalar.', kind: 'SEALED_PRODUCT', stockMode: 'QUANTITY', priceMinor: 1250000n, stock: 12, pokemonCard: null },
  { id: '66666666-6666-4666-8666-666666666666', sku: 'SEALED-BASE-002', slug: 'verdant-elite-trainer', name: 'Verdant Clash Elite Trainer Box', description: 'Caja de entrenador con accesorios y sobres de la expansión.', kind: 'SEALED_PRODUCT', stockMode: 'QUANTITY', priceMinor: 780000n, stock: 8, pokemonCard: null },
  { id: '77777777-7777-4777-8777-777777777777', sku: 'SEALED-BASE-003', slug: 'ember-rise-bundle', name: 'Ember Rise Bundle', description: 'Bundle sellado para comenzar una nueva búsqueda sin perder el ritual.', kind: 'SEALED_PRODUCT', stockMode: 'QUANTITY', priceMinor: 315000n, stock: 15, pokemonCard: null },
  { id: '88888888-8888-4888-8888-888888888888', sku: 'ACCESSORY-001', slug: 'collector-protector-kit', name: 'Collector Protector Kit', description: 'Kit de sleeves y protectores rígidos para cuidar tu colección.', kind: 'ACCESSORY', stockMode: 'QUANTITY', priceMinor: 68000n, stock: 30, pokemonCard: null },
  { id: '99999991-9999-4999-8999-999999999991', sku: 'CARD-BASE-052', slug: 'tidal-sovereign', name: 'Tidal Sovereign', description: 'Carta de tipo Agua con arte clásico y desgaste leve de colección.', kind: 'SINGLE_CARD', stockMode: 'UNIQUE', priceMinor: 29000n, stock: 1, pokemonCard: { pokemonType: 'WATER', setName: 'Ocean Echoes', setCode: 'OCE', cardNumber: '052/112', rarity: 'Rare', language: 'EN', condition: 'GOOD', finish: 'Non-Holo', edition: 'Unlimited', gradingCompany: null, grade: null, certificationNumber: null } },
  { id: '99999992-9999-4999-8999-999999999992', sku: 'CARD-BASE-061', slug: 'storm-runner', name: 'Storm Runner', description: 'Carta eléctrica rápida con brillo holográfico y bordes impecables.', kind: 'SINGLE_CARD', stockMode: 'UNIQUE', priceMinor: 61000n, stock: 1, pokemonCard: { pokemonType: 'LIGHTNING', setName: 'Tempest Circuit', setCode: 'TPC', cardNumber: '061/104', rarity: 'Rare Holo', language: 'ES', condition: 'NM', finish: 'Holo', edition: 'Primera edición', gradingCompany: null, grade: null, certificationNumber: null } },
  { id: '99999993-9999-4999-8999-999999999993', sku: 'CARD-BASE-073', slug: 'iron-sentinel', name: 'Iron Sentinel', description: 'Full art de tipo Metal con textura marcada para una carpeta moderna.', kind: 'SINGLE_CARD', stockMode: 'UNIQUE', priceMinor: 87000n, stock: 1, pokemonCard: { pokemonType: 'METAL', setName: 'Chrome Frontier', setCode: 'CHF', cardNumber: '073/100', rarity: 'Full Art Rare', language: 'EN', condition: 'EXCELLENT', finish: 'Full Art', edition: 'Unlimited', gradingCompany: null, grade: null, certificationNumber: null } },
  { id: '99999994-9999-4999-8999-999999999994', sku: 'CARD-BASE-081', slug: 'mind-oracle', name: 'Mind Oracle', description: 'Carta psíquica jugada, ideal para completar una colección a buen precio.', kind: 'SINGLE_CARD', stockMode: 'UNIQUE', priceMinor: 18000n, stock: 0, pokemonCard: { pokemonType: 'PSYCHIC', setName: 'Astral Bonds', setCode: 'ASB', cardNumber: '081/126', rarity: 'Uncommon', language: 'ES', condition: 'PLAYED', finish: 'Reverse Holo', edition: 'Unlimited', gradingCompany: null, grade: null, certificationNumber: null } },
  { id: '99999995-9999-4999-8999-999999999995', sku: 'CARD-BASE-095', slug: 'fairy-wish', name: 'Fairy Wish', description: 'Promo de tipo Hada con patrón cosmos y presentación para exhibición.', kind: 'SINGLE_CARD', stockMode: 'UNIQUE', priceMinor: 54000n, stock: 1, pokemonCard: { pokemonType: 'FAIRY', setName: 'Dreamlight Promos', setCode: 'DLP', cardNumber: '095/P', rarity: 'Promo', language: 'JP', condition: 'NM', finish: 'Cosmos Holo', edition: 'Promo', gradingCompany: 'CGC', grade: '9.5', certificationNumber: 'DLP-000095' } },
  { id: '99999996-9999-4999-8999-999999999996', sku: 'CARD-BASE-103', slug: 'arena-bruiser', name: 'Arena Bruiser', description: 'Carta de tipo Lucha con señales visibles de juego y precio accesible.', kind: 'SINGLE_CARD', stockMode: 'UNIQUE', priceMinor: 9000n, stock: 1, pokemonCard: { pokemonType: 'FIGHTING', setName: 'Arena Rivals', setCode: 'ARV', cardNumber: '103/130', rarity: 'Common', language: 'EN', condition: 'DAMAGED', finish: 'Non-Holo', edition: 'Unlimited', gradingCompany: null, grade: null, certificationNumber: null } },
  { id: '99999997-9999-4999-8999-999999999997', sku: 'CARD-BASE-117', slug: 'wandering-companion', name: 'Wandering Companion', description: 'Illustration rare incolora con acabado cálido y estado de colección.', kind: 'SINGLE_CARD', stockMode: 'UNIQUE', priceMinor: 114000n, stock: 1, pokemonCard: { pokemonType: 'COLORLESS', setName: 'Open Roads', setCode: 'OPR', cardNumber: '117/142', rarity: 'Illustration Rare', language: 'ES', condition: 'NM', finish: 'Foil', edition: 'Unlimited', gradingCompany: null, grade: null, certificationNumber: null } },
  { id: '99999998-9999-4999-8999-999999999998', sku: 'ACCESSORY-002', slug: 'vault-binder-nine-pocket', name: 'Vault Binder 9-Pocket', description: 'Binder de carga lateral con cierre y capacidad para 360 cartas.', kind: 'ACCESSORY', stockMode: 'QUANTITY', priceMinor: 145000n, stock: 18, pokemonCard: null },
  { id: '99999999-9999-4999-8999-999999999998', sku: 'ACCESSORY-003', slug: 'aurora-playmat', name: 'Aurora Playmat', description: 'Playmat de neoprene con superficie suave y base antideslizante.', kind: 'ACCESSORY', stockMode: 'QUANTITY', priceMinor: 92000n, stock: 22, pokemonCard: null },
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
    await prisma.product.upsert({ where: { id: product.id }, update: { sku: product.sku, slug: product.slug, name: product.name, description: product.description, kind: product.kind, stockMode: product.stockMode, priceMinor: product.priceMinor, currency: 'ARS', status: 'PUBLISHED', publishedAt: new Date(), archivedAt: null, version: 1 }, create: { id: product.id, sku: product.sku, slug: product.slug, name: product.name, description: product.description, kind: product.kind, stockMode: product.stockMode, priceMinor: product.priceMinor, currency: 'ARS', status: 'PUBLISHED', publishedAt: new Date(), version: 1 } });
    const currentInventory = await prisma.inventory.findUnique({ where: { productId: product.id } });
    if (!currentInventory) await prisma.inventory.create({ data: { productId: product.id, onHand: product.stock, reserved: 0, version: 1 } });
    else if (currentInventory.reserved === 0) await prisma.inventory.update({ where: { productId: product.id }, data: { onHand: product.stock } });
    if (product.pokemonCard) await prisma.pokemonCardDetails.upsert({ where: { productId: product.id }, update: product.pokemonCard, create: { productId: product.id, ...product.pokemonCard } });
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

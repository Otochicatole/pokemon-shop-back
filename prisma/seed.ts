import { Prisma, PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { BASE_CURRENCY } from '../src/shared/currency.js';

const prisma = new PrismaClient();
const storageRoot = path.resolve(process.env.STORAGE_ROOT ?? './storage');
const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@cardshop.test';
const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'Admin123!seed-card-shop';
const userEmail = process.env.SEED_USER_EMAIL ?? 'user@cardshop.test';
const userPassword = process.env.SEED_USER_PASSWORD ?? 'User123!seed-card-shop';
const affiliateEmail = process.env.SEED_AFFILIATE_EMAIL ?? 'affiliate@cardshop.test';
const affiliatePassword = process.env.SEED_AFFILIATE_PASSWORD ?? 'Affiliate123!seed-card-shop';
const loyaltyProgramId = 'default';
const demoLoyaltyStartingPoints = 40;

/** 1 punto = US$0.01; ganás 1 punto por cada US$1; canje desde 1 punto hasta 50% del subtotal de tienda. */
const loyaltyProgramSeed = {
  enabled: true,
  currency: BASE_CURRENCY,
  spendPerPointMinor: 100n,
  pointsPerStep: 1,
  pointValueMinor: 1n,
  minimumRedemptionPoints: 1,
  maximumRedemptionPercent: 50,
} as const;

// Seed prices are expressed directly in USD minor units.

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

type SeedOrderStatus =
  | 'PENDING_PAYMENT'
  | 'PAYMENT_REVIEW'
  | 'PAID'
  | 'PREPARING'
  | 'READY_FOR_PICKUP'
  | 'SHIPPED'
  | 'COMPLETED'
  | 'EXPIRED'
  | 'REFUND_RECORDED'
  | 'PAYMENT_REQUIRES_REVIEW';

type SeedPaymentStatus = 'UNDER_REVIEW' | 'APPROVED' | 'REFUNDED' | 'REQUIRES_REVIEW';

type SeedOrderFixture = {
  number: string;
  status: SeedOrderStatus;
  paymentMethod: 'BANK_TRANSFER' | 'MERCADO_PAGO';
  paymentStatus: SeedPaymentStatus;
  fulfillmentType: 'SHIPMENT' | 'PICKUP';
  ageHours: number;
  items: readonly { productId: string; quantity: number }[];
  history: readonly SeedOrderStatus[];
  reservationState: 'ACTIVE' | 'CONSUMED' | 'RELEASED';
  providerStatus?: string;
  providerStatusDetail?: string;
  pendingTransferReceipt?: boolean;
  refund?: { reason: string; externalReference: string };
  auditAction: string;
  auditActor: 'ADMIN' | 'SYSTEM' | 'USER';
};

const products: SeedProduct[] = [
  { id: '11111111-1111-4111-8111-111111111111', sku: 'CARD-BASE-001', slug: 'aurora-dragon', name: 'Aurora Dragon', description: 'Una pieza holográfica de presencia luminosa, seleccionada por su estado y acabado.', kind: 'SINGLE_CARD', stockMode: 'UNIQUE', priceMinor: 122n, stock: 1, pokemonCard: { pokemonType: 'DRAGON', setName: 'Aurora Origins', setCode: 'AOR', cardNumber: '001/120', rarity: 'Ultra Rare', language: 'ES', condition: 'NM', finish: 'Holo', edition: 'Primera edición', gradingCompany: 'PSA', grade: '10', certificationNumber: 'AOR-000001' } },
  { id: '22222222-2222-4222-8222-222222222222', sku: 'CARD-BASE-014', slug: 'forest-guardian', name: 'Forest Guardian', description: 'Carta individual con ilustración de bosque y una textura foil delicada.', kind: 'SINGLE_CARD', stockMode: 'UNIQUE', priceMinor: 50n, stock: 1, pokemonCard: { pokemonType: 'GRASS', setName: 'Verdant Clash', setCode: 'VCL', cardNumber: '014/098', rarity: 'Rare Holo', language: 'EN', condition: 'NM', finish: 'Foil', edition: 'Unlimited', gradingCompany: null, grade: null, certificationNumber: null } },
  { id: '33333333-3333-4333-8333-333333333333', sku: 'CARD-BASE-027', slug: 'volcanic-spark', name: 'Volcanic Spark', description: 'Una carta intensa para quienes buscan color y carácter en su binder.', kind: 'SINGLE_CARD', stockMode: 'UNIQUE', priceMinor: 28n, stock: 1, pokemonCard: { pokemonType: 'FIRE', setName: 'Ember Rise', setCode: 'EMR', cardNumber: '027/110', rarity: 'Illustration Rare', language: 'ES', condition: 'EXCELLENT', finish: 'Reverse Holo', edition: 'Unlimited', gradingCompany: null, grade: null, certificationNumber: null } },
  { id: '44444444-4444-4444-8444-444444444444', sku: 'CARD-BASE-039', slug: 'moonlit-fox', name: 'Moonlit Fox', description: 'Edición especial de tirada corta, protegida y lista para exhibir.', kind: 'SINGLE_CARD', stockMode: 'UNIQUE', priceMinor: 65n, stock: 1, pokemonCard: { pokemonType: 'DARKNESS', setName: 'Nocturne Set', setCode: 'NOC', cardNumber: '039/088', rarity: 'Special Rare', language: 'JP', condition: 'NM', finish: 'Holo', edition: 'Promo', gradingCompany: null, grade: null, certificationNumber: null } },
  { id: '55555555-5555-4555-8555-555555555555', sku: 'SEALED-BASE-001', slug: 'aurora-booster-box', name: 'Aurora Origins Booster Box', description: 'Caja sellada de 36 sobres para abrir, guardar o regalar.', kind: 'SEALED_PRODUCT', stockMode: 'QUANTITY', priceMinor: 822n, stock: 12, pokemonCard: null },
  { id: '66666666-6666-4666-8666-666666666666', sku: 'SEALED-BASE-002', slug: 'verdant-elite-trainer', name: 'Verdant Clash Elite Trainer Box', description: 'Caja de entrenador con accesorios y sobres de la expansión.', kind: 'SEALED_PRODUCT', stockMode: 'QUANTITY', priceMinor: 513n, stock: 8, pokemonCard: null },
  { id: '77777777-7777-4777-8777-777777777777', sku: 'SEALED-BASE-003', slug: 'ember-rise-bundle', name: 'Ember Rise Bundle', description: 'Bundle sellado para comenzar una nueva búsqueda sin perder el ritual.', kind: 'SEALED_PRODUCT', stockMode: 'QUANTITY', priceMinor: 207n, stock: 15, pokemonCard: null },
  { id: '88888888-8888-4888-8888-888888888888', sku: 'ACCESSORY-001', slug: 'collector-protector-kit', name: 'Collector Protector Kit', description: 'Kit de sleeves y protectores rígidos para cuidar tu colección.', kind: 'ACCESSORY', stockMode: 'QUANTITY', priceMinor: 45n, stock: 30, pokemonCard: null },
  { id: '99999991-9999-4999-8999-999999999991', sku: 'CARD-BASE-052', slug: 'tidal-sovereign', name: 'Tidal Sovereign', description: 'Carta de tipo Agua con arte clásico y desgaste leve de colección.', kind: 'SINGLE_CARD', stockMode: 'UNIQUE', priceMinor: 19n, stock: 1, pokemonCard: { pokemonType: 'WATER', setName: 'Ocean Echoes', setCode: 'OCE', cardNumber: '052/112', rarity: 'Rare', language: 'EN', condition: 'GOOD', finish: 'Non-Holo', edition: 'Unlimited', gradingCompany: null, grade: null, certificationNumber: null } },
  { id: '99999992-9999-4999-8999-999999999992', sku: 'CARD-BASE-061', slug: 'storm-runner', name: 'Storm Runner', description: 'Carta eléctrica rápida con brillo holográfico y bordes impecables.', kind: 'SINGLE_CARD', stockMode: 'UNIQUE', priceMinor: 40n, stock: 1, pokemonCard: { pokemonType: 'LIGHTNING', setName: 'Tempest Circuit', setCode: 'TPC', cardNumber: '061/104', rarity: 'Rare Holo', language: 'ES', condition: 'NM', finish: 'Holo', edition: 'Primera edición', gradingCompany: null, grade: null, certificationNumber: null } },
  { id: '99999993-9999-4999-8999-999999999993', sku: 'CARD-BASE-073', slug: 'iron-sentinel', name: 'Iron Sentinel', description: 'Full art de tipo Metal con textura marcada para una carpeta moderna.', kind: 'SINGLE_CARD', stockMode: 'UNIQUE', priceMinor: 57n, stock: 1, pokemonCard: { pokemonType: 'METAL', setName: 'Chrome Frontier', setCode: 'CHF', cardNumber: '073/100', rarity: 'Full Art Rare', language: 'EN', condition: 'EXCELLENT', finish: 'Full Art', edition: 'Unlimited', gradingCompany: null, grade: null, certificationNumber: null } },
  { id: '99999994-9999-4999-8999-999999999994', sku: 'CARD-BASE-081', slug: 'mind-oracle', name: 'Mind Oracle', description: 'Carta psíquica jugada, ideal para completar una colección a buen precio.', kind: 'SINGLE_CARD', stockMode: 'UNIQUE', priceMinor: 12n, stock: 0, pokemonCard: { pokemonType: 'PSYCHIC', setName: 'Astral Bonds', setCode: 'ASB', cardNumber: '081/126', rarity: 'Uncommon', language: 'ES', condition: 'PLAYED', finish: 'Reverse Holo', edition: 'Unlimited', gradingCompany: null, grade: null, certificationNumber: null } },
  { id: '99999995-9999-4999-8999-999999999995', sku: 'CARD-BASE-095', slug: 'fairy-wish', name: 'Fairy Wish', description: 'Promo de tipo Hada con patrón cosmos y presentación para exhibición.', kind: 'SINGLE_CARD', stockMode: 'UNIQUE', priceMinor: 36n, stock: 1, pokemonCard: { pokemonType: 'FAIRY', setName: 'Dreamlight Promos', setCode: 'DLP', cardNumber: '095/P', rarity: 'Promo', language: 'JP', condition: 'NM', finish: 'Cosmos Holo', edition: 'Promo', gradingCompany: 'CGC', grade: '9.5', certificationNumber: 'DLP-000095' } },
  { id: '99999996-9999-4999-8999-999999999996', sku: 'CARD-BASE-103', slug: 'arena-bruiser', name: 'Arena Bruiser', description: 'Carta de tipo Lucha con señales visibles de juego y precio accesible.', kind: 'SINGLE_CARD', stockMode: 'UNIQUE', priceMinor: 6n, stock: 1, pokemonCard: { pokemonType: 'FIGHTING', setName: 'Arena Rivals', setCode: 'ARV', cardNumber: '103/130', rarity: 'Common', language: 'EN', condition: 'DAMAGED', finish: 'Non-Holo', edition: 'Unlimited', gradingCompany: null, grade: null, certificationNumber: null } },
  { id: '99999997-9999-4999-8999-999999999997', sku: 'CARD-BASE-117', slug: 'wandering-companion', name: 'Wandering Companion', description: 'Illustration rare incolora con acabado cálido y estado de colección.', kind: 'SINGLE_CARD', stockMode: 'UNIQUE', priceMinor: 75n, stock: 1, pokemonCard: { pokemonType: 'COLORLESS', setName: 'Open Roads', setCode: 'OPR', cardNumber: '117/142', rarity: 'Illustration Rare', language: 'ES', condition: 'NM', finish: 'Foil', edition: 'Unlimited', gradingCompany: null, grade: null, certificationNumber: null } },
  { id: '99999998-9999-4999-8999-999999999998', sku: 'ACCESSORY-002', slug: 'vault-binder-nine-pocket', name: 'Vault Binder 9-Pocket', description: 'Binder de carga lateral con cierre y capacidad para 360 cartas.', kind: 'ACCESSORY', stockMode: 'QUANTITY', priceMinor: 95n, stock: 18, pokemonCard: null },
  { id: '99999999-9999-4999-8999-999999999998', sku: 'ACCESSORY-003', slug: 'aurora-playmat', name: 'Aurora Playmat', description: 'Playmat de neoprene con superficie suave y base antideslizante.', kind: 'ACCESSORY', stockMode: 'QUANTITY', priceMinor: 61n, stock: 22, pokemonCard: null },
];

const affiliateListings = [
  {
    listingId: 'e1111111-1111-4111-8111-111111111111',
    productId: 'd1111111-1111-4111-8111-111111111111',
    sku: 'AFF-SEED-001',
    slug: 'affiliate-neon-flare',
    name: 'Neon Flare',
    description: 'Publicación aprobada del afiliado demo, visible en el catálogo.',
    kind: 'SINGLE_CARD' as const,
    stockMode: 'QUANTITY' as const,
    priceMinor: 88n,
    stock: 5,
    listingStatus: 'APPROVED' as const,
    productStatus: 'PUBLISHED' as const,
    imageIndex: 20,
    pokemonCard: { pokemonType: 'FIRE' as const, setName: 'Affiliate Demo', setCode: 'AFD', cardNumber: '001/060', rarity: 'Rare Holo', language: 'ES', condition: 'NM' as const, finish: 'Holo', edition: 'Unlimited', gradingCompany: null, grade: null, certificationNumber: null },
  },
  {
    listingId: 'e2222222-2222-4222-8222-222222222222',
    productId: 'd2222222-2222-4222-8222-222222222222',
    sku: 'AFF-SEED-002',
    slug: 'affiliate-archived-ember',
    name: 'Archived Ember',
    description: 'Publicación aprobada pero archivada, para probar desarchivar en el portal.',
    kind: 'SINGLE_CARD' as const,
    stockMode: 'UNIQUE' as const,
    priceMinor: 42n,
    stock: 1,
    listingStatus: 'APPROVED' as const,
    productStatus: 'ARCHIVED' as const,
    imageIndex: 21,
    pokemonCard: { pokemonType: 'FIRE' as const, setName: 'Affiliate Demo', setCode: 'AFD', cardNumber: '014/060', rarity: 'Uncommon', language: 'EN', condition: 'EXCELLENT' as const, finish: 'Non-Holo', edition: 'Unlimited', gradingCompany: null, grade: null, certificationNumber: null },
  },
  {
    listingId: 'e3333333-3333-4333-8333-333333333333',
    productId: 'd3333333-3333-4333-8333-333333333333',
    sku: 'AFF-SEED-003',
    slug: 'affiliate-draft-shield',
    name: 'Draft Shield',
    description: 'Borrador del afiliado demo, todavía no enviado a revisión.',
    kind: 'ACCESSORY' as const,
    stockMode: 'QUANTITY' as const,
    priceMinor: 35n,
    stock: 6,
    listingStatus: 'DRAFT' as const,
    productStatus: 'DRAFT' as const,
    imageIndex: 22,
    pokemonCard: null,
  },
  {
    listingId: 'e4444444-4444-4444-8444-444444444444',
    productId: 'd4444444-4444-4444-8444-444444444444',
    sku: 'AFF-SEED-004',
    slug: 'affiliate-pending-tide',
    name: 'Pending Tide',
    description: 'Publicación en revisión administrativa.',
    kind: 'SINGLE_CARD' as const,
    stockMode: 'UNIQUE' as const,
    priceMinor: 55n,
    stock: 1,
    listingStatus: 'PENDING_REVIEW' as const,
    productStatus: 'DRAFT' as const,
    imageIndex: 23,
    pokemonCard: { pokemonType: 'WATER' as const, setName: 'Affiliate Demo', setCode: 'AFD', cardNumber: '028/060', rarity: 'Rare', language: 'ES', condition: 'NM' as const, finish: 'Reverse Holo', edition: 'Unlimited', gradingCompany: null, grade: null, certificationNumber: null },
  },
] as const;

const suppliers = [
  { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', name: 'Mazo Norte Distribuciones', contactName: 'Lucía Fernández', email: 'lucia@mazonorte.test', phone: '+54 11 4555 0101', address: 'Av. Corrientes 2450, CABA', notes: 'Entrega quincenal. Coordinar recepción con 48 h de anticipación.', active: true },
  { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', name: 'Coleccionables del Sur', contactName: 'Martín Acosta', email: 'ventas@coleccionablesdelsur.test', phone: '+54 11 4777 2233', address: 'Calle 12 840, La Plata', notes: 'Especialistas en accesorios y productos sellados.', active: true },
  { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', name: 'Importadora Prisma', contactName: 'Sofía Ruiz', email: 'sofia@importadoraprisma.test', phone: '+54 351 455 8899', address: 'Bv. San Juan 980, Córdoba', notes: 'Proveedor histórico actualmente inactivo.', active: false },
] as const;

const cmsOrderFixtures = [
  {
    number: 'CS-DEMO-1001', status: 'PAYMENT_REVIEW', paymentMethod: 'BANK_TRANSFER', paymentStatus: 'UNDER_REVIEW', fulfillmentType: 'SHIPMENT', ageHours: 2,
    items: [{ productId: '88888888-8888-4888-8888-888888888888', quantity: 2 }],
    history: ['PENDING_PAYMENT', 'PAYMENT_REVIEW'], reservationState: 'ACTIVE', pendingTransferReceipt: true,
    auditAction: 'TRANSFER_RECEIPT_SUBMITTED', auditActor: 'USER',
  },
  {
    number: 'CS-DEMO-1002', status: 'PAID', paymentMethod: 'MERCADO_PAGO', paymentStatus: 'APPROVED', fulfillmentType: 'PICKUP', ageHours: 5,
    items: [{ productId: '55555555-5555-4555-8555-555555555555', quantity: 1 }],
    history: ['PENDING_PAYMENT', 'PAID'], reservationState: 'CONSUMED', providerStatus: 'approved', providerStatusDetail: 'accredited',
    auditAction: 'PAYMENT_APPROVED', auditActor: 'SYSTEM',
  },
  {
    number: 'CS-DEMO-1003', status: 'PREPARING', paymentMethod: 'MERCADO_PAGO', paymentStatus: 'APPROVED', fulfillmentType: 'PICKUP', ageHours: 26,
    items: [{ productId: '77777777-7777-4777-8777-777777777777', quantity: 2 }],
    history: ['PENDING_PAYMENT', 'PAID', 'PREPARING'], reservationState: 'CONSUMED', providerStatus: 'approved', providerStatusDetail: 'accredited',
    auditAction: 'ORDER_STATUS_CHANGED', auditActor: 'ADMIN',
  },
  {
    number: 'CS-DEMO-1004', status: 'SHIPPED', paymentMethod: 'MERCADO_PAGO', paymentStatus: 'APPROVED', fulfillmentType: 'SHIPMENT', ageHours: 50,
    items: [{ productId: '66666666-6666-4666-8666-666666666666', quantity: 1 }],
    history: ['PENDING_PAYMENT', 'PAID', 'PREPARING', 'SHIPPED'], reservationState: 'CONSUMED', providerStatus: 'approved', providerStatusDetail: 'accredited',
    auditAction: 'ORDER_STATUS_CHANGED', auditActor: 'ADMIN',
  },
  {
    number: 'CS-DEMO-1005', status: 'COMPLETED', paymentMethod: 'MERCADO_PAGO', paymentStatus: 'APPROVED', fulfillmentType: 'PICKUP', ageHours: 82,
    items: [
      { productId: '88888888-8888-4888-8888-888888888888', quantity: 1 },
      { productId: '99999998-9999-4999-8999-999999999998', quantity: 1 },
    ],
    history: ['PENDING_PAYMENT', 'PAID', 'PREPARING', 'READY_FOR_PICKUP', 'COMPLETED'], reservationState: 'CONSUMED', providerStatus: 'approved', providerStatusDetail: 'accredited',
    auditAction: 'ORDER_STATUS_CHANGED', auditActor: 'ADMIN',
  },
  {
    number: 'CS-DEMO-1006', status: 'PAYMENT_REQUIRES_REVIEW', paymentMethod: 'MERCADO_PAGO', paymentStatus: 'REQUIRES_REVIEW', fulfillmentType: 'SHIPMENT', ageHours: 3,
    items: [{ productId: '99999998-9999-4999-8999-999999999998', quantity: 1 }],
    history: ['PENDING_PAYMENT', 'EXPIRED', 'PAYMENT_REQUIRES_REVIEW'], reservationState: 'RELEASED', providerStatus: 'approved', providerStatusDetail: 'amount_mismatch',
    auditAction: 'MERCADO_PAGO_REVIEW_REQUIRED', auditActor: 'SYSTEM',
  },
  {
    number: 'CS-DEMO-1007', status: 'REFUND_RECORDED', paymentMethod: 'MERCADO_PAGO', paymentStatus: 'REFUNDED', fulfillmentType: 'SHIPMENT', ageHours: 130,
    items: [{ productId: '99999999-9999-4999-8999-999999999998', quantity: 1 }],
    history: ['PENDING_PAYMENT', 'PAID', 'PREPARING', 'SHIPPED', 'COMPLETED', 'REFUND_RECORDED'], reservationState: 'CONSUMED', providerStatus: 'refunded', providerStatusDetail: 'refunded',
    refund: { reason: 'Devolución total de demostración', externalReference: 'MP-REFUND-DEMO-1007' },
    auditAction: 'FULL_REFUND_RECORDED', auditActor: 'ADMIN',
  },
] as const satisfies readonly SeedOrderFixture[];

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

const hourMs = 60 * 60 * 1000;

function seedUuid(namespace: number, value: number) {
  return `${namespace.toString(16).padStart(2, '0')}${value.toString(16).padStart(6, '0')}-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
}

function historyNote(status: SeedOrderStatus) {
  const notes: Record<SeedOrderStatus, string> = {
    PENDING_PAYMENT: 'Orden de demostración creada',
    PAYMENT_REVIEW: 'Comprobante recibido; revisión pendiente',
    PAID: 'Pago acreditado',
    PREPARING: 'Preparación iniciada',
    READY_FOR_PICKUP: 'Lista para retirar',
    SHIPPED: 'Despachada al cliente',
    COMPLETED: 'Entrega completada',
    EXPIRED: 'La reserva de stock expiró',
    REFUND_RECORDED: 'Reembolso total registrado',
    PAYMENT_REQUIRES_REVIEW: 'Mercado Pago requiere revisión manual',
  };
  return notes[status];
}

type SeedSellerOrderStatus =
  | 'PENDING_PAYMENT'
  | 'PAID'
  | 'PREPARING'
  | 'READY_FOR_PICKUP'
  | 'PICKED_UP'
  | 'SHIPPED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'REFUNDED';

function sellerStatusFromParent(status: SeedOrderStatus): SeedSellerOrderStatus {
  switch (status) {
    case 'PENDING_PAYMENT':
    case 'PAYMENT_REVIEW':
    case 'PAYMENT_REQUIRES_REVIEW':
      return 'PENDING_PAYMENT';
    case 'PAID':
      return 'PAID';
    case 'PREPARING':
      return 'PREPARING';
    case 'READY_FOR_PICKUP':
      return 'READY_FOR_PICKUP';
    case 'SHIPPED':
      return 'SHIPPED';
    case 'COMPLETED':
      return 'COMPLETED';
    case 'EXPIRED':
      return 'CANCELLED';
    case 'REFUND_RECORDED':
      return 'REFUNDED';
  }
}

function sellerHistoryFromParent(history: readonly SeedOrderStatus[]): SeedSellerOrderStatus[] {
  const mapped = history.map(sellerStatusFromParent);
  return mapped.filter((status, index) => index === 0 || status !== mapped[index - 1]);
}

function sellerHistoryNote(status: SeedSellerOrderStatus) {
  const notes: Record<SeedSellerOrderStatus, string> = {
    PENDING_PAYMENT: 'Suborden de demostración creada',
    PAID: 'Pago acreditado',
    PREPARING: 'Preparación iniciada',
    READY_FOR_PICKUP: 'Lista para retirar',
    PICKED_UP: 'Retirada por el comprador',
    SHIPPED: 'Despachada al cliente',
    COMPLETED: 'Entrega completada',
    CANCELLED: 'Suborden cancelada',
    REFUNDED: 'Reembolso registrado',
  };
  return notes[status];
}

function commissionMinorFor(subtotalMinor: bigint, commissionBps: number) {
  if (commissionBps <= 0) return 0n;
  return (subtotalMinor * BigInt(commissionBps) + 9999n) / 10000n;
}

async function syncSeedInventory(tx: Prisma.TransactionClient, baselines: Array<{ id: string; sku: string; stock: number }>) {
  const productIds = baselines.map((product) => product.id);
  const [reservations, adjustments] = await Promise.all([
    tx.inventoryReservation.findMany({ where: { productId: { in: productIds } }, select: { productId: true, quantity: true, releasedAt: true, consumedAt: true } }),
    tx.inventoryAdjustment.findMany({ where: { productId: { in: productIds } }, select: { productId: true, delta: true } }),
  ]);
  for (const baseline of baselines) {
    const productReservations = reservations.filter((reservation) => reservation.productId === baseline.id);
    const consumed = productReservations.filter((reservation) => reservation.consumedAt !== null).reduce((total, reservation) => total + reservation.quantity, 0);
    const reserved = productReservations.filter((reservation) => reservation.releasedAt === null && reservation.consumedAt === null).reduce((total, reservation) => total + reservation.quantity, 0);
    const adjustmentDelta = adjustments.filter((adjustment) => adjustment.productId === baseline.id).reduce((total, adjustment) => total + adjustment.delta, 0);
    const onHand = baseline.stock + adjustmentDelta - consumed;
    if (onHand < reserved || onHand < 0) throw new Error(`Seed inventory invariant failed for ${baseline.sku}: onHand=${onHand}, reserved=${reserved}`);
    const current = await tx.inventory.findUniqueOrThrow({ where: { productId: baseline.id } });
    if (current.onHand !== onHand || current.reserved !== reserved) {
      await tx.inventory.update({ where: { productId: baseline.id }, data: { onHand, reserved, version: { increment: 1 } } });
    }
  }
}

async function seedPrivateTransferReceipt() {
  const fileId = seedUuid(0xa9, 1);
  const relative = `private/receipts/${fileId}.webp`;
  const absolute = path.join(storageRoot, relative);
  const receiptSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200" viewBox="0 0 900 1200"><rect width="900" height="1200" fill="#f5f0df"/><rect x="55" y="55" width="790" height="1090" rx="20" fill="white" stroke="#2b4939" stroke-width="8"/><text x="100" y="170" fill="#2b4939" font-family="Arial" font-size="48" font-weight="700">COMPROBANTE DEMO</text><text x="100" y="260" fill="#57665c" font-family="Arial" font-size="28">Transferencia bancaria</text><path d="M100 330h700M100 470h700M100 610h700M100 750h700" stroke="#d8dfd5" stroke-width="4"/><text x="100" y="410" fill="#202a24" font-family="Arial" font-size="34">Orden CS-DEMO-1001</text><text x="100" y="550" fill="#202a24" font-family="Arial" font-size="34">Estado: pendiente de revisión</text><text x="100" y="690" fill="#202a24" font-family="Arial" font-size="34">Documento sin valor comercial</text><circle cx="450" cy="930" r="115" fill="#d77c61"/><path d="M385 930l42 42 92-105" fill="none" stroke="white" stroke-width="28" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  await mkdir(path.dirname(absolute), { recursive: true });
  const output = await sharp(Buffer.from(receiptSvg)).webp({ quality: 84 }).toBuffer();
  await writeFile(absolute, output);
  await prisma.storedFile.upsert({
    where: { id: fileId },
    update: { storageKey: relative, originalName: 'comprobante-demo.webp', mimeType: 'image/webp', sizeBytes: output.byteLength, sha256: createHash('sha256').update(output).digest('hex'), visibility: 'PRIVATE' },
    create: { id: fileId, storageKey: relative, originalName: 'comprobante-demo.webp', mimeType: 'image/webp', sizeBytes: output.byteLength, sha256: createHash('sha256').update(output).digest('hex'), visibility: 'PRIVATE' },
  });
  return fileId;
}

async function seedAffiliateMarketplace(input: { adminId: string; now: Date }) {
  const affiliateUser = await prisma.user.upsert({
    where: { email: affiliateEmail },
    update: {
      name: 'Demo Affiliate',
      passwordHash: await argon2.hash(affiliatePassword, { type: argon2.argon2id }),
      status: 'ACTIVE',
      emailVerifiedAt: input.now,
    },
    create: {
      email: affiliateEmail,
      name: 'Demo Affiliate',
      passwordHash: await argon2.hash(affiliatePassword, { type: argon2.argon2id }),
      status: 'ACTIVE',
      emailVerifiedAt: input.now,
    },
  });

  const affiliate = await prisma.affiliate.upsert({
    where: { userId: affiliateUser.id },
    update: {
      publicName: 'Mazo Norte Cards',
      contactPhone: '+54 11 5555 2200',
      payoutAccountLast4: '4321',
      status: 'ACTIVE',
    },
    create: {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      userId: affiliateUser.id,
      publicName: 'Mazo Norte Cards',
      contactPhone: '+54 11 5555 2200',
      payoutAccountLast4: '4321',
      status: 'ACTIVE',
    },
  });

  await prisma.affiliateProgramSettings.upsert({
    where: { id: 'default' },
    update: { commissionBps: 1000, autoCompleteDays: 7, updatedById: input.adminId },
    create: { id: 'default', commissionBps: 1000, autoCompleteDays: 7, updatedById: input.adminId },
  });

  const zone = await prisma.shippingZone.upsert({
    where: { id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1' },
    update: { name: 'AMBA afiliado', active: true, affiliateId: affiliate.id },
    create: { id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1', name: 'AMBA afiliado', active: true, affiliateId: affiliate.id },
  });
  await prisma.shippingZoneProvince.deleteMany({ where: { zoneId: zone.id } });
  await prisma.shippingZoneProvince.createMany({ data: ['Buenos Aires', 'CABA'].map((province) => ({ zoneId: zone.id, province })) });
  await prisma.shippingRate.upsert({
    where: { id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2' },
    update: { zoneId: zone.id, name: 'Envío afiliado', priceMinor: 55n, currency: BASE_CURRENCY, active: true },
    create: { id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2', zoneId: zone.id, name: 'Envío afiliado', priceMinor: 55n, currency: BASE_CURRENCY, active: true },
  });
  await prisma.pickupPoint.upsert({
    where: { id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd3' },
    update: { name: 'Mazo Norte · Retiro', address: 'Av. Córdoba 3500, CABA', active: true, affiliateId: affiliate.id },
    create: { id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd3', name: 'Mazo Norte · Retiro', address: 'Av. Córdoba 3500, CABA', active: true, affiliateId: affiliate.id },
  });

  for (const listing of affiliateListings) {
    const publishedAt = listing.productStatus === 'PUBLISHED' || listing.productStatus === 'ARCHIVED' ? input.now : null;
    const archivedAt = listing.productStatus === 'ARCHIVED' ? input.now : null;
    const submittedAt = listing.listingStatus === 'PENDING_REVIEW' || listing.listingStatus === 'APPROVED' ? input.now : null;
    const reviewedAt = listing.listingStatus === 'APPROVED' ? input.now : null;

    await prisma.product.upsert({
      where: { id: listing.productId },
      update: {
        sku: listing.sku,
        slug: listing.slug,
        name: listing.name,
        description: listing.description,
        kind: listing.kind,
        stockMode: listing.stockMode,
        priceMinor: listing.priceMinor,
        currency: BASE_CURRENCY,
        status: listing.productStatus,
        publishedAt,
        archivedAt,
        affiliateId: affiliate.id,
        version: 1,
      },
      create: {
        id: listing.productId,
        sku: listing.sku,
        slug: listing.slug,
        name: listing.name,
        description: listing.description,
        kind: listing.kind,
        stockMode: listing.stockMode,
        priceMinor: listing.priceMinor,
        currency: BASE_CURRENCY,
        status: listing.productStatus,
        publishedAt,
        archivedAt,
        affiliateId: affiliate.id,
        version: 1,
      },
    });

    const inventory = await prisma.inventory.findUnique({ where: { productId: listing.productId } });
    if (!inventory) await prisma.inventory.create({ data: { productId: listing.productId, onHand: listing.stock, reserved: 0, version: 1 } });
    else if (inventory.reserved === 0) await prisma.inventory.update({ where: { productId: listing.productId }, data: { onHand: listing.stock } });

    if (listing.pokemonCard) {
      await prisma.pokemonCardDetails.upsert({
        where: { productId: listing.productId },
        update: listing.pokemonCard,
        create: { productId: listing.productId, ...listing.pokemonCard },
      });
    }

    await seedImage(listing.productId, listing.imageIndex, listing.name);

    await prisma.affiliateListing.upsert({
      where: { id: listing.listingId },
      update: {
        productId: listing.productId,
        affiliateId: affiliate.id,
        status: listing.listingStatus,
        reviewNote: null,
        submittedAt,
        reviewedAt,
        reviewedById: reviewedAt ? input.adminId : null,
      },
      create: {
        id: listing.listingId,
        productId: listing.productId,
        affiliateId: affiliate.id,
        status: listing.listingStatus,
        reviewNote: null,
        submittedAt,
        reviewedAt,
        reviewedById: reviewedAt ? input.adminId : null,
      },
    });
  }

  return {
    affiliateId: affiliate.id,
    userId: affiliateUser.id,
    publicName: affiliate.publicName,
    contactPhone: affiliate.contactPhone,
    listings: affiliateListings.length,
    zoneId: zone.id,
    shippingRateId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2',
    pickupPointId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd3',
    commissionBps: 1000,
  };
}

async function seedAffiliateDemoOrder(input: {
  adminId: string;
  userId: string;
  affiliate: {
    affiliateId: string;
    publicName: string;
    contactPhone: string | null;
    zoneId: string;
    shippingRateId: string;
    commissionBps: number;
  };
  now: Date;
}) {
  const listing = affiliateListings[0];
  const quantity = 1;
  const orderNumber = 'CS-AFF-2001';
  const orderId = seedUuid(0xa1, 1);
  const paymentId = seedUuid(0xa2, 1);
  const sellerOrderId = seedUuid(0xa3, 1);
  const itemId = seedUuid(0xa4, 1);
  const reservationId = seedUuid(0xa5, 1);
  const createdAt = new Date(input.now.getTime() - 8 * hourMs);
  const paidAt = new Date(createdAt.getTime() + 20 * 60 * 1000);
  const preparingAt = new Date(paidAt.getTime() + 30 * 60 * 1000);
  const expiresAt = new Date(createdAt.getTime() + 24 * hourMs);

  const product = await prisma.product.findUniqueOrThrow({
    where: { id: listing.productId },
    include: {
      pokemonCard: true,
      images: { where: { retiredAt: null }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
    },
  });

  const shippingRate = await prisma.shippingRate.findUniqueOrThrow({ where: { id: input.affiliate.shippingRateId }, include: { zone: true } });
  const subtotalMinor = product.priceMinor * BigInt(quantity);
  const shippingMinor = shippingRate.priceMinor;
  const commissionBps = input.affiliate.commissionBps;
  const commissionMinor = commissionMinorFor(subtotalMinor, commissionBps);
  const sellerNetMinor = subtotalMinor + shippingMinor - commissionMinor;
  const totalMinor = subtotalMinor + shippingMinor;
  const imageFileId = product.images[0]?.fileId ?? null;
  const productSnapshot = JSON.stringify({
    id: product.id,
    sku: product.sku,
    slug: product.slug,
    name: product.name,
    description: product.description,
    kind: product.kind,
    stockMode: product.stockMode,
    priceMinor: product.priceMinor.toString(),
    currency: product.currency,
    pokemonCard: product.pokemonCard,
    imageFileId,
    affiliateId: input.affiliate.affiliateId,
  });

  let linkedSellerOrderId = sellerOrderId;

  await prisma.$transaction(async (tx) => {
    const orderData = {
      userId: input.userId,
      number: orderNumber,
      status: 'PREPARING' as const,
      version: 3,
      paymentMethod: 'MERCADO_PAGO' as const,
      fulfillmentType: 'SHIPMENT' as const,
      currency: BASE_CURRENCY,
      subtotalMinor,
      shippingMinor,
      totalMinor,
      shippingRateId: shippingRate.id,
      shippingZoneName: shippingRate.zone.name,
      shippingRateName: shippingRate.name,
      shippingRatePriceMinor: shippingRate.priceMinor,
      recipientName: 'Demo Collector',
      recipientPhone: '+54 11 5555 0101',
      addressLine1: 'Av. Siempreviva 742',
      addressLine2: 'Piso 2, Depto. B',
      city: 'Buenos Aires',
      province: 'CABA',
      postalCode: 'C1414',
      idempotencyKey: 'seed-affiliate-order-cs-aff-2001',
      idempotencyHash: createHash('sha256').update('CS-AFF-2001:affiliate-seed-v1').digest('hex'),
      expiresAt,
      createdAt,
      updatedAt: preparingAt,
    };
    await tx.order.upsert({ where: { id: orderId }, update: orderData, create: { id: orderId, ...orderData } });

    const sellerOrderData = {
      orderId,
      number: `${orderNumber}-01`,
      sellerType: 'AFFILIATE' as const,
      affiliateId: input.affiliate.affiliateId,
      sellerName: input.affiliate.publicName,
      sellerContactPhone: input.affiliate.contactPhone,
      status: 'PREPARING' as const,
      version: 3,
      subtotalMinor,
      shippingMinor,
      commissionBps,
      commissionMinor,
      sellerNetMinor,
      fulfillmentType: 'SHIPMENT' as const,
      shippingRateId: shippingRate.id,
      shippingZoneName: shippingRate.zone.name,
      shippingRateName: shippingRate.name,
      shippingRatePriceMinor: shippingRate.priceMinor,
      recipientName: 'Demo Collector',
      recipientPhone: '+54 11 5555 0101',
      addressLine1: 'Av. Siempreviva 742',
      addressLine2: 'Piso 2, Depto. B',
      city: 'Buenos Aires',
      province: 'CABA',
      postalCode: 'C1414',
      createdAt,
      updatedAt: preparingAt,
    };
    await tx.sellerOrder.upsert({ where: { number: sellerOrderData.number }, update: sellerOrderData, create: { id: sellerOrderId, ...sellerOrderData } });
    linkedSellerOrderId = (await tx.sellerOrder.findUniqueOrThrow({ where: { number: sellerOrderData.number } })).id;

    await tx.orderItem.upsert({
      where: { id: itemId },
      update: { orderId, sellerOrderId: linkedSellerOrderId, productId: product.id, sku: product.sku, productName: product.name, productSnapshot, imageFileId, unitPriceMinor: product.priceMinor, quantity, lineTotalMinor: subtotalMinor },
      create: { id: itemId, orderId, sellerOrderId: linkedSellerOrderId, productId: product.id, sku: product.sku, productName: product.name, productSnapshot, imageFileId, unitPriceMinor: product.priceMinor, quantity, lineTotalMinor: subtotalMinor },
    });

    await tx.inventoryReservation.upsert({
      where: { orderId_productId: { orderId, productId: product.id } },
      update: { sellerOrderId: linkedSellerOrderId, quantity, expiresAt, releasedAt: null, consumedAt: paidAt, createdAt },
      create: { id: reservationId, orderId, sellerOrderId: linkedSellerOrderId, productId: product.id, quantity, expiresAt, releasedAt: null, consumedAt: paidAt, createdAt },
    });

    const paymentData = { method: 'MERCADO_PAGO' as const, status: 'APPROVED' as const, amountMinor: totalMinor, currency: BASE_CURRENCY, providerReference: `MP-${orderNumber}`, createdAt, updatedAt: paidAt };
    await tx.payment.upsert({ where: { orderId }, update: paymentData, create: { id: paymentId, orderId, ...paymentData } });
    await tx.mercadoPagoPayment.upsert({
      where: { paymentId },
      update: { preferenceId: `PREF-${orderNumber}`, externalPaymentId: `MP-${orderNumber}`, status: 'approved', statusDetail: 'accredited', checkoutUrl: null, expiresAt },
      create: { id: seedUuid(0xa6, 1), paymentId, preferenceId: `PREF-${orderNumber}`, externalPaymentId: `MP-${orderNumber}`, status: 'approved', statusDetail: 'accredited', checkoutUrl: null, expiresAt },
    });

    const parentHistory: Array<{ id: string; from: SeedOrderStatus | null; to: SeedOrderStatus; at: Date }> = [
      { id: seedUuid(0xa7, 1), from: null, to: 'PENDING_PAYMENT', at: createdAt },
      { id: seedUuid(0xa7, 2), from: 'PENDING_PAYMENT', to: 'PAID', at: paidAt },
      { id: seedUuid(0xa7, 3), from: 'PAID', to: 'PREPARING', at: preparingAt },
    ];
    for (const entry of parentHistory) {
      await tx.orderStatusHistory.upsert({
        where: { id: entry.id },
        update: { orderId, fromStatus: entry.from, toStatus: entry.to, note: historyNote(entry.to), createdAt: entry.at, changedById: entry.from ? input.adminId : null },
        create: { id: entry.id, orderId, fromStatus: entry.from, toStatus: entry.to, note: historyNote(entry.to), createdAt: entry.at, changedById: entry.from ? input.adminId : null },
      });
    }

    const sellerHistory: Array<{ id: string; from: SeedSellerOrderStatus | null; to: SeedSellerOrderStatus; at: Date }> = [
      { id: seedUuid(0xaa, 1), from: null, to: 'PENDING_PAYMENT', at: createdAt },
      { id: seedUuid(0xaa, 2), from: 'PENDING_PAYMENT', to: 'PAID', at: paidAt },
      { id: seedUuid(0xaa, 3), from: 'PAID', to: 'PREPARING', at: preparingAt },
    ];
    for (const entry of sellerHistory) {
      await tx.sellerOrderHistory.upsert({
        where: { id: entry.id },
        update: { sellerOrderId: linkedSellerOrderId, fromStatus: entry.from, toStatus: entry.to, note: sellerHistoryNote(entry.to), changedByType: entry.from ? 'ADMIN' : 'SYSTEM', changedById: entry.from ? input.adminId : null, createdAt: entry.at },
        create: { id: entry.id, sellerOrderId: linkedSellerOrderId, fromStatus: entry.from, toStatus: entry.to, note: sellerHistoryNote(entry.to), changedByType: entry.from ? 'ADMIN' : 'SYSTEM', changedById: entry.from ? input.adminId : null, createdAt: entry.at },
      });
    }

    await tx.affiliateLedgerEntry.upsert({
      where: { dedupeKey: `sale-pending:${linkedSellerOrderId}` },
      update: { affiliateId: input.affiliate.affiliateId, sellerOrderId: linkedSellerOrderId, bucket: 'PENDING', type: 'SALE_PENDING', amountMinor: sellerNetMinor, note: 'Payment accredited; available after completion' },
      create: { id: seedUuid(0xa9, 2), affiliateId: input.affiliate.affiliateId, sellerOrderId: linkedSellerOrderId, bucket: 'PENDING', type: 'SALE_PENDING', amountMinor: sellerNetMinor, dedupeKey: `sale-pending:${linkedSellerOrderId}`, note: 'Payment accredited; available after completion' },
    });

    await syncSeedInventory(tx, [{ id: listing.productId, sku: listing.sku, stock: listing.stock }]);
  });

  return { orderNumber, sellerOrderId: linkedSellerOrderId, productId: listing.productId };
}

async function seedCmsOrders(input: {
  adminId: string;
  userId: string;
  zone: { id: string; name: string };
  shippingRate: { id: string; name: string; priceMinor: bigint };
  pickupPoint: { id: string; name: string; address: string };
  receiptFileId: string;
  now: Date;
}) {
  const affectedProductIds = [...new Set(cmsOrderFixtures.flatMap((fixture) => fixture.items.map((item) => item.productId)))];

  await prisma.$transaction(async (tx) => {
    const seededProducts = await tx.product.findMany({
      where: { id: { in: affectedProductIds } },
      include: {
        pokemonCard: true,
        images: { where: { retiredAt: null }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
      },
    });
    const productsById = new Map(seededProducts.map((product) => [product.id, product]));

    for (const [fixtureOffset, fixtureValue] of cmsOrderFixtures.entries()) {
      const fixture: SeedOrderFixture = fixtureValue;
      const fixtureNumber = fixtureOffset + 1;
      const orderId = seedUuid(0xc0, fixtureNumber);
      const paymentId = seedUuid(0xf0, fixtureNumber);
      const createdAt = new Date(input.now.getTime() - fixture.ageHours * hourMs);
      const transitionDates = fixture.history.map((_status, index) => new Date(createdAt.getTime() + index * 10 * 60 * 1000));
      const updatedAt = transitionDates.at(-1) ?? createdAt;
      const expiresAt = new Date(createdAt.getTime() + (fixture.paymentMethod === 'BANK_TRANSFER' ? 24 : 0.5) * hourMs);
      const resolvedItems = fixture.items.map((item) => {
        const product = productsById.get(item.productId);
        if (!product) throw new Error(`Missing seed product ${item.productId} for ${fixture.number}`);
        return { item, product, lineTotalMinor: product.priceMinor * BigInt(item.quantity) };
      });
      const subtotalMinor = resolvedItems.reduce((total, item) => total + item.lineTotalMinor, 0n);
      const shippingMinor = fixture.fulfillmentType === 'SHIPMENT' ? input.shippingRate.priceMinor : 0n;
      const totalMinor = subtotalMinor + shippingMinor;
      const idempotencyKey = `seed-cms-order-${fixture.number.toLowerCase()}`;

      const orderData = {
        userId: input.userId,
        number: fixture.number,
        status: fixture.status,
        version: fixture.history.length,
        paymentMethod: fixture.paymentMethod,
        fulfillmentType: fixture.fulfillmentType,
        currency: BASE_CURRENCY,
        subtotalMinor,
        shippingMinor,
        totalMinor,
        shippingRateId: fixture.fulfillmentType === 'SHIPMENT' ? input.shippingRate.id : null,
        pickupPointId: fixture.fulfillmentType === 'PICKUP' ? input.pickupPoint.id : null,
        shippingZoneName: fixture.fulfillmentType === 'SHIPMENT' ? input.zone.name : null,
        shippingRateName: fixture.fulfillmentType === 'SHIPMENT' ? input.shippingRate.name : null,
        shippingRatePriceMinor: fixture.fulfillmentType === 'SHIPMENT' ? input.shippingRate.priceMinor : null,
        pickupPointName: fixture.fulfillmentType === 'PICKUP' ? input.pickupPoint.name : null,
        pickupPointAddress: fixture.fulfillmentType === 'PICKUP' ? input.pickupPoint.address : null,
        recipientName: fixture.fulfillmentType === 'SHIPMENT' ? 'Demo Collector' : null,
        recipientPhone: fixture.fulfillmentType === 'SHIPMENT' ? '+54 11 5555 0101' : null,
        addressLine1: fixture.fulfillmentType === 'SHIPMENT' ? 'Av. Siempreviva 742' : null,
        addressLine2: fixture.fulfillmentType === 'SHIPMENT' ? 'Piso 2, Depto. B' : null,
        city: fixture.fulfillmentType === 'SHIPMENT' ? 'Buenos Aires' : null,
        province: fixture.fulfillmentType === 'SHIPMENT' ? 'CABA' : null,
        postalCode: fixture.fulfillmentType === 'SHIPMENT' ? 'C1414' : null,
        idempotencyKey,
        idempotencyHash: createHash('sha256').update(`${fixture.number}:cms-seed-v1`).digest('hex'),
        expiresAt,
        createdAt,
        updatedAt,
      };
      await tx.order.upsert({ where: { id: orderId }, update: orderData, create: { id: orderId, ...orderData } });

      const sellerOrderId = seedUuid(0xf1, fixtureNumber);
      const sellerStatus = sellerStatusFromParent(fixture.status);
      const sellerHistory = sellerHistoryFromParent(fixture.history);
      const sellerOrderData = {
        orderId,
        number: `${fixture.number}-01`,
        sellerType: 'STORE' as const,
        affiliateId: null,
        sellerName: 'Card Shop',
        sellerContactPhone: null,
        status: sellerStatus,
        version: Math.max(1, sellerHistory.length),
        subtotalMinor,
        shippingMinor,
        commissionBps: 0,
        commissionMinor: 0n,
        sellerNetMinor: subtotalMinor + shippingMinor,
        fulfillmentType: fixture.fulfillmentType,
        shippingRateId: fixture.fulfillmentType === 'SHIPMENT' ? input.shippingRate.id : null,
        pickupPointId: fixture.fulfillmentType === 'PICKUP' ? input.pickupPoint.id : null,
        shippingZoneName: fixture.fulfillmentType === 'SHIPMENT' ? input.zone.name : null,
        shippingRateName: fixture.fulfillmentType === 'SHIPMENT' ? input.shippingRate.name : null,
        shippingRatePriceMinor: fixture.fulfillmentType === 'SHIPMENT' ? input.shippingRate.priceMinor : null,
        pickupPointName: fixture.fulfillmentType === 'PICKUP' ? input.pickupPoint.name : null,
        pickupPointAddress: fixture.fulfillmentType === 'PICKUP' ? input.pickupPoint.address : null,
        recipientName: fixture.fulfillmentType === 'SHIPMENT' ? 'Demo Collector' : null,
        recipientPhone: fixture.fulfillmentType === 'SHIPMENT' ? '+54 11 5555 0101' : null,
        addressLine1: fixture.fulfillmentType === 'SHIPMENT' ? 'Av. Siempreviva 742' : null,
        addressLine2: fixture.fulfillmentType === 'SHIPMENT' ? 'Piso 2, Depto. B' : null,
        city: fixture.fulfillmentType === 'SHIPMENT' ? 'Buenos Aires' : null,
        province: fixture.fulfillmentType === 'SHIPMENT' ? 'CABA' : null,
        postalCode: fixture.fulfillmentType === 'SHIPMENT' ? 'C1414' : null,
        carrier: fixture.status === 'SHIPPED' || fixture.history.includes('SHIPPED') ? 'Correo Argentino' : null,
        trackingCode: fixture.status === 'SHIPPED' || fixture.history.includes('SHIPPED') ? `CA-${fixture.number}` : null,
        completedAt: sellerStatus === 'COMPLETED' || sellerStatus === 'REFUNDED' ? updatedAt : null,
        createdAt,
        updatedAt,
      };
      await tx.sellerOrder.upsert({ where: { number: sellerOrderData.number }, update: sellerOrderData, create: { id: sellerOrderId, ...sellerOrderData } });
      const storedSellerOrder = await tx.sellerOrder.findUniqueOrThrow({ where: { number: sellerOrderData.number } });
      const linkedSellerOrderId = storedSellerOrder.id;

      for (const [itemOffset, resolved] of resolvedItems.entries()) {
        const itemNumber = fixtureNumber * 10 + itemOffset + 1;
        const imageFileId = resolved.product.images[0]?.fileId ?? null;
        const productSnapshot = JSON.stringify({
          id: resolved.product.id,
          sku: resolved.product.sku,
          slug: resolved.product.slug,
          name: resolved.product.name,
          description: resolved.product.description,
          kind: resolved.product.kind,
          stockMode: resolved.product.stockMode,
          priceMinor: resolved.product.priceMinor.toString(),
          currency: resolved.product.currency,
          pokemonCard: resolved.product.pokemonCard,
          imageFileId,
        });
        await tx.orderItem.upsert({
          where: { id: seedUuid(0xd0, itemNumber) },
          update: { orderId, sellerOrderId: linkedSellerOrderId, productId: resolved.product.id, sku: resolved.product.sku, productName: resolved.product.name, productSnapshot, imageFileId, unitPriceMinor: resolved.product.priceMinor, quantity: resolved.item.quantity, lineTotalMinor: resolved.lineTotalMinor },
          create: { id: seedUuid(0xd0, itemNumber), orderId, sellerOrderId: linkedSellerOrderId, productId: resolved.product.id, sku: resolved.product.sku, productName: resolved.product.name, productSnapshot, imageFileId, unitPriceMinor: resolved.product.priceMinor, quantity: resolved.item.quantity, lineTotalMinor: resolved.lineTotalMinor },
        });

        const paidIndex = fixture.history.indexOf('PAID');
        const expiredIndex = fixture.history.indexOf('EXPIRED');
        const consumedAt = fixture.reservationState === 'CONSUMED' ? transitionDates[Math.max(0, paidIndex)] ?? updatedAt : null;
        const releasedAt = fixture.reservationState === 'RELEASED' ? transitionDates[Math.max(0, expiredIndex)] ?? updatedAt : null;
        const reservationData = { sellerOrderId: linkedSellerOrderId, quantity: resolved.item.quantity, expiresAt, releasedAt, consumedAt, createdAt };
        await tx.inventoryReservation.upsert({
          where: { orderId_productId: { orderId, productId: resolved.product.id } },
          update: reservationData,
          create: { id: seedUuid(0xe0, itemNumber), orderId, productId: resolved.product.id, ...reservationData },
        });
      }

      for (const [historyOffset, toStatus] of sellerHistory.entries()) {
        const historyNumber = fixtureNumber * 100 + historyOffset + 1;
        const historyData = {
          sellerOrderId: linkedSellerOrderId,
          fromStatus: historyOffset === 0 ? null : sellerHistory[historyOffset - 1] ?? null,
          toStatus,
          note: sellerHistoryNote(toStatus),
          changedByType: historyOffset === 0 ? 'SYSTEM' : 'ADMIN',
          changedById: historyOffset === 0 ? null : input.adminId,
          createdAt: transitionDates[Math.min(historyOffset, transitionDates.length - 1)] ?? createdAt,
        };
        await tx.sellerOrderHistory.upsert({ where: { id: seedUuid(0xf2, historyNumber) }, update: historyData, create: { id: seedUuid(0xf2, historyNumber), ...historyData } });
      }

      const providerReference = fixture.paymentMethod === 'BANK_TRANSFER' ? `TR-${fixture.number}` : `MP-${fixture.number}`;
      const paymentData = { method: fixture.paymentMethod, status: fixture.paymentStatus, amountMinor: totalMinor, currency: BASE_CURRENCY, providerReference, createdAt, updatedAt };
      await tx.payment.upsert({ where: { orderId }, update: paymentData, create: { id: paymentId, orderId, ...paymentData } });

      if (fixture.paymentMethod === 'BANK_TRANSFER') {
        const transferData = {
          reference: providerReference,
          reviewStatus: fixture.paymentStatus === 'UNDER_REVIEW' ? 'PENDING' as const : 'APPROVED' as const,
          reviewedAt: fixture.paymentStatus === 'UNDER_REVIEW' ? null : updatedAt,
          reviewedById: fixture.paymentStatus === 'UNDER_REVIEW' ? null : input.adminId,
        };
        await tx.bankTransfer.upsert({ where: { paymentId }, update: transferData, create: { id: seedUuid(0xb1, fixtureNumber), paymentId, ...transferData } });
      } else {
        const mercadoPagoData = {
          preferenceId: `PREF-${fixture.number}`,
          externalPaymentId: providerReference,
          status: fixture.providerStatus ?? null,
          statusDetail: fixture.providerStatusDetail ?? null,
          checkoutUrl: null,
          expiresAt,
        };
        await tx.mercadoPagoPayment.upsert({ where: { paymentId }, update: mercadoPagoData, create: { id: seedUuid(0xb2, fixtureNumber), paymentId, ...mercadoPagoData } });
      }

      for (const [historyOffset, toStatus] of fixture.history.entries()) {
        const historyNumber = fixtureNumber * 100 + historyOffset + 1;
        const historyData = {
          orderId,
          fromStatus: historyOffset === 0 ? null : fixture.history[historyOffset - 1] ?? null,
          toStatus,
          note: historyNote(toStatus),
          createdAt: transitionDates[historyOffset] ?? createdAt,
          changedById: historyOffset === 0 ? null : input.adminId,
        };
        await tx.orderStatusHistory.upsert({ where: { id: seedUuid(0xc1, historyNumber) }, update: historyData, create: { id: seedUuid(0xc1, historyNumber), ...historyData } });
      }

      if (fixture.pendingTransferReceipt) {
        const receiptData = { orderId, review: 'PENDING' as const, note: 'Comprobante privado de demostración', createdAt: transitionDates[1] ?? createdAt, reviewedAt: null, reviewedById: null };
        await tx.transferReceipt.upsert({ where: { fileId: input.receiptFileId }, update: receiptData, create: { id: seedUuid(0xa8, fixtureNumber), fileId: input.receiptFileId, ...receiptData } });
      }

      if (fixture.refund) {
        const refundData = { paymentId, sellerOrderId: linkedSellerOrderId, fullRefundKey: paymentId, amountMinor: totalMinor, currency: BASE_CURRENCY, reason: fixture.refund.reason, externalReference: fixture.refund.externalReference, createdAt: updatedAt, createdById: input.adminId };
        await tx.refundRecord.upsert({ where: { fullRefundKey: paymentId }, update: refundData, create: { id: seedUuid(0xb3, fixtureNumber), ...refundData } });
      }

      const auditActorId = fixture.auditActor === 'ADMIN' ? input.adminId : fixture.auditActor === 'USER' ? input.userId : null;
      const auditData = {
        actorType: fixture.auditActor,
        actorId: auditActorId,
        action: fixture.auditAction,
        entityType: 'Order',
        entityId: orderId,
        metadata: JSON.stringify({ number: fixture.number, status: fixture.status, paymentMethod: fixture.paymentMethod, paymentStatus: fixture.paymentStatus, sellerOrderId: linkedSellerOrderId }),
        requestId: `seed-${fixture.number.toLowerCase()}`,
        createdAt: updatedAt,
      };
      await tx.auditLog.upsert({ where: { id: seedUuid(0xc2, fixtureNumber) }, update: auditData, create: { id: seedUuid(0xc2, fixtureNumber), ...auditData } });
    }

    await syncSeedInventory(tx, products.map((product) => ({ id: product.id, sku: product.sku, stock: product.stock })));
  });
}

async function main() {
  if (adminPassword.length < 12 || userPassword.length < 12 || affiliatePassword.length < 12) throw new Error('Seed passwords must have at least 12 characters');
  const now = new Date();
  const admin = await prisma.admin.upsert({
    where: { email: adminEmail },
    update: {
      name: 'Store Admin',
      passwordHash: await argon2.hash(adminPassword, { type: argon2.argon2id }),
      status: 'ACTIVE',
      totpSecretCipher: null,
      totpEnabledAt: null,
    },
    create: {
      email: adminEmail,
      name: 'Store Admin',
      passwordHash: await argon2.hash(adminPassword, { type: argon2.argon2id }),
      status: 'ACTIVE',
    },
  });
  const user = await prisma.user.upsert({ where: { email: userEmail }, update: { name: 'Demo Collector', passwordHash: await argon2.hash(userPassword, { type: argon2.argon2id }), status: 'ACTIVE', emailVerifiedAt: now }, create: { email: userEmail, name: 'Demo Collector', passwordHash: await argon2.hash(userPassword, { type: argon2.argon2id }), status: 'ACTIVE', emailVerifiedAt: now } });
  await prisma.loyaltyProgram.upsert({
    where: { id: loyaltyProgramId },
    update: { ...loyaltyProgramSeed, updatedById: admin.id },
    create: { id: loyaltyProgramId, ...loyaltyProgramSeed, updatedById: admin.id },
  });
  await prisma.$transaction(async (tx) => {
    const existingAccount = await tx.loyaltyAccount.findUnique({ where: { userId: user.id } });
    if (existingAccount) return;
    const account = await tx.loyaltyAccount.create({ data: { userId: user.id, balance: demoLoyaltyStartingPoints } });
    await tx.loyaltyTransaction.create({
      data: {
        accountId: account.id,
        userId: user.id,
        type: 'ADJUSTMENT',
        points: demoLoyaltyStartingPoints,
        balanceAfter: demoLoyaltyStartingPoints,
        description: 'Saldo inicial de demostración para probar descuentos exclusivos',
      },
    });
  });
  await prisma.adminRecoveryCode.deleteMany({ where: { adminId: admin.id } });
  for (const product of products) {
    await prisma.product.upsert({ where: { id: product.id }, update: { sku: product.sku, slug: product.slug, name: product.name, description: product.description, kind: product.kind, stockMode: product.stockMode, priceMinor: product.priceMinor, currency: BASE_CURRENCY, status: 'PUBLISHED', publishedAt: now, archivedAt: null, version: 1 }, create: { id: product.id, sku: product.sku, slug: product.slug, name: product.name, description: product.description, kind: product.kind, stockMode: product.stockMode, priceMinor: product.priceMinor, currency: BASE_CURRENCY, status: 'PUBLISHED', publishedAt: now, version: 1 } });
    const currentInventory = await prisma.inventory.findUnique({ where: { productId: product.id } });
    if (!currentInventory) await prisma.inventory.create({ data: { productId: product.id, onHand: product.stock, reserved: 0, version: 1 } });
    else if (currentInventory.reserved === 0) await prisma.inventory.update({ where: { productId: product.id }, data: { onHand: product.stock } });
    if (product.pokemonCard) await prisma.pokemonCardDetails.upsert({ where: { productId: product.id }, update: product.pokemonCard, create: { productId: product.id, ...product.pokemonCard } });
    await seedImage(product.id, products.indexOf(product), product.name);
  }
  const zone = await prisma.shippingZone.upsert({ where: { id: '99999999-9999-4999-8999-999999999999' }, update: { name: 'Argentina', active: true, affiliateId: null }, create: { id: '99999999-9999-4999-8999-999999999999', name: 'Argentina', active: true } });
  await prisma.shippingZoneProvince.deleteMany({ where: { zoneId: zone.id } });
  await prisma.shippingZoneProvince.createMany({ data: ['Buenos Aires', 'CABA', 'Córdoba', 'Santa Fe', 'Mendoza'].map((province) => ({ zoneId: zone.id, province })) });
  const standardShippingRate = await prisma.shippingRate.upsert({ where: { id: 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1' }, update: { zoneId: zone.id, name: 'Envío estándar', priceMinor: 43n, currency: BASE_CURRENCY, active: true }, create: { id: 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1', zoneId: zone.id, name: 'Envío estándar', priceMinor: 43n, currency: BASE_CURRENCY, active: true } });
  await prisma.shippingRate.upsert({ where: { id: 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2' }, update: { zoneId: zone.id, name: 'Envío express', priceMinor: 79n, currency: BASE_CURRENCY, active: true }, create: { id: 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2', zoneId: zone.id, name: 'Envío express', priceMinor: 79n, currency: BASE_CURRENCY, active: true } });
  const pickupPoint = await prisma.pickupPoint.upsert({ where: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, update: { name: 'Card Shop · Palermo', address: 'Av. Santa Fe 1234, CABA', active: true, affiliateId: null }, create: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Card Shop · Palermo', address: 'Av. Santa Fe 1234, CABA', active: true } });
  for (const supplier of suppliers) {
    await prisma.supplier.upsert({ where: { id: supplier.id }, update: supplier, create: supplier });
  }
  const affiliateSeed = await seedAffiliateMarketplace({ adminId: admin.id, now });
  await prisma.transferSettings.upsert({
    where: { id: 'default' },
    update: {
      enabled: true,
      bankName: 'Banco Demo',
      accountHolder: 'Card Shop SA',
      cbu: '0000003100010000000001',
      alias: 'cardshop.demo',
      updatedById: admin.id,
    },
    create: {
      id: 'default',
      enabled: true,
      bankName: 'Banco Demo',
      accountHolder: 'Card Shop SA',
      cbu: '0000003100010000000001',
      alias: 'cardshop.demo',
      updatedById: admin.id,
    },
  });
  const receiptFileId = await seedPrivateTransferReceipt();
  await seedCmsOrders({ adminId: admin.id, userId: user.id, zone, shippingRate: standardShippingRate, pickupPoint, receiptFileId, now });
  const affiliateOrder = await seedAffiliateDemoOrder({
    adminId: admin.id,
    userId: user.id,
    affiliate: {
      affiliateId: affiliateSeed.affiliateId,
      publicName: affiliateSeed.publicName,
      contactPhone: affiliateSeed.contactPhone,
      zoneId: affiliateSeed.zoneId,
      shippingRateId: affiliateSeed.shippingRateId,
      commissionBps: affiliateSeed.commissionBps,
    },
    now,
  });
  console.log(JSON.stringify({
    seed: 'ok',
    admin: { email: adminEmail, password: adminPassword },
    user: { email: userEmail, password: userPassword, loyaltyStartingPoints: demoLoyaltyStartingPoints },
    affiliate: {
      email: affiliateEmail,
      password: affiliatePassword,
      publicName: affiliateSeed.publicName,
      listings: affiliateSeed.listings,
      demoOrder: affiliateOrder.orderNumber,
      demoSellerOrderId: affiliateOrder.sellerOrderId,
    },
    loyalty: {
      spendPerPointMinor: loyaltyProgramSeed.spendPerPointMinor.toString(),
      pointValueMinor: loyaltyProgramSeed.pointValueMinor.toString(),
      minimumRedemptionPoints: loyaltyProgramSeed.minimumRedemptionPoints,
      maximumRedemptionPercent: loyaltyProgramSeed.maximumRedemptionPercent,
    },
    transferSettings: { enabled: true, alias: 'cardshop.demo' },
    products: products.length,
    suppliers: suppliers.length,
    orders: cmsOrderFixtures.length + 1,
    pendingTransferReceiptFileId: receiptFileId,
    pickupPointId: pickupPoint.id,
    shippingRateIds: ['aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2'],
  }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { await prisma.$disconnect(); });

import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const prisma = new PrismaClient();
const storageRoot = path.resolve(process.env.STORAGE_ROOT ?? './storage');
const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@cardshop.test';
const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'Admin123!seed-card-shop';
const userEmail = process.env.SEED_USER_EMAIL ?? 'user@cardshop.test';
const userPassword = process.env.SEED_USER_PASSWORD ?? 'User123!seed-card-shop';

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
        currency: 'ARS',
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
          update: { orderId, productId: resolved.product.id, sku: resolved.product.sku, productName: resolved.product.name, productSnapshot, imageFileId, unitPriceMinor: resolved.product.priceMinor, quantity: resolved.item.quantity, lineTotalMinor: resolved.lineTotalMinor },
          create: { id: seedUuid(0xd0, itemNumber), orderId, productId: resolved.product.id, sku: resolved.product.sku, productName: resolved.product.name, productSnapshot, imageFileId, unitPriceMinor: resolved.product.priceMinor, quantity: resolved.item.quantity, lineTotalMinor: resolved.lineTotalMinor },
        });

        const paidIndex = fixture.history.indexOf('PAID');
        const expiredIndex = fixture.history.indexOf('EXPIRED');
        const consumedAt = fixture.reservationState === 'CONSUMED' ? transitionDates[Math.max(0, paidIndex)] ?? updatedAt : null;
        const releasedAt = fixture.reservationState === 'RELEASED' ? transitionDates[Math.max(0, expiredIndex)] ?? updatedAt : null;
        const reservationData = { quantity: resolved.item.quantity, expiresAt, releasedAt, consumedAt, createdAt };
        await tx.inventoryReservation.upsert({
          where: { orderId_productId: { orderId, productId: resolved.product.id } },
          update: reservationData,
          create: { id: seedUuid(0xe0, itemNumber), orderId, productId: resolved.product.id, ...reservationData },
        });
      }

      const providerReference = fixture.paymentMethod === 'BANK_TRANSFER' ? `TR-${fixture.number}` : `MP-${fixture.number}`;
      const paymentData = { method: fixture.paymentMethod, status: fixture.paymentStatus, amountMinor: totalMinor, currency: 'ARS', providerReference, createdAt, updatedAt };
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
        const refundData = { paymentId, fullRefundKey: paymentId, amountMinor: totalMinor, currency: 'ARS', reason: fixture.refund.reason, externalReference: fixture.refund.externalReference, createdAt: updatedAt, createdById: input.adminId };
        await tx.refundRecord.upsert({ where: { fullRefundKey: paymentId }, update: refundData, create: { id: seedUuid(0xb3, fixtureNumber), ...refundData } });
      }

      const auditActorId = fixture.auditActor === 'ADMIN' ? input.adminId : fixture.auditActor === 'USER' ? input.userId : null;
      const auditData = {
        actorType: fixture.auditActor,
        actorId: auditActorId,
        action: fixture.auditAction,
        entityType: 'Order',
        entityId: orderId,
        metadata: JSON.stringify({ number: fixture.number, status: fixture.status, paymentMethod: fixture.paymentMethod, paymentStatus: fixture.paymentStatus }),
        requestId: `seed-${fixture.number.toLowerCase()}`,
        createdAt: updatedAt,
      };
      await tx.auditLog.upsert({ where: { id: seedUuid(0xc2, fixtureNumber) }, update: auditData, create: { id: seedUuid(0xc2, fixtureNumber), ...auditData } });
    }

    const [reservations, adjustments] = await Promise.all([
      tx.inventoryReservation.findMany({ where: { productId: { in: affectedProductIds } }, select: { productId: true, quantity: true, releasedAt: true, consumedAt: true } }),
      tx.inventoryAdjustment.findMany({ where: { productId: { in: affectedProductIds } }, select: { productId: true, delta: true } }),
    ]);
    for (const productId of affectedProductIds) {
      const baseline = products.find((product) => product.id === productId);
      if (!baseline) throw new Error(`Missing inventory baseline for seed product ${productId}`);
      const productReservations = reservations.filter((reservation) => reservation.productId === productId);
      const consumed = productReservations.filter((reservation) => reservation.consumedAt !== null).reduce((total, reservation) => total + reservation.quantity, 0);
      const reserved = productReservations.filter((reservation) => reservation.releasedAt === null && reservation.consumedAt === null).reduce((total, reservation) => total + reservation.quantity, 0);
      const adjustmentDelta = adjustments.filter((adjustment) => adjustment.productId === productId).reduce((total, adjustment) => total + adjustment.delta, 0);
      const onHand = baseline.stock + adjustmentDelta - consumed;
      if (onHand < reserved || onHand < 0) throw new Error(`Seed inventory invariant failed for ${baseline.sku}: onHand=${onHand}, reserved=${reserved}`);
      const current = await tx.inventory.findUniqueOrThrow({ where: { productId } });
      if (current.onHand !== onHand || current.reserved !== reserved) {
        await tx.inventory.update({ where: { productId }, data: { onHand, reserved, version: { increment: 1 } } });
      }
    }
  });
}

async function main() {
  if (adminPassword.length < 12 || userPassword.length < 12) throw new Error('Seed passwords must have at least 12 characters');
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
  const user = await prisma.user.upsert({ where: { email: userEmail }, update: { name: 'Demo Collector', passwordHash: await argon2.hash(userPassword, { type: argon2.argon2id }), status: 'ACTIVE', emailVerifiedAt: new Date() }, create: { email: userEmail, name: 'Demo Collector', passwordHash: await argon2.hash(userPassword, { type: argon2.argon2id }), status: 'ACTIVE', emailVerifiedAt: new Date() } });
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
  const standardShippingRate = await prisma.shippingRate.upsert({ where: { id: 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1' }, update: { zoneId: zone.id, name: 'Envío estándar', priceMinor: 65000n, currency: 'ARS', active: true }, create: { id: 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1', zoneId: zone.id, name: 'Envío estándar', priceMinor: 65000n, currency: 'ARS', active: true } });
  await prisma.shippingRate.upsert({ where: { id: 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2' }, update: { zoneId: zone.id, name: 'Envío express', priceMinor: 120000n, currency: 'ARS', active: true }, create: { id: 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2', zoneId: zone.id, name: 'Envío express', priceMinor: 120000n, currency: 'ARS', active: true } });
  const pickupPoint = await prisma.pickupPoint.upsert({ where: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, update: { name: 'Card Shop · Palermo', address: 'Av. Santa Fe 1234, CABA', active: true }, create: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Card Shop · Palermo', address: 'Av. Santa Fe 1234, CABA', active: true } });
  for (const supplier of suppliers) {
    await prisma.supplier.upsert({ where: { id: supplier.id }, update: supplier, create: supplier });
  }
  const receiptFileId = await seedPrivateTransferReceipt();
  await seedCmsOrders({ adminId: admin.id, userId: user.id, zone, shippingRate: standardShippingRate, pickupPoint, receiptFileId, now: new Date() });
  console.log(JSON.stringify({ seed: 'ok', admin: { email: adminEmail, password: adminPassword }, user: { email: userEmail, password: userPassword }, products: products.length, suppliers: suppliers.length, orders: cmsOrderFixtures.length, pendingTransferReceiptFileId: receiptFileId, pickupPointId: pickupPoint.id, shippingRateIds: ['aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2'] }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { await prisma.$disconnect(); });

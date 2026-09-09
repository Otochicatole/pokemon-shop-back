import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma, writeCoordinator } from '../src/infrastructure/prisma.js';
import { createAdminCmsApplication, createPrismaAdminCmsRepositories } from '../src/modules/backoffice/index.js';
import { supplierWriteSchema } from '../src/modules/backoffice/http/admin-cms-schemas.js';

const cms = createAdminCmsApplication(createPrismaAdminCmsRepositories(prisma, writeCoordinator), {
  integrations: { bankTransfer: false, mercadoPago: false, smtp: false },
});
const adminId = randomUUID();
const actor = { adminId, requestId: `supplier-test-${randomUUID()}` };
const supplierIds: string[] = [];

describe('supplier directory', () => {
  beforeAll(async () => {
    await prisma.admin.create({ data: { id: adminId, email: `supplier-${adminId}@example.test`, passwordHash: 'not-used' } });
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { actorId: adminId } });
    if (supplierIds.length) await prisma.supplier.deleteMany({ where: { id: { in: supplierIds } } });
    await prisma.admin.delete({ where: { id: adminId } });
  });

  it('allows a minimal supplier and normalizes empty optional fields', async () => {
    const input = supplierWriteSchema.parse({ name: '  Mazo Central  ', email: '   ', phone: '  ', address: '', notes: '   ' });
    const created = await cms.suppliers.create(actor, input);
    supplierIds.push(created.supplier.id);
    expect(created.supplier).toEqual(expect.objectContaining({ name: 'Mazo Central', email: null, phone: null, active: true, version: 1 }));
  });

  it('filters, edits with version checks, and audits lifecycle changes', async () => {
    const created = await cms.suppliers.create(actor, { name: 'Distribuciones Prisma', contactName: 'Ada', email: 'ada@example.test' });
    supplierIds.push(created.supplier.id);
    const listed = await cms.suppliers.list({ search: 'Prisma', active: true, limit: 10 });
    expect(listed.data.map((supplier) => supplier.id)).toContain(created.supplier.id);

    const updated = await cms.suppliers.update(actor, created.supplier.id, { expectedVersion: 1, name: 'Distribuciones Prisma Sur', notes: 'Llamar por la mañana' });
    expect(updated.supplier).toEqual(expect.objectContaining({ name: 'Distribuciones Prisma Sur', notes: 'Llamar por la mañana', version: 2 }));
    await expect(cms.suppliers.update(actor, created.supplier.id, { expectedVersion: 1, name: 'Versión obsoleta' })).rejects.toMatchObject({ code: 'SUPPLIER_CHANGED', status: 409 });

    const inactive = await cms.suppliers.setActive(actor, created.supplier.id, false, 2);
    expect(inactive).toEqual({ id: created.supplier.id, active: false, version: 3 });
    expect((await cms.suppliers.list({ active: true, limit: 10 })).data.map((supplier) => supplier.id)).not.toContain(created.supplier.id);
    expect((await cms.suppliers.list({ active: false, limit: 10 })).data.map((supplier) => supplier.id)).toContain(created.supplier.id);
    const active = await cms.suppliers.setActive(actor, created.supplier.id, true, 3);
    expect(active).toEqual({ id: created.supplier.id, active: true, version: 4 });
    await expect(cms.suppliers.setActive(actor, created.supplier.id, true, 3)).rejects.toMatchObject({ code: 'SUPPLIER_CHANGED', status: 409 });

    const audit = await prisma.auditLog.findMany({ where: { actorId: adminId, entityType: 'Supplier', entityId: created.supplier.id }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((entry) => entry.action)).toEqual(['SUPPLIER_CREATED', 'SUPPLIER_UPDATED', 'SUPPLIER_DEACTIVATED', 'SUPPLIER_REACTIVATED']);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { app } from '../src/app.js';
import { prisma } from '../src/infrastructure/prisma.js';
import { ADMIN_COOKIE } from '../src/infrastructure/sessions.js';
import { sha256 } from '../src/shared/ids.js';

const fixture = randomUUID();
const adminId = randomUUID();
const adminToken = `transfer-settings-admin-${fixture}`;
const csrfToken = `transfer-settings-csrf-${fixture}`;
const cookie = `${ADMIN_COOKIE}=${adminToken}`;

describe('transfer settings administration', () => {
  let original: Awaited<ReturnType<typeof prisma.transferSettings.findUnique>>;

  beforeAll(async () => {
    original = await prisma.transferSettings.findUnique({ where: { id: 'default' } });
    await prisma.admin.create({ data: { id: adminId, email: `transfer-settings-${fixture}@example.test`, passwordHash: 'not-used' } });
    await prisma.adminSession.create({ data: {
      adminId,
      tokenHash: sha256(adminToken),
      csrfHash: sha256(csrfToken),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    } });
  });

  afterAll(async () => {
    if (original) {
      await prisma.transferSettings.update({ where: { id: 'default' }, data: {
        enabled: original.enabled,
        bankName: original.bankName,
        accountHolder: original.accountHolder,
        cbu: original.cbu,
        alias: original.alias,
        version: original.version,
        updatedById: original.updatedById,
        updatedAt: original.updatedAt,
      } });
    } else await prisma.transferSettings.deleteMany({ where: { id: 'default' } });
    await prisma.auditLog.deleteMany({ where: { actorId: adminId } });
    await prisma.adminSession.deleteMany({ where: { adminId } });
    await prisma.admin.deleteMany({ where: { id: adminId } });
  });

  it('reads and updates the protected configuration with optimistic concurrency', async () => {
    const initial = await request(app).get('/api/v2/admin/config/transfer').set('Cookie', cookie);
    expect(initial.status).toBe(200);
    const initialVersion = initial.body.data.version as number;
    expect(initial.body.data).toEqual(expect.objectContaining({ version: initialVersion }));

    const missingCsrf = await request(app).patch('/api/v2/admin/config/transfer').set('Cookie', cookie).send({
      enabled: false, bankName: '', accountHolder: '', cbu: null, alias: null, expectedVersion: initialVersion,
    });
    expect(missingCsrf.status).toBe(403);

    const incomplete = await request(app).patch('/api/v2/admin/config/transfer').set('Cookie', cookie).set('X-CSRF-Token', csrfToken).send({
      enabled: true, bankName: 'Banco Demo', accountHolder: 'Card Shop', cbu: null, alias: null, expectedVersion: initialVersion,
    });
    expect(incomplete.status).toBe(400);

    const updated = await request(app).patch('/api/v2/admin/config/transfer').set('Cookie', cookie).set('X-CSRF-Token', csrfToken).send({
      enabled: true, bankName: '  Banco Demo  ', accountHolder: '  Card Shop  ', cbu: '1234567890123456789012', alias: null, expectedVersion: initialVersion,
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toEqual(expect.objectContaining({ enabled: true, bankName: 'Banco Demo', accountHolder: 'Card Shop', cbu: '1234567890123456789012', version: initialVersion + 1 }));

    const stale = await request(app).patch('/api/v2/admin/config/transfer').set('Cookie', cookie).set('X-CSRF-Token', csrfToken).send({
      enabled: false, bankName: '', accountHolder: '', cbu: null, alias: null, expectedVersion: initialVersion,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('TRANSFER_SETTINGS_CHANGED');

    const audit = await prisma.auditLog.findFirst({ where: { actorId: adminId, action: 'TRANSFER_SETTINGS_UPDATED' }, orderBy: { createdAt: 'desc' } });
    expect(audit).not.toBeNull();
    expect(audit?.metadata).not.toContain('1234567890123456789012');
  });

  it('uses the persisted activation state in checkout options and dashboard integrations', async () => {
    const options = await request(app).get('/api/v2/checkout/options');
    expect(options.status).toBe(200);
    expect(options.body.data.paymentMethods.BANK_TRANSFER).toBe(true);

    const dashboard = await request(app).get('/api/v2/admin/dashboard?range=7D').set('Cookie', cookie);
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.data.integrations.bankTransfer).toBe(true);
  });

  it('removes transfer from checkout when the persisted setting is disabled', async () => {
    const current = await request(app).get('/api/v2/admin/config/transfer').set('Cookie', cookie);
    const disabled = await request(app).patch('/api/v2/admin/config/transfer').set('Cookie', cookie).set('X-CSRF-Token', csrfToken).send({
      enabled: false, bankName: '', accountHolder: '', cbu: null, alias: null, expectedVersion: current.body.data.version,
    });
    expect(disabled.status).toBe(200);

    const options = await request(app).get('/api/v2/checkout/options');
    expect(options.body.data.paymentMethods.BANK_TRANSFER).toBe(false);
  });
});

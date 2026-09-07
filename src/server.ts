import { open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { app } from './app.js';
import { env } from './config/env.js';
import { configureSqlite, prisma, writeCoordinator } from './infrastructure/prisma.js';
import { ensureStorage } from './modules/media/media.js';
import { logger } from './infrastructure/logger.js';
import { ExpireReservations } from './modules/inventory/index.js';

const lockPath = path.resolve(env.STORAGE_ROOT, 'app.lock');

async function writeLock() {
  const handle = await open(lockPath, 'wx');
  await handle.writeFile(String(process.pid));
  await handle.close();
  return async () => unlink(lockPath).catch(() => undefined);
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function acquireLock() {
  try {
    return await writeLock();
  } catch {
    let ownerPid: number | undefined;
    try {
      const value = Number.parseInt((await readFile(lockPath, 'utf8')).trim(), 10);
      if (Number.isInteger(value) && value > 0) ownerPid = value;
    } catch {
      // The lock may have been removed between the failed create and the read.
    }

    if (ownerPid && ownerPid !== process.pid && !isProcessAlive(ownerPid)) {
      await unlink(lockPath).catch(() => undefined);
      try {
        return await writeLock();
      } catch {
        // Another live process won the race while the stale lock was replaced.
      }
    }

    throw new Error(`Another back-card-shop process appears to be using ${env.STORAGE_ROOT}`);
  }
}

async function expireOrders() {
  await new ExpireReservations({ prisma, writeCoordinator }).execute();
}

async function main() {
  await ensureStorage();
  const releaseLock = await acquireLock();
  await configureSqlite();
  const expirationTimer = setInterval(() => { void expireOrders().catch((error) => logger.error({ err: error }, 'Order expiry job failed')); }, 60_000);
  expirationTimer.unref();
  const server = app.listen(env.PORT, () => logger.info({ port: env.PORT }, 'back-card-shop listening'));
  const shutdown = async () => { clearInterval(expirationTimer); server.close(); await releaseLock(); await prisma.$disconnect(); };
  process.once('SIGINT', () => void shutdown().then(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)));
}

main().catch(async (error) => { logger.fatal({ err: error }, 'Unable to start server'); await prisma.$disconnect(); process.exit(1); });

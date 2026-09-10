import { open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { app, composition } from './app.js';
import { env } from './config/env.js';
import { configureSqlite, prisma, writeCoordinator } from './infrastructure/prisma.js';
import { ensureStorage } from './modules/media/index.js';
import { logger } from './infrastructure/logger.js';
import { ExpireReservations } from './modules/inventory/index.js';
import { attachSupportWebSocketServer, getSupportUnreadCount } from './modules/support/index.js';

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

let expirationRunning: Promise<void> | null = null;
let mediaCleanupRunning: Promise<void> | null = null;

function expireOrders(): Promise<void> {
  if (expirationRunning) return expirationRunning;
  expirationRunning = new ExpireReservations({ prisma, writeCoordinator }).execute()
    .then(() => undefined)
    .finally(() => { expirationRunning = null; });
  return expirationRunning;
}

function cleanupRetiredImages(): Promise<void> {
  if (mediaCleanupRunning) return mediaCleanupRunning;
  mediaCleanupRunning = composition.applications.retiredImageCleanup.execute()
    .then((result) => {
      if (result.claimed > 0) logger.info(result, 'Retired product image cleanup completed');
    })
    .finally(() => { mediaCleanupRunning = null; });
  return mediaCleanupRunning;
}

async function main() {
  await ensureStorage();
  const releaseLock = await acquireLock();
  await configureSqlite();
  const expirationTimer = setInterval(() => { void expireOrders().catch((error) => logger.error({ err: error }, 'Order expiry job failed')); }, 60_000);
  const mediaCleanupTimer = setInterval(() => { void cleanupRetiredImages().catch((error) => logger.error({ err: error }, 'Retired product image cleanup failed')); }, 5 * 60_000);
  expirationTimer.unref();
  mediaCleanupTimer.unref();
  void cleanupRetiredImages().catch((error) => logger.error({ err: error }, 'Initial retired product image cleanup failed'));
  const server = app.listen(env.PORT, () => logger.info({ port: env.PORT }, 'back-card-shop listening'));
  const supportWebSocketServer = attachSupportWebSocketServer(server, {
    hub: composition.realtime.support,
    getUnreadCount: (actor) => getSupportUnreadCount(prisma, actor),
  });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(expirationTimer);
    clearInterval(mediaCleanupTimer);
    await supportWebSocketServer.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    const activeJobs = [expirationRunning, mediaCleanupRunning]
      .filter((job): job is Promise<void> => job !== null);
    await Promise.allSettled(activeJobs);
    await releaseLock();
    await prisma.$disconnect();
  };
  const exitGracefully = () => {
    void shutdown()
      .then(() => process.exit(0))
      .catch((error) => {
        logger.error({ err: error }, 'Graceful shutdown failed');
        process.exit(1);
      });
  };
  process.once('SIGINT', exitGracefully);
  process.once('SIGTERM', exitGracefully);
}

main().catch(async (error) => { logger.fatal({ err: error }, 'Unable to start server'); await prisma.$disconnect(); process.exit(1); });

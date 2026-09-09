import { env } from '../config/env.js';
import { configureSqlite, prisma, writeCoordinator } from '../infrastructure/prisma.js';
import { ensureStorage, createRetiredImageCleanup } from '../modules/media/index.js';

async function main() {
  await ensureStorage();
  await configureSqlite();
  const cleanup = createRetiredImageCleanup(prisma, writeCoordinator, env.STORAGE_ROOT);
  const result = await cleanup.execute({ limit: 100 });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());

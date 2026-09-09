import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const moduleRoot = join(process.cwd(), 'src', 'modules', 'backoffice');

describe('backoffice architecture boundaries', () => {
  it('keeps domain and application independent from Express and Prisma', async () => {
    const files = [
      ...await sourceFiles(join(moduleRoot, 'domain')),
      ...await sourceFiles(join(moduleRoot, 'application')),
    ];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      expect(source, file).not.toMatch(/from ['"](?:express|@prisma\/client)['"]/);
    }
  });

  it('keeps the HTTP router dependent on injected application and media ports', async () => {
    const source = await readFile(join(moduleRoot, 'http', 'admin-cms-router.ts'), 'utf8');
    expect(source).not.toContain('PrismaAdminCmsRepository');
    expect(source).not.toContain("@prisma/client");
    expect(source).not.toContain("../infrastructure/");
    expect(source).toContain('AdminCmsHttpDependencies');
  });

  it('uses concrete DTOs rather than a generic JSON result port', async () => {
    const source = await readFile(join(moduleRoot, 'application', 'ports.ts'), 'utf8');
    expect(source).not.toContain('JsonResult');
    expect(source).toContain('CursorPageDto<ProductDto>');
    expect(source).toContain('Promise<OrderDetailDto>');
  });
});

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  }));
  return nested.flat();
}

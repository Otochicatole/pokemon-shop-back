import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { prisma } from '../infrastructure/prisma.js';
import { hashPassword } from '../shared/crypto.js';
import { normalizeEmail } from '../shared/ids.js';

const readline = createInterface({ input, output });
try {
  const emailValue = normalizeEmail(await readline.question('Admin email: '));
  const name = (await readline.question('Admin name (optional): ')).trim() || undefined;
  const password = await readline.question('Admin password (min 12): ');
  if (password.length < 12) throw new Error('Password must have at least 12 characters');
  const existing = await prisma.admin.findUnique({ where: { email: emailValue } });
  if (existing) throw new Error('An admin with that email already exists');
  await prisma.admin.create({
    data: {
      email: emailValue,
      ...(name ? { name } : {}),
      passwordHash: await hashPassword(password),
    },
  });
  console.log('Admin created.');
} finally {
  readline.close();
  await prisma.$disconnect();
}

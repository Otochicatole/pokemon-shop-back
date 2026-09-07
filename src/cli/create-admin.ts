import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { prisma } from '../infrastructure/prisma.js';
import { hashPassword, encrypt, createTotp } from '../shared/crypto.js';
import { normalizeEmail, randomToken, sha256 } from '../shared/ids.js';

const readline = createInterface({ input, output });
try {
  const emailValue = normalizeEmail(await readline.question('Admin email: '));
  const name = (await readline.question('Admin name (optional): ')).trim() || undefined;
  const password = await readline.question('Admin password (min 12): ');
  if (password.length < 12) throw new Error('Password must have at least 12 characters');
  const existing = await prisma.admin.findUnique({ where: { email: emailValue } });
  if (existing) throw new Error('An admin with that email already exists');
  const totp = createTotp(emailValue);
  const recoveryCodes = Array.from({ length: 8 }, () => randomToken(8));
  await prisma.admin.create({ data: { email: emailValue, ...(name ? { name } : {}), passwordHash: await hashPassword(password), totpSecretCipher: encrypt(totp.secret), totpEnabledAt: new Date(), recoveryCodes: { create: recoveryCodes.map((code) => ({ codeHash: sha256(code) })) } } });
  console.log(`Admin created. Add this URI to an authenticator:\n${totp.uri}`);
  console.log(`Recovery codes (store once, they will not be shown again):\n${recoveryCodes.join('\n')}`);
} finally {
  readline.close();
  await prisma.$disconnect();
}

import argon2 from 'argon2';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
import { Secret, TOTP } from 'otpauth';

const encryptionKey = createHash('sha256').update(env.APP_ENCRYPTION_KEY).digest();

export const hashPassword = (value: string) => argon2.hash(value, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
export const verifyPassword = (hash: string, value: string) => argon2.verify(hash, value);

export function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decrypt(value: string): string {
  const [ivValue, tagValue, dataValue] = value.split('.');
  if (!ivValue || !tagValue || !dataValue) throw new Error('Invalid encrypted value');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataValue, 'base64url')), decipher.final()]).toString('utf8');
}

export function createTotp(email: string) {
  const secret = new Secret({ size: 20 });
  const totp = new TOTP({ issuer: 'back-card-shop', label: email, secret });
  return { secret: secret.base32, uri: totp.toString() };
}

export function verifyTotp(secretValue: string, token: string): boolean {
  if (!/^\d{6}$/.test(token)) return false;
  const totp = new TOTP({ issuer: 'back-card-shop', label: 'admin', secret: Secret.fromBase32(secretValue) });
  return totp.validate({ token, window: 1 }) !== null;
}

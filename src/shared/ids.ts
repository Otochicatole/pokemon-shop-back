import { randomBytes, createHash } from 'node:crypto';

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
export const publicOrderNumber = (): string => `BCS-${randomBytes(10).toString('hex').toUpperCase()}`;
export const normalizeEmail = (value: string): string => value.trim().toLowerCase();

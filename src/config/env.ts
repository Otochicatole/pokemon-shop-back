import 'dotenv/config';
import { z } from 'zod';

const rawSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1).default('file:../storage/db/card-shop.db'),
  STORAGE_ROOT: z.string().min(1).default('./storage'),
  FRONTEND_ORIGINS: z.string().default('http://localhost:5173'),
  COOKIE_SECURE: z.string().default('false'),
  SWAGGER_ENABLED: z.string().default('true'),
  SESSION_SECRET: z.string().min(16).default('development-only-session-secret-change-me'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().default('http://localhost:3001/api/v2/auth/google/callback'),
  PUBLIC_API_URL: z.string().url().optional(),
  MERCADOPAGO_ACCESS_TOKEN: z.string().optional(),
  MERCADOPAGO_WEBHOOK_SECRET: z.string().optional(),
  MERCADOPAGO_COLLECTOR_ID: z.string().optional(),
  BANK_NAME: z.string().optional(),
  BANK_ACCOUNT_HOLDER: z.string().optional(),
  BANK_CBU: z.string().optional(),
  BANK_ALIAS: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().email().optional(),
});

const parsed = rawSchema.parse(process.env);

if (parsed.NODE_ENV === 'production') {
  const required = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'MERCADOPAGO_ACCESS_TOKEN', 'MERCADOPAGO_WEBHOOK_SECRET', 'SMTP_HOST', 'SMTP_FROM'] as const;
  for (const key of required) {
    if (!parsed[key]) throw new Error(`Missing required production environment variable: ${key}`);
  }
  if (parsed.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET must have at least 32 characters in production');
}

const toBool = (value: string): boolean => ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());

export const env = {
  ...parsed,
  cookieSecure: toBool(parsed.COOKIE_SECURE),
  swaggerEnabled: toBool(parsed.SWAGGER_ENABLED),
  frontendOrigins: parsed.FRONTEND_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
};

export type Env = typeof env;

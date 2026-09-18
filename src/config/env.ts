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
  AFFILIATE_BANK_ENCRYPTION_KEY: z.string().min(16).optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().default('http://localhost:3001/api/v2/auth/google/callback'),
  PUBLIC_API_URL: z.string().url().optional(),
  PUBLIC_WEB_URL: z.string().url().optional(),
  MERCADOPAGO_ENABLED: z.string().default('false'),
  MERCADOPAGO_ACCESS_TOKEN: z.string().optional(),
  MERCADOPAGO_WEBHOOK_SECRET: z.string().optional(),
  MERCADOPAGO_COLLECTOR_ID: z.string().optional(),
  DOLARAPI_BASE_URL: z.string().url().default('https://dolarapi.com/v1/dolares'),
  DOLARAPI_URL: z.string().url().optional(),
  DOLARAPI_TIMEOUT_MS: z.coerce.number().int().min(500).max(15_000).default(3_000),
  DOLARAPI_CACHE_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(1_800),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().email().optional(),
});

const parsed = rawSchema.parse(process.env);

if (parsed.NODE_ENV === 'production') {
  const required = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SMTP_HOST', 'SMTP_FROM', 'AFFILIATE_BANK_ENCRYPTION_KEY'] as const;
  for (const key of required) {
    if (!parsed[key]) throw new Error(`Missing required production environment variable: ${key}`);
  }
  if (parsed.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET must have at least 32 characters in production');
}

const toBool = (value: string): boolean => ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());

function resolveDolarApiBaseUrl() {
  if (parsed.DOLARAPI_BASE_URL && parsed.DOLARAPI_BASE_URL !== 'https://dolarapi.com/v1/dolares') {
    return parsed.DOLARAPI_BASE_URL.replace(/\/+$/, '');
  }
  if (parsed.DOLARAPI_URL) {
    return parsed.DOLARAPI_URL.replace(/\/+$/, '').replace(/\/(?:oficial|blue|bolsa|contadoconliqui|mayorista|cripto|tarjeta)$/i, '');
  }
  return 'https://dolarapi.com/v1/dolares';
}

export const env = {
  ...parsed,
  DOLARAPI_BASE_URL: resolveDolarApiBaseUrl(),
  cookieSecure: toBool(parsed.COOKIE_SECURE),
  swaggerEnabled: toBool(parsed.SWAGGER_ENABLED),
  mercadoPagoEnabled: toBool(parsed.MERCADOPAGO_ENABLED),
  frontendOrigins: parsed.FRONTEND_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
};

if (env.mercadoPagoEnabled) {
  const required = ['MERCADOPAGO_ACCESS_TOKEN', 'MERCADOPAGO_WEBHOOK_SECRET', 'MERCADOPAGO_COLLECTOR_ID', 'PUBLIC_API_URL', 'PUBLIC_WEB_URL'] as const;
  for (const key of required) {
    if (!parsed[key]) throw new Error(`Missing required Mercado Pago environment variable: ${key}`);
  }
  if (parsed.NODE_ENV === 'production') {
    for (const key of ['PUBLIC_API_URL', 'PUBLIC_WEB_URL'] as const) {
      const value = parsed[key]!;
      let url: URL;
      try { url = new URL(value); } catch { throw new Error(`${key} must be a valid public URL when Mercado Pago is enabled in production`); }
      if (url.protocol !== 'https:') throw new Error(`${key} must use HTTPS when Mercado Pago is enabled in production`);
      if (['localhost', '127.0.0.1', '::1'].includes(url.hostname.toLowerCase())) throw new Error(`${key} cannot use localhost when Mercado Pago is enabled in production`);
    }
  }
}

export type Env = typeof env;

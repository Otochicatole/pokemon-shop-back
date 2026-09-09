import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12).max(128),
  name: z.string().trim().min(1).max(100).optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(128),
});

export const adminLoginSchema = loginSchema.strict();

export const tokenSchema = z.object({ token: z.string().min(20).max(300) });
export const resetSchema = tokenSchema.extend({ password: z.string().min(12).max(128) });
export const forgotPasswordSchema = z.object({ email: z.string().email() });

export const adminPrincipalSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string().nullable(),
  role: z.literal('SUPER_ADMIN'),
});

export const csrfTokenSchema = z.object({ csrfToken: z.string().nullable() });

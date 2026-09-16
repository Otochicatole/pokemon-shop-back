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

/**
 * Fields a signed-in user can edit from their profile. Email is intentionally
 * absent so it can never be changed through this endpoint.
 */
export const profileUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).nullable().optional(),
  currentPassword: z.string().max(128).optional(),
  newPassword: z.string().min(12).max(128).optional(),
  confirmPassword: z.string().max(128).optional(),
}).superRefine((input, ctx) => {
  const passwordFieldsPresent = input.currentPassword !== undefined
    || input.newPassword !== undefined
    || input.confirmPassword !== undefined;
  if (input.name === undefined && !passwordFieldsPresent) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [], message: 'PROFILE_NO_CHANGES' });
  }
  if (passwordFieldsPresent && input.newPassword === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['newPassword'], message: 'NEW_PASSWORD_REQUIRED' });
  }
  if (input.newPassword !== undefined && input.confirmPassword !== input.newPassword) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confirmPassword'], message: 'PASSWORD_CONFIRMATION_MISMATCH' });
  }
});

export const adminPrincipalSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string().nullable(),
  role: z.literal('SUPER_ADMIN'),
});

export const csrfTokenSchema = z.object({ csrfToken: z.string().nullable() });

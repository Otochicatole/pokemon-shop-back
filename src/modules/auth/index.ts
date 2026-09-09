/** Public adapter for customer-access and admin-access HTTP composition. */
export { createAuthRouter, createAdminAuthRouter } from './auth.js';
export {
  adminLoginSchema,
  adminPrincipalSchema,
  csrfTokenSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetSchema,
  tokenSchema,
} from './auth-schemas.js';

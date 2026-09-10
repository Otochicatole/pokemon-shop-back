import { Router, type Request, type Response, type NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { env } from '../../config/env.js';
import { AppError, badRequest, conflict, unauthorized } from '../../shared/errors.js';
import { normalizeEmail, randomToken, sha256 } from '../../shared/ids.js';
import { hashPassword, verifyPassword } from '../../shared/crypto.js';
import {
  createAdminSession,
  createUserSession,
  currentAdmin,
  currentUser,
  requireAdmin,
  requireUser,
  revokeAdminSession,
  revokeUserSession,
  rotateAdminCsrfToken,
  rotateUserCsrfToken,
  type SessionRevocationHandler,
} from '../../infrastructure/sessions.js';
import { email } from '../../infrastructure/email.js';
import { logger } from '../../infrastructure/logger.js';
import { prisma as db } from '../../infrastructure/prisma.js';
import { rateLimit } from '../../infrastructure/rate-limit.js';
import { discovery, authorizationCodeGrant, buildAuthorizationUrl, calculatePKCECodeChallenge, randomNonce, randomPKCECodeVerifier, randomState } from 'openid-client';
import {
  adminLoginSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetSchema,
  tokenSchema,
} from './auth-schemas.js';
const GOOGLE_COOKIE = env.cookieSecure ? '__Host-bcs_google_oauth' : 'bcs_google_oauth';
const redirectTarget = () => env.frontendOrigins[0] ?? 'http://localhost:5173';

function signOAuth(value: string): string {
  const encoded = Buffer.from(value).toString('base64url');
  const signature = createHmac('sha256', env.SESSION_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyOAuth(value: string): string | null {
  const [encoded, signature] = value.split('.');
  if (!encoded || !signature) return null;
  const expected = createHmac('sha256', env.SESSION_SECRET).update(encoded).digest('base64url');
  const expectedBytes = Buffer.from(expected);
  const signatureBytes = Buffer.from(signature);
  if (expectedBytes.length !== signatureBytes.length || !timingSafeEqual(expectedBytes, signatureBytes)) return null;
  try { return Buffer.from(encoded, 'base64url').toString('utf8'); } catch { return null; }
}

async function googleConfig() {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new AppError(503, 'OAUTH_NOT_CONFIGURED', 'Google OAuth is not configured');
  return discovery(new URL('https://accounts.google.com'), env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
}

function issueVerificationEmail(userId: string, to: string) {
  return (async () => {
    const raw = randomToken(32);
    await db.userToken.create({ data: { userId, type: 'EMAIL_VERIFICATION', tokenHash: sha256(raw), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } });
    await email.send(to, 'Verifica tu email', `Verifica tu cuenta usando este token: ${raw}`);
  })();
}

function toPublicUser(user: { id: string; email: string; name: string | null; emailVerifiedAt: Date | null }) {
  return { id: user.id, email: user.email, name: user.name, emailVerified: Boolean(user.emailVerifiedAt) };
}

type AuthRouterOptions = {
  onSessionRevoked?: SessionRevocationHandler;
};

export function createAuthRouter(prisma: PrismaClient, options: AuthRouterOptions = {}): Router {
  const router = Router();

  router.get('/csrf', async (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(200).json({ csrfToken: null });
    return res.status(200).json({ csrfToken: await rotateUserCsrfToken(req, res) });
  });

  router.post('/register', rateLimit(5, 15 * 60 * 1000), async (req, res) => {
    const input = registerSchema.parse(req.body);
    const emailValue = normalizeEmail(input.email);
    const existing = await prisma.user.findUnique({ where: { email: emailValue } });
    if (existing) throw conflict('EMAIL_IN_USE', 'Unable to create account with these details');
    const user = await prisma.user.create({ data: { email: emailValue, name: input.name, passwordHash: await hashPassword(input.password) } });
    await issueVerificationEmail(user.id, user.email);
    return res.status(201).json({ user: toPublicUser(user), verificationRequired: true });
  });

  router.post('/login', rateLimit(10, 15 * 60 * 1000, (request) => `${request.ip}:${String(request.body?.email ?? '').toLowerCase()}`), async (req, res) => {
    const input = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: normalizeEmail(input.email) } });
    if (!user || !user.passwordHash || !(await verifyPassword(user.passwordHash, input.password))) throw unauthorized('Invalid credentials');
    if (user.status !== 'ACTIVE') throw unauthorized('Invalid credentials');
    const session = await createUserSession(user.id, res, req, options.onSessionRevoked);
    return res.status(200).json({ user: toPublicUser(user), csrfToken: session.csrfToken });
  });

  router.post('/logout', async (req, res) => {
    await revokeUserSession(req, res, options.onSessionRevoked);
    return res.status(204).send();
  });
  router.get('/me', requireUser, (req, res) => res.json({ user: toPublicUser(currentUser(req)!.user) }));

  router.post('/verify-email', async (req, res) => {
    const input = tokenSchema.parse(req.body);
    const token = await prisma.userToken.findFirst({ where: { tokenHash: sha256(input.token), type: 'EMAIL_VERIFICATION', usedAt: null, expiresAt: { gt: new Date() } } });
    if (!token) throw badRequest('INVALID_TOKEN', 'Invalid or expired verification token');
    await prisma.$transaction(async (tx) => {
      await tx.userToken.update({ where: { id: token.id }, data: { usedAt: new Date() } });
      await tx.user.update({ where: { id: token.userId }, data: { emailVerifiedAt: new Date() } });
    });
    return res.status(204).send();
  });

  router.post('/forgot-password', rateLimit(5, 15 * 60 * 1000), async (req, res) => {
    const { email: inputEmail } = forgotPasswordSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: normalizeEmail(inputEmail) } });
    if (user) {
      const raw = randomToken(32);
      await prisma.userToken.create({ data: { userId: user.id, type: 'PASSWORD_RESET', tokenHash: sha256(raw), expiresAt: new Date(Date.now() + 30 * 60 * 1000) } });
      await email.send(user.email, 'Recuperación de acceso', `Usa este token para restablecer tu contraseña: ${raw}`);
    }
    return res.status(202).json({ accepted: true });
  });

  router.post('/reset-password', rateLimit(5, 15 * 60 * 1000), async (req, res) => {
    const input = resetSchema.parse(req.body);
    const token = await prisma.userToken.findFirst({ where: { tokenHash: sha256(input.token), type: 'PASSWORD_RESET', usedAt: null, expiresAt: { gt: new Date() } } });
    if (!token) throw badRequest('INVALID_TOKEN', 'Invalid or expired reset token');
    const revokedSessions = await prisma.$transaction(async (tx) => {
      const sessions = await tx.userSession.findMany({
        where: { userId: token.userId, revokedAt: null },
        select: { id: true },
      });
      await tx.userToken.update({ where: { id: token.id }, data: { usedAt: new Date() } });
      await tx.user.update({ where: { id: token.userId }, data: { passwordHash: await hashPassword(input.password) } });
      await tx.userSession.updateMany({ where: { userId: token.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      return sessions;
    });
    for (const session of revokedSessions) {
      options.onSessionRevoked?.({ actorType: 'USER', actorId: token.userId, sessionId: session.id });
    }
    return res.status(204).send();
  });

  router.get('/google', async (req, res) => {
    const config = await googleConfig();
    const verifier = randomPKCECodeVerifier();
    const challenge = await calculatePKCECodeChallenge(verifier);
    const state = randomState();
    const nonce = randomNonce();
    const linkUserId = currentUser(req)?.userId;
    const payload = JSON.stringify({ verifier, state, nonce, mode: linkUserId ? 'link' : 'login', userId: linkUserId, expiresAt: Date.now() + 10 * 60 * 1000 });
    res.cookie(GOOGLE_COOKIE, signOAuth(payload), { httpOnly: true, secure: env.cookieSecure, sameSite: 'lax', path: '/', maxAge: 10 * 60 * 1000 });
    const url = buildAuthorizationUrl(config, { redirect_uri: env.GOOGLE_REDIRECT_URI, scope: 'openid email profile', response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state, nonce });
    return res.redirect(url.href);
  });

  router.get('/google/callback', async (req, res) => {
    try {
      const signed = req.cookies?.[GOOGLE_COOKIE] as string | undefined;
      const raw = signed ? verifyOAuth(signed) : null;
      if (!raw) throw badRequest('INVALID_OAUTH_STATE', 'Invalid OAuth state');
      const attempt = JSON.parse(raw) as { verifier: string; state: string; nonce: string; mode: 'login' | 'link'; userId?: string; expiresAt: number };
      if (attempt.expiresAt < Date.now()) throw badRequest('EXPIRED_OAUTH_STATE', 'Expired OAuth state');
      const config = await googleConfig();
      // The callback may arrive through the Next.js same-origin proxy. Always
      // use the registered URI so the code exchange remains stable behind it.
      const currentUrl = new URL(env.GOOGLE_REDIRECT_URI);
      currentUrl.search = new URL(`${req.protocol}://${req.get('host')}${req.originalUrl}`).search;
      const tokens = await authorizationCodeGrant(config, currentUrl, { pkceCodeVerifier: attempt.verifier, expectedState: attempt.state, expectedNonce: attempt.nonce });
      const claims = tokens.claims() as { iss?: string; sub?: string; email?: string; email_verified?: boolean; name?: string } | undefined;
      if (!claims?.iss || !claims.sub || !claims.email || claims.email_verified !== true) throw badRequest('INVALID_OIDC_IDENTITY', 'Google identity is not verified');
      const issuer = claims.iss;
      let user = await prisma.userOAuthAccount.findUnique({ where: { issuer_subject: { issuer, subject: claims.sub } }, include: { user: true } }).then((account) => account?.user);
      if (attempt.mode === 'link') {
        if (!attempt.userId) throw unauthorized();
        const owner = await prisma.user.findUnique({ where: { id: attempt.userId } });
        if (!owner) throw unauthorized();
        if (user && user.id !== owner.id) throw conflict('OAUTH_ACCOUNT_LINKED', 'Google account is already linked');
        if (!user) await prisma.userOAuthAccount.create({ data: { userId: owner.id, issuer, subject: claims.sub, emailAtLogin: claims.email } });
        res.clearCookie(GOOGLE_COOKIE, { path: '/' });
        return res.redirect(`${redirectTarget()}/account?oauth=linked`);
      }
      if (!user) {
        const existing = await prisma.user.findUnique({ where: { email: normalizeEmail(claims.email) } });
        if (existing) throw conflict('EXPLICIT_LINK_REQUIRED', 'Sign in locally before linking this Google account');
        user = await prisma.user.create({ data: { email: normalizeEmail(claims.email), name: claims.name, emailVerifiedAt: new Date(), oauthAccounts: { create: { issuer, subject: claims.sub, emailAtLogin: claims.email } } } });
      }
      const session = await createUserSession(user.id, res, req, options.onSessionRevoked);
      res.clearCookie(GOOGLE_COOKIE, { path: '/' });
      return res.redirect(`${redirectTarget()}/auth/callback?oauth=success`);
    } catch (error) {
      logger.warn({ err: error }, 'Google OAuth callback failed');
      res.clearCookie(GOOGLE_COOKIE, { path: '/' });
      return res.redirect(`${redirectTarget()}/auth/callback?oauth=error`);
    }
  });

  return router;
}

export function createAdminAuthRouter(prisma: PrismaClient, options: AuthRouterOptions = {}): Router {
  const router = Router();
  router.get('/csrf', requireAdmin, async (req, res) => {
    return res.status(200).json({ csrfToken: await rotateAdminCsrfToken(req, res) });
  });
  router.post('/login', rateLimit(5, 15 * 60 * 1000, (request) => `${request.ip}:${String(request.body?.email ?? '').toLowerCase()}`), async (req, res) => {
    const input = adminLoginSchema.parse(req.body);
    const admin = await prisma.admin.findUnique({ where: { email: normalizeEmail(input.email) } });
    if (!admin || admin.status !== 'ACTIVE' || !(await verifyPassword(admin.passwordHash, input.password))) throw unauthorized('Invalid credentials');
    const session = await createAdminSession(admin.id, res, req, options.onSessionRevoked);
    return res.json({ admin: { id: admin.id, email: admin.email, name: admin.name, role: 'SUPER_ADMIN' }, csrfToken: session.csrfToken });
  });
  router.post('/logout', async (req, res) => {
    await revokeAdminSession(req, res, options.onSessionRevoked);
    return res.status(204).send();
  });
  router.get('/me', requireAdmin, (req, res) => res.json({ admin: { id: currentAdmin(req)!.admin.id, email: currentAdmin(req)!.admin.email, name: currentAdmin(req)!.admin.name, role: 'SUPER_ADMIN' } }));
  return router;
}

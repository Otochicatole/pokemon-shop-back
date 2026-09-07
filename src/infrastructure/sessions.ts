import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { prisma } from './prisma.js';
import { randomToken, sha256 } from '../shared/ids.js';
import { unauthorized, forbidden } from '../shared/errors.js';

const cookiePrefix = env.cookieSecure ? '__Host-' : '';
export const USER_COOKIE = `${cookiePrefix}bcs_user`;
export const ADMIN_COOKIE = `${cookiePrefix}bcs_admin`;
export const USER_CSRF_COOKIE = `${cookiePrefix}bcs_user_csrf`;
export const ADMIN_CSRF_COOKIE = `${cookiePrefix}bcs_admin_csrf`;

const cookieOptions = (httpOnly: boolean) => ({
  httpOnly,
  secure: env.cookieSecure,
  sameSite: 'strict' as const,
  path: '/',
  maxAge: httpOnly ? undefined : 8 * 60 * 60 * 1000,
});

const validHash = (raw: string, hash: string): boolean => {
  const expected = Buffer.from(hash, 'hex');
  const actual = Buffer.from(sha256(raw), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

export async function createUserSession(userId: string, response: Response, request: Request) {
  const token = randomToken(32);
  const csrf = randomToken(32);
  const now = new Date();
  const session = await prisma.userSession.create({
    data: {
      userId,
      tokenHash: sha256(token),
      csrfHash: sha256(csrf),
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      userAgent: request.get('user-agent')?.slice(0, 512),
    },
  });
  response.cookie(USER_COOKIE, token, { ...cookieOptions(true), maxAge: 30 * 24 * 60 * 60 * 1000 });
  response.cookie(USER_CSRF_COOKIE, csrf, cookieOptions(false));
  return { id: session.id, csrfToken: csrf };
}

export async function createAdminSession(adminId: string, response: Response, request: Request) {
  const token = randomToken(32);
  const csrf = randomToken(32);
  const now = new Date();
  const session = await prisma.adminSession.create({
    data: {
      adminId,
      tokenHash: sha256(token),
      csrfHash: sha256(csrf),
      expiresAt: new Date(now.getTime() + 8 * 60 * 60 * 1000),
      userAgent: request.get('user-agent')?.slice(0, 512),
    },
  });
  response.cookie(ADMIN_COOKIE, token, { ...cookieOptions(true), maxAge: 8 * 60 * 60 * 1000 });
  response.cookie(ADMIN_CSRF_COOKIE, csrf, cookieOptions(false));
  return { id: session.id, csrfToken: csrf };
}

export async function revokeUserSession(request: Request, response: Response) {
  const token = request.cookies?.[USER_COOKIE] as string | undefined;
  if (token) await prisma.userSession.updateMany({ where: { tokenHash: sha256(token), revokedAt: null }, data: { revokedAt: new Date() } });
  response.clearCookie(USER_COOKIE, cookieOptions(true));
  response.clearCookie(USER_CSRF_COOKIE, cookieOptions(false));
}

export async function revokeAdminSession(request: Request, response: Response) {
  const token = request.cookies?.[ADMIN_COOKIE] as string | undefined;
  if (token) await prisma.adminSession.updateMany({ where: { tokenHash: sha256(token), revokedAt: null }, data: { revokedAt: new Date() } });
  response.clearCookie(ADMIN_COOKIE, cookieOptions(true));
  response.clearCookie(ADMIN_CSRF_COOKIE, cookieOptions(false));
}

export async function getUserSession(request: Request) {
  const token = request.cookies?.[USER_COOKIE] as string | undefined;
  if (!token) return null;
  const session = await prisma.userSession.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
  if (!session || session.revokedAt || session.expiresAt <= new Date() || session.user.status !== 'ACTIVE') return null;
  return session;
}

export async function getAdminSession(request: Request) {
  const token = request.cookies?.[ADMIN_COOKIE] as string | undefined;
  if (!token) return null;
  const session = await prisma.adminSession.findUnique({ where: { tokenHash: sha256(token) }, include: { admin: true } });
  if (!session || session.revokedAt || session.expiresAt <= new Date() || session.admin.status !== 'ACTIVE' || !session.admin.totpEnabledAt) return null;
  return session;
}

export async function requireUser(request: Request, _response: Response, next: NextFunction) {
  const session = await getUserSession(request);
  if (!session) return next(unauthorized());
  resLocals(request).userSession = session;
  return next();
}

export async function requireAdmin(request: Request, _response: Response, next: NextFunction) {
  const session = await getAdminSession(request);
  if (!session) return next(unauthorized());
  resLocals(request).adminSession = session;
  return next();
}

type Locals = { userSession?: Awaited<ReturnType<typeof getUserSession>>; adminSession?: Awaited<ReturnType<typeof getAdminSession>> };
const resLocals = (request: Request): Locals => (request as Request & { authLocals?: Locals }).authLocals ?? ((request as Request & { authLocals?: Locals }).authLocals = {});

export function currentUser(request: Request) { return resLocals(request).userSession; }
export function currentAdmin(request: Request) { return resLocals(request).adminSession; }

/** Rotates the double-submit CSRF token for the active session. */
export async function rotateCsrfToken(request: Request, response: Response): Promise<string | null> {
  const userSession = currentUser(request);
  if (userSession) {
    const token = randomToken(32);
    await prisma.userSession.update({ where: { id: userSession.id }, data: { csrfHash: sha256(token) } });
    response.cookie(USER_CSRF_COOKIE, token, cookieOptions(false));
    return token;
  }
  const adminSession = currentAdmin(request);
  if (adminSession) {
    const token = randomToken(32);
    await prisma.adminSession.update({ where: { id: adminSession.id }, data: { csrfHash: sha256(token) } });
    response.cookie(ADMIN_CSRF_COOKIE, token, cookieOptions(false));
    return token;
  }
  return null;
}

export async function csrfProtection(request: Request, _response: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next();
  const session = currentUser(request) ?? currentAdmin(request);
  if (!session) return next();
  const csrfHeader = request.get('x-csrf-token');
  if (!csrfHeader || !validHash(csrfHeader, session.csrfHash)) return next(forbidden('Invalid CSRF token'));
  return next();
}

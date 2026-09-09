import type { RequestHandler } from 'express';

/** Prevents browsers and shared proxies from retaining any CMS response. */
export const adminNoStore: RequestHandler = (_request, response, next) => {
  response.setHeader('Cache-Control', 'no-store, max-age=0');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('Expires', '0');
  response.vary('Cookie');
  next();
};

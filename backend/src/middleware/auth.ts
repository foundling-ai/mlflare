import { createMiddleware } from 'hono/factory';
import type { Env } from '../index';
import { verifyJwt } from '../lib/jwt';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/** Bearer token auth for agent endpoints. */
export const agentAuth = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }
  const token = header.slice(7);
  if (!timingSafeEqual(token, c.env.API_TOKEN)) {
    return c.json({ error: 'Invalid token' }, 401);
  }
  await next();
});

/** JWT auth for PWA/API endpoints. */
export const jwtAuth = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  // Check Authorization header first, then query param (for SSE)
  let token: string | undefined;
  const header = c.req.header('Authorization');
  if (header?.startsWith('Bearer ')) {
    token = header.slice(7);
  } else {
    token = c.req.query('token');
  }

  if (!token) {
    return c.json({ error: 'Missing authentication' }, 401);
  }

  const payload = await verifyJwt(token, c.env.JWT_SECRET);
  if (!payload) {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }

  c.set('jwtPayload' as never, payload);
  await next();
});

/** Bearer token auth for SDK endpoints (same as agent). */
export const sdkAuth = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }
  const token = header.slice(7);
  if (!timingSafeEqual(token, c.env.API_TOKEN)) {
    return c.json({ error: 'Invalid token' }, 401);
  }
  await next();
});

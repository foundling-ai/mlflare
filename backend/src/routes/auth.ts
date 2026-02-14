import { Hono } from 'hono';
import type { Env } from '../index';
import { validateTOTP } from '../lib/totp';
import { signJwt } from '../lib/jwt';

const auth = new Hono<{ Bindings: Env }>();

auth.post('/totp', async (c) => {
  const body = await c.req.json<{ code: string }>();
  if (!body.code || body.code.length !== 6) {
    return c.json({ error: 'Invalid TOTP code format' }, 400);
  }

  const valid = await validateTOTP(body.code, c.env.TOTP_SECRET);
  if (!valid) {
    return c.json({ error: 'Invalid TOTP code' }, 401);
  }

  const token = await signJwt({ sub: 'admin', role: 'admin' }, c.env.JWT_SECRET, 86400);
  return c.json({ token });
});

export default auth;

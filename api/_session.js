/**
 * Verificación de la cookie de sesión, compartida por los endpoints que
 * devuelven datos sensibles.
 *
 * El middleware del edge ya bloquea /api/* sin sesión válida; esto es defensa
 * en profundidad: si alguna vez se cambia el `matcher` del middleware por error,
 * el endpoint de emails no queda expuesto por ese solo descuido.
 */
import { createHmac, timingSafeEqual } from 'crypto';

export function verifySession(req) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;

  const cookie = req.headers?.cookie || '';
  const m = cookie.match(/(?:^|;\s*)webdash_session=([^;]+)/);
  if (!m) return null;

  let decoded;
  try {
    decoded = Buffer.from(m[1], 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const i = decoded.lastIndexOf(':');
  if (i < 0) return null;
  const payload = decoded.slice(0, i);
  const sig = decoded.slice(i + 1);

  const expiry = Number(payload.slice(payload.lastIndexOf(':') + 1));
  if (!Number.isFinite(expiry) || Date.now() > expiry) return null;

  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  return { username: payload.slice(0, payload.lastIndexOf(':')), expiry };
}

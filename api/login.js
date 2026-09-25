/**
 * POST /api/login  { username, password } → setea la cookie de sesión.
 *
 * Mismo criterio que AppDash (api/login.js de vtex-utm-audit): contraseña
 * compartida en env var + token HMAC firmado, la contraseña nunca vuelve al
 * browser. Diferencia: la lista de usuarios permitidos NO va hardcodeada en el
 * código sino en la env var DASHBOARD_USERS, porque este repo puede ser público
 * y una lista de nombres de empleados también es dato personal.
 */
import { timingSafeEqual } from 'crypto';
import { sessionCookie } from './_session.js';
import { normUser, parseUsers } from './_users.js';

function equal(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const password = process.env.DASHBOARD_PASSWORD;
  const secret = process.env.SESSION_SECRET;
  if (!password || !secret) {
    return res.status(500).json({ error: 'Auth no configurada: faltan DASHBOARD_PASSWORD y SESSION_SECRET en Vercel.' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  // "gaston_ruiz@carrefour.com" y "gaston_ruiz" son el mismo usuario.
  const username = normUser(body?.username);
  const given = String(body?.password || '');

  if (!username || !equal(given, password)) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }

  const users = parseUsers();
  if (users.size && !users.has(username)) {
    return res.status(401).json({ error: 'Ese usuario no está habilitado para entrar.' });
  }

  res.setHeader('Set-Cookie', sessionCookie(username, secret));
  return res.status(200).json({ ok: true, username, name: users.get(username) || username });
}

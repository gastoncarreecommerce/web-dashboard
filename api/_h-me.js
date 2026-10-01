/**
 * GET  /api/me → { username, name, views, admin } del usuario de la sesión.
 * POST /api/me → lo mismo, y además renueva la sesión otros 10 minutos. El
 *                dashboard lo llama solo cuando la persona está usándolo, así
 *                que un cambio de accesos le llega en menos de un minuto.
 */
import { verifySession, sessionCookie } from './_session.js';
import { parseUsers } from './_users.js';
import { readAccess, viewsFor, isAdmin } from './_access.js';

export default async function handler(req, res) {
  const s = verifySession(req);
  if (!s) return res.status(401).json({ error: 'No autenticado' });
  const users = parseUsers();
  if (users.size && !users.has(s.username)) return res.status(401).json({ error: 'No habilitado' });
  if (req.method === 'POST') res.setHeader('Set-Cookie', sessionCookie(s.username, process.env.SESSION_SECRET));
  let cfg = null;
  try { cfg = await readAccess(); } catch { /* sin Redis: sin restricciones */ }
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json({
    username: s.username,
    name: users.get(s.username) || s.username,
    views: viewsFor(s.username, cfg),
    admin: isAdmin(s.username),
    expiresAt: req.method === 'POST' ? Date.now() + 10 * 60 * 1000 : s.expiry,
  });
}

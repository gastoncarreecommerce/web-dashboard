/**
 * GET  /api/me → { username, name } del usuario de la sesión, para el menú.
 * POST /api/me → lo mismo, y además renueva la sesión otros 10 minutos. El
 *                dashboard lo llama solo cuando la persona está usándolo.
 */
import { verifySession, sessionCookie } from './_session.js';
import { parseUsers } from './_users.js';

export default function handler(req, res) {
  const s = verifySession(req);
  if (!s) return res.status(401).json({ error: 'No autenticado' });
  const users = parseUsers();
  if (users.size && !users.has(s.username)) return res.status(401).json({ error: 'No habilitado' });
  if (req.method === 'POST') res.setHeader('Set-Cookie', sessionCookie(s.username, process.env.SESSION_SECRET));
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json({
    username: s.username,
    name: users.get(s.username) || s.username,
    expiresAt: req.method === 'POST' ? Date.now() + 10 * 60 * 1000 : s.expiry,
  });
}

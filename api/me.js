/** GET /api/me → { username, name } del usuario de la sesión, para el menú. */
import { verifySession } from './_session.js';
import { parseUsers } from './_users.js';

export default function handler(req, res) {
  const s = verifySession(req);
  if (!s) return res.status(401).json({ error: 'No autenticado' });
  const users = parseUsers();
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json({ username: s.username, name: users.get(s.username) || s.username });
}

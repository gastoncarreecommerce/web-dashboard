/**
 * /api/access — panel de accesos (solo admins).
 *
 *   GET → { modules, users: [{ username, name, views|null, admin }], updatedAt, updatedBy }
 *         views null = sin restricción (ve todo).
 *   PUT { username, views }  → cambia a una persona (views null = ve todo)
 */
import { verifySession } from './_session.js';
import { parseUsers, normUser } from './_users.js';
import { MODULES, readAccess, writeAccess, isAdmin } from './_access.js';

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
  }
  let data = '';
  for await (const chunk of req) data += chunk;
  return JSON.parse(data || '{}');
}

export default async function handler(req, res) {
  const s = verifySession(req);
  if (!s) return res.status(401).json({ error: 'No autenticado' });
  if (!isAdmin(s.username)) return res.status(403).json({ error: 'Solo administradores' });
  res.setHeader('Cache-Control', 'private, no-store');

  try {
    const cfg = await readAccess();
    if (!cfg.available) return res.status(503).json({ error: 'not_configured' });

    if (req.method === 'GET') {
      const known = parseUsers();
      // Usuarios de la lista de Vercel + cualquiera que tenga config guardada.
      const names = new Map(known);
      for (const u of Object.keys(cfg.users)) if (!names.has(u)) names.set(u, u);
      const users = [...names.entries()]
        .map(([username, name]) => ({
          username, name,
          admin: isAdmin(username),
          views: isAdmin(username) ? null : cfg.users[username] ?? null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'es'));
      return res.status(200).json({ modules: MODULES, users, updatedAt: cfg.updatedAt, updatedBy: cfg.updatedBy });
    }

    if (req.method === 'PUT') {
      const b = await readBody(req);
      const user = normUser(b.username);
      if (!user) return res.status(400).json({ error: 'bad_request' });
      if (isAdmin(user)) return res.status(400).json({ error: 'Los administradores ven todo siempre.' });
      const users = { ...cfg.users };
      if (b.views === null) delete users[user];
      else users[user] = Array.isArray(b.views) ? b.views : [];
      const by = parseUsers().get(s.username) || s.username;
      const out = await writeAccess(users, by);
      return res.status(200).json({ ok: true, views: out.users[user] ?? null, updatedAt: out.updatedAt, updatedBy: out.updatedBy });
    }

    return res.status(405).json({ error: 'Método no permitido' });
  } catch (e) {
    console.error('access:', e);
    return res.status(500).json({ error: 'server_error' });
  }
}

/**
 * Una sola función de servidor para varios endpoints chicos.
 *
 * El plan Hobby de Vercel permite hasta 12 funciones por deploy; con el
 * módulo de Contactos SFMC eran 13 y el build fallaba. Estos endpoints
 * siguen teniendo su URL de siempre (/api/me, /api/access, /api/logout,
 * /api/sfmc-contacts): vercel.json los reescribe hacia acá con ?fn=…, y el
 * middleware (que corre antes de la reescritura) sigue viendo la URL
 * original, así que los permisos por módulo no cambian.
 *
 * Los handlers viven en api/_h-*.js (con "_" Vercel no los cuenta como
 * funciones).
 */
import access from './_h-access.js';
import me from './_h-me.js';
import logout from './_h-logout.js';
import sfmcContacts from './_h-sfmc-contacts.js';

const ROUTES = { access, me, logout, 'sfmc-contacts': sfmcContacts };

export default async function handler(req, res) {
  let fn = req.query?.fn;
  if (!fn) {
    // Por si la plataforma no pasa el query de la reescritura: el último
    // segmento de la URL original.
    try { fn = new URL(req.url, 'http://x').pathname.split('/').filter(Boolean).pop(); } catch { fn = ''; }
  }
  const route = ROUTES[fn];
  if (!route) return res.status(404).json({ error: 'not_found' });
  return route(req, res);
}

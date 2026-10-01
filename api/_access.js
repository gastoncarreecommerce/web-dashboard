/**
 * Qué módulos ve cada usuario.
 *
 * Se configura desde el panel "Accesos" del propio dashboard (solo admins) y
 * se guarda en el mismo Redis que usa "Hoy en vivo". Quien no tiene nada
 * configurado ve todo: así sumar a alguien a DASHBOARD_USERS no lo deja con
 * la pantalla vacía hasta que un admin lo configure.
 *
 * Admins: env var DASHBOARD_ADMINS (usuarios separados por coma). Ven todo
 * siempre y son los únicos que pueden cambiar accesos.
 *
 * El mismo mapa de módulos → datos protegidos está copiado en middleware.js
 * (el edge no comparte módulos con las funciones): si se cambia acá, cambiarlo
 * allá también.
 */
import { getRedis } from './_live-cache.js';
import { normUser } from './_users.js';

export const ACCESS_KEY = 'webdash:access:v1';

export const MODULES = [
  { k: 'dashboard', label: 'Resumen', group: 'Cómo venimos' },
  { k: 'canales', label: 'App vs. Web', group: 'Cómo venimos' },
  { k: 'mensual', label: 'Resumen mensual', group: 'Cómo venimos' },
  { k: 'productos', label: 'Productos', group: 'Qué se vende' },
  { k: 'analytics', label: 'Analítica', group: 'Qué se vende' },
  { k: 'tiendas', label: 'Tiendas', group: 'Qué se vende' },
  { k: 'marketing', label: 'Marketing', group: 'Qué mueve la demanda' },
  { k: 'coupons', label: 'Cupones', group: 'Qué mueve la demanda' },
  { k: 'buscador', label: 'Buscador', group: 'Qué mueve la demanda' },
  { k: 'audiences', label: 'Audiencias', group: 'Qué mueve la demanda' },
  // optIn: maneja datos personales (DNI → mail). No entra en "Todo": solo lo
  // ven los admins y a quien se le tilde a mano en Accesos.
  { k: 'exportaciones', label: 'Exportaciones', group: 'Herramientas' },
  { k: 'contactos', label: 'Contactos SFMC', group: 'Herramientas', optIn: true },
];
export const MODULE_KEYS = MODULES.map((m) => m.k);
const DEFAULT_KEYS = MODULES.filter((m) => !m.optIn).map((m) => m.k);

// Si nadie configuró admins, el dueño del dashboard lo es por defecto.
export function admins() {
  const raw = process.env.DASHBOARD_ADMINS || 'gaston_ruiz';
  return new Set(raw.split(/[,\n]/).map(normUser).filter(Boolean));
}
export const isAdmin = (u) => admins().has(normUser(u));

export async function readAccess() {
  const redis = getRedis();
  if (!redis) return { users: {}, available: false };
  const raw = await redis.get(ACCESS_KEY);
  const cfg = !raw ? {} : typeof raw === 'string' ? JSON.parse(raw) : raw;
  return { users: cfg.users || {}, updatedAt: cfg.updatedAt || null, updatedBy: cfg.updatedBy || null, available: true };
}

export async function writeAccess(users, by) {
  const redis = getRedis();
  if (!redis) throw new Error('not_configured');
  const clean = {};
  for (const [u, views] of Object.entries(users || {})) {
    const user = normUser(u);
    if (!user || isAdmin(user)) continue;
    if (views === null) continue; // null = sin restricción (ve todo)
    clean[user] = [...new Set((Array.isArray(views) ? views : []).filter((v) => MODULE_KEYS.includes(v)))];
  }
  const cfg = { users: clean, updatedAt: new Date().toISOString(), updatedBy: by || '' };
  await redis.set(ACCESS_KEY, JSON.stringify(cfg));
  return cfg;
}

/** Módulos que ve un usuario: todos si es admin; sin configuración, todos menos los opcionales. */
export function viewsFor(username, cfg) {
  if (isAdmin(username)) return MODULE_KEYS.slice();
  const v = cfg?.users?.[normUser(username)];
  return Array.isArray(v) ? v.filter((x) => MODULE_KEYS.includes(x)) : DEFAULT_KEYS.slice();
}

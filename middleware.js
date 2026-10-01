/**
 * Vercel Edge Middleware — puerta de entrada de TODO el sitio.
 *
 * Por qué middleware y no un chequeo en el frontend: un login hecho en JS solo
 * esconde la UI. Los archivos de datos (docs/data/**) se siguen pudiendo bajar
 * escribiendo la URL directa. El middleware corre en el edge ANTES de servir
 * cualquier archivo estático, así que también protege los JSON — que es la
 * condición para poder guardar datos sensibles en el deploy.
 *
 * Env vars requeridas en Vercel:
 *   DASHBOARD_PASSWORD  contraseña compartida
 *   SESSION_SECRET      secreto para firmar el token de sesión (string largo y random)
 *   DASHBOARD_USERS     (opcional) usuarios permitidos, separados por coma, cada uno
 *                       "usuario" o "usuario=Nombre Apellido" (ver api/_users.js).
 *                       Si no está, cualquier usuario con la contraseña correcta entra.
 *                       Se chequea en CADA pedido: sacar a alguien de la lista le corta
 *                       el acceso al instante, sin esperar a que venza su sesión.
 *   DASHBOARD_ADMINS    (opcional) quiénes administran los accesos por módulo
 *                       (por defecto gaston_ruiz). Ver api/_access.js.
 */
export const config = {
  // Se excluyen solo los recursos que la propia pantalla de login necesita.
  matcher: ['/((?!api/login|api/logout|login.html|login.css|favicon.ico|favicon.svg|_next/static).*)'],
};

const COOKIE = 'webdash_session';

function toBytes(str) {
  return new TextEncoder().encode(str);
}

function hexOf(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret, payload) {
  const key = await crypto.subtle.importKey('raw', toBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hexOf(await crypto.subtle.sign('HMAC', key, toBytes(payload)));
}

/** Comparación en tiempo constante: evita filtrar la firma por diferencia de tiempos. */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Mismo parseo que api/_users.js (el edge no comparte módulo con las funciones). */
function allowedUsers() {
  const set = new Set();
  for (const entry of String(process.env.DASHBOARD_USERS || '').split(/[,\n]/)) {
    const u = entry.split('=')[0].trim().toLowerCase().replace(/@.*$/, '');
    if (u) set.add(u);
  }
  return set;
}

async function isValidToken(token, secret) {
  if (!token) return false;
  let decoded;
  try {
    decoded = atob(token.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return false;
  }
  const idx = decoded.lastIndexOf(':');
  if (idx < 0) return false;
  const payload = decoded.slice(0, idx);
  const sig = decoded.slice(idx + 1);

  const expiry = Number(payload.slice(payload.lastIndexOf(':') + 1));
  if (!Number.isFinite(expiry) || Date.now() > expiry) return false;

  if (!safeEqual(sig, await hmacHex(secret, payload))) return false;
  const user = payload.slice(0, payload.lastIndexOf(':'));
  const allowed = allowedUsers();
  return !allowed.size || allowed.has(user) ? user : false;
}

// ── Accesos por módulo ─────────────────────────────────────────────────────
// Los datos que usa UN solo módulo (o unos pocos) se niegan a quien no tiene
// ese módulo habilitado desde el panel de Accesos. Lo que comparte todo el
// dashboard (daily-summary, productos, geo, índice de pedidos) no se puede
// cortar sin romper el resto; esos módulos igual quedan fuera del menú.
// Espejo de api/_access.js: si se cambia allá, cambiarlo acá.
const PROTECTED = [
  [/^\/api\/campaigns/, ['audiences']],
  [/^\/data\/web\/audience-index\.json/, ['audiences', 'coupons']],
  [/^\/api\/audience-emails/, ['audiences', 'coupons', 'analytics', 'tiendas']],
  [/^\/data\/web\/cohorts\.json/, ['analytics']],
  [/^\/data\/web\/search-(diagnosis|insights)/, ['buscador']],
  [/^\/api\/(buscador-compara|competencia)/, ['buscador']],
  [/^\/comparador-de-precios\.html/, ['buscador']],
  [/^\/api\/sfmc-contacts/, ['contactos']],
];
// Módulos opcionales (datos personales): sin configuración NO se ven.
const OPT_IN = new Set(['contactos']);
function modulesFor(url) {
  // /api/tools agrupa varios endpoints (ver api/tools.js): se juzga por el
  // endpoint real, por si alguien la llama directo en vez de por su URL.
  if (url.pathname === '/api/tools') {
    const fn = url.searchParams.get('fn') || '';
    return modulesFor(new URL(`/api/${fn}`, url));
  }
  if (url.pathname === '/api/archive') {
    const p = url.searchParams.get('path') || '';
    if (p.startsWith('customer-activity')) return ['audiences'];
    if (p.startsWith('orders/')) return ['tiendas'];
    if (p.startsWith('order-items/')) return ['exportaciones'];
    return null;
  }
  for (const [re, mods] of PROTECTED) if (re.test(url.pathname)) return mods;
  return null;
}

function isAdminUser(u) {
  const raw = process.env.DASHBOARD_ADMINS || 'gaston_ruiz';
  return raw.split(/[,\n]/).map((x) => x.trim().toLowerCase().replace(/@.*$/, '')).includes(u);
}

// La config vive en Upstash; se cachea 30 s por instancia del edge para no
// pegarle en cada pedido. Si Redis no responde, se usa lo último conocido.
let accessCache = { at: 0, users: null };
async function accessUsers() {
  if (accessCache.users && Date.now() - accessCache.at < 30000) return accessCache.users;
  const base = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) return {};
  try {
    const r = await fetch(`${base.replace(/\/$/, '')}/get/webdash:access:v1`, { headers: { Authorization: `Bearer ${token}` } });
    const { result } = await r.json();
    const cfg = result ? (typeof result === 'string' ? JSON.parse(result) : result) : {};
    accessCache = { at: Date.now(), users: cfg.users || {} };
  } catch {
    if (!accessCache.users) return {};
  }
  return accessCache.users;
}

async function canAccess(user, url) {
  const need = modulesFor(url);
  if (!need || isAdminUser(user)) return true;
  const views = (await accessUsers())[user];
  if (!Array.isArray(views)) return need.some((m) => !OPT_IN.has(m)); // sin configurar = todo menos lo opcional
  return need.some((m) => views.includes(m));
}

export default async function middleware(request) {
  const secret = process.env.SESSION_SECRET;
  const password = process.env.DASHBOARD_PASSWORD;
  const url = new URL(request.url);

  // Sin auth configurada el sitio quedaría abierto de par en par: se bloquea
  // entero en vez de fallar hacia el lado inseguro.
  if (!secret || !password) {
    return new Response(
      'WebDash no tiene la autenticación configurada. Faltan las env vars DASHBOARD_PASSWORD y SESSION_SECRET en Vercel.',
      { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } }
    );
  }

  const cookie = request.headers.get('cookie') || '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  const user = await isValidToken(match?.[1], secret);
  if (user) {
    if (await canAccess(user, url)) return; // sesión válida y módulo habilitado: seguir
    // 403 y no 401: la sesión sigue valiendo, solo que esto no le corresponde.
    return new Response(JSON.stringify({ error: 'Este módulo no está habilitado para tu usuario.' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Las peticiones de datos reciben 401 (no un redirect a HTML, que rompería el fetch).
  if (url.pathname.startsWith('/data/') || url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'No autenticado' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const login = new URL('/login.html', request.url);
  login.searchParams.set('next', url.pathname + url.search);
  return Response.redirect(login, 302);
}

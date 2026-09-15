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
 *   DASHBOARD_USERS     (opcional) lista de usuarios permitidos separada por comas.
 *                       Si no está, cualquier usuario con la contraseña correcta entra.
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

  return safeEqual(sig, await hmacHex(secret, payload));
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
  if (await isValidToken(match?.[1], secret)) return; // sesión válida: seguir

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

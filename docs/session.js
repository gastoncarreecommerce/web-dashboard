/* global window, document, location */
/**
 * Sesión de 10 minutos sin uso.
 *
 * El servidor emite la cookie con 10 minutos de vida; acá se la renueva
 * mientras la persona usa el dashboard (mouse, teclado, scroll, toques), como
 * mucho una vez por minuto. Si deja la pestaña en segundo plano y vuelve más
 * tarde, se cierra la sesión ANTES de mostrar nada: una pestaña vieja
 * mezclaba números viejos con datos nuevos y parecía un error de los datos.
 *
 * También: cualquier 401 de /api o /data (sesión vencida o usuario sacado
 * de la lista) manda directo al login en vez de dejar la pantalla a medias.
 */
(function () {
  const W = (window.W = window.W || {});
  const IDLE_MS = 10 * 60 * 1000;
  const REFRESH_EVERY_MS = 60 * 1000;

  let enabled = false;       // solo con backend real (en local no hay /api/me)
  let lastActivity = Date.now();
  let lastRefresh = 0;
  let expiresAt = Date.now() + IDLE_MS;
  let leaving = false;

  function expire() {
    if (leaving) return;
    leaving = true;
    // Se borra la pantalla primero: que no quede a la vista nada viejo.
    document.documentElement.style.visibility = 'hidden';
    const next = location.pathname + location.search;
    const go = () => { location.href = `/login.html?expired=1&next=${encodeURIComponent(next)}`; };
    _fetch('/api/logout', { method: 'POST' }).then(go, go);
  }

  async function refresh() {
    lastRefresh = Date.now();
    try {
      const r = await _fetch('/api/me', { method: 'POST', cache: 'no-store' });
      if (r.status === 401) { expire(); return null; }
      if (!r.ok) return null;
      const me = await r.json();
      enabled = true;
      expiresAt = me.expiresAt || Date.now() + IDLE_MS;
      return me;
    } catch { return null; }
  }

  function check() {
    if (!enabled || leaving) return;
    const now = Date.now();
    if (now - lastActivity >= IDLE_MS || now >= expiresAt) expire();
  }

  function activity() {
    if (leaving) return;
    check();
    if (leaving) return;
    lastActivity = Date.now();
    if (enabled && lastActivity - lastRefresh >= REFRESH_EVERY_MS) refresh();
  }

  ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove', 'scroll'].forEach((ev) =>
    window.addEventListener(ev, activity, { passive: true, capture: true }));
  // Al volver a la pestaña se chequea ANTES de que el usuario mire los números.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
  window.addEventListener('focus', check);
  window.addEventListener('pageshow', check);
  setInterval(check, 15 * 1000);

  // Cualquier 401 de datos = la sesión ya no vale.
  const _fetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const res = await _fetch(input, init);
    if (res.status === 401) {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.origin === location.origin && /^\/(api|data)\//.test(url.pathname) && !/^\/api\/(login|logout)/.test(url.pathname)) expire();
    }
    return res;
  };

  /** Renueva ahora y devuelve { username, name } (o null sin backend). */
  W.session = { ready: refresh(), expire };
})();

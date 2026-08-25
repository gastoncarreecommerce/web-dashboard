'use strict';

const REQUIRED_ENV = ['VTEX_ACCOUNT_NAME', 'VTEX_APP_KEY', 'VTEX_APP_TOKEN'];

function getEnvOrThrow() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `Faltan variables de entorno de VTEX: ${missing.join(', ')}. ` +
        'Configuralas como GitHub Actions secrets (o en tu shell local) antes de correr el pipeline. ' +
        'Nunca deben quedar hardcodeadas en el código ni en config/*.json.'
    );
  }
  return {
    account: process.env.VTEX_ACCOUNT_NAME,
    environment: process.env.VTEX_ENVIRONMENT || 'vtexcommercestable',
    appKey: process.env.VTEX_APP_KEY,
    appToken: process.env.VTEX_APP_TOKEN,
  };
}

function baseUrl() {
  const { account, environment } = getEnvOrThrow();
  return `https://${account}.${environment}.com.br`;
}

function authHeaders() {
  const { appKey, appToken } = getEnvOrThrow();
  return {
    'X-VTEX-API-AppKey': appKey,
    'X-VTEX-API-AppToken': appToken,
    Accept: 'application/json',
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Reintenta con backoff exponencial. Necesario porque el pipeline pide los
 * detalles con alta concurrencia y VTEX responde 429 cuando se pasa de rosca;
 * un 429 no es un error definitivo, hay que esperar y reintentar.
 * Los errores de credenciales o de pedido inexistente no se reintentan.
 */
async function vtexFetch(path, { retries = 6, baseDelay = 800 } = {}) {
  const url = `${baseUrl()}${path}`;
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: authHeaders() });
      if (res.ok) return res.json();

      const body = await res.text().catch(() => '');
      const err = new Error(`VTEX API ${res.status} en ${path}: ${body.slice(0, 300)}`);
      err.status = res.status;
      if (res.status === 401 || res.status === 403 || res.status === 404) throw err;
      lastErr = err;
    } catch (e) {
      if (e.status === 401 || e.status === 403 || e.status === 404) throw e;
      lastErr = e;
    }
    if (attempt < retries) await sleep(baseDelay * Math.pow(2, attempt) + Math.random() * 250);
  }
  throw lastErr;
}

/**
 * Ejecuta `fn` sobre cada item con como máximo `limit` en vuelo a la vez.
 * Los resultados se entregan al callback apenas llegan, así no se acumulan
 * miles de pedidos completos en memoria.
 */
async function forEachLimit(items, limit, fn) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

/**
 * Pagina la Order API (search) entre dos fechas de creación.
 * Devuelve pedidos "resumidos" (lista); para detalle completo por pedido usar getOrder().
 */
async function listOrders({ fromISO, toISO, page = 1, perPage = 100 }) {
  const f = encodeURIComponent(`creationDate:[${fromISO} TO ${toISO}]`);
  const path = `/api/oms/pvt/orders?f_creationDate=${f}&page=${page}&per_page=${perPage}&orderBy=creationDate,desc`;
  return vtexFetch(path);
}

async function getOrder(orderId) {
  return vtexFetch(`/api/oms/pvt/orders/${orderId}`);
}

async function getCategoryTree(levels = 3) {
  return vtexFetch(`/api/catalog_system/pub/category/tree/${levels}`);
}

async function listSalesChannels() {
  return vtexFetch('/api/catalog_system/pub/saleschannel/list');
}

const MAX_PAGE = 30; // límite duro de la VTEX Order Search API (page * per_page <= 3000)

/**
 * Recorre todos los pedidos de una ventana [fromISO, toISO). La Order Search API
 * de VTEX no deja pasar de MAX_PAGE páginas por consulta (no importa qué tan angosto
 * sea el rango de fechas, si hay más pedidos que MAX_PAGE*perPage en esa ventana falla
 * con "Max page exceed"). Por eso, si una ventana tiene más resultados de los que entran,
 * se parte al medio recursivamente hasta que cada sub-ventana entre en el límite.
 */
async function* iterateAllOrders({ fromISO, toISO, perPage = 100 }) {
  const from = new Date(fromISO);
  const to = new Date(toISO);

  const first = await listOrders({ fromISO, toISO, page: 1, perPage });
  const total = first.paging?.total || 0;
  const totalPages = Math.ceil(total / perPage);

  if (totalPages <= MAX_PAGE) {
    for (const o of first.list || []) yield o;
    let page = 2;
    while (page <= totalPages) {
      const res = await listOrders({ fromISO, toISO, page, perPage });
      const list = res.list || [];
      if (list.length === 0) break;
      for (const o of list) yield o;
      page += 1;
    }
    return;
  }

  // Ventana con más pedidos de los que entran en MAX_PAGE páginas: partir al medio.
  const spanMs = to.getTime() - from.getTime();
  if (spanMs <= 1000) {
    // Ventana ya no se puede partir más (menos de 1 segundo) y sigue habiendo overflow:
    // aceptamos perder el excedente en vez de loopear infinito, mejor que romper el pipeline.
    for (const o of first.list || []) yield o;
    return;
  }
  const mid = new Date(from.getTime() + Math.floor(spanMs / 2));
  const midMinus1ms = new Date(mid.getTime() - 1);
  yield* iterateAllOrders({ fromISO: from.toISOString(), toISO: midMinus1ms.toISOString(), perPage });
  yield* iterateAllOrders({ fromISO: mid.toISOString(), toISO: to.toISOString(), perPage });
}

module.exports = {
  getEnvOrThrow,
  vtexFetch,
  listOrders,
  getOrder,
  getCategoryTree,
  listSalesChannels,
  iterateAllOrders,
  forEachLimit,
};

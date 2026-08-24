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

async function vtexFetch(path) {
  const url = `${baseUrl()}${path}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`VTEX API ${res.status} en ${path}: ${body.slice(0, 500)}`);
  }
  return res.json();
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

async function* iterateAllOrders({ fromISO, toISO, perPage = 100 }) {
  let page = 1;
  for (;;) {
    const res = await listOrders({ fromISO, toISO, page, perPage });
    const list = res.list || [];
    for (const o of list) yield o;
    const totalPages = Math.ceil((res.paging?.total || 0) / perPage);
    if (page >= totalPages || list.length === 0) break;
    page += 1;
  }
}

module.exports = {
  getEnvOrThrow,
  vtexFetch,
  listOrders,
  getOrder,
  getCategoryTree,
  iterateAllOrders,
};

/**
 * GET /api/today-live — pedidos y GMV de HOY, consultados directo a VTEX en
 * el momento (no desde docs/data/web, que se actualiza cada 30 min como
 * mucho). Objetivo puntual: que el número de "Hoy" en el Dashboard coincida
 * con lo que se ve en VTEX en el mismo instante, en vez de arrastrar el
 * delay de la actualización periódica.
 *
 * Por qué SOLO el total (no el desglose por segmento/categoría/cupón): eso
 * requeriría el DETALLE de cada pedido (una llamada a VTEX por pedido), que
 * con miles de pedidos a la tarde/noche puede tardar minutos — demasiado
 * para una consulta que tiene que responder mientras alguien mira la
 * pantalla. El LISTADO de pedidos (esta consulta) ya trae `status` y
 * `totalValue` sin pedir el detalle, así que es rápido sea la hora que sea.
 *
 * Importante: el listado de VTEX no distingue canal web/app (ese dato solo
 * viene en el detalle completo de cada pedido), así que este total incluye
 * TODOS los canales — a diferencia del resto del dashboard, que es
 * específicamente el canal web. En esta cuenta el canal app es una porción
 * chica del total, así que la diferencia debería ser marginal, pero no es
 * cero. Si esa distinción importa, avisar para revisarlo.
 *
 * Env vars en Vercel (ADEMÁS de VTEX_ACCOUNT_NAME, que ya hace falta para
 * las fotos de producto):
 *   VTEX_APP_KEY     credencial de la API de VTEX (ya existe como secret de
 *   VTEX_APP_TOKEN   GitHub Actions, pero Vercel tiene su propio storage —
 *                    hay que cargarlas también ahí)
 *   VTEX_ENVIRONMENT (opcional) default 'vtexcommercestable'
 */
import fs from 'fs';
import path from 'path';
import { verifySession } from './_session.js';

const MAX_PAGE = 30; // mismo límite duro de la VTEX Order Search API que usa el pipeline
const PER_PAGE = 100;

function baseUrl() {
  const account = process.env.VTEX_ACCOUNT_NAME;
  const environment = process.env.VTEX_ENVIRONMENT || 'vtexcommercestable';
  return `https://${account}.${environment}.com.br`;
}

function authHeaders() {
  return {
    'X-VTEX-API-AppKey': process.env.VTEX_APP_KEY,
    'X-VTEX-API-AppToken': process.env.VTEX_APP_TOKEN,
    Accept: 'application/json',
  };
}

async function listOrders(fromISO, toISO, page) {
  const f = encodeURIComponent(`creationDate:[${fromISO} TO ${toISO}]`);
  const url = `${baseUrl()}/api/oms/pvt/orders?f_creationDate=${f}&page=${page}&per_page=${PER_PAGE}&orderBy=creationDate,desc`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`VTEX API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function addPage(list, statusFilter, acc) {
  for (const o of list || []) {
    acc.scanned += 1;
    if (statusFilter.includeStatuses.includes(o.status)) {
      acc.orders += 1;
      acc.gmv += (Number(o.totalValue) || 0) / 100;
    }
  }
}

/**
 * Misma lógica que iterateAllOrders de src/vtex-client.js: si una ventana
 * tiene más resultados de los que entran en MAX_PAGE páginas, se parte al
 * medio recursivamente. Sin esto, un día de mucho volumen tira "Max page
 * exceed" en vez de responder.
 */
async function sumWindow(fromISO, toISO, statusFilter, acc) {
  const first = await listOrders(fromISO, toISO, 1);
  const total = first.paging?.total || 0;
  const totalPages = Math.ceil(total / PER_PAGE);

  if (totalPages > MAX_PAGE) {
    const from = new Date(fromISO);
    const to = new Date(toISO);
    const spanMs = to.getTime() - from.getTime();
    if (spanMs <= 1000) {
      addPage(first.list, statusFilter, acc); // ventana ya no partible: se acepta perder el excedente
      return;
    }
    const mid = new Date(from.getTime() + Math.floor(spanMs / 2));
    const midMinus1 = new Date(mid.getTime() - 1);
    await sumWindow(fromISO, midMinus1.toISOString(), statusFilter, acc);
    await sumWindow(mid.toISOString(), toISO, statusFilter, acc);
    return;
  }

  addPage(first.list, statusFilter, acc);
  for (let page = 2; page <= totalPages; page++) {
    const res = await listOrders(fromISO, toISO, page);
    addPage(res.list, statusFilter, acc);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });
  if (!verifySession(req)) return res.status(401).json({ error: 'No autenticado' });

  if (!process.env.VTEX_ACCOUNT_NAME || !process.env.VTEX_APP_KEY || !process.env.VTEX_APP_TOKEN) {
    return res.status(404).json({ error: 'not_configured' });
  }

  try {
    const statusFilter = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'config', 'status-filter.json'), 'utf8')
    );

    // Ventana AR (UTC-3, sin horario de verano) del día de hoy — misma cuenta
    // que arDayRange()/W.arToday() en el resto del proyecto.
    const todayAR = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const fromISO = new Date(`${todayAR}T03:00:00.000Z`).toISOString();
    const toISO = new Date(new Date(fromISO).getTime() + 24 * 60 * 60 * 1000).toISOString();

    const acc = { scanned: 0, orders: 0, gmv: 0 };
    await sumWindow(fromISO, toISO, statusFilter, acc);

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      date: todayAR,
      orders: acc.orders,
      gmv: Math.round(acc.gmv),
      scanned: acc.scanned,
      queriedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('today-live:', e);
    return res.status(502).json({ error: 'vtex_fetch_failed' });
  }
}

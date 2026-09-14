/**
 * GET /api/today-live — el día de HOY completo, en el mismo formato que una
 * entrada de daily-summary.json (`{segments, statusStats, discount,
 * activeCustomers, ...}`), para que el cliente lo empalme sobre el histórico
 * y TODAS las vistas (Dashboard, Analítica, Marketing, Cupones) queden en
 * vivo — no solo los 3 tiles de arriba — sin depender de que corra el
 * pipeline de 30 min ni de esperar ningún deploy.
 *
 * Cómo evita volver a pedirle todo a VTEX: el listado del día (barato, trae
 * status y monto pero NO canal/categoría/etc.) se revisa completo en cada
 * llamada — de ahí sale `statusStats`, sin costo extra. El detalle completo
 * de cada pedido (caro: es lo único que trae canal, ítems, categorías,
 * marketing, pago, cliente) solo se pide para pedidos que todavía no están
 * en el cache de Redis. Cada pedido ya clasificado se guarda en Redis como un
 * "delta" chico (su aporte a un segmento, no el pedido crudo completo) para
 * que reconstruir el día completo en cada poll de 15s sea liviano — sumar
 * unos miles de deltas chicos es instantáneo, releer miles de pedidos crudos
 * completos en cada poll no lo sería.
 *
 * La clasificación en sí (web/app, segmento, categorías, marketing, pago) NO
 * se reimplementa acá: se importa directo de src/fetch-day.js
 * (newDayAcc/applyOrderToAcc), la MISMA función que usa el pipeline por
 * lotes, para que este endpoint nunca pueda desviarse de cómo se cuenta un
 * pedido en el histórico committeado.
 *
 * Por las dudas un día muy activo tenga una montaña de pedidos nuevos de
 * golpe, se procesa como mucho MAX_NEW_PER_CALL por llamada — el resto queda
 * para la vuelta siguiente, 15s después.
 *
 * Env vars en Vercel: VTEX_ACCOUNT_NAME, VTEX_APP_KEY, VTEX_APP_TOKEN,
 * VTEX_ENVIRONMENT (opcional) — y el storage Redis (ver api/_live-cache.js).
 * Sin Redis configurado, este endpoint no funciona (404 not_configured) y el
 * dashboard sigue mostrando los datos committeados de siempre, sin vivo.
 */
import { createRequire } from 'module';
import { verifySession } from './_session.js';
import { getRedis, vtexBaseUrl, vtexHeaders, vtexGetOrder, todayAR, cacheKey } from './_live-cache.js';
import { newDayAcc, applyOrderToAcc } from '../src/fetch-day.js';

const require = createRequire(import.meta.url);
const SEGMENTS = require('../config/segment-map.json').tabs.list;

const MAX_PAGE = 30; // límite duro de la VTEX Order Search API
const PER_PAGE = 100;
const MAX_NEW_PER_CALL = 300;
const DETAIL_CONCURRENCY = 20;
const CACHE_TTL_SECONDS = 2 * 24 * 60 * 60; // 2 días: de sobra para "hoy", no se acumula para siempre

async function listOrders(fromISO, toISO, page) {
  const f = encodeURIComponent(`creationDate:[${fromISO} TO ${toISO}]`);
  const url = `${vtexBaseUrl()}/api/oms/pvt/orders?f_creationDate=${f}&page=${page}&per_page=${PER_PAGE}&orderBy=creationDate,desc`;
  const res = await fetch(url, { headers: vtexHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`VTEX API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/** Igual que iterateAllOrders de src/vtex-client.js: parte la ventana al
 * medio si hay más resultados de los que entran en MAX_PAGE páginas. Guarda
 * el resumen completo (no solo el id): status y totalValue vienen gratis acá
 * y son lo que arma `statusStats` sin pedir detalle de nadie. */
async function collectSummaries(fromISO, toISO, out) {
  const first = await listOrders(fromISO, toISO, 1);
  const total = first.paging?.total || 0;
  const totalPages = Math.ceil(total / PER_PAGE);

  if (totalPages > MAX_PAGE) {
    const from = new Date(fromISO);
    const to = new Date(toISO);
    const spanMs = to.getTime() - from.getTime();
    if (spanMs <= 1000) {
      for (const o of first.list || []) out.push(o);
      return;
    }
    const mid = new Date(from.getTime() + Math.floor(spanMs / 2));
    const midMinus1 = new Date(mid.getTime() - 1);
    await collectSummaries(fromISO, midMinus1.toISOString(), out);
    await collectSummaries(mid.toISOString(), toISO, out);
    return;
  }

  for (const o of first.list || []) out.push(o);
  for (let page = 2; page <= totalPages; page++) {
    const res = await listOrders(fromISO, toISO, page);
    for (const o of res.list || []) out.push(o);
  }
}

async function forEachLimit(items, limit, fn) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

function emptySeg() {
  return {
    orders: 0, gmv: 0, units: 0,
    marketing: {}, categories: {}, categoriesN1: {}, categoriesN2: {},
    coupons: {}, payments: {}, paymentBrands: {}, installments: {},
    hourly: new Array(24).fill(0),
  };
}

// Recorta lo que produce applyOrderToAcc a lo que hace falta guardar por
// pedido: sin customerCounts/productsById (no los usa esta vista, y guardar
// mil pedidos con eso adentro infla el cache sin necesidad).
function stripSeg(seg) {
  return {
    orders: seg.orders, gmv: seg.gmv, units: seg.units,
    marketing: seg.marketing, categories: seg.categories, categoriesN1: seg.categoriesN1, categoriesN2: seg.categoriesN2,
    coupons: seg.coupons, payments: seg.payments, paymentBrands: seg.paymentBrands, installments: seg.installments,
    hourly: seg.hourly,
  };
}

function mergeMapInto(target, source) {
  for (const [k, v] of Object.entries(source || {})) {
    const e = (target[k] = target[k] || { orders: 0, gmv: 0, units: 0 });
    e.orders += v.orders || 0;
    e.gmv += v.gmv || 0;
    e.units += v.units || 0;
  }
}

function mergeSegInto(target, source) {
  target.orders += source.orders || 0;
  target.gmv += source.gmv || 0;
  target.units += source.units || 0;
  for (const key of ['marketing', 'categories', 'categoriesN1', 'categoriesN2', 'coupons', 'payments', 'paymentBrands', 'installments']) {
    mergeMapInto(target[key], source[key]);
  }
  (source.hourly || []).forEach((n, h) => { target.hourly[h] += n; });
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });
  if (!verifySession(req)) return res.status(401).json({ error: 'No autenticado' });

  const redis = getRedis();
  if (!redis || !process.env.VTEX_ACCOUNT_NAME || !process.env.VTEX_APP_KEY || !process.env.VTEX_APP_TOKEN) {
    return res.status(404).json({ error: 'not_configured' });
  }

  try {
    const date = todayAR();
    const key = cacheKey(date);
    const fromISO = new Date(`${date}T03:00:00.000Z`).toISOString();
    const toISO = new Date(new Date(fromISO).getTime() + 24 * 60 * 60 * 1000).toISOString();

    const [known, summaries] = await Promise.all([
      redis.hgetall(key).then((v) => v || {}),
      (async () => { const out = []; await collectSummaries(fromISO, toISO, out); return out; })(),
    ]);

    const allIds = summaries.map((s) => s.orderId);
    // Del listado: cuenta y monto por estado, TODOS los pedidos de hoy (web y
    // app, cualquier status) — igual que hace el pipeline por lotes, sin
    // pedir detalle de nadie para esto.
    const statusStats = {};
    for (const s of summaries) {
      const st = s.status || 'sin_estado';
      const e = (statusStats[st] = statusStats[st] || { orders: 0, gmv: 0 });
      e.orders += 1;
      e.gmv += (Number(s.totalValue) || 0) / 100;
    }

    const newIds = allIds.filter((id) => !(id in known));
    const toFetch = newIds.slice(0, MAX_NEW_PER_CALL);

    if (toFetch.length) {
      const fresh = {};
      await forEachLimit(toFetch, DETAIL_CONCURRENCY, async (orderId) => {
        try {
          const full = await vtexGetOrder(orderId);
          const singleAcc = newDayAcc();
          const isWeb = applyOrderToAcc(singleAcc, full);
          let bucket = null;
          if (isWeb) {
            for (const s of SEGMENTS) {
              if (singleAcc.segments[s].orders > 0) { bucket = s; break; }
            }
          }
          fresh[orderId] = JSON.stringify({
            bucket,
            seg: bucket ? stripSeg(singleAcc.segments[bucket]) : null,
            discount: singleAcc.discountTotal || 0,
            hash: Object.keys(singleAcc.customers)[0] || null,
          });
        } catch {
          // Un pedido que falla queda afuera de este ciclo — al no quedar
          // cacheado, se reintenta solo en el próximo poll.
        }
      });
      if (Object.keys(fresh).length) {
        await redis.hset(key, fresh);
        await redis.expire(key, CACHE_TTL_SECONDS);
        Object.assign(known, fresh);
      }
    }

    // ── Reconstruir el día completo sumando los deltas cacheados ────────────
    const segments = Object.fromEntries(SEGMENTS.map((s) => [s, emptySeg()]));
    let discount = 0;
    const hashes = new Set();
    for (const raw of Object.values(known)) {
      let rec;
      try { rec = JSON.parse(raw); } catch { continue; }
      if (rec.bucket && rec.seg) mergeSegInto(segments[rec.bucket], rec.seg);
      discount += rec.discount || 0;
      if (rec.hash) hashes.add(rec.hash);
    }

    let orders = 0, gmv = 0;
    for (const s of SEGMENTS) { orders += segments[s].orders; gmv += segments[s].gmv; }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      date,
      orders,
      gmv: Math.round(gmv),
      segments,
      discount: Math.round(discount),
      // "Nuevos hoy" necesitaría cruzar contra todo el historial de clientes
      // (~16MB de audience-index.json) en cada poll de 15s — no vale la pena
      // acá. Queda en 0 y se corrige solo con la próxima corrida del pipeline
      // de 30 min, que sí lo calcula bien contra el histórico completo.
      newCustomers: 0,
      activeCustomers: hashes.size,
      statusStats,
      scanned: allIds.length,
      pending: newIds.length - toFetch.length, // > 0: todavía hay pedidos nuevos por clasificar, se completa en el próximo poll
      queriedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('today-live:', e);
    return res.status(502).json({ error: 'vtex_fetch_failed' });
  }
}

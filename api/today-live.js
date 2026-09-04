/**
 * GET /api/today-live — pedidos y GMV de HOY, canal WEB únicamente, SIN
 * filtrar por estado (cuenta todo lo que VTEX tenga creado hoy para ese
 * canal, pendientes y cancelados incluidos) — a propósito, para que
 * coincida con el total crudo que se ve en VTEX. Consultado casi en el
 * momento: pensado para que el frontend lo pida cada 15s mientras alguien
 * mira "Hoy" (mismo patrón que el otro dashboard de VTEX de la cuenta),
 * sin repetir el costo caro cada vez.
 *
 * Cómo evita volver a pedir todo: el listado de pedidos del día (barato,
 * trae status pero NO el canal) se revisa completo en cada llamada. El
 * canal (web vs. app) solo viene en el DETALLE de cada pedido — eso es lo
 * caro — así que se guarda en Redis apenas se pide una vez, y las próximas
 * llamadas del mismo día solo piden detalle de los pedidos que todavía no
 * están en el cache. En un día activo, después de la primera llamada (que
 * puede tardar según cuántos pedidos haya) las siguientes son casi
 * instantáneas: unos pocos pedidos nuevos cada 15s, no miles.
 *
 * Por las dudas un día muy activo tenga una montaña de pedidos nuevos de
 * golpe (primera consulta del día, a la tarde), se procesa como mucho
 * MAX_NEW_PER_CALL por llamada — el resto queda para la vuelta siguiente,
 * 15s después, en vez de arriesgar que la función tarde demasiado.
 *
 * Env vars en Vercel: VTEX_ACCOUNT_NAME, VTEX_APP_KEY, VTEX_APP_TOKEN,
 * VTEX_ENVIRONMENT (opcional) — y el storage Redis (ver api/_live-cache.js).
 * Sin Redis configurado, este endpoint no funciona (404 not_configured) y
 * el Dashboard sigue mostrando los datos guardados de siempre, sin "en vivo".
 */
import { verifySession } from './_session.js';
import {
  getRedis, getChannelMap, orderChannel, vtexBaseUrl, vtexHeaders, vtexGetOrder, todayAR, cacheKey,
} from './_live-cache.js';

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
 * medio si hay más resultados de los que entran en MAX_PAGE páginas. */
async function collectIds(fromISO, toISO, out) {
  const first = await listOrders(fromISO, toISO, 1);
  const total = first.paging?.total || 0;
  const totalPages = Math.ceil(total / PER_PAGE);

  if (totalPages > MAX_PAGE) {
    const from = new Date(fromISO);
    const to = new Date(toISO);
    const spanMs = to.getTime() - from.getTime();
    if (spanMs <= 1000) {
      for (const o of first.list || []) out.push(o.orderId);
      return;
    }
    const mid = new Date(from.getTime() + Math.floor(spanMs / 2));
    const midMinus1 = new Date(mid.getTime() - 1);
    await collectIds(fromISO, midMinus1.toISOString(), out);
    await collectIds(mid.toISOString(), toISO, out);
    return;
  }

  for (const o of first.list || []) out.push(o.orderId);
  for (let page = 2; page <= totalPages; page++) {
    const res = await listOrders(fromISO, toISO, page);
    for (const o of res.list || []) out.push(o.orderId);
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

    const [known, allIds] = await Promise.all([
      redis.hgetall(key).then((v) => v || {}),
      (async () => { const ids = []; await collectIds(fromISO, toISO, ids); return ids; })(),
    ]);

    const newIds = allIds.filter((id) => !(id in known));
    const toFetch = newIds.slice(0, MAX_NEW_PER_CALL);

    if (toFetch.length) {
      const channelMap = getChannelMap();
      const fresh = {};
      await forEachLimit(toFetch, DETAIL_CONCURRENCY, async (orderId) => {
        try {
          const order = await vtexGetOrder(orderId);
          fresh[orderId] = {
            channel: orderChannel(order, channelMap),
            // A propósito SIN filtrar por estado (pedido explícito del usuario,
            // 2026-09-04): tiene que coincidir con el total crudo que se ve en
            // VTEX, que tampoco filtra pendientes/cancelados. El resto del
            // dashboard (todo lo que no es "Hoy en vivo") sigue usando
            // config/status-filter.json para reportar solo ventas confirmadas
            // — son preguntas distintas ("cuántos pedidos hay hoy en VTEX" vs.
            // "cuántas ventas reales hubo"), y cada vista responde la suya.
            counts: true,
            gmv: typeof order.value === 'number' ? order.value / 100 : 0,
          };
        } catch {
          // Un pedido que falla queda afuera de este ciclo — al no quedar
          // marcado como conocido, se reintenta solo en el próximo poll.
        }
      });
      if (Object.keys(fresh).length) {
        await redis.hset(key, fresh);
        await redis.expire(key, CACHE_TTL_SECONDS);
        Object.assign(known, fresh);
      }
    }

    let orders = 0;
    let gmv = 0;
    for (const id of allIds) {
      const v = known[id];
      if (v?.channel === 'web' && v?.counts) {
        orders += 1;
        gmv += Number(v.gmv) || 0;
      }
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      date,
      orders,
      gmv: Math.round(gmv),
      scanned: allIds.length,
      pending: newIds.length - toFetch.length, // > 0: todavía hay pedidos nuevos por clasificar, se completa en el próximo poll
      queriedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('today-live:', e);
    return res.status(502).json({ error: 'vtex_fetch_failed' });
  }
}

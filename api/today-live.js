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
import { verifySession } from './_session.js';
import { getRedis, vtexBaseUrl, vtexHeaders, vtexGetOrder, todayAR, cacheKey } from './_live-cache.js';
// SEGMENTS viene de fetch-day.js, NO de un createRequire del JSON de config.
// Esa era la única función del proyecto que usaba createRequire, y era la
// única que devolvía 500: el bundler de Vercel rastrea los `require()` de un
// módulo CJS, pero un createRequire dentro de un módulo ESM no siempre, así
// que el JSON podía no quedar en el bundle y el módulo reventaba al
// inicializar — antes de que cualquier try/catch del handler pudiera correr,
// de ahí el 500 pelado en vez de un error entendible.
//
// Traerlo de fetch-day.js además garantiza que el vivo y el pipeline por
// lotes usen exactamente la misma lista de segmentos, igual que ya pasa con
// la clasificación.
import { newDayAcc, applyOrderToAcc, SEGMENTS } from '../src/fetch-day.js';

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

  // Antes esto devolvía un `not_configured` pelado si faltaba cualquiera de
  // las cinco variables, así que desde afuera era imposible saber cuál. Y sin
  // saberlo, "el vivo no anda" se vuelve adivinanza: el dashboard cae a los
  // datos committeados y nadie se entera de qué hay que configurar. Ahora
  // dice exactamente qué falta.
  //
  // Van los NOMBRES de las variables, nunca sus valores, y solo después de
  // verifySession: son los mismos nombres que están documentados en el README.
  // getRedis() no solo puede devolver null (sin configurar): el cliente de
  // Upstash TIRA si la URL está mal escrita (tiene que empezar con https).
  // Sin este try/catch eso salía como un 500 pelado, que es el peor caso
  // posible — parece un bug del endpoint cuando en realidad es un valor mal
  // pegado en Vercel.
  const faltan = [];
  let redis = null;
  try {
    redis = getRedis();
  } catch (e) {
    faltan.push(`Redis está configurado pero mal: ${e.message}`);
  }
  if (!redis && !faltan.length) {
    faltan.push('KV_REST_API_URL + KV_REST_API_TOKEN (o UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)');
  }
  for (const v of ['VTEX_ACCOUNT_NAME', 'VTEX_APP_KEY', 'VTEX_APP_TOKEN']) {
    if (!process.env[v]) faltan.push(v);
  }
  if (faltan.length) {
    return res.status(404).json({
      error: 'not_configured',
      faltan,
      ayuda: 'Estas env vars van en Vercel (Settings → Environment Variables). Sin ellas el dashboard usa los datos committeados (recent.json, cada 30 min) en vez del vivo de 15s.',
    });
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
    // OJO con el tipo que devuelve Redis: el cliente de Upstash trae
    // `automaticDeserialization` en true por defecto, así que un valor que se
    // guardó con JSON.stringify VUELVE YA PARSEADO, como objeto. Hacerle
    // JSON.parse a un objeto tira, y el `continue` de abajo se comía TODOS los
    // pedidos cacheados en silencio: el endpoint reportaba solo los ~300 que
    // acababa de traer de VTEX en esa misma llamada. Como el listado viene
    // ordenado por creationDate desc, esos eran los 300 más nuevos → el
    // dashboard mostraba ~180 pedidos cuando en realidad había 1.067, y el
    // número se movía apenas entre polls en vez de crecer.
    //
    // Se acepta cualquiera de las dos formas para no volver a depender de esa
    // opción del cliente.
    let descartados = 0;
    for (const raw of Object.values(known)) {
      let rec;
      try {
        rec = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        descartados += 1;
        continue;
      }
      if (!rec || typeof rec !== 'object') { descartados += 1; continue; }
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
      // > 0 significa que hay registros en el cache que no se pudieron leer:
      // el total estaría subestimado. Fue justo la falla que hizo que este
      // endpoint reportara 180 pedidos habiendo 1.067, sin dejar rastro.
      dropped: descartados,
      pending: newIds.length - toFetch.length, // > 0: todavía hay pedidos nuevos por clasificar, se completa en el próximo poll
      queriedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('today-live:', e);
    return res.status(502).json({ error: 'vtex_fetch_failed' });
  }
}

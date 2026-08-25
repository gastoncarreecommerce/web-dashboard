'use strict';

/**
 * Trae y clasifica TODOS los pedidos del canal web de un día calendario
 * argentino (UTC-3), y escribe docs/data/web/daily/YYYY-MM-DD.json con los
 * agregados de ese día. No pisa el archivo si ya existe, salvo --force (así el
 * backfill es resumible: si se corta a mitad de camino, retomar solo vuelve a
 * pedir los días faltantes).
 *
 * PII: el email del cliente NUNCA se escribe a este archivo (es público vía
 * GitHub Pages/Vercel). Se guarda solo el hash truncado de src/customer-key.js.
 * El mapeo hash -> email lo produce src/export-audience.js, que corre en un
 * workflow aparte y deja el resultado como artifact PRIVADO de GitHub Actions.
 *
 * Uso: node src/fetch-day.js 2026-08-24 [--force]
 */
const fs = require('fs');
const path = require('path');

const { iterateAllOrders, getOrder, forEachLimit } = require('./vtex-client');
const { orderChannel, isIncludedStatus, classifyOrder } = require('./classify');
const { customerHash } = require('./customer-key');

const channelMap = require('../config/channel-map.json');
const statusFilter = require('../config/status-filter.json');
const segmentMap = require('../config/segment-map.json');

const SEGMENTS = segmentMap.tabs.list;
const OUT_DIR = path.join(__dirname, '..', 'docs', 'data', 'web', 'daily');

// Un supermercado mueve decenas de miles de SKUs distintos por día; guardar todos
// haría que el repo crezca sin control. Se guarda el top por GMV, que es lo que
// alimenta el pareto de productos, más los totales para no perder el denominador.
const TOP_PRODUCTS_PER_DAY = Number(process.env.TOP_PRODUCTS_PER_DAY || 600);

// El detalle de cada pedido es una llamada aparte a VTEX y hay ~2000 por día:
// pedirlos de a uno tardaba ~25 min por día. Con este pool baja a ~1 min.
// AppDash usa 20 por rango con 3 rangos en paralelo (≈60); 30 acá está en el
// mismo orden. Si VTEX empieza a tirar 429 hay backoff en vtex-client.js, pero
// conviene bajar este número antes que vivir reintentando.
const DETAIL_CONCURRENCY = Number(process.env.DETAIL_CONCURRENCY || 30);

function arDayRange(dateStr) {
  // Medianoche AR (UTC-3) del día `dateStr` hasta medianoche AR del día siguiente.
  const from = new Date(`${dateStr}T03:00:00.000Z`);
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  return { fromISO: from.toISOString(), toISO: to.toISOString() };
}

function emptySegmentAgg() {
  return { orders: 0, gmv: 0, units: 0, customerCounts: {}, marketing: {} };
}

function marketingSource(order) {
  return order.marketingData?.utmSource || 'sin_atribucion';
}

/**
 * Departamento (categoría raíz) del item. VTEX manda `productCategoryIds` como
 * "/161/1610/" y `productCategories` como { "161": "Almacén", "1610": "Aceites" }.
 * Se toma el primer id del path = el departamento. Si el pedido no trae esos
 * campos (varía por versión de la API), cae a 'Sin categoría'.
 */
function itemDepartment(item) {
  const ids = String(item.productCategoryIds || '').split('/').filter(Boolean);
  const cats = item.productCategories || {};
  if (ids.length && cats[ids[0]]) return String(cats[ids[0]]);
  const arr = item.additionalInfo?.categories;
  if (Array.isArray(arr) && arr.length && arr[0]?.name) return String(arr[0].name);
  return 'Sin categoría';
}

function orderHourAR(order) {
  const d = new Date(order.creationDate);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() - 3 * 60 * 60 * 1000).getUTCHours();
}

function paymentGroups(order) {
  const out = new Set();
  for (const t of order.paymentData?.transactions || []) {
    for (const p of t.payments || []) {
      const label = p.group || p.paymentSystemName || 'otro';
      out.add(String(label));
    }
  }
  return out.size ? [...out] : ['sin_dato'];
}

function bump(map, key, orders, gmv, units) {
  const e = (map[key] = map[key] || { orders: 0, gmv: 0, units: 0 });
  e.orders += orders;
  e.gmv += gmv;
  e.units += units || 0;
}

/** Acumulador vacío de un día. Mismo shape que el archivo guardado, para que
 *  se pueda reconstruir desde el disco y seguir sumándole pedidos (ver repair.js). */
function newDayAcc() {
  return {
    segments: Object.fromEntries(SEGMENTS.map((s) => [s, emptySegmentAgg()])),
    hourly: new Array(24).fill(0),
    coupons: {},
    payments: {},
    categories: {},
    productsById: {},
    customers: {},
    webOrders: 0,
    webGmv: 0,
    discountTotal: 0,
    productRowsSeen: 0,
  };
}

/** Suma UN pedido completo al acumulador. Es todo lo que hay que hacer por pedido,
 *  así que sirve igual para el fetch inicial y para reparar los que fallaron. */
function applyOrderToAcc(acc, full) {
  if (orderChannel(full, channelMap) !== 'web') return false;

  const view = classifyOrder(full, segmentMap);
  const gmv = view.gmv;
  acc.webOrders += 1;
  acc.webGmv += gmv;

  const agg = acc.segments[view.bucket];
  agg.orders += 1;
  agg.gmv += gmv;

  let orderUnits = 0;
  for (const item of view.items) orderUnits += Number(item.quantity) || 0;
  agg.units += orderUnits;

  const src = marketingSource(full);
  const m = (agg.marketing[src] = agg.marketing[src] || { orders: 0, gmv: 0 });
  m.orders += 1;
  m.gmv += gmv;

  const hour = orderHourAR(full);
  if (hour != null) acc.hourly[hour] += 1;

  const coupon = full.marketingData?.coupon;
  if (coupon) {
    const c = (acc.coupons[coupon] = acc.coupons[coupon] || { orders: 0, gmv: 0, units: 0 });
    c.orders += 1;
    c.gmv += gmv;
  }

  // `discounts` en VTEX viene negativo (centavos); se guarda en positivo y en pesos.
  const disc = (full.totals || []).find((t) => t.id === 'Discounts');
  if (disc && typeof disc.value === 'number') acc.discountTotal += Math.abs(disc.value) / 100;

  for (const g of paymentGroups(full)) bump(acc.payments, g, 1, gmv, 0);

  // ── Productos y categorías (a nivel línea de ítem) ────────────────────────
  const orderCats = new Set();
  for (const item of view.items) {
    const qty = Number(item.quantity) || 0;
    const lineGmv = ((Number(item.sellingPrice) || 0) * qty) / 100;
    const dept = itemDepartment(item);
    orderCats.add(dept);
    bump(acc.categories, dept, 1, lineGmv, qty);

    const id = String(item.refId || item.id || item.name || 'sin_sku');
    const p = (acc.productsById[id] = acc.productsById[id] || {
      sku: id, name: item.name || id, dept, qty: 0, gmv: 0, orders: 0,
    });
    p.qty += qty;
    p.gmv += lineGmv;
    p.orders += 1;
    acc.productRowsSeen += 1;
  }

  // ── Perfil de cliente del día (hash, nunca email) ─────────────────────────
  const hash = customerHash(full);
  if (hash) {
    agg.customerCounts[hash] = (agg.customerCounts[hash] || 0) + 1;
    const c = (acc.customers[hash] = acc.customers[hash] || { o: 0, g: 0, s: {}, c: {} });
    c.o += 1;
    c.g += gmv;
    c.s[view.bucket] = (c.s[view.bucket] || 0) + 1;
    for (const dept of orderCats) c.c[dept] = (c.c[dept] || 0) + 1;
  }
  return true;
}

/** Reconstruye el acumulador desde un archivo diario ya guardado. */
function accFromDayFile(day) {
  const acc = newDayAcc();
  for (const s of SEGMENTS) {
    const src = day.segments?.[s];
    if (src) acc.segments[s] = { ...emptySegmentAgg(), ...src };
  }
  acc.hourly = (day.hourly || new Array(24).fill(0)).slice();
  acc.coupons = { ...(day.coupons || {}) };
  acc.payments = { ...(day.payments || {}) };
  acc.categories = { ...(day.categories || {}) };
  acc.customers = { ...(day.customers || {}) };
  acc.webOrders = day.webOrders || 0;
  acc.webGmv = day.webGmv || 0;
  acc.discountTotal = day.discountTotal || 0;
  acc.productRowsSeen = day.productRowsSeen || 0;
  for (const p of day.products || []) acc.productsById[p.sku] = { ...p };
  return acc;
}

function finalizeDay(acc, meta) {
  const allProducts = Object.values(acc.productsById).sort((a, b) => b.gmv - a.gmv);
  const products = allProducts.slice(0, TOP_PRODUCTS_PER_DAY).map((p) => ({
    sku: p.sku, name: p.name, dept: p.dept,
    qty: Math.round(p.qty), gmv: Math.round(p.gmv), orders: p.orders,
  }));

  return {
    date: meta.date,
    generatedAt: new Date().toISOString(),
    scanned: meta.scanned,
    webOrders: acc.webOrders,
    webGmv: Math.round(acc.webGmv),
    discountTotal: Math.round(acc.discountTotal),
    detailsRequested: meta.detailsRequested,
    detailsFailed: meta.failedOrderIds.length,
    // Se guardan los IDs, no solo el conteo: es lo que permite que src/repair.js
    // vuelva a buscar EXACTAMENTE los que fallaron en vez de rehacer todo el día.
    failedOrderIds: meta.failedOrderIds,
    unknownStatuses: meta.unknownStatuses,
    statusStats: meta.statusStats || {},
    segments: acc.segments,
    hourly: acc.hourly,
    coupons: acc.coupons,
    payments: acc.payments,
    categories: acc.categories,
    products,
    productsTruncated: allProducts.length > products.length,
    distinctSkus: allProducts.length,
    productRowsSeen: acc.productRowsSeen,
    customers: acc.customers,
  };
}

async function fetchDay(dateStr) {
  const { fromISO, toISO } = arDayRange(dateStr);
  const acc = newDayAcc();
  const unknownStatuses = new Set();
  let scanned = 0;

  // Paso 1: el listado (barato, ~20 llamadas para 2000 pedidos). Se filtra por
  // status acá, que sí viene en el resumen, para no pedir detalles de más.
  const idsToFetch = [];
  const statusStats = {};
  for await (const summary of iterateAllOrders({ fromISO, toISO })) {
    scanned += 1;
    // Cantidad Y monto por estado, tomados del LISTADO: el listado ya trae
    // status y totalValue, así que medir cancelaciones no cuesta ninguna
    // llamada extra (el detalle es lo caro y a estos no se les pide).
    const st = summary.status || 'sin_estado';
    const stat = (statusStats[st] = statusStats[st] || { orders: 0, gmv: 0 });
    stat.orders += 1;
    stat.gmv += (Number(summary.totalValue) || 0) / 100;
    if (!statusFilter.includeStatuses.includes(st) && !statusFilter.excludeStatuses.includes(st)) {
      unknownStatuses.add(st);
    }
    if (!isIncludedStatus(summary, statusFilter)) continue;
    idsToFetch.push(summary.orderId);
  }

  // Paso 2: los detalles, en paralelo. Es la parte cara (una llamada por pedido)
  // y la única forma de saber el canal, el seller y el cliente.
  const failedOrderIds = [];
  await forEachLimit(idsToFetch, DETAIL_CONCURRENCY, async (orderId) => {
    let full;
    try {
      full = await getOrder(orderId);
    } catch {
      failedOrderIds.push(orderId);
      return;
    }
    applyOrderToAcc(acc, full);
  });

  if (failedOrderIds.length) {
    console.warn(`  ⚠ ${failedOrderIds.length} pedidos no se pudieron traer; quedan anotados para reintentar.`);
  }

  return finalizeDay(acc, {
    date: dateStr,
    scanned,
    detailsRequested: idsToFetch.length,
    failedOrderIds,
    unknownStatuses: [...unknownStatuses],
    statusStats,
  });
}

async function main() {
  const dateArg = process.argv[2];
  const force = process.argv.includes('--force');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateArg || '')) {
    console.error('Uso: node src/fetch-day.js YYYY-MM-DD [--force]');
    process.exit(1);
  }

  const outPath = path.join(OUT_DIR, `${dateArg}.json`);
  if (fs.existsSync(outPath) && !force) {
    console.log(`Ya existe ${outPath}, salteando (usar --force para rehacerlo).`);
    return;
  }

  console.log(`Procesando ${dateArg}...`);
  const day = await fetchDay(dateArg);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(day));
  console.log(`OK ${dateArg}: escaneados=${day.scanned} web=${day.webOrders} skus=${day.distinctSkus}`);
  if (day.unknownStatuses.length) console.warn('Statuses desconocidos:', day.unknownStatuses);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('fetch-day falló:', err.message);
    process.exit(1);
  });
}

module.exports = {
  fetchDay,
  arDayRange,
  itemDepartment,
  newDayAcc,
  applyOrderToAcc,
  accFromDayFile,
  finalizeDay,
  OUT_DIR,
  DETAIL_CONCURRENCY,
};

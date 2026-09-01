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
const { customerHash, realEmail } = require('./customer-key');
const { provinceCode, orderStore } = require('./geo');

const channelMap = require('../config/channel-map.json');
const statusFilter = require('../config/status-filter.json');
const segmentMap = require('../config/segment-map.json');

const SEGMENTS = segmentMap.tabs.list;
// Los archivos diarios son insumo del pipeline, no los lee el dashboard. Viven
// fuera de docs/ para que Vercel no despliegue ~300MB de datos crudos en cada
// build (y para que los hashes de cliente no queden servidos públicamente).
const OUT_DIR = path.join(__dirname, '..', 'data', 'daily');
// Salida con PII: gitignorada, se publica solo al repositorio PRIVADO.
const PRIVATE_DIR = path.join(__dirname, '..', 'private-out', 'emails');

// Un supermercado mueve decenas de miles de SKUs distintos por día; guardar todos
// haría que el repo crezca sin control. Se guarda el top por GMV, que es lo que
// alimenta el pareto de productos, más los totales para no perder el denominador.
const TOP_PRODUCTS_PER_SEGMENT = Number(process.env.TOP_PRODUCTS_PER_SEGMENT || 250);

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

/**
 * Cada segmento lleva su propio catálogo (categorías, cupones, medios de pago,
 * productos, horario). Antes esos datos estaban solo a nivel día, así que la
 * Analítica no se podía filtrar por Food / Non Food / Marketplace / Quick.
 */
function emptySegmentAgg() {
  return {
    orders: 0, gmv: 0, units: 0,
    customerCounts: {}, marketing: {},
    categories: {}, categoriesN1: {}, categoriesN2: {},
    coupons: {}, payments: {}, paymentBrands: {}, installments: {}, productsById: {},
    hourly: new Array(24).fill(0),
  };
}

function marketingSource(order) {
  return order.marketingData?.utmSource || 'sin_atribucion';
}

const NO_CATEGORY = 'Sin categoría';

/**
 * N1 (departamento) / N2 (rubro) / N3 (detalle) de un item, de más general a
 * más específico.
 *
 * VTEX manda la ruta completa en additionalInfo.categoriesIds, RAÍZ primero
 * (ej. "/161/190/193/" = Almacén → Sal, aderezos y saborizadores → Hierbas
 * secas y especias), y additionalInfo.categories como [{id,name}, …] en el
 * orden CONTRARIO (más específico primero) — confirmado contra pedidos
 * reales en config/channel-map.report.json.
 *
 * Una versión anterior de esta función buscaba `item.productCategoryIds` y
 * `item.productCategories`, que son campos de la API de CATÁLOGO y nunca
 * vienen en el item de un pedido — así que siempre fallaba en silencio y
 * caía al respaldo (el primer elemento de additionalInfo.categories, que es
 * el nivel MÁS específico, no el departamento). Por eso "categoría
 * dominante" venía mostrando cosas como "Smart TV" en vez de "Electro".
 *
 * Cuando el árbol tiene menos de 3 niveles, el nivel que falta repite el más
 * profundo disponible en vez de quedar vacío (ej. un producto de solo 2
 * niveles tiene N2 y N3 iguales).
 */
function itemCategoryPath(item) {
  const ai = item.additionalInfo || {};
  const byId = new Map((ai.categories || []).map((c) => [String(c.id), c.name]).filter(([, n]) => n));

  const ids = String(ai.categoriesIds || '').split('/').filter(Boolean);
  let names = ids.map((id) => byId.get(id)).filter(Boolean);

  // Sin la ruta (pedidos de antes de trackear esto, o el campo no vino): el
  // array de categorías solo alcanza en orden inverso al de la ruta.
  if (!names.length && ai.categories?.length) {
    names = [...ai.categories].reverse().map((c) => c.name).filter(Boolean);
  }

  if (!names.length) return { n1: NO_CATEGORY, n2: NO_CATEGORY, n3: NO_CATEGORY };
  return { n1: names[0], n2: names[1] || names[0], n3: names[names.length - 1] };
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

/**
 * Detalle por pago: marca (paymentSystemName, ej. "Visa", "Mastercard") y
 * cuotas. `group` da "creditCard" para toda tarjeta de crédito por igual —
 * esto es lo que permite distinguir Visa de Mastercard y contado de 12
 * cuotas. Devuelve un item por pago (un pedido puede combinar más de uno).
 */
function paymentDetails(order) {
  const out = [];
  for (const t of order.paymentData?.transactions || []) {
    for (const p of t.payments || []) {
      const group = String(p.group || 'otro');
      const brand = String(p.paymentSystemName || p.group || 'Sin dato');
      const installments = Number(p.installments) || 1;
      out.push({ group, brand, installments });
    }
  }
  return out.length ? out : [{ group: 'sin_dato', brand: 'Sin dato', installments: 1 }];
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
    // Provincia y tienda se guardan a nivel día con el desglose por segmento
    // adentro: así el nombre de la tienda no se repite cuatro veces.
    provinces: {},
    stores: {},
    // Un registro liviano por pedido con tienda: es lo único que permite
    // listar "qué pedidos hizo esta tienda" en Analítica sin volver a leer
    // VTEX. No lleva email (eso es privado); el cruce hash->email se hace
    // en el navegador igual que en Audiencias.
    orders: [],
    customers: {},
    // hash -> email real. Se escribe a private-out/ (gitignored) y de ahí al
    // repositorio PRIVADO; nunca al archivo diario público.
    emails: {},
    webOrders: 0,
    webGmv: 0,
    discountTotal: 0,
    productRowsSeen: 0,
    // Todo orderId ya pasado por applyOrderToAcc (web o no — su canal no
    // cambia). Es lo que permite que una actualización en vivo posterior no
    // vuelva a pedirle el detalle a VTEX de un pedido que ya tiene sumado:
    // ver fetchDay({ incremental: true }).
    processedIds: new Set(),
  };
}

/** Suma UN pedido completo al acumulador. Es todo lo que hay que hacer por pedido,
 *  así que sirve igual para el fetch inicial y para reparar los que fallaron. */
function applyOrderToAcc(acc, full) {
  acc.processedIds.add(String(full.orderId));
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
  if (hour != null) agg.hourly[hour] += 1;

  // VTEX guarda TODOS los cupones de un pedido en un solo string separado por
  // comas ("LECHE5K,ENVIOGRATIS,SUPER26") — usarlo tal cual como clave hacía
  // que cada combinación distinta de cupones apareciera como un "cupón" propio
  // en vez de contar cada cupón individual. Un pedido con 3 cupones suma sus
  // $gmv/pedidos a los 3, no se prorratea: la pregunta que responde esta tabla
  // es "cuántos pedidos usaron el cupón X", no "a qué cupón se le atribuye el pedido".
  const couponRaw = full.marketingData?.coupon;
  const couponList = couponRaw ? couponRaw.split(',').map((c) => c.trim()).filter(Boolean) : [];
  for (const coupon of couponList) {
    const c = (agg.coupons[coupon] = agg.coupons[coupon] || { orders: 0, gmv: 0, units: 0 });
    c.orders += 1;
    c.gmv += gmv;
  }

  // `discounts` en VTEX viene negativo (centavos); se guarda en positivo y en pesos.
  const disc = (full.totals || []).find((t) => t.id === 'Discounts');
  if (disc && typeof disc.value === 'number') acc.discountTotal += Math.abs(disc.value) / 100;

  for (const g of paymentGroups(full)) bump(agg.payments, g, 1, gmv, 0);
  for (const pd of paymentDetails(full)) {
    bump(agg.paymentBrands, pd.brand, 1, gmv, 0);
    const instKey = pd.installments > 1 ? `${pd.installments} cuotas` : '1 pago';
    bump(agg.installments, instKey, 1, gmv, 0);
  }

  // ── Provincia y tienda ────────────────────────────────────────────────────
  const prov = provinceCode(full);
  if (prov) {
    const pe = (acc.provinces[prov] = acc.provinces[prov] || { seg: {} });
    const ps = (pe.seg[view.bucket] = pe.seg[view.bucket] || { orders: 0, gmv: 0 });
    ps.orders += 1;
    ps.gmv += gmv;
  }
  const store = orderStore(full);
  if (store) {
    const se = (acc.stores[store.code] = acc.stores[store.code] || { name: store.name, prov: prov || null, seg: {} });
    // Un mismo código puede aparecer con provincia nula en algún pedido; se
    // conserva la primera que sí vino para no perder la ubicación.
    if (!se.prov && prov) se.prov = prov;
    const ss = (se.seg[view.bucket] = se.seg[view.bucket] || { orders: 0, gmv: 0 });
    ss.orders += 1;
    ss.gmv += gmv;
  }

  // ── Productos y categorías (a nivel línea de ítem) ────────────────────────
  const orderCats = new Set(), orderCatsN1 = new Set(), orderCatsN2 = new Set();
  for (const item of view.items) {
    const qty = Number(item.quantity) || 0;
    const lineGmv = ((Number(item.sellingPrice) || 0) * qty) / 100;
    const { n1, n2, n3: dept } = itemCategoryPath(item);
    orderCats.add(dept);
    orderCatsN1.add(n1);
    orderCatsN2.add(n2);
    bump(agg.categories, dept, 1, lineGmv, qty);
    bump(agg.categoriesN1, n1, 1, lineGmv, qty);
    bump(agg.categoriesN2, n2, 1, lineGmv, qty);

    const id = String(item.refId || item.id || item.name || 'sin_sku');
    const p = (agg.productsById[id] = agg.productsById[id] || {
      sku: id, name: item.name || id, dept, qty: 0, gmv: 0, orders: 0,
    });
    p.qty += qty;
    p.gmv += lineGmv;
    p.orders += 1;
    acc.productRowsSeen += 1;
  }

  // ── Perfil de cliente del día ─────────────────────────────────────────────
  // El hash va al archivo público; el email va aparte (acc.emails) y termina
  // solo en el repositorio privado.
  const hash = customerHash(full);
  if (hash) {
    agg.customerCounts[hash] = (agg.customerCounts[hash] || 0) + 1;
    const c = (acc.customers[hash] = acc.customers[hash] || { o: 0, g: 0, s: {}, c: {}, c1: {}, c2: {}, cp: 0, pm: {} });
    // repair.js puede traer este cliente desde un día con schema viejo (sin
    // c1/c2 todavía) y sumarle acá un pedido reparado: no asumir que existen.
    c.c1 = c.c1 || {};
    c.c2 = c.c2 || {};
    c.o += 1;
    c.g += gmv;
    c.s[view.bucket] = (c.s[view.bucket] || 0) + 1;
    for (const dept of orderCats) c.c[dept] = (c.c[dept] || 0) + 1;
    for (const n1 of orderCatsN1) c.c1[n1] = (c.c1[n1] || 0) + 1;
    for (const n2 of orderCatsN2) c.c2[n2] = (c.c2[n2] || 0) + 1;
    // cp = pedidos con cupón. Es lo que permite separar "compra siempre con
    // descuento" de "compra a precio lleno" en el constructor de audiencias.
    if (couponList.length) c.cp += 1;
    for (const g of paymentGroups(full)) c.pm[g] = (c.pm[g] || 0) + 1;

    // El DNI se guarda junto al email, en la salida privada: la base de
    // mailing que pide el usuario es exactamente DNI + MAIL.
    const email = realEmail(full.clientProfileData?.email);
    const doc = String(full.clientProfileData?.document || '').trim();
    if (email || doc) acc.emails[hash] = { email: email || '', doc };
  }

  // ── Registro por pedido, solo si tiene tienda ────────────────────────────
  // Claves cortas a propósito: esto se repite por cada pedido de cada día del
  // historial, así que el ahorro por campo se nota multiplicado por cientos
  // de miles de filas.
  if (store) {
    acc.orders.push({
      id: full.orderId,
      t: full.creationDate,
      s: store.code,
      sg: view.bucket,
      h: hash || null,
      g: Math.round(gmv),
      st: full.status || null,
      // Solo si tiene cupón: la gran mayoría de los pedidos no lleva ninguno,
      // y omitir la clave en vez de guardar un array vacío ahorra bastante
      // en un archivo que se repite por cada pedido del historial.
      ...(couponList.length ? { cp: couponList } : {}),
      it: view.items.map((item) => ({
        n: item.name || 'sin_nombre',
        q: Number(item.quantity) || 0,
        g: Math.round(((Number(item.sellingPrice) || 0) * (Number(item.quantity) || 0)) / 100),
      })),
    });
  }
  return true;
}

/** Reconstruye el acumulador desde un archivo diario ya guardado. */
function accFromDayFile(day) {
  const acc = newDayAcc();
  for (const s of SEGMENTS) {
    const src = day.segments?.[s];
    if (!src) continue;
    const seg = acc.segments[s];
    Object.assign(seg, {
      orders: src.orders || 0, gmv: src.gmv || 0, units: src.units || 0,
      customerCounts: { ...(src.customerCounts || {}) },
      marketing: { ...(src.marketing || {}) },
      categories: { ...(src.categories || {}) },
      categoriesN1: { ...(src.categoriesN1 || {}) },
      categoriesN2: { ...(src.categoriesN2 || {}) },
      coupons: { ...(src.coupons || {}) },
      payments: { ...(src.payments || {}) },
      paymentBrands: { ...(src.paymentBrands || {}) },
      installments: { ...(src.installments || {}) },
      hourly: (src.hourly || new Array(24).fill(0)).slice(),
    });
    for (const p of src.products || []) seg.productsById[p.sku] = { ...p };
  }
  acc.provinces = JSON.parse(JSON.stringify(day.provinces || {}));
  acc.stores = JSON.parse(JSON.stringify(day.stores || {}));
  acc.orders = JSON.parse(JSON.stringify(day.orders || []));
  acc.customers = { ...(day.customers || {}) };
  // acc.emails queda vacío a propósito: el archivo público no los tiene. Al
  // reparar un día solo se recuperan los de los pedidos reprocesados.
  acc.webOrders = day.webOrders || 0;
  acc.webGmv = day.webGmv || 0;
  acc.discountTotal = day.discountTotal || 0;
  acc.productRowsSeen = day.productRowsSeen || 0;
  acc.processedIds = new Set(day.processedIds || []);
  return acc;
}

function finalizeDay(acc, meta) {
  // El top de productos se recorta POR SEGMENTO: si se recortara sobre el total,
  // Food (que es el 93% del volumen) se comería toda la lista y Marketplace
  // quedaría sin productos para mostrar.
  let distinctSkus = 0;
  const segments = {};
  for (const s of SEGMENTS) {
    const a = acc.segments[s];
    const all = Object.values(a.productsById).sort((x, y) => y.gmv - x.gmv);
    distinctSkus += all.length;
    segments[s] = {
      orders: a.orders, gmv: a.gmv, units: a.units,
      customerCounts: a.customerCounts,
      marketing: a.marketing,
      categories: a.categories,
      categoriesN1: a.categoriesN1,
      categoriesN2: a.categoriesN2,
      coupons: a.coupons,
      payments: a.payments,
      paymentBrands: a.paymentBrands,
      installments: a.installments,
      hourly: a.hourly,
      products: all.slice(0, TOP_PRODUCTS_PER_SEGMENT).map((p) => ({
        sku: p.sku, name: p.name, dept: p.dept,
        qty: Math.round(p.qty), gmv: Math.round(p.gmv), orders: p.orders,
      })),
      productsTruncated: all.length > TOP_PRODUCTS_PER_SEGMENT,
    };
  }

  const publicDay = {
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
    schema: 2, // v2 = catálogo por segmento + provincia + tienda
    segments,
    provinces: acc.provinces,
    stores: acc.stores,
    orders: acc.orders,
    distinctSkus,
    productRowsSeen: acc.productRowsSeen,
    customers: acc.customers,
    // Ver newDayAcc(): habilita que la próxima actualización en vivo de este
    // mismo día sea incremental en vez de re-pedirle el detalle a VTEX de
    // pedidos que ya están sumados acá.
    processedIds: [...acc.processedIds],
  };
  // Los emails viajan por fuera del objeto público (no enumerable para que un
  // JSON.stringify accidental del día nunca los arrastre).
  Object.defineProperty(publicDay, '_emails', { value: acc.emails || {}, enumerable: false });
  return publicDay;
}

/** Escribe hash,email,dni del día en private-out/ (gitignored). */
function writeDayEmails(dateStr, emails) {
  const n = Object.keys(emails || {}).length;
  if (!n) return 0;
  fs.mkdirSync(PRIVATE_DIR, { recursive: true });
  const q = (v) => (/[",\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : v);
  const lines = ['hash,email,dni'];
  for (const [h, v] of Object.entries(emails)) {
    const email = typeof v === 'string' ? v : v.email || '';
    const doc = typeof v === 'string' ? '' : v.doc || '';
    lines.push(`${h},${q(email)},${q(doc)}`);
  }
  fs.writeFileSync(path.join(PRIVATE_DIR, `${dateStr}.csv`), lines.join('\n') + '\n');
  return n;
}

/**
 * incremental: true reutiliza lo que ya está sumado en data/daily/<fecha>.json
 * (si existe y tiene processedIds — los días viejos no lo tienen, y ahí se cae
 * sola a un fetch completo, que es lo seguro) y solo le pide el detalle a VTEX
 * a los pedidos que todavía no están contados. El listado (paso 1, barato) se
 * recorre completo igual siempre: es lo que da el conteo real de "cuántos
 * pedidos hay hoy" y las estadísticas por estado, no tiene sentido cachearlo.
 *
 * Por qué no alcanza con mirar `acc.orders`: ese array solo lleva pedidos con
 * tienda resuelta (ver applyOrderToAcc), así que un pedido sin tienda ya
 * contado igual volvería a pedirse Y volvería a sumarse — duplicado. Por eso
 * el criterio de "ya lo tengo" es su propio set aparte (processedIds), no una
 * lista que se filtró por otra razón.
 */
async function fetchDay(dateStr, { incremental = false } = {}) {
  const { fromISO, toISO } = arDayRange(dateStr);

  let acc = null;
  let knownIds = new Set();
  if (incremental) {
    try {
      const existing = JSON.parse(fs.readFileSync(path.join(OUT_DIR, `${dateStr}.json`), 'utf8'));
      if (Array.isArray(existing.processedIds)) {
        acc = accFromDayFile(existing);
        knownIds = acc.processedIds;
      }
    } catch { /* no existe todavía: primera pasada del día, fetch completo */ }
  }
  if (!acc) acc = newDayAcc();

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
    if (knownIds.has(String(summary.orderId))) continue; // ya sumado en una pasada anterior de hoy
    idsToFetch.push(summary.orderId);
  }

  // Paso 2: los detalles, en paralelo. Es la parte cara (una llamada por pedido,
  // y la única forma de saber el canal, el seller y el cliente) — por eso vale
  // la pena saltear acá los que el paso incremental ya identificó como sabidos.
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
  const incremental = process.argv.includes('--incremental');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateArg || '')) {
    console.error('Uso: node src/fetch-day.js YYYY-MM-DD [--force | --incremental]');
    process.exit(1);
  }

  const outPath = path.join(OUT_DIR, `${dateArg}.json`);
  if (fs.existsSync(outPath) && !force && !incremental) {
    console.log(`Ya existe ${outPath}, salteando (usar --force o --incremental para actualizarlo).`);
    return;
  }

  console.log(`Procesando ${dateArg}${incremental ? ' (incremental)' : ''}...`);
  const day = await fetchDay(dateArg, { incremental });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(day));
  const nEmails = writeDayEmails(dateArg, day._emails);
  console.log(`OK ${dateArg}: escaneados=${day.scanned} web=${day.webOrders} skus=${day.distinctSkus} emails=${nEmails}`);
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
  itemCategoryPath,
  newDayAcc,
  applyOrderToAcc,
  accFromDayFile,
  finalizeDay,
  OUT_DIR,
  PRIVATE_DIR,
  DETAIL_CONCURRENCY,
  writeDayEmails,
};

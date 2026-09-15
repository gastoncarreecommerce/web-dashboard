'use strict';

/**
 * Lee todos los data/daily/YYYY-MM-DD.json desde
 * config/pipeline-config.json > detailWindowStartDate y produce los datasets
 * públicos que consume el dashboard:
 *
 *   docs/data/web/daily-summary.json  serie diaria por segmento + horario + descuentos
 *   docs/data/web/catalog.json        productos, categorías, cupones, medios de pago
 *   docs/data/web/cohorts.json        retención por cohorte mensual + nuevos vs recurrentes
 *   docs/data/web/audience-index.json perfiles de cliente HASHEADOS (constructor de audiencias)
 *   docs/data/web/<segmento>/metrics.json  métricas históricas por pestaña
 *   docs/data/web/_meta/run-info.json      salud del pipeline
 *
 * PII: ningún archivo de acá lleva emails. audience-index.json usa el hash
 * truncado de src/customer-key.js. El cruce hash -> email vive fuera del sitio
 * público (ver src/export-audience.js).
 */
const fs = require('fs');
const path = require('path');

const { computeAllMetricsFromAggregate } = require('./metrics');
const segmentMap = require('../config/segment-map.json');
const { PROVINCES } = require('./geo');
const pipelineConfig = require('../config/pipeline-config.json');

const SEGMENTS = segmentMap.tabs.list;
const REPO_ROOT = path.join(__dirname, '..');

/**
 * Las tres raíces del pipeline, separadas porque cada una vive en un lugar
 * distinto desde que los datos pesados salieron del deploy:
 *
 *   DAILY_DIR     los volcados crudos de VTEX (1,6 GB). Insumo del pipeline,
 *                 el browser no los toca nunca. Viven en la rama `data-raw`.
 *   OUT_ROOT      los agregados que el dashboard necesita al abrir la página
 *                 (~40 MB). Van en la rama que deploya Vercel.
 *   ARCHIVE_ROOT  orders/ y order-index/ (1,1 GB). Solo se leen a demanda vía
 *                 /api/archive, así que también viven en `data-raw`.
 *
 * Por defecto las tres apuntan al repo local, así correr `node
 * src/aggregate.js` a mano sigue funcionando igual que siempre. El workflow
 * las apunta a los dos checkouts distintos que usa.
 */
const DAILY_DIR = process.env.WEBDASH_DAILY_DIR || path.join(REPO_ROOT, 'data', 'daily');
const OUT_ROOT = process.env.WEBDASH_OUT_ROOT || REPO_ROOT;
const ARCHIVE_ROOT = process.env.WEBDASH_ARCHIVE_ROOT || REPO_ROOT;

const TOP_PRODUCTS = Number(process.env.CATALOG_TOP_PRODUCTS || 400);
const TOP_CATEGORIES = Number(process.env.CATALOG_TOP_CATEGORIES || 60);
const TOP_PRODUCTS_PER_SEG_MONTH = Number(process.env.TOP_PRODUCTS_PER_SEG_MONTH || 150);

function emptyAgg() {
  return {
    gmv: 0,
    orders: 0,
    customerCounts: new Map(),
    segmentParticipation: {},
    monthToDate: { gmv: 0, orders: 0 },
  };
}

function mergeDayIntoAgg(agg, daySegment, isCurrentMonth) {
  agg.gmv += daySegment.gmv;
  agg.orders += daySegment.orders;
  if (isCurrentMonth) {
    agg.monthToDate.gmv += daySegment.gmv;
    agg.monthToDate.orders += daySegment.orders;
  }
  for (const [hash, count] of Object.entries(daySegment.customerCounts || {})) {
    agg.customerCounts.set(hash, (agg.customerCounts.get(hash) || 0) + count);
  }
  for (const [seg, v] of Object.entries(daySegment.marketing || daySegment.segmentParticipation || {})) {
    agg.segmentParticipation[seg] = agg.segmentParticipation[seg] || { orders: 0, gmv: 0 };
    agg.segmentParticipation[seg].orders += v.orders;
    agg.segmentParticipation[seg].gmv += v.gmv;
  }
}

function listAvailableDays(startDate) {
  if (!fs.existsSync(DAILY_DIR)) return [];
  return fs
    .readdirSync(DAILY_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, 10))
    .filter((d) => d >= startDate)
    .sort();
}

/**
 * No escribe si el contenido es byte-a-byte igual al que ya está en disco.
 * aggregate.js recalcula TODO desde data/daily/ en cada corrida, así que sin
 * esto cada uno de los ~1300 archivos de docs/data/web quedaría con una
 * fecha de modificación nueva aunque su contenido no haya cambiado — git lo
 * vería como "sin cambios" igual (compara contenido, no mtime), pero evitar
 * la escritura innecesaria es gratis y deja el disco/los diffs más claros.
 */
function writeJson(relPath, data, root = OUT_ROOT) {
  const outPath = path.join(root, relPath);
  const json = JSON.stringify(data);
  if (fs.existsSync(outPath) && fs.readFileSync(outPath, 'utf8') === json) {
    return fs.statSync(outPath).size;
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, json);
  return Buffer.byteLength(json);
}

function addInto(target, key, v) {
  const e = (target[key] = target[key] || { orders: 0, gmv: 0, units: 0 });
  e.orders += v.orders || 0;
  e.gmv += v.gmv || 0;
  e.units += v.units || 0;
}

function topEntries(obj, n, mapFn) {
  return Object.entries(obj)
    .sort((a, b) => b[1].gmv - a[1].gmv)
    .slice(0, n)
    .map(mapFn);
}

function monthOf(dateStr) {
  return dateStr.slice(0, 7);
}

function main() {
  const startDate = pipelineConfig.detailWindowStartDate;
  const days = listAvailableDays(startDate);

  // Salvaguarda: si los archivos diarios desaparecieron (un rm de más, un
  // checkout incompleto, un artifact que no bajó) NO se pisan las métricas
  // buenas con ceros. Ya pasó una vez y dejó producción en blanco.
  const prevPath = path.join(OUT_ROOT, 'docs', 'data', 'web', '_meta', 'run-info.json');
  if (!days.length && fs.existsSync(prevPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(prevPath, 'utf8'));
      if (prev.daysAggregated > 0 && !process.env.ALLOW_EMPTY_AGGREGATE) {
        console.error(`✗ No hay archivos diarios, pero las métricas actuales tienen ${prev.daysAggregated} días.`);
        console.error('  Se aborta para no dejar el dashboard en cero. Revisá data/daily/.');
        console.error('  Si el vaciado es intencional, correr con ALLOW_EMPTY_AGGREGATE=1.');
        process.exit(1);
      }
    } catch { /* run-info ilegible: se sigue */ }
  }
  const now = new Date();
  const currentMonthPrefix = now.toISOString().slice(0, 7);

  const aggs = Object.fromEntries(SEGMENTS.map((s) => [s, emptyAgg()]));
  const missingDays = [];
  let scannedTotal = 0;
  const unknownStatuses = new Set();
  const statusTotals = {};

  const lastAvailable = days[days.length - 1];
  if (lastAvailable) {
    let d = new Date(`${startDate}T00:00:00Z`);
    const end = new Date(`${lastAvailable}T00:00:00Z`);
    const available = new Set(days);
    while (d <= end) {
      const ds = d.toISOString().slice(0, 10);
      if (!available.has(ds)) missingDays.push(ds);
      d = new Date(d.getTime() + 86400000);
    }
  }

  // ── Acumuladores de catálogo / cohortes / audiencias ────────────────────
  const catalogProducts = {};
  const catalogCategories = {};
  const catalogCategoriesN1 = {};
  const catalogCategoriesN2 = {};
  const catalogCoupons = {};
  const catalogPayments = {};
  const catalogPaymentBrands = {};
  const catalogInstallments = {};
  const hourlyTotal = new Array(24).fill(0);
  const dowTotals = new Array(7).fill(null).map(() => ({ orders: 0, gmv: 0, days: 0 }));

  /** hash -> perfil acumulado (solo en memoria del pipeline) */
  const profiles = new Map();
  /** cohorte (mes de primera compra) -> Set de meses activos por cliente */
  const cohortFirstMonth = new Map();
  const cohortActivity = new Map(); // `${cohortMonth}|${activeMonth}` -> Set(hash)

  const dailySeries = [];
  // Geografía: serie diaria compacta ([pedidos, gmv] por segmento) más un
  // diccionario aparte con nombre y provincia de cada tienda, para no repetir
  // esos textos 236 veces.
  const geoDays = [];
  const storeMeta = {};
  // Pedidos por tienda: se guardan por tienda y por mes (no por día, y no
  // todos juntos) para que "ver los pedidos de esta tienda" en Analítica
  // baje solo un archivo chico en vez de los pedidos de las 180 tiendas.
  const ordersByStoreMonth = {};
  const orderIndexByMonth = {};
  // Productos: por segmento y por mes. Por día sería enorme (250 skus × 4
  // segmentos × 236 días) y a nivel mes alcanza para analizar surtido.
  const productsBySegMonth = {};

  for (const date of days) {
    const day = JSON.parse(fs.readFileSync(path.join(DAILY_DIR, `${date}.json`), 'utf8'));
    scannedTotal += day.scanned || 0;
    for (const s of day.unknownStatuses || []) unknownStatuses.add(s);
    for (const [st, v] of Object.entries(day.statusStats || {})) {
      const e = (statusTotals[st] = statusTotals[st] || { orders: 0, gmv: 0 });
      e.orders += v.orders || 0;
      e.gmv += v.gmv || 0;
    }
    const isCurrentMonth = date.slice(0, 7) === currentMonthPrefix;

    const month = monthOf(date);
    const daySegments = {};
    for (const seg of SEGMENTS) {
      const daySeg = day.segments[seg] || { gmv: 0, orders: 0, units: 0, customerCounts: {}, marketing: {} };
      mergeDayIntoAgg(aggs[seg], daySeg, isCurrentMonth);
      daySegments[seg] = {
        gmv: daySeg.gmv,
        orders: daySeg.orders,
        units: daySeg.units || 0,
        marketing: daySeg.marketing || daySeg.segmentParticipation || {},
        // Catálogo por segmento (schema 2). En los días viejos no está y queda
        // vacío: la UI lo detecta y avisa en vez de mostrar cero.
        categories: daySeg.categories || {},
        categoriesN1: daySeg.categoriesN1 || {},
        categoriesN2: daySeg.categoriesN2 || {},
        coupons: daySeg.coupons || {},
        payments: daySeg.payments || {},
        paymentBrands: daySeg.paymentBrands || {},
        installments: daySeg.installments || {},
        hourly: daySeg.hourly || null,
      };

      const bucket = (productsBySegMonth[seg] = productsBySegMonth[seg] || {});
      const mk = (bucket[month] = bucket[month] || {});
      for (const p of daySeg.products || []) {
        const e = (mk[p.sku] = mk[p.sku] || { sku: p.sku, name: p.name, dept: p.dept, qty: 0, gmv: 0, orders: 0 });
        e.qty += p.qty; e.gmv += p.gmv; e.orders += p.orders;
      }
    }

    // Geografía del día, en formato compacto [pedidos, gmv].
    const gp = {}, gs = {};
    for (const [code, v] of Object.entries(day.provinces || {})) {
      const row = {};
      for (const [seg, x] of Object.entries(v.seg || {})) row[seg] = [x.orders, Math.round(x.gmv)];
      if (Object.keys(row).length) gp[code] = row;
    }
    for (const [code, v] of Object.entries(day.stores || {})) {
      if (!storeMeta[code]) storeMeta[code] = { name: v.name || code, prov: v.prov || null };
      else if (!storeMeta[code].prov && v.prov) storeMeta[code].prov = v.prov;
      const row = {};
      for (const [seg, x] of Object.entries(v.seg || {})) row[seg] = [x.orders, Math.round(x.gmv)];
      if (Object.keys(row).length) gs[code] = row;
    }
    if (Object.keys(gp).length || Object.keys(gs).length) geoDays.push({ date, prov: gp, stores: gs });

    // Pedidos por tienda (schema 2 con orders[]; días de antes no lo traen).
    // De paso arma qué tienda(s) visitó cada cliente hoy — se usa más abajo
    // para "compró en la tienda X" en el constructor de audiencias. Solo
    // cubre pedidos con tienda resuelta (mismo alcance que el resto de esta
    // sección), así que es una cobertura parcial, no el 100% del historial.
    const dayStoresByHash = {};
    for (const o of day.orders || []) {
      const bucket = (ordersByStoreMonth[o.s] = ordersByStoreMonth[o.s] || {});
      (bucket[month] = bucket[month] || []).push(o);
      // Índice liviano de TODOS los pedidos (sin items) por mes: lo usan el
      // detalle de "qué pedidos usaron este cupón" en Cupones y las pestañas
      // por estado del XLSX de Estados de pedido. o.st/o.cp solo existen en
      // pedidos procesados después de agregarlos acá — días previos quedan
      // sin esos campos (undefined), no reprocesables sin volver a pedirle a VTEX.
      (orderIndexByMonth[month] = orderIndexByMonth[month] || []).push({
        id: o.id, t: o.t, s: o.s, sg: o.sg, h: o.h, g: o.g, st: o.st || null, cp: o.cp || undefined,
      });
      if (o.h) (dayStoresByHash[o.h] = dayStoresByHash[o.h] || new Set()).add(o.s);
    }

    // Totales de catálogo: en schema 2 vienen dentro de cada segmento; en los
    // días viejos venían a nivel día. Se soportan los dos para poder convivir
    // durante la transición.
    const catSources = day.schema >= 2
      ? SEGMENTS.map((seg) => day.segments[seg]).filter(Boolean)
      : [day];
    for (const src of catSources) {
      for (const p of src.products || []) {
        const e = (catalogProducts[p.sku] = catalogProducts[p.sku] || {
          sku: p.sku, name: p.name, dept: p.dept, qty: 0, gmv: 0, orders: 0,
        });
        e.qty += p.qty; e.gmv += p.gmv; e.orders += p.orders;
      }
      for (const [k, v] of Object.entries(src.categories || {})) addInto(catalogCategories, k, v);
      for (const [k, v] of Object.entries(src.categoriesN1 || {})) addInto(catalogCategoriesN1, k, v);
      for (const [k, v] of Object.entries(src.categoriesN2 || {})) addInto(catalogCategoriesN2, k, v);
      for (const [k, v] of Object.entries(src.coupons || {})) addInto(catalogCoupons, k, v);
      for (const [k, v] of Object.entries(src.payments || {})) addInto(catalogPayments, k, v);
      for (const [k, v] of Object.entries(src.paymentBrands || {})) addInto(catalogPaymentBrands, k, v);
      for (const [k, v] of Object.entries(src.installments || {})) addInto(catalogInstallments, k, v);
      (src.hourly || []).forEach((n, h) => (hourlyTotal[h] += n));
    }

    const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
    const dayOrders = SEGMENTS.reduce((s, seg) => s + (daySegments[seg]?.orders || 0), 0);
    const dayGmv = SEGMENTS.reduce((s, seg) => s + (daySegments[seg]?.gmv || 0), 0);
    dowTotals[dow].orders += dayOrders;
    dowTotals[dow].gmv += dayGmv;
    dowTotals[dow].days += 1;

    // ── Perfiles + cohortes ───────────────────────────────────────────────
    let newCustomers = 0;
    for (const [hash, c] of Object.entries(day.customers || {})) {
      let p = profiles.get(hash);
      if (!p) {
        p = { o: 0, g: 0, first: date, last: date, segs: {}, cats: {}, catsN1: {}, catsN2: {}, cp: 0, pms: {}, stores: {}, days: [] };
        profiles.set(hash, p);
        cohortFirstMonth.set(hash, month);
        newCustomers += 1;
      }
      p.o += c.o;
      p.g += c.g;
      p.last = date;
      p.cp += c.cp || 0;
      for (const [s, n] of Object.entries(c.s || {})) p.segs[s] = (p.segs[s] || 0) + n;
      for (const [cat, n] of Object.entries(c.c || {})) p.cats[cat] = (p.cats[cat] || 0) + n;
      for (const [cat, n] of Object.entries(c.c1 || {})) p.catsN1[cat] = (p.catsN1[cat] || 0) + n;
      for (const [cat, n] of Object.entries(c.c2 || {})) p.catsN2[cat] = (p.catsN2[cat] || 0) + n;
      for (const [pm, n] of Object.entries(c.pm || {})) p.pms[pm] = (p.pms[pm] || 0) + n;
      for (const store of dayStoresByHash[hash] || []) p.stores[store] = (p.stores[store] || 0) + 1;

      const cm = cohortFirstMonth.get(hash);
      const key = `${cm}|${month}`;
      if (!cohortActivity.has(key)) cohortActivity.set(key, new Set());
      cohortActivity.get(key).add(hash);
    }

    // El horario por hora vive a nivel DÍA en schema 1 (day.hourly) y a nivel
    // SEGMENTO en schema 2 (day.segments[s].hourly) — sin este fallback,
    // daily-summary.json quedaba con hourly:null para todos los días schema 2
    // (todo el historial reciente) y el heatmap de "Cuándo compran" del
    // Dashboard no tenía con qué dibujarse, aunque el dato SÍ estaba guardado.
    let dayHourly = day.hourly || null;
    if (!dayHourly) {
      const summed = new Array(24).fill(0);
      let any = false;
      for (const seg of SEGMENTS) {
        const h = daySegments[seg]?.hourly;
        if (!h) continue;
        any = true;
        h.forEach((n, i) => (summed[i] += n));
      }
      dayHourly = any ? summed : null;
    }

    dailySeries.push({
      date,
      segments: daySegments,
      hourly: dayHourly,
      discount: day.discountTotal || 0,
      newCustomers,
      activeCustomers: Object.keys(day.customers || {}).length,
      statusStats: day.statusStats || {},
    });
  }

  // ── daily-summary.json ──────────────────────────────────────────────────
  const sizeDaily = writeJson('docs/data/web/daily-summary.json', {
    generatedAt: now.toISOString(),
    detailWindowStartDate: startDate,
    days: dailySeries,
  });

  // ── recent.json (la cola de la serie, para el refresco de cada 30 min) ──
  // Mismo formato que las entradas de daily-summary.json, pero SOLO los
  // últimos días. Existe porque daily-summary pesa 20 MB y audience-index 18
  // MB, y los dos se reescriben enteros en cuanto cambia un número de hoy:
  // commitearlos cada 30 min era lo que hacía crecer el repo ~500 MB por día
  // y lo que volvía lentos los deploys (Vercel clona --depth=10, así que esos
  // commits se transferían en cada uno).
  //
  // Este archivo pesa ~100 KB, así que el workflow de cada 30 min puede
  // commitearlo sin costo y el cliente lo empalma sobre daily-summary. Es lo
  // que mantiene "Hoy" al día SIN depender de que /api/today-live tenga Redis
  // configurado: si el vivo anda, pisa esto con datos de 15 segundos; si no
  // anda, el dashboard igual muestra hoy con 30 min de atraso en vez de
  // quedarse esperando hasta la corrida de las 03:00.
  //
  // Van los DOS últimos días, no solo hoy: entre las 00:00 y las 03:00 AR el
  // pipeline todavía no procesó "ayer", y con un solo día ayer quedaba en
  // blanco durante esas tres horas.
  const RECENT_DAYS = 2;
  const sizeRecent = writeJson('docs/data/web/recent.json', {
    generatedAt: now.toISOString(),
    days: dailySeries.slice(-RECENT_DAYS),
  });

  // ── geo.json (mapa por provincia + tiendas) ─────────────────────────────
  const sizeGeo = writeJson('docs/data/web/geo.json', {
    generatedAt: now.toISOString(),
    provinces: PROVINCES,
    segments: SEGMENTS,
    stores: storeMeta,
    // days[i] = { date, prov: { AR-B: { food: [pedidos, gmv] } }, stores: {...} }
    days: geoDays,
  });

  // ── orders/<tienda>/<mes>.json (detalle de pedidos, por tienda y mes) ───
  // Esto ANTES se partía por semestre, para que la cantidad de archivos
  // creciera cada 6 meses en vez de cada mes. Se revirtió a propósito, porque
  // esa decisión optimizaba lo que ya no importa y pagaba con lo único que sí
  // importa: la inmutabilidad.
  //
  // El problema medido: un archivo semestral de una tienda grande llega a
  // 57 MB, y para agregarle los pedidos de hoy hay que reescribirlo entero.
  // Git no guarda "la diferencia" de un JSON de una línea: guarda un blob
  // nuevo completo. Con 91 tiendas activas eso eran 48,6 MB de crecimiento
  // del repo POR COMMIT, unos 500 MB por día, y el semestre en curso se
  // reescribía así durante 6 meses seguidos.
  //
  // Partido por mes, un mes cerrado no vuelve a cambiar nunca: git lo guarda
  // una sola vez y listo. Solo churnea el mes en curso, y cada archivo queda
  // ~6x más chico (lejos del límite de 100 MB de GitHub).
  //
  // La contra de la partición mensual —más archivos, ~180 tiendas × 12 meses
  // al año— dejó de ser un problema cuando estos archivos salieron del
  // deploy: ahora viven en la rama `data-raw` y los sirve /api/archive a
  // demanda, así que la cantidad de archivos no le cuesta nada a Vercel.
  //
  // El formato de adentro NO cambia: sigue siendo { "<mes>": [pedidos] },
  // ahora con una sola clave por archivo, así el cliente lo sigue leyendo y
  // fusionando igual que antes.
  let ordersFilesWritten = 0, ordersBytesTotal = 0;
  for (const [storeCode, byMonth] of Object.entries(ordersByStoreMonth)) {
    for (const [m, list] of Object.entries(byMonth)) {
      list.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
      ordersBytesTotal += writeJson(`docs/data/web/orders/${storeCode}/${m}.json`, { [m]: list }, ARCHIVE_ROOT);
      ordersFilesWritten += 1;
    }
  }

  // ── order-index/<mes>.json (TODOS los pedidos, sin items, por mes) ──────
  // Alimenta "ver detalle" de un cupón (Cupones) y las pestañas por estado
  // del XLSX de Estados de pedido — ambos necesitan buscar en TODOS los
  // pedidos del rango, no solo los de una tienda.
  let orderIndexBytesTotal = 0;
  for (const [m, list] of Object.entries(orderIndexByMonth)) {
    list.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
    orderIndexBytesTotal += writeJson(`docs/data/web/order-index/${m}.json`, list, ARCHIVE_ROOT);
  }

  // ── products.json (por segmento y por mes) ──────────────────────────────
  const productsOut = {};
  for (const seg of SEGMENTS) {
    productsOut[seg] = {};
    for (const [m, skus] of Object.entries(productsBySegMonth[seg] || {})) {
      productsOut[seg][m] = Object.values(skus)
        .sort((a, b) => b.gmv - a.gmv)
        .slice(0, TOP_PRODUCTS_PER_SEG_MONTH)
        .map((p) => ({ sku: p.sku, name: p.name, dept: p.dept, qty: Math.round(p.qty), gmv: Math.round(p.gmv), orders: p.orders }));
    }
  }
  const sizeProducts = writeJson('docs/data/web/products.json', {
    generatedAt: now.toISOString(),
    note: 'Top productos por segmento y por mes. El corte mensual mantiene el archivo manejable; para el día exacto está el detalle en data/daily.',
    months: [...new Set(days.map(monthOf))].sort(),
    segments: productsOut,
  });

  // ── catalog.json ────────────────────────────────────────────────────────
  const productList = Object.values(catalogProducts)
    .sort((a, b) => b.gmv - a.gmv)
    .slice(0, TOP_PRODUCTS)
    .map((p) => ({ sku: p.sku, name: p.name, dept: p.dept, qty: Math.round(p.qty), gmv: Math.round(p.gmv), orders: p.orders }));

  const sizeCatalog = writeJson('docs/data/web/catalog.json', {
    generatedAt: now.toISOString(),
    from: days[0] || null,
    to: lastAvailable || null,
    products: productList,
    categories: topEntries(catalogCategories, TOP_CATEGORIES, ([name, v]) => ({
      name,
      orders: v.orders,
      gmv: Math.round(v.gmv),
      units: Math.round(v.units),
    })),
    categoriesN1: topEntries(catalogCategoriesN1, TOP_CATEGORIES, ([name, v]) => ({
      name,
      orders: v.orders,
      gmv: Math.round(v.gmv),
      units: Math.round(v.units),
    })),
    categoriesN2: topEntries(catalogCategoriesN2, TOP_CATEGORIES, ([name, v]) => ({
      name,
      orders: v.orders,
      gmv: Math.round(v.gmv),
      units: Math.round(v.units),
    })),
    coupons: topEntries(catalogCoupons, 200, ([code, v]) => ({ code, orders: v.orders, gmv: Math.round(v.gmv) })),
    payments: topEntries(catalogPayments, 50, ([group, v]) => ({ group, orders: v.orders, gmv: Math.round(v.gmv) })),
    paymentBrands: topEntries(catalogPaymentBrands, 50, ([brand, v]) => ({ brand, orders: v.orders, gmv: Math.round(v.gmv) })),
    installments: topEntries(catalogInstallments, 30, ([label, v]) => ({ label, orders: v.orders, gmv: Math.round(v.gmv) })),
    hourly: hourlyTotal,
    dayOfWeek: dowTotals.map((d) => ({
      orders: d.orders,
      gmv: Math.round(d.gmv),
      days: d.days,
      avgOrders: d.days ? Math.round(d.orders / d.days) : 0,
    })),
  });

  // ── cohorts.json ────────────────────────────────────────────────────────
  const cohortMonths = [...new Set([...cohortFirstMonth.values()])].sort();
  const activeMonths = [...new Set(days.map(monthOf))].sort();
  const cohortSizes = {};
  for (const m of cohortFirstMonth.values()) cohortSizes[m] = (cohortSizes[m] || 0) + 1;
  const cohortMatrix = cohortMonths.map((cm) =>
    activeMonths.map((am) => (am < cm ? null : (cohortActivity.get(`${cm}|${am}`)?.size || 0)))
  );

  const sizeCohorts = writeJson('docs/data/web/cohorts.json', {
    generatedAt: now.toISOString(),
    cohortMonths,
    activeMonths,
    cohortSizes: cohortMonths.map((m) => cohortSizes[m] || 0),
    matrix: cohortMatrix,
  });

  // ── audience-index.json (hasheado, columnar para que pese menos) ────────
  // Factory en vez de triplicar el Map+array a mano: se usa una vez para
  // categorías N3 (de siempre), y una vez más para cada nivel nuevo (N1/N2).
  function makeIndexer() {
    const index = new Map();
    const names = [];
    return { names, of: (name) => {
      if (!index.has(name)) { index.set(name, names.length); names.push(name); }
      return index.get(name);
    } };
  }
  const { names: catNames, of: catOf } = makeIndexer();
  const { names: catNamesN1, of: catOfN1 } = makeIndexer();
  const { names: catNamesN2, of: catOfN2 } = makeIndexer();
  const { names: pmNames, of: pmOf } = makeIndexer();
  // Tiendas: se reusa el diccionario código->nombre que ya arma storeMeta (ver
  // arriba, del geo.json) en vez de un indexer nuevo — mismo código, mismo
  // nombre, en el mismo orden siempre (ordenado, no por orden de aparición).
  const storeCodesList = Object.keys(storeMeta).sort();
  const storeCodeIndex = new Map(storeCodesList.map((c, i) => [c, i]));
  const storeNamesList = storeCodesList.map((c) => storeMeta[c].name || c);

  const dayIndex = new Map(days.map((d, i) => [d, i]));
  // cp = pedidos con cupón · ip = días promedio entre compras (0 si compró una
  // sola vez) · pd = medio de pago dominante · std = tienda dominante ·
  // sts = hasta 5 tiendas donde más compró (para "compró en la tienda X").
  // `ip` es lo que hace posible definir churn en serio: no es "hace X días
  // que no compra" a secas, sino "hace mucho más de lo que suele tardar
  // ESTE cliente en volver".
  const A = { h: [], o: [], g: [], f: [], l: [], sd: [], cd: [], cd1: [], cd2: [], cs: [], cp: [], ip: [], pd: [], std: [], sts: [] };
  // Los archivos diarios generados antes de que el pipeline capturara cupón,
  // medio de pago o tienda por cliente no traen esos campos. Se detecta y se
  // informa, para que la UI deshabilite esos filtros en vez de devolver 0 en
  // todos y hacer creer que nadie usó cupón / nadie compró en tiendas.
  let anyCoupon = false, anyPayment = false, anyCategoryN1 = false, anyStore = false;
  for (const [hash, p] of profiles) {
    const segEntries = Object.entries(p.segs).sort((a, b) => b[1] - a[1]);
    const catEntries = Object.entries(p.cats).sort((a, b) => b[1] - a[1]);
    const catEntriesN1 = Object.entries(p.catsN1).sort((a, b) => b[1] - a[1]);
    const catEntriesN2 = Object.entries(p.catsN2).sort((a, b) => b[1] - a[1]);
    const pmEntries = Object.entries(p.pms).sort((a, b) => b[1] - a[1]);
    const storeEntries = Object.entries(p.stores || {}).sort((a, b) => b[1] - a[1]);
    const fi = dayIndex.get(p.first) ?? 0;
    const li = dayIndex.get(p.last) ?? 0;
    A.h.push(hash);
    A.o.push(p.o);
    A.g.push(Math.round(p.g));
    A.f.push(fi);
    A.l.push(li);
    A.sd.push(segEntries.length ? SEGMENTS.indexOf(segEntries[0][0]) : -1);
    A.cd.push(catEntries.length ? catOf(catEntries[0][0]) : -1);
    A.cd1.push(catEntriesN1.length ? catOfN1(catEntriesN1[0][0]) : -1);
    A.cd2.push(catEntriesN2.length ? catOfN2(catEntriesN2[0][0]) : -1);
    if (catEntriesN1.length) anyCategoryN1 = true;
    A.cs.push(catEntries.slice(0, 5).map(([name]) => catOf(name)));
    A.cp.push(p.cp);
    if (p.cp > 0) anyCoupon = true;
    if (pmEntries.length) anyPayment = true;
    A.ip.push(p.o > 1 ? Math.round((li - fi) / (p.o - 1)) : 0);
    A.pd.push(pmEntries.length ? pmOf(pmEntries[0][0]) : -1);
    A.std.push(storeEntries.length ? storeCodeIndex.get(storeEntries[0][0]) : -1);
    A.sts.push(storeEntries.slice(0, 5).map(([code]) => storeCodeIndex.get(code)));
    if (storeEntries.length) anyStore = true;
  }

  const sizeAudience = writeJson('docs/data/web/audience-index.json', {
    generatedAt: now.toISOString(),
    note: 'Perfiles HASHEADOS. No contiene emails ni datos personales. Ver src/export-audience.js para el cruce privado hash->email.',
    days,
    segments: SEGMENTS,
    categories: catNames,
    categoriesN1: catNamesN1,
    categoriesN2: catNamesN2,
    payments: pmNames,
    stores: storeNamesList,
    hasCouponData: anyCoupon,
    hasPaymentData: anyPayment,
    hasStoreData: anyStore,
    // Los archivos de antes de esta función no traen categoriesN1/N2 por
    // pedido (el bug que hacía que "categoría dominante" mostrara el nivel
    // más específico en vez del departamento): hasta que se reprocesen con
    // un backfill, N1/N2 quedan vacíos y la UI lo avisa en vez de dejar
    // pensar que nadie compra en ningún departamento.
    hasCategoryLevels: anyCategoryN1,
    count: A.h.length,
    ...A,
  });

  // ── metrics.json por segmento ───────────────────────────────────────────
  for (const seg of SEGMENTS) {
    const metrics = computeAllMetricsFromAggregate(aggs[seg], { referenceDate: now });
    writeJson(`docs/data/web/${seg}/metrics.json`, {
      generatedAt: now.toISOString(),
      channel: 'web',
      bucket: seg,
      label: segmentMap.tabs.labels[seg],
      detailWindowStartDate: startDate,
      daysAggregated: days.length,
      ...metrics,
    });
  }

  writeJson('docs/data/web/_meta/run-info.json', {
    generatedAt: now.toISOString(),
    channel: 'web',
    detailWindowStartDate: startDate,
    daysAggregated: days.length,
    lastAvailableDay: lastAvailable || null,
    missingDays,
    scannedOrdersTotal: scannedTotal,
    uniqueCustomers: profiles.size,
    unknownStatuses: [...unknownStatuses],
    statusTotals: Object.fromEntries(Object.entries(statusTotals).sort((a, b) => b[1].orders - a[1].orders)),
    hasSegmentCatalog: dailySeries.some((d) => SEGMENTS.some((s) => Object.keys(d.segments[s]?.categories || {}).length)),
    hasGeo: geoDays.length > 0,
    hasStoreOrders: ordersFilesWritten > 0,
    fileSizes: {
      'geo.json': sizeGeo,
      'products.json': sizeProducts,
      'daily-summary.json': sizeDaily,
      'catalog.json': sizeCatalog,
      'cohorts.json': sizeCohorts,
      'audience-index.json': sizeAudience,
      'orders/**': ordersBytesTotal,
    },
    warning:
      missingDays.length > 0
        ? `Faltan ${missingDays.length} días entre ${startDate} y ${lastAvailable} — correr el backfill para completarlos.`
        : unknownStatuses.size > 0
          ? 'Hay statuses de VTEX no clasificados en config/status-filter.json.'
          : null,
  });

  const mb = (n) => `${(n / 1048576).toFixed(1)}MB`;
  console.log(`Agregado OK. Días: ${days.length}. Faltantes: ${missingDays.length}. Clientes únicos: ${profiles.size}.`);
  console.log(`  daily-summary ${mb(sizeDaily)} · recent ${mb(sizeRecent)} · catalog ${mb(sizeCatalog)} · cohorts ${mb(sizeCohorts)} · audience ${mb(sizeAudience)}`);
  console.log(`  geo ${mb(sizeGeo)} (${geoDays.length} días, ${Object.keys(storeMeta).length} tiendas) · products ${mb(sizeProducts)}`);
  console.log(`  orders ${mb(ordersBytesTotal)} (${ordersFilesWritten} archivos, uno por tienda y mes)`);
  console.log(`  order-index ${mb(orderIndexBytesTotal)} (${Object.keys(orderIndexByMonth).length} meses)`);
  if (sizeAudience > 25 * 1048576) {
    console.warn('  ⚠ audience-index.json supera 25MB: el navegador va a tardar en cargarlo. Considerar acotar la ventana.');
  }
}

main();

'use strict';

/**
 * Lee todos los docs/data/web/daily/YYYY-MM-DD.json desde
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
const DAILY_DIR = path.join(__dirname, '..', 'data', 'daily');
const OUT_BASE = path.join(__dirname, '..', 'docs', 'data', 'web');

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

function writeJson(relPath, data) {
  const outPath = path.join(__dirname, '..', relPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(data));
  return fs.statSync(outPath).size;
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
  const prevPath = path.join(__dirname, '..', 'docs', 'data', 'web', '_meta', 'run-info.json');
  if (!days.length && fs.existsSync(prevPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(prevPath, 'utf8'));
      if (prev.daysAggregated > 0 && !process.env.ALLOW_EMPTY_AGGREGATE) {
        console.error(`✗ No hay archivos diarios, pero las métricas actuales tienen ${prev.daysAggregated} días.`);
        console.error('  Se aborta para no dejar el dashboard en cero. Revisá docs/data/web/daily/.');
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
  const catalogCoupons = {};
  const catalogPayments = {};
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
        coupons: daySeg.coupons || {},
        payments: daySeg.payments || {},
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
      for (const [k, v] of Object.entries(src.coupons || {})) addInto(catalogCoupons, k, v);
      for (const [k, v] of Object.entries(src.payments || {})) addInto(catalogPayments, k, v);
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
        p = { o: 0, g: 0, first: date, last: date, segs: {}, cats: {}, cp: 0, pms: {}, days: [] };
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
      for (const [pm, n] of Object.entries(c.pm || {})) p.pms[pm] = (p.pms[pm] || 0) + n;

      const cm = cohortFirstMonth.get(hash);
      const key = `${cm}|${month}`;
      if (!cohortActivity.has(key)) cohortActivity.set(key, new Set());
      cohortActivity.get(key).add(hash);
    }

    dailySeries.push({
      date,
      segments: daySegments,
      hourly: day.hourly || null,
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

  // ── geo.json (mapa por provincia + tiendas) ─────────────────────────────
  const sizeGeo = writeJson('docs/data/web/geo.json', {
    generatedAt: now.toISOString(),
    provinces: PROVINCES,
    segments: SEGMENTS,
    stores: storeMeta,
    // days[i] = { date, prov: { AR-B: { food: [pedidos, gmv] } }, stores: {...} }
    days: geoDays,
  });

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
    coupons: topEntries(catalogCoupons, 200, ([code, v]) => ({ code, orders: v.orders, gmv: Math.round(v.gmv) })),
    payments: topEntries(catalogPayments, 50, ([group, v]) => ({ group, orders: v.orders, gmv: Math.round(v.gmv) })),
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
  const catIndex = new Map();
  const catNames = [];
  const catOf = (name) => {
    if (!catIndex.has(name)) {
      catIndex.set(name, catNames.length);
      catNames.push(name);
    }
    return catIndex.get(name);
  };

  const pmIndex = new Map();
  const pmNames = [];
  const pmOf = (name) => {
    if (!pmIndex.has(name)) {
      pmIndex.set(name, pmNames.length);
      pmNames.push(name);
    }
    return pmIndex.get(name);
  };

  const dayIndex = new Map(days.map((d, i) => [d, i]));
  // cp = pedidos con cupón · ip = días promedio entre compras (0 si compró una
  // sola vez) · pd = medio de pago dominante. `ip` es lo que hace posible
  // definir churn en serio: no es "hace X días que no compra" a secas, sino
  // "hace mucho más de lo que suele tardar ESTE cliente en volver".
  const A = { h: [], o: [], g: [], f: [], l: [], sd: [], cd: [], cs: [], cp: [], ip: [], pd: [] };
  // Los archivos diarios generados antes de que el pipeline capturara cupón y
  // medio de pago por cliente no traen esos campos. Se detecta y se informa,
  // para que la UI deshabilite esos filtros en vez de devolver 0 en todos y
  // hacer creer que nadie usó cupón.
  let anyCoupon = false, anyPayment = false;
  for (const [hash, p] of profiles) {
    const segEntries = Object.entries(p.segs).sort((a, b) => b[1] - a[1]);
    const catEntries = Object.entries(p.cats).sort((a, b) => b[1] - a[1]);
    const pmEntries = Object.entries(p.pms).sort((a, b) => b[1] - a[1]);
    const fi = dayIndex.get(p.first) ?? 0;
    const li = dayIndex.get(p.last) ?? 0;
    A.h.push(hash);
    A.o.push(p.o);
    A.g.push(Math.round(p.g));
    A.f.push(fi);
    A.l.push(li);
    A.sd.push(segEntries.length ? SEGMENTS.indexOf(segEntries[0][0]) : -1);
    A.cd.push(catEntries.length ? catOf(catEntries[0][0]) : -1);
    A.cs.push(catEntries.slice(0, 5).map(([name]) => catOf(name)));
    A.cp.push(p.cp);
    if (p.cp > 0) anyCoupon = true;
    if (pmEntries.length) anyPayment = true;
    A.ip.push(p.o > 1 ? Math.round((li - fi) / (p.o - 1)) : 0);
    A.pd.push(pmEntries.length ? pmOf(pmEntries[0][0]) : -1);
  }

  const sizeAudience = writeJson('docs/data/web/audience-index.json', {
    generatedAt: now.toISOString(),
    note: 'Perfiles HASHEADOS. No contiene emails ni datos personales. Ver src/export-audience.js para el cruce privado hash->email.',
    days,
    segments: SEGMENTS,
    categories: catNames,
    payments: pmNames,
    hasCouponData: anyCoupon,
    hasPaymentData: anyPayment,
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
    fileSizes: {
      'geo.json': sizeGeo,
      'products.json': sizeProducts,
      'daily-summary.json': sizeDaily,
      'catalog.json': sizeCatalog,
      'cohorts.json': sizeCohorts,
      'audience-index.json': sizeAudience,
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
  console.log(`  daily-summary ${mb(sizeDaily)} · catalog ${mb(sizeCatalog)} · cohorts ${mb(sizeCohorts)} · audience ${mb(sizeAudience)}`);
  console.log(`  geo ${mb(sizeGeo)} (${geoDays.length} días, ${Object.keys(storeMeta).length} tiendas) · products ${mb(sizeProducts)}`);
  if (sizeAudience > 25 * 1048576) {
    console.warn('  ⚠ audience-index.json supera 25MB: el navegador va a tardar en cargarlo. Considerar acotar la ventana.');
  }
}

main();

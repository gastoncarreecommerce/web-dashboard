/**
 * Arma el dataset del canal APP con el mismo schema rico que ya usa el canal
 * web, para que el dashboard pueda tratar los dos canales igual y sumarlos.
 *
 *   entradas
 *     <PRIVADO>/daily/YYYY-MM-DD-rows.json    detalle por pedido (con PII)
 *     <APPDASH>/docs/data/daily/YYYY-MM-DD.json  agregado del dia (total ecommerce)
 *
 *   salidas
 *     docs/data/app/daily-summary.json   serie diaria, por segmento
 *     docs/data/app/products.json        ranking de productos del canal
 *
 * POR QUE LEER LOS ROWS Y NO LOS AGREGADOS. Los agregados diarios de AppDash
 * solo traen pedidos y GMV por segmento. Todo lo demas que el dashboard
 * necesita —unidades, productos, cupones, estados, horario, fuentes, clientes—
 * esta en el detalle por pedido. Una primera version de este script uso los
 * agregados y el resultado fue un canal app que "no medía" media docena de
 * cosas que en realidad si estan.
 *
 * PII. Los rows traen el email del cliente. Este script lo usa solo en memoria
 * para contar clientes unicos y nuevos, y NUNCA lo escribe: la salida son
 * agregados. Se normaliza igual que en AppDash (scripts/comercial-lib.mjs):
 * VTEX le pega un sufijo por pedido al dominio, asi que sin sacarlo el mismo
 * cliente cuenta como uno nuevo en cada compra.
 *
 * Uso:
 *   node scripts/build-app-summary.mjs [--appdash DIR] [--private DIR]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function arg(nombre, def) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const APPDASH = arg('appdash', process.env.APPDASH_DIR || '../vtex-utm-audit');
const PRIVADO = arg('private', process.env.PRIVATE_DATA_DIR || '../appdash-private-data');
// order-index es pesado (uno por pedido, todo el historico) — igual que
// docs/data/web/order-index, vive en la rama `data-raw` para no sumarle peso
// al deploy. Default '.' deja el comportamiento de siempre para correrlo a
// mano (todo bajo docs/data/app/, sin separar).
const ARCHIVE_ROOT = arg('archive-root', process.env.APP_ARCHIVE_ROOT || '.');

const AGG = path.join(APPDASH, 'docs', 'data', 'daily');
const ROWS = path.join(PRIVADO, 'daily');
const OUT_DIR = path.join('docs', 'data', 'app');
const ORDER_INDEX_DIR = path.join(ARCHIVE_ROOT, 'docs', 'data', 'app', 'order-index');

for (const [d, q] of [[AGG, 'agregados de AppDash'], [ROWS, 'rows del repo privado']]) {
  if (!fs.existsSync(d)) {
    console.error(`No encuentro los ${q} en ${d}`);
    process.exit(1);
  }
}

// App escribe non_food; el front de WebDash usa non-food en todos lados.
const SEG_MAP = { food: 'food', non_food: 'non-food', marketplace: 'marketplace', quickcommerce: 'quickcommerce' };
const SEGMENTS = ['food', 'non-food', 'marketplace', 'quickcommerce'];

// Misma politica que el canal Web (config/status-filter.json, src/classify.js
// isIncludedStatus): un pedido cancelado no es un "pedido" para las metricas
// de negocio. Antes esto NO se aplicaba aca, asi que el total de App incluia
// sus cancelados mientras el de Web no — el dashboard nunca iba a cuadrar
// contra "pedidos totales" de VTEX de forma consistente entre canales.
const statusFilter = JSON.parse(fs.readFileSync(new URL('../config/status-filter.json', import.meta.url)));
const estadoIncluido = (estado) => statusFilter.includeStatuses.includes(estado);

/** Igual que realEmail() en AppDash: saca el sufijo por pedido que agrega VTEX. */
const normEmail = (e) => (e ? String(e).replace(/-[^-@]*\.ct\.vtex\.com\.br$/i, '').toLowerCase() || null : null);

// Mismo hash que src/customer-key.js#customerHash (sha256 del email real,
// truncado a 64 bits) para que un mismo cliente comparta la misma clave
// entre el order-index de Web y el de App — el export cruza contra el mapa
// hash->email/DNI de audiencias sin importar de qué canal vino el pedido.
const customerHash = (mailNorm) => (mailNorm
  ? crypto.createHash('sha256').update(mailNorm).digest('hex').slice(0, 16)
  : null);

// r.fecha ya viene en hora de pared AR ("15/9/2026, 19:23:41", ver
// formatFechaAR en vtex-utm-audit/fetch-orders.js) — a diferencia de
// full.creationDate en el pipeline Web, que es UTC crudo. order-index.t tiene
// que guardar lo mismo en los dos canales (UTC real) para que W.arDateOf /
// W.arDateTimeOf en el dashboard lo conviertan bien sin importar el canal:
// por eso se SUMAN 3h acá (al revés del -3h que hace el front) para volver a
// UTC antes de guardar.
function arLocalToUtcIso(fecha) {
  const m = typeof fecha === 'string'
    && fecha.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}),\s*(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [d, mo, y, h, mi, s] = m.slice(1).map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s) + 3 * 60 * 60 * 1000).toISOString();
}

/** "15/9/2026, 19:23:41" -> 19. Es el formato que escribe fetch-orders.js. */
function horaDe(fecha) {
  if (typeof fecha !== 'string') return null;
  const m = fecha.match(/,\s*(\d{1,2}):/);
  if (!m) return null;
  const h = Number(m[1]);
  return h >= 0 && h <= 23 ? h : null;
}

const vacioSeg = () => ({
  gmv: 0, orders: 0, units: 0,
  marketing: {}, coupons: {}, hourly: new Array(24).fill(0),
});
const bump = (obj, key, gmv, units) => {
  if (!key) return;
  const e = (obj[key] = obj[key] || { orders: 0, gmv: 0, units: 0 });
  e.orders += 1; e.gmv += gmv; e.units += units;
};

const archivos = fs.readdirSync(ROWS).filter((f) => /^\d{4}-\d{2}-\d{2}-rows\.json$/.test(f)).sort();

const days = [];
// Productos con el MISMO corte que el canal web: por segmento y por mes, para
// que los dos rankings se puedan fusionar y mirar juntos. La clave es el sku
// cuando existe (el nombre cambia de escritura entre pedidos).
const productos = {};          // `${seg}|${ym}|${sku}` -> {sku, name, qty, gmv, orders}
const vistos = new Set();      // emails ya vistos en dias anteriores -> clientes nuevos
let sinFecha = 0, sinSegmento = 0, excluidosPorEstado = 0;

// Indice liviano por pedido (sin items, sin email) — mismo shape que
// docs/data/web/order-index del canal Web (src/aggregate.js), para que la
// hoja "Pedidos" del export pueda mostrar los dos canales juntos. Incluye
// TODO estado (cancelados tambien): es el mismo criterio que Web, que lo usa
// para las pestañas por estado y el detalle de cupones.
const orderIndexByMonth = {}; // 'YYYY-MM' -> [{id,t,sg,h,g,st,cp}]

for (const f of archivos) {
  const date = f.slice(0, 10);

  let rows;
  try { rows = JSON.parse(fs.readFileSync(path.join(ROWS, f), 'utf8')); }
  catch { console.warn(`  ! ${f} no es JSON valido, se saltea`); continue; }
  if (!Array.isArray(rows)) continue;

  // El agregado del mismo dia aporta el total del ecommerce completo, que es
  // el denominador honesto para la participacion de cada canal.
  let agg = null;
  const pAgg = path.join(AGG, `${date}.json`);
  if (fs.existsSync(pAgg)) { try { agg = JSON.parse(fs.readFileSync(pAgg, 'utf8')); } catch { /* sigue sin el */ } }

  const segments = {};
  for (const s of SEGMENTS) segments[s] = vacioSeg();
  const hourly = new Array(24).fill(0);
  const statusStats = {};
  const delDia = new Set();
  let nuevos = 0, conUtm = 0, sinUtm = 0;

  for (const r of rows) {
    const segRaw = r.segment;
    const seg = SEG_MAP[segRaw] || (SEGMENTS.includes(segRaw) ? segRaw : null);
    if (!seg) { sinSegmento++; continue; }
    const ym = date.slice(0, 7);

    // statusStats mide TODO lo que llegó (igual que el listado crudo del canal
    // Web), cancelados incluidos: es lo que deja ver la tasa de cancelación.
    const gmv = Number(r.total) || 0;
    const st = r.estado || 'sin-estado';
    const e = (statusStats[st] = statusStats[st] || { orders: 0, gmv: 0 });
    e.orders += 1; e.gmv += gmv;

    const mailIdx = normEmail(r.email);
    (orderIndexByMonth[ym] = orderIndexByMonth[ym] || []).push({
      id: r.order_id,
      t: arLocalToUtcIso(r.fecha) || r.fecha,
      sg: seg,
      h: customerHash(mailIdx),
      g: Math.round(gmv),
      st,
      cp: r.coupon ? [r.coupon] : undefined,
    });

    if (!estadoIncluido(st)) { excluidosPorEstado++; continue; }

    const items = Array.isArray(r.items) ? r.items : [];
    const units = items.reduce((t, i) => t + (Number(i.qty) || 0), 0);
    const S = segments[seg];

    S.orders += 1; S.gmv += gmv; S.units += units;

    const h = horaDe(r.fecha);
    if (h == null) sinFecha++; else { S.hourly[h] += 1; hourly[h] += 1; }

    // Atribucion: en App la fuente es utm_source, y "sin atribucion" es un
    // valor con nombre propio, no un hueco — es EL kpi que mira AppDash.
    const fuente = r.utm_source || 'sin_atribucion';
    bump(S.marketing, fuente, gmv, units);
    if (r.utm_source) conUtm += 1; else sinUtm += 1;

    if (r.coupon) bump(S.coupons, r.coupon, gmv, units);

    const mail = normEmail(r.email);
    if (mail) {
      delDia.add(mail);
      if (!vistos.has(mail)) { vistos.add(mail); nuevos += 1; }
    }

    for (const i of items) {
      const sku = i.sku || i.id || i.name;
      if (!sku) continue;
      const k = `${seg}|${ym}|${sku}`;
      const p = (productos[k] = productos[k] || { seg, ym, sku, name: i.name || String(sku), qty: 0, gmv: 0, orders: 0 });
      p.orders += 1;
      p.qty += Number(i.qty) || 0;
      p.gmv += (Number(i.price) || 0) * (Number(i.qty) || 0);
    }
  }

  days.push({
    date,
    segments,
    hourly,
    statusStats,
    newCustomers: nuevos,
    activeCustomers: delDia.size,
    // Descuentos no estan en los rows de App (el row trae el total ya neteado),
    // asi que se deja en 0 y el front no lo suma para este canal.
    discount: 0,
    totalEcommOrders: agg?.total_ecomm_orders || 0,
    totalEcommGmv: agg?.total_ecomm_gmv || 0,
    conUtm, sinUtm,
    fetchedAt: agg?.fetched_at || null,
  });
}

// ── Dias que tienen agregado pero todavia no tienen rows ────────────────────
// Los rows del repo privado se escriben una vez que el dia cerro, asi que HOY
// (y a veces ayer) no tiene archivo de rows. Iterar solo los rows hacia que
// esos dias no existieran en este dataset: el dashboard mostraba App = 0
// pedidos para hoy mientras AppDash mostraba cientos. El agregado de AppDash
// si esta al dia, y trae pedidos y GMV por segmento — menos de lo que dan los
// rows (sin unidades, cupones, productos ni hora), pero infinitamente mejor
// que un cero que miente.
//
// Van marcados con `partial: true` para que la UI pueda decir que a ese dia le
// falta detalle, y con `desdeAgregado: true` para saber de donde salio.
const conRows = new Set(days.map((d) => d.date));
let soloAgg = 0;
for (const f of fs.readdirSync(AGG).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort()) {
  const date = f.slice(0, 10);
  if (conRows.has(date)) continue;

  let agg;
  try { agg = JSON.parse(fs.readFileSync(path.join(AGG, f), 'utf8')); } catch { continue; }
  const app = agg?.app;
  if (!app) continue;

  const segments = {};
  for (const seg of SEGMENTS) {
    const sg = app.segments?.[seg] || {};
    segments[seg] = {
      ...vacioSeg(),
      orders: sg.orders || 0,
      gmv: sg.gmv || 0,
    };
  }
  days.push({
    date,
    segments,
    hourly: null,
    statusStats: {},
    newCustomers: 0,
    activeCustomers: 0,
    discount: 0,
    totalEcommOrders: agg.total_ecomm_orders || 0,
    totalEcommGmv: agg.total_ecomm_gmv || 0,
    conUtm: app.con_utm || 0,
    sinUtm: app.sin_utm || 0,
    fetchedAt: agg.fetched_at || null,
    partial: true,
    desdeAgregado: true,
  });
  soloAgg += 1;
}
days.sort((a, b) => a.date.localeCompare(b.date));
if (soloAgg) console.log(`${soloAgg} dia(s) sin rows todavia: pedidos y GMV desde el agregado de AppDash, sin detalle`);

// La frescura del DATO, no la hora en que corrio este script.
const fechas = days.map((d) => d.fetchedAt).filter(Boolean).sort();
const dataFreshAt = fechas.length ? fechas[fechas.length - 1] : null;

const salida = {
  generatedAt: new Date().toISOString(),
  dataFreshAt,
  channel: 'app',
  source: 'vtex-utm-audit/docs/data/daily + appdash-private-data/daily (rows)',
  schema: 2,
  /**
   * Que mide este canal. Solo tres cosas quedan afuera y es por la fuente, no
   * por como esta armado esto: los rows de App no traen medio de pago, cuotas
   * ni la categoria del producto (haria falta cruzar con el catalogo), y
   * tampoco provincia o tienda.
   */
  has: {
    orders: true, gmv: true, units: true, products: true, coupons: true,
    marketing: true, hourly: true, statusStats: true, customers: true,
    totalEcomm: true, utm: true,
    payments: false, installments: false, categories: false, geo: false, discount: false,
  },
  days,
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'daily-summary.json'), JSON.stringify(salida));

fs.mkdirSync(ORDER_INDEX_DIR, { recursive: true });
let orderIndexBytesTotal = 0;
for (const [ym, list] of Object.entries(orderIndexByMonth)) {
  list.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  const buf = JSON.stringify(list);
  fs.writeFileSync(path.join(ORDER_INDEX_DIR, `${ym}.json`), buf);
  orderIndexBytesTotal += buf.length;
}

// products.json con el schema del canal web: segments[segmento][mes] = top 150.
// El corte por mes mantiene el archivo manejable y el top evita publicar la cola
// larga de SKUs de una sola venta. `dept` queda vacio: los rows de App no traen
// la categoria del producto (haria falta cruzar el catalogo de VTEX).
const TOP_POR_MES = 150;
const porSegMes = {};
for (const v of Object.values(productos)) {
  ((porSegMes[v.seg] = porSegMes[v.seg] || {})[v.ym] = porSegMes[v.seg][v.ym] || []).push(v);
}
const segments = {};
const meses = new Set();
for (const seg of SEGMENTS) {
  segments[seg] = {};
  for (const [ym, arr] of Object.entries(porSegMes[seg] || {})) {
    meses.add(ym);
    segments[seg][ym] = arr
      .sort((a, b) => b.qty - a.qty)
      .slice(0, TOP_POR_MES)
      .map((v) => ({ sku: v.sku, name: v.name, dept: '', qty: v.qty, gmv: Math.round(v.gmv), orders: v.orders }));
  }
}
fs.writeFileSync(path.join(OUT_DIR, 'products.json'), JSON.stringify({
  generatedAt: salida.generatedAt,
  channel: 'app',
  note: `Top ${TOP_POR_MES} productos por segmento y por mes, mismo corte que el canal web. dept vacio: los rows de App no traen la categoria del producto.`,
  months: [...meses].sort(),
  totalDistinct: new Set(Object.values(productos).map((v) => v.sku)).size,
  segments,
}));

const kb = (p) => (fs.statSync(path.join(OUT_DIR, p)).size / 1024).toFixed(0);
const tot = (k) => days.reduce((t, d) => t + SEGMENTS.reduce((a, s) => a + d.segments[s][k], 0), 0);
console.log(`daily-summary.json · ${days.length} dias · ${tot('orders').toLocaleString('es-AR')} pedidos · ${tot('units').toLocaleString('es-AR')} unidades · ${kb('daily-summary.json')} KB`);
const nProd = Object.values(segments).reduce((t, m) => t + Object.values(m).reduce((a, arr) => a + arr.length, 0), 0);
console.log(`products.json     · ${nProd} filas (top ${TOP_POR_MES} x segmento x mes) de ${new Set(Object.values(productos).map((v) => v.sku)).size} skus · ${kb('products.json')} KB`);
console.log(`order-index       · ${(orderIndexBytesTotal / 1048576).toFixed(1)}MB (${Object.keys(orderIndexByMonth).length} meses) en ${ORDER_INDEX_DIR}`);
console.log(`clientes unicos en todo el historial: ${vistos.size.toLocaleString('es-AR')}`);
console.log(`frescura del dato: ${dataFreshAt || 'n/d'}`);
if (excluidosPorEstado) console.log(`(${excluidosPorEstado} pedido(s) cancelados/pendientes, excluidos de las metricas de negocio — igual que el canal Web)`);
if (sinSegmento) console.log(`(${sinSegmento} pedido(s) sin segmento reconocido, descartados)`);
if (sinFecha) console.log(`(${sinFecha} pedido(s) sin hora parseable, no entran en el horario)`);

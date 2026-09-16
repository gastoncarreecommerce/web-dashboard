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

function arg(nombre, def) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const APPDASH = arg('appdash', process.env.APPDASH_DIR || '../vtex-utm-audit');
const PRIVADO = arg('private', process.env.PRIVATE_DATA_DIR || '../appdash-private-data');

const AGG = path.join(APPDASH, 'docs', 'data', 'daily');
const ROWS = path.join(PRIVADO, 'daily');
const OUT_DIR = path.join('docs', 'data', 'app');

for (const [d, q] of [[AGG, 'agregados de AppDash'], [ROWS, 'rows del repo privado']]) {
  if (!fs.existsSync(d)) {
    console.error(`No encuentro los ${q} en ${d}`);
    process.exit(1);
  }
}

// App escribe non_food; el front de WebDash usa non-food en todos lados.
const SEG_MAP = { food: 'food', non_food: 'non-food', marketplace: 'marketplace', quickcommerce: 'quickcommerce' };
const SEGMENTS = ['food', 'non-food', 'marketplace', 'quickcommerce'];

/** Igual que realEmail() en AppDash: saca el sufijo por pedido que agrega VTEX. */
const normEmail = (e) => (e ? String(e).replace(/-[^-@]*\.ct\.vtex\.com\.br$/i, '').toLowerCase() || null : null);

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
const productos = {};          // nombre -> {orders, gmv, units, sku}
const vistos = new Set();      // emails ya vistos en dias anteriores -> clientes nuevos
let sinFecha = 0, sinSegmento = 0;

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

    const gmv = Number(r.total) || 0;
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

    const st = r.estado || 'sin-estado';
    const e = (statusStats[st] = statusStats[st] || { orders: 0, gmv: 0 });
    e.orders += 1; e.gmv += gmv;

    const mail = normEmail(r.email);
    if (mail) {
      delDia.add(mail);
      if (!vistos.has(mail)) { vistos.add(mail); nuevos += 1; }
    }

    for (const i of items) {
      const nombre = i.name || i.sku || i.id;
      if (!nombre) continue;
      const p = (productos[nombre] = productos[nombre] || { orders: 0, gmv: 0, units: 0, sku: i.sku || i.id || '' });
      p.orders += 1;
      p.units += Number(i.qty) || 0;
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

// Ranking de productos: se recorta a los 3000 con mas unidades para no publicar
// un archivo gigante con la cola larga de SKUs de una sola venta.
const topProd = Object.entries(productos)
  .sort((a, b) => b[1].units - a[1].units)
  .slice(0, 3000)
  .map(([name, v]) => ({ name, sku: v.sku, orders: v.orders, units: v.units, gmv: Math.round(v.gmv) }));
fs.writeFileSync(path.join(OUT_DIR, 'products.json'), JSON.stringify({
  generatedAt: salida.generatedAt, channel: 'app',
  totalDistinct: Object.keys(productos).length,
  products: topProd,
}));

const kb = (p) => (fs.statSync(path.join(OUT_DIR, p)).size / 1024).toFixed(0);
const tot = (k) => days.reduce((t, d) => t + SEGMENTS.reduce((a, s) => a + d.segments[s][k], 0), 0);
console.log(`daily-summary.json · ${days.length} dias · ${tot('orders').toLocaleString('es-AR')} pedidos · ${tot('units').toLocaleString('es-AR')} unidades · ${kb('daily-summary.json')} KB`);
console.log(`products.json     · ${topProd.length} de ${Object.keys(productos).length} productos · ${kb('products.json')} KB`);
console.log(`clientes unicos en todo el historial: ${vistos.size.toLocaleString('es-AR')}`);
console.log(`frescura del dato: ${dataFreshAt || 'n/d'}`);
if (sinSegmento) console.log(`(${sinSegmento} pedido(s) sin segmento reconocido, descartados)`);
if (sinFecha) console.log(`(${sinFecha} pedido(s) sin hora parseable, no entran en el horario)`);

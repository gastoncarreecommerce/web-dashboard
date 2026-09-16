/**
 * Convierte los agregados diarios de AppDash al schema que ya consume WebDash,
 * para poder mirar los dos canales en la misma vista.
 *
 *   entrada  <APPDASH>/docs/data/daily/YYYY-MM-DD.json   (uno por dia)
 *   salida   docs/data/app/daily-summary.json            (un solo archivo)
 *
 * Por que normalizar en vez de leer el formato de App en el front: asi
 * W.sumRange sirve igual para los dos canales y la vista no se llena de ramas
 * "si es app entonces". Las diferencias reales de contenido (App no tiene
 * units, categorias, medios de pago ni horario) quedan expuestas en `has`,
 * para que la UI pueda decir "esto no existe para App" en vez de mostrar cero.
 *
 * Los agregados de App NO tienen PII: el email vive solo en los -rows.json,
 * que estan en el repo privado appdash-private-data. Estos archivos pesan
 * 552KB en total para 138 dias.
 *
 * Uso:  node scripts/build-app-summary.mjs [ruta-al-repo-de-appdash]
 */
import fs from 'node:fs';
import path from 'node:path';

const APPDASH = process.argv[2] || process.env.APPDASH_DIR || '../vtex-utm-audit';
const SRC = path.join(APPDASH, 'docs', 'data', 'daily');
const OUT = path.join('docs', 'data', 'app', 'daily-summary.json');

// App escribe non_food con guion bajo; WebDash usa non-food en todo el front.
const SEG = { food: 'food', non_food: 'non-food', marketplace: 'marketplace', quickcommerce: 'quickcommerce' };

if (!fs.existsSync(SRC)) {
  console.error(`No encuentro los daily de AppDash en ${SRC}`);
  console.error('Pasá la ruta del repo: node scripts/build-app-summary.mjs /ruta/a/vtex-utm-audit');
  process.exit(1);
}

const archivos = fs.readdirSync(SRC)
  .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))   // los -rows.json no entran
  .sort();

const days = [];
let descartados = 0;

for (const f of archivos) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8')); }
  catch { descartados++; continue; }

  const app = j.app;
  if (!app || typeof app.total !== 'number') { descartados++; continue; }

  const segments = {};
  for (const [origen, destino] of Object.entries(SEG)) {
    const s = app.segments?.[origen] || {};
    segments[destino] = { gmv: s.gmv || 0, orders: s.orders || 0, units: 0 };
  }

  days.push({
    date: j.date || f.slice(0, 10),
    segments,
    // Lo que App sí tiene y Web no: el total del ecommerce completo, que sirve
    // de denominador honesto para la participacion de cada canal.
    totalEcommOrders: j.total_ecomm_orders || 0,
    totalEcommGmv: j.total_ecomm_gmv || 0,
    // Atribucion, que en App es el KPI central y en Web vive dentro de marketing.
    conUtm: app.con_utm || 0,
    sinUtm: app.sin_utm || 0,
    fetchedAt: j.fetched_at || null,
  });
}

// La frescura del DATO, que no es la hora en que corrio este script: cada daily
// de App trae su fetched_at (cuando se le pregunto a VTEX). Sin esta distincion
// el canal app parece recien actualizado apenas se regenera el archivo, aunque
// los pedidos que trae sean de ayer.
const fechas = days.map((d) => d.fetchedAt).filter(Boolean).sort();
const dataFreshAt = fechas.length ? fechas[fechas.length - 1] : null;

const salida = {
  generatedAt: new Date().toISOString(),
  dataFreshAt,
  channel: 'app',
  source: 'gastoncarreecommerce/vtex-utm-audit · docs/data/daily',
  // Que campos existen de verdad en este canal. La vista lee esto para no
  // mostrar un cero donde en realidad el dato no se mide.
  has: {
    orders: true, gmv: true,
    units: false, categories: false, payments: false, coupons: false,
    hourly: false, marketing: false, newCustomers: false, statusStats: false,
    totalEcomm: true, utm: true,
  },
  days,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(salida));

const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
const ped = days.reduce((t, d) => t + Object.values(d.segments).reduce((a, s) => a + s.orders, 0), 0);
console.log(`docs/data/app/daily-summary.json · ${days.length} dias · ${ped.toLocaleString('es-AR')} pedidos · ${kb} KB`);
console.log(`frescura del dato (max fetched_at): ${dataFreshAt || 'n/d'}`);
if (descartados) console.log(`(${descartados} archivo(s) descartado(s) por no tener app.total)`);
if (days.length) console.log(`rango: ${days[0].date} -> ${days[days.length - 1].date}`);

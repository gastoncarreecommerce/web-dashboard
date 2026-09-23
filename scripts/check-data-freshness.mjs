/**
 * Corre al final del pipeline diario y hace fallar el workflow (exit 1, rojo
 * en Actions) si el ULTIMO DIA YA CERRADO tiene muchos menos pedidos de los
 * esperados — la firma exacta del bug que pasó dos días seguidos: un canal
 * (App) quedó congelado con un conteo parcial de la madrugada y nadie lo
 * notó hasta mirar el dashboard a la mañana siguiente.
 *
 * No corrige nada: el objetivo es que un dato incompleto ya no pueda llegar
 * en silencio. Si esto falla, revisar docs/data/web/daily-summary.json y
 * docs/data/app/daily-summary.json para la fecha que imprime, y volver a
 * correr el paso de fetch que corresponda antes de confiar en el dashboard.
 *
 * Uso: node scripts/check-data-freshness.mjs
 */
import fs from 'node:fs';

const UMBRAL = 0.5; // el día cerrado no puede tener menos de la mitad de la mediana previa
const VENTANA = 7;  // días previos que arman la mediana

function ordersPorDia(path, segKeys) {
  let data;
  try { data = JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch { return new Map(); }
  const out = new Map();
  for (const d of data.days || []) {
    const orders = segKeys.reduce((t, k) => t + (d.segments?.[k]?.orders || 0), 0);
    out.set(d.date, orders);
  }
  return out;
}

function hoyAR() {
  const ar = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return ar.toISOString().slice(0, 10);
}

function diasAtras(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function mediana(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const CANALES = {
  web: ordersPorDia('docs/data/web/daily-summary.json', ['food', 'non-food', 'marketplace', 'quickcommerce']),
  app: ordersPorDia('docs/data/app/daily-summary.json', ['food', 'non-food', 'marketplace', 'quickcommerce']),
};

const hoy = hoyAR();
const ayer = diasAtras(hoy, 1);

let huboFalla = false;
for (const [nombre, porDia] of Object.entries(CANALES)) {
  // Chequeo POR CANAL, no sobre el total combinado: un canal chico (App) se
  // puede caer al 5% de lo normal y el total combinado ni se entera porque el
  // otro (Web) lo tapa — exactamente lo que pasó y por lo que este chequeo
  // habría dado "OK" en falso si comparara solo la suma.
  if (!porDia.has(ayer)) {
    console.log(`check-data-freshness [${nombre}]: ${ayer} todavía no está en los datos, nada que chequear.`);
    continue;
  }
  const totalAyer = porDia.get(ayer);
  const previos = [];
  for (let i = 2; i <= VENTANA + 1; i++) {
    const f = diasAtras(hoy, i);
    if (porDia.has(f)) previos.push(porDia.get(f));
  }
  if (previos.length < 3) {
    console.log(`check-data-freshness [${nombre}]: solo ${previos.length} día(s) previos disponibles, muy poco historial para comparar. Sin chequeo.`);
    continue;
  }
  const base = mediana(previos);
  const ratio = base > 0 ? totalAyer / base : 1;
  console.log(`check-data-freshness [${nombre}]: ${ayer} → ${totalAyer.toLocaleString('es-AR')} pedidos · mediana previa ${base.toLocaleString('es-AR')} · ratio ${(ratio * 100).toFixed(1)}%`);
  if (ratio < UMBRAL) {
    console.error(`::error::[${nombre}] ${ayer} tiene ${(ratio * 100).toFixed(0)}% de la mediana previa (${totalAyer} vs ~${Math.round(base)}) — pinta a día incompleto, no a una baja real. Revisar docs/data/${nombre}/daily-summary.json antes de confiar en el dashboard.`);
    huboFalla = true;
  }
}

if (huboFalla) process.exit(1);
console.log('check-data-freshness: OK.');

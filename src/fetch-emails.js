'use strict';

/**
 * PRIVADO — construye el mapeo hash -> email leyendo la base de clientes de
 * VTEX Master Data (entidad CL), NO los pedidos.
 *
 * El hash que usa el dashboard es SHA-256 del email real, así que con la lista
 * de emails se reconstruye el mapeo entero sin volver a pedir el detalle de
 * ~866.000 pedidos.
 *
 * IMPORTANTE — por qué scroll y no search:
 * El endpoint /search de Master Data v1 corta en 10.000 registros: a partir de
 * ahí devuelve vacío sin avisar. Una primera versión de este script usaba
 * search y se quedaba clavada en 9.900 mails mientras el contador de bloques
 * seguía subiendo. El endpoint /scroll está hecho justamente para exportar la
 * base completa: entrega un token en el header X-VTEX-MD-TOKEN y con eso se
 * sigue paginando sin tope. Es secuencial por diseño (cada página depende del
 * token de la anterior), así que no se puede paralelizar.
 *
 * Reanudable: guarda el avance cada RESUME_EVERY páginas, así una cancelación
 * no tira a la basura lo ya bajado — al re-ejecutar arranca desde ahí.
 *
 * ⚠ La salida CONTIENE DATOS PERSONALES: va a private-out/ (gitignored) y de
 * ahí solo al repositorio PRIVADO.
 *
 * Uso: node src/fetch-emails.js
 */
const fs = require('fs');
const path = require('path');

const { getEnvOrThrow } = require('./vtex-client');
const { customerHash } = require('./customer-key');

const SIZE = Number(process.env.MD_PAGE_SIZE || 1000); // tope del scroll
const RESUME_EVERY = 25;
const OUT_DIR = path.join(__dirname, '..', 'private-out');
const OUT_FILE = path.join(OUT_DIR, 'hash-email.csv');
const STATE_FILE = path.join(OUT_DIR, '.scroll-state.json');
const BASE_DIR = path.join(OUT_DIR, 'base');
// Persistido en el repo PRIVADO junto al CSV: sobrevive de una corrida a otra.
const SYNC_FILE = path.join(OUT_DIR, '.sync-state.json');

// Campo de Master Data por el que se filtra el incremental. Configurable por si
// la cuenta usa otro nombre; el probe de abajo avisa si no existe.
const SINCE_FIELD = process.env.MD_SINCE_FIELD || 'updatedIn';
// Margen hacia atrás: Master Data no es inmediatamente consistente y el reloj
// del runner no es el de VTEX. Un día de solape cuesta poco y evita agujeros.
const OVERLAP_DAYS = Number(process.env.MD_OVERLAP_DAYS || 1);

function baseUrl() {
  const { account, environment } = getEnvOrThrow();
  return `https://${account}.${environment}.com.br`;
}
function headers() {
  const { appKey, appToken } = getEnvOrThrow();
  return {
    'X-VTEX-API-AppKey': appKey,
    'X-VTEX-API-AppToken': appToken,
    Accept: 'application/vnd.vtex.ds.v10+json',
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Una página del scroll. Devuelve { rows, token }. */
async function scrollPage(token, since, retries = 5) {
  let url;
  if (token) {
    url = `${baseUrl()}/api/dataentities/CL/scroll?_token=${encodeURIComponent(token)}`;
  } else {
    url = `${baseUrl()}/api/dataentities/CL/scroll?_fields=email,document&_size=${SIZE}`;
    if (since) url += `&_where=${encodeURIComponent(`${SINCE_FIELD}>${since}`)}`;
  }

  for (let a = 0; a <= retries; a++) {
    try {
      const res = await fetch(url, { headers: headers() });
      if (res.ok) {
        return {
          rows: await res.json(),
          token: res.headers.get('x-vtex-md-token') || res.headers.get('X-VTEX-MD-TOKEN') || null,
        };
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(`VTEX ${res.status}: el token no tiene permiso sobre Master Data (entidad CL).`);
      }
    } catch (e) {
      if (a === retries || /permiso/.test(e.message)) throw e;
    }
    await sleep(700 * Math.pow(2, a) + Math.random() * 200);
  }
  throw new Error('No se pudo traer la página del scroll');
}

/**
 * Comprueba que Master Data acepte el filtro antes de largar el scroll entero.
 * Si el campo no existe o la sintaxis no le gusta, la API devuelve un error y
 * conviene enterarse ahora y no después de bajar media base equivocada.
 */
async function incrementalFunciona(since) {
  const url = `${baseUrl()}/api/dataentities/CL/search?_fields=email&_where=${
    encodeURIComponent(`${SINCE_FIELD}>${since}`)}`;
  try {
    const res = await fetch(url, { headers: { ...headers(), 'REST-Range': 'resources=0-0' } });
    if (res.ok) return true;
    console.warn(`⚠ Master Data rechazó el filtro por ${SINCE_FIELD} (HTTP ${res.status}).`);
  } catch (e) {
    console.warn(`⚠ No se pudo verificar el filtro por ${SINCE_FIELD}: ${e.message}`);
  }
  return false;
}

/** Desde cuándo pedir. null = base completa. */
function watermark() {
  if (process.env.FULL_RESYNC === 'true') {
    console.log('FULL_RESYNC=true: se relee la base entera.');
    return null;
  }
  const manual = (process.env.MD_SINCE || '').trim();
  if (manual) return manual;
  if (!fs.existsSync(SYNC_FILE)) return null;
  if (!fs.existsSync(OUT_FILE) && !fs.existsSync(BASE_DIR)) return null;
  try {
    const w = JSON.parse(fs.readFileSync(SYNC_FILE, 'utf8')).lastSync;
    if (!w) return null;
    const d = new Date(w);
    d.setUTCDate(d.getUTCDate() - OVERLAP_DAYS);
    return d.toISOString().slice(0, 10);
  } catch { return null; }
}

/**
 * La base previa llega repartida en base/NN.csv con columnas email,dni — sin
 * el hash, que se recalcula acá. Guardar 5,1M de hashes costaba 65 bytes por
 * fila (~330MB) para algo que se deriva del mail en unos segundos.
 */
function loadBaseShards(map) {
  if (!fs.existsSync(BASE_DIR)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(BASE_DIR).filter((x) => x.endsWith('.csv'))) {
    const lines = fs.readFileSync(path.join(BASE_DIR, f), 'utf8').split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const c = lines[i].split(',');
      const email = (c[0] || '').trim().replace(/^"|"$/g, '');
      if (!email) continue;
      const h = customerHash({ clientProfileData: { email } });
      if (!h) continue;
      map.set(h, { email, dni: (c[1] || '').trim().replace(/^"|"$/g, '') });
      n += 1;
    }
  }
  return n;
}

function loadExisting() {
  const map = new Map();
  const desdePedazos = loadBaseShards(map);
  if (desdePedazos) console.log(`Base previa: ${desdePedazos.toLocaleString('es-AR')} clientes desde base/.`);

  // Un hash-email.csv suelto es lo que deja una corrida interrumpida de este
  // mismo script; pisa a la base porque es más reciente.
  if (fs.existsSync(OUT_FILE)) {
    const lines = fs.readFileSync(OUT_FILE, 'utf8').split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      if (cols[0]) map.set(cols[0], { email: cols[1] || '', dni: cols[2] || '' });
    }
  }
  let token = null;
  if (fs.existsSync(STATE_FILE)) {
    try { token = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).token || null; } catch { /* estado corrupto: se empieza de cero */ }
  }
  return { map, token };
}

function saveSync(startedAt) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(SYNC_FILE, JSON.stringify({ lastSync: startedAt, field: SINCE_FIELD }, null, 2));
}

function save(map, token) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const q = (v) => (/[",\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : v);
  const out = ['hash,email,dni'];
  for (const [h, v] of map) out.push(`${h},${q(v.email || '')},${q(v.dni || '')}`);
  fs.writeFileSync(OUT_FILE, out.join('\n') + '\n');
  fs.writeFileSync(STATE_FILE, JSON.stringify({ token, savedAt: new Date().toISOString(), count: map.size }));
}

async function main() {
  const startedAt = new Date().toISOString();
  const { map, token: resumeToken } = loadExisting();
  const antes = map.size;
  if (antes) console.log(`Partiendo de ${antes.toLocaleString('es-AR')} mails ya conocidos.`);

  // Solo tiene sentido pedir el delta si hay una base previa sobre la que
  // aplicarlo: sin CSV de partida, un incremental dejaría la base incompleta.
  let since = watermark();
  if (since && !antes) {
    console.log('Hay marca de tiempo pero no hay CSV de partida: se lee la base completa.');
    since = null;
  }
  if (since && !(await incrementalFunciona(since))) {
    console.warn('  → se cae a la lectura completa.');
    since = null;
  }

  // El token manda: si viene de una corrida cortada, continúa AQUELLA lectura,
  // sea la que haya sido. El filtro solo se aplica al pedir la primera página.
  console.log(resumeToken
    ? 'Reanudando la lectura que quedó a medias (Master Data · scroll)…'
    : since
      ? `Leyendo SOLO los clientes con ${SINCE_FIELD} > ${since} (Master Data · scroll)…`
      : 'Leyendo la base de clientes COMPLETA (Master Data · scroll)…');

  let token = resumeToken;
  let pages = 0;
  let rowsSeen = 0;
  const t0 = Date.now();

  for (;;) {
    const { rows, token: next } = await scrollPage(token, since);
    if (!rows || !rows.length) break;

    rowsSeen += rows.length;
    for (const r of rows) {
      const email = r?.email;
      if (!email) continue; // el hash se deriva del email: sin email no hay clave
      const h = customerHash({ clientProfileData: { email } });
      if (h) map.set(h, { email: String(email).toLowerCase().trim(), dni: String(r?.document || '').trim() });
    }

    token = next;
    pages += 1;
    if (pages % RESUME_EVERY === 0) {
      save(map, token);
      const mins = ((Date.now() - t0) / 60000).toFixed(1);
      console.log(`  ${rowsSeen.toLocaleString('es-AR')} clientes leídos · ${map.size.toLocaleString('es-AR')} mails · ${mins} min`);
    }
    if (!token) break; // el scroll se agotó
  }

  save(map, null);
  // La marca es el arranque de ESTA corrida, no el final: cualquier cliente
  // modificado mientras el scroll avanzaba entra en el próximo delta.
  saveSync(startedAt);

  const withDni = [...map.values()].filter((v) => v.dni).length;
  console.log(`\n✅ ${map.size.toLocaleString('es-AR')} mails (${withDni.toLocaleString('es-AR')} con DNI) en ${OUT_FILE}`);
  if (since) console.log(`   ${(map.size - antes).toLocaleString('es-AR')} nuevos en este delta.`);
  console.log(`   ${rowsSeen.toLocaleString('es-AR')} registros recorridos en ${((Date.now() - t0) / 60000).toFixed(1)} min.`);
  console.log(`   Próxima corrida: solo lo modificado desde ${startedAt.slice(0, 10)}.`);
  console.log('   CONTIENE PII — no commitear al repo público.');
}

main().catch((err) => {
  console.error('fetch-emails falló:', err.message);
  process.exit(1);
});

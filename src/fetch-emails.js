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
async function scrollPage(token, retries = 5) {
  const url = token
    ? `${baseUrl()}/api/dataentities/CL/scroll?_token=${encodeURIComponent(token)}`
    : `${baseUrl()}/api/dataentities/CL/scroll?_fields=email&_size=${SIZE}`;

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

function loadExisting() {
  const map = new Map();
  if (fs.existsSync(OUT_FILE)) {
    const lines = fs.readFileSync(OUT_FILE, 'utf8').split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].indexOf(',');
      if (c > 0) map.set(lines[i].slice(0, c), lines[i].slice(c + 1));
    }
  }
  let token = null;
  if (fs.existsSync(STATE_FILE)) {
    try { token = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).token || null; } catch { /* estado corrupto: se empieza de cero */ }
  }
  return { map, token };
}

function save(map, token) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = ['hash,email'];
  for (const [h, e] of map) out.push(`${h},${e}`);
  fs.writeFileSync(OUT_FILE, out.join('\n') + '\n');
  fs.writeFileSync(STATE_FILE, JSON.stringify({ token, savedAt: new Date().toISOString(), count: map.size }));
}

async function main() {
  const { map, token: resumeToken } = loadExisting();
  if (map.size) console.log(`Reanudando: ya había ${map.size.toLocaleString('es-AR')} mails.`);
  console.log('Leyendo la base de clientes (Master Data · scroll)…');

  let token = resumeToken;
  let pages = 0;
  let rowsSeen = 0;
  const t0 = Date.now();

  for (;;) {
    const { rows, token: next } = await scrollPage(token);
    if (!rows || !rows.length) break;

    rowsSeen += rows.length;
    for (const r of rows) {
      const email = r?.email;
      if (!email) continue;
      const h = customerHash({ clientProfileData: { email } });
      if (h) map.set(h, String(email).toLowerCase().trim());
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
  console.log(`\n✅ ${map.size.toLocaleString('es-AR')} mails en ${OUT_FILE}`);
  console.log(`   ${rowsSeen.toLocaleString('es-AR')} registros recorridos en ${((Date.now() - t0) / 60000).toFixed(1)} min.`);
  console.log('   CONTIENE PII — no commitear al repo público.');
}

main().catch((err) => {
  console.error('fetch-emails falló:', err.message);
  process.exit(1);
});

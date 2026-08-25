'use strict';

/**
 * PRIVADO — construye el mapeo hash -> email leyendo la base de clientes de
 * VTEX Master Data (entidad CL), NO los pedidos.
 *
 * Por qué así: el hash que usa el dashboard es SHA-256 del email real, o sea
 * que alcanza con tener la lista de emails para reconstruir el mapeo entero.
 * Master Data se pagina de a 100 registros: ~2.300 llamadas livianas para una
 * base de 230k clientes, contra las ~866.000 llamadas que costaría volver a
 * pedir el detalle de cada pedido. Minutos en vez de una hora.
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

const PAGE = 100; // tope de Master Data v1
const CONCURRENCY = Number(process.env.MD_CONCURRENCY || 12);
const OUT_DIR = path.join(__dirname, '..', 'private-out');

function headers() {
  const { appKey, appToken } = getEnvOrThrow();
  return {
    'X-VTEX-API-AppKey': appKey,
    'X-VTEX-API-AppToken': appToken,
    Accept: 'application/vnd.vtex.ds.v10+json',
    'Content-Type': 'application/json',
  };
}

function baseUrl() {
  const { account, environment } = getEnvOrThrow();
  return `https://${account}.${environment}.com.br`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Trae un bloque [from, to] de la entidad CL. Devuelve { rows, total }. */
async function fetchPage(from, to, retries = 5) {
  const url = `${baseUrl()}/api/dataentities/CL/search?_fields=email`;
  for (let a = 0; a <= retries; a++) {
    try {
      const res = await fetch(url, { headers: { ...headers(), 'REST-Range': `resources=${from}-${to}` } });
      if (res.ok) {
        // "resources 0-99/228431" -> el total está después de la barra.
        const cr = res.headers.get('rest-content-range') || res.headers.get('REST-Content-Range') || '';
        const total = Number(String(cr).split('/')[1]) || null;
        return { rows: await res.json(), total };
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(`VTEX ${res.status}: el token no tiene permiso sobre Master Data (entidad CL).`);
      }
    } catch (e) {
      if (a === retries || /permiso/.test(e.message)) throw e;
    }
    await sleep(600 * Math.pow(2, a) + Math.random() * 200);
  }
  throw new Error(`No se pudo traer el bloque ${from}-${to}`);
}

async function main() {
  console.log('Leyendo la base de clientes desde VTEX Master Data (entidad CL)…');

  const first = await fetchPage(0, PAGE - 1);
  const total = first.total;
  if (!total) {
    console.error('No se pudo leer el total de clientes (header REST-Content-Range ausente).');
    process.exit(1);
  }
  console.log(`Clientes en Master Data: ${total.toLocaleString('es-AR')}`);

  const map = new Map();
  const add = (rows) => {
    for (const r of rows || []) {
      const email = r?.email;
      if (!email) continue;
      // Se hashea igual que el pipeline para que el mapeo case con el índice.
      const h = customerHash({ clientProfileData: { email } });
      if (h) map.set(h, String(email).toLowerCase().trim());
    }
  };
  add(first.rows);

  const starts = [];
  for (let s = PAGE; s < total; s += PAGE) starts.push(s);

  let done = 0;
  let failed = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < starts.length) {
      const s = starts[cursor++];
      try {
        const { rows } = await fetchPage(s, Math.min(s + PAGE - 1, total - 1));
        add(rows);
      } catch {
        failed += 1;
      }
      if (++done % 200 === 0) console.log(`  ${done}/${starts.length} bloques · ${map.size} mails`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, starts.length) }, worker));

  if (!map.size) {
    console.error('No se obtuvo ningún email.');
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = ['hash,email'];
  for (const [h, e] of map) out.push(`${h},${/[",\n]/.test(e) ? '"' + e.replace(/"/g, '""') + '"' : e}`);
  fs.writeFileSync(path.join(OUT_DIR, 'hash-email.csv'), out.join('\n') + '\n');

  console.log(`\n✅ ${map.size.toLocaleString('es-AR')} mails en private-out/hash-email.csv`);
  if (failed) console.warn(`⚠ ${failed} bloques fallaron; volver a correr el script los completa.`);
  console.log('   CONTIENE PII — no commitear al repo público.');
}

main().catch((err) => {
  console.error('fetch-emails falló:', err.message);
  process.exit(1);
});

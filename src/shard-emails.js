'use strict';

/**
 * PRIVADO — parte el mapeo de mails en dos juegos de archivos, porque tienen
 * usos distintos y tamaños incompatibles.
 *
 * El CSV entero (5,1M de clientes, ~487MB) no se puede publicar tal cual:
 *  - GitHub rechaza cualquier archivo de más de 100MB en el push;
 *  - la Contents API no sirve descargas de más de 100MB;
 *  - una función de Vercel no puede devolver más de ~4,5MB.
 * Y aunque se pudiera, no tiene sentido mandarle 487MB de PII al navegador.
 *
 * Se generan entonces:
 *
 *   base/NN.csv           email,dni — la base COMPLETA, sin el hash (que es
 *                         SHA-256 del mail, o sea derivable) para ahorrar 65
 *                         bytes por fila. Es el insumo del sync incremental:
 *                         sin esto habría que releer Master Data entero.
 *
 *   audiencias/NN.csv     hash,email,dni — SOLO los clientes que aparecen en
 *                         el índice de audiencias. Es lo único que el
 *                         dashboard puede llegar a pedir.
 *   audiencias/manifest.json  cuántos pedazos hay y cuántas filas.
 *
 * El reparto es por los primeros caracteres del hash, que es uniforme, así que
 * los pedazos salen parejos solos.
 *
 * ⚠ TODO lo que genera CONTIENE PII: vive en private-out/ (gitignored) y solo
 * se publica al repositorio PRIVADO.
 *
 * Uso: node src/shard-emails.js
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { customerHash } = require('./customer-key');

const PRIV = path.join(__dirname, '..', 'private-out');
const IN_FILE = path.join(PRIV, 'hash-email.csv');
const BASE_DIR = path.join(PRIV, 'base');
const AUD_DIR = path.join(PRIV, 'audiencias');
const AUDIENCE_INDEX = process.env.AUDIENCE_INDEX
  || path.join(__dirname, '..', 'docs', 'data', 'web', 'audience-index.json');

// Apuntamos a pedazos de ~2MB: entran holgados en el límite de Vercel y dejan
// margen para que la base de clientes crezca sin tener que rehacer esto.
const TARGET_BYTES = 2 * 1024 * 1024;
const BASE_SHARDS = 16;

const q = (v) => (/[",\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : v);

/** Cuántos pedazos hacen falta para que cada uno quede cerca de TARGET_BYTES. */
function shardCount(rows, bytesPerRow) {
  const n = Math.ceil((rows * bytesPerRow) / TARGET_BYTES);
  // Potencia de 16 para poder repartir por prefijo hexadecimal del hash.
  if (n <= 16) return 16;
  if (n <= 256) return 256;
  return 4096;
}

/** Prefijo hexadecimal del hash que corresponde a `total` pedazos. */
function shardOf(hash, total) {
  const chars = total === 16 ? 1 : total === 256 ? 2 : 3;
  return hash.slice(0, chars);
}

function writeShards(dir, groups, header) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  let bytes = 0;
  for (const [name, lines] of groups) {
    const body = header + '\n' + lines.join('\n') + '\n';
    fs.writeFileSync(path.join(dir, `${name}.csv`), body);
    bytes += Buffer.byteLength(body);
  }
  return bytes;
}

async function main() {
  if (!fs.existsSync(IN_FILE)) {
    console.error(`No existe ${IN_FILE}. Corré antes src/fetch-emails.js.`);
    process.exit(1);
  }

  // Los hashes que el dashboard puede llegar a pedir. Si el índice no está,
  // se genera igual la base y se avisa: no es motivo para abortar.
  let wanted = null;
  if (fs.existsSync(AUDIENCE_INDEX)) {
    const idx = JSON.parse(fs.readFileSync(AUDIENCE_INDEX, 'utf8'));
    wanted = new Set(idx.h || []);
    console.log(`Índice de audiencias: ${wanted.size.toLocaleString('es-AR')} clientes con pedidos.`);
  } else {
    console.warn('⚠ No hay audience-index.json: se genera la base pero no los archivos del dashboard.');
  }

  const baseGroups = new Map();
  for (let i = 0; i < BASE_SHARDS; i++) baseGroups.set(i.toString(16), []);

  const audRows = [];
  let total = 0, conDni = 0;

  // El archivo no entra en memoria: se lee línea por línea.
  const rl = readline.createInterface({ input: fs.createReadStream(IN_FILE), crlfDelay: Infinity });
  let first = true;
  for await (const line of rl) {
    if (first) { first = false; if (line.toLowerCase().startsWith('hash')) continue; }
    if (!line.trim()) continue;
    const c = line.split(',');
    const hash = (c[0] || '').trim();
    const email = (c[1] || '').trim().replace(/^"|"$/g, '');
    const dni = (c[2] || '').trim().replace(/^"|"$/g, '');
    if (!hash || !email) continue;

    total += 1;
    if (dni) conDni += 1;
    baseGroups.get(shardOf(hash, BASE_SHARDS)).push(`${q(email)},${q(dni)}`);
    if (wanted && wanted.has(hash)) audRows.push([hash, email, dni]);
  }

  const baseBytes = writeShards(BASE_DIR, baseGroups, 'email,dni');
  console.log(`\nbase/        ${BASE_SHARDS} pedazos · ${total.toLocaleString('es-AR')} clientes · ${(baseBytes / 1024 ** 2).toFixed(0)}MB`);
  console.log(`             (${(baseBytes / BASE_SHARDS / 1024 ** 2).toFixed(1)}MB por pedazo — el tope de GitHub son 100MB)`);

  if (!wanted) return;

  const n = shardCount(audRows.length, 100);
  const audGroups = new Map();
  for (const [hash, email, dni] of audRows) {
    const k = shardOf(hash, n);
    if (!audGroups.has(k)) audGroups.set(k, []);
    audGroups.get(k).push(`${hash},${q(email)},${q(dni)}`);
  }
  const audBytes = writeShards(AUD_DIR, audGroups, 'hash,email,dni');
  fs.writeFileSync(path.join(AUD_DIR, 'manifest.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    shards: [...audGroups.keys()].sort(),
    rows: audRows.length,
    withEmail: audRows.filter((r) => r[1]).length,
    withDni: audRows.filter((r) => r[2]).length,
  }, null, 2));

  const mayor = audGroups.size ? Math.max(...[...audGroups.values()].map((l) => l.join('\n').length)) : 0;
  console.log(`audiencias/  ${audGroups.size} pedazos · ${audRows.length.toLocaleString('es-AR')} clientes · ${(audBytes / 1024 ** 2).toFixed(1)}MB`);
  console.log(`             el más grande: ${(mayor / 1024 ** 2).toFixed(2)}MB (el tope de Vercel son ~4,5MB)`);
  console.log(`\nDe ${total.toLocaleString('es-AR')} clientes, ${audRows.length.toLocaleString('es-AR')} tienen pedidos (${conDni.toLocaleString('es-AR')} con DNI en la base).`);
  console.log('CONTIENE PII — no commitear al repo público.');
}

main().catch((e) => { console.error('shard-emails falló:', e.message); process.exit(1); });

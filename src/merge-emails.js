'use strict';

/**
 * PRIVADO — junta los hash,email que fue dejando el pipeline en
 * private-out/emails/*.csv con la base previa, y consolida todo en
 * private-out/hash-email.csv.
 *
 * Por qué existe: el email solo viene en el detalle de cada pedido, y el
 * pipeline ya pide ese detalle para todo. Antes había que volver a barrer VTEX
 * con un workflow aparte (tan caro como un backfill) solo para conseguir los
 * mails; ahora salen de la misma pasada, sin ninguna llamada extra.
 *
 * La salida sigue siendo un único CSV (no repartido): este script corre
 * ANTES de src/shard-emails.js, que es quien lo parte en pedazos publicables.
 * Con los 5,1M de clientes reales ese archivo intermedio pesa ~500MB, así que
 * NUNCA se commitea tal cual — vive solo en el runner, de paso hacia el shard.
 *
 * ⚠ La salida CONTIENE DATOS PERSONALES. private-out/ está en .gitignore y solo
 * se publica al repositorio PRIVADO configurado en PRIVATE_DATA_REPO.
 *
 * Uso: node src/merge-emails.js [base.csv | carpeta-base/]
 *   La base (opcional) es lo que ya está en el repo privado: un hash-email.csv
 *   suelto (formato viejo) o una carpeta base/ con pedazos email,dni (formato
 *   actual — ver src/shard-emails.js). Sin el hash en los pedazos, se
 *   recalcula acá con customerHash.
 */
const fs = require('fs');
const path = require('path');
const { customerHash } = require('./customer-key');

const EMAILS_DIR = path.join(__dirname, '..', 'private-out', 'emails');
const OUT_FILE = path.join(__dirname, '..', 'private-out', 'hash-email.csv');

/** Parsea hash,email,dni (dni opcional para archivos viejos). */
function parseCsv(text, map) {
  const lines = String(text).split(/\r?\n/);
  const start = (lines[0] || '').toLowerCase().includes('hash') ? 1 : 0;
  for (let i = start; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = splitCsvLine(lines[i]);
    const hash = (cols[0] || '').trim();
    const email = (cols[1] || '').trim();
    const dni = (cols[2] || '').trim();
    if (!hash || (!email && !dni)) continue;
    const prev = map.get(hash) || { email: '', dni: '' };
    // No se pisa un valor bueno con uno vacío al mergear días distintos.
    map.set(hash, { email: email || prev.email, dni: dni || prev.dni });
  }
}

function splitCsvLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Pedazos email,dni sin hash (formato actual del repo privado). */
function parseBaseShards(dir, map) {
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.csv'))) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const [email, dni] = splitCsvLine(lines[i]);
      const clean = (email || '').trim().replace(/^"|"$/g, '');
      if (!clean) continue;
      const h = customerHash({ clientProfileData: { email: clean } });
      if (h) map.set(h, { email: clean, dni: (dni || '').trim().replace(/^"|"$/g, '') });
    }
  }
}

function main() {
  const base = process.argv[2];
  const map = new Map();

  if (base && fs.existsSync(base)) {
    if (fs.statSync(base).isDirectory()) {
      parseBaseShards(base, map);
      console.log(`Base existente (pedazos): ${map.size.toLocaleString('es-AR')} mails`);
    } else {
      parseCsv(fs.readFileSync(base, 'utf8'), map);
      console.log(`Base existente: ${map.size.toLocaleString('es-AR')} mails`);
    }
  }
  const before = map.size;

  if (fs.existsSync(EMAILS_DIR)) {
    const files = fs.readdirSync(EMAILS_DIR).filter((f) => f.endsWith('.csv')).sort();
    for (const f of files) parseCsv(fs.readFileSync(path.join(EMAILS_DIR, f), 'utf8'), map);
    console.log(`Días incorporados: ${files.length}`);
  }

  if (!map.size) {
    console.log('No hay mails para consolidar.');
    return;
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  const q = (v) => (/[",\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : v);
  const out = ['hash,email,dni'];
  for (const [h, v] of map) out.push(`${h},${q(v.email || '')},${q(v.dni || '')}`);
  fs.writeFileSync(OUT_FILE, out.join('\n') + '\n');

  console.log(`✅ ${OUT_FILE}: ${map.size} mails (${map.size - before} nuevos). CONTIENE PII.`);
}

main();

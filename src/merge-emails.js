'use strict';

/**
 * PRIVADO — junta los hash,email que fue dejando el pipeline en
 * private-out/emails/*.csv y los consolida en private-out/hash-email.csv.
 *
 * Por qué existe: el email solo viene en el detalle de cada pedido, y el
 * pipeline ya pide ese detalle para todo. Antes había que volver a barrer VTEX
 * con un workflow aparte (tan caro como un backfill) solo para conseguir los
 * mails; ahora salen de la misma pasada, sin ninguna llamada extra.
 *
 * ⚠ La salida CONTIENE DATOS PERSONALES. private-out/ está en .gitignore y solo
 * se publica al repositorio PRIVADO configurado en PRIVATE_DATA_REPO.
 *
 * Uso: node src/merge-emails.js [archivo-base.csv]
 *   El archivo base (opcional) es el hash-email.csv que ya está en el repo
 *   privado: se arranca desde ahí para no perder los días viejos.
 */
const fs = require('fs');
const path = require('path');

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

function main() {
  const base = process.argv[2];
  const map = new Map();

  if (base && fs.existsSync(base)) {
    parseCsv(fs.readFileSync(base, 'utf8'), map);
    console.log(`Base existente: ${map.size} mails`);
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

'use strict';

/**
 * Corre fetch-day.js para cada día en [from, to] (inclusive, fechas AR).
 * Resumible: si un día ya tiene archivo, lo saltea (ver fetch-day.js), así que
 * se puede cortar y volver a correr sin perder progreso ni duplicar trabajo.
 * Pensado para dispararse en tandas manuales (como backfill-web-recompra.yml de
 * AppDash) porque el volumen de pedidos hace que rangos largos no entren en el
 * límite de 6hs de un job de GitHub Actions.
 *
 * Uso: node src/backfill.js 2026-01-01 2026-01-31
 */
const { fetchDay, writeDayEmails } = require('./fetch-day');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'data', 'daily');

function eachDate(from, to) {
  const out = [];
  let d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 86400000);
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const [from, to] = args.filter((a) => !a.startsWith('--'));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) {
    console.error('Uso: node src/backfill.js YYYY-MM-DD YYYY-MM-DD [--force]');
    process.exit(1);
  }

  const dates = eachDate(from, to);
  console.log(`Backfill ${from} -> ${to} (${dates.length} días)${force ? ' [--force: rehace los ya existentes]' : ''}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const date of dates) {
    const outPath = path.join(OUT_DIR, `${date}.json`);
    if (fs.existsSync(outPath) && !force) {
      console.log(`  = ${date} (ya existe, salteado)`);
      continue;
    }
    const day = await fetchDay(date);
    fs.writeFileSync(outPath, JSON.stringify(day));
    const nEmails = writeDayEmails(date, day._emails);
    console.log(`  ✓ ${date}: escaneados=${day.scanned} web=${day.webOrders} emails=${nEmails}`);
  }

  console.log('Backfill terminado.');
}

main().catch((err) => {
  console.error('Backfill falló:', err.message);
  process.exit(1);
});

'use strict';

/**
 * Parte un rango de fechas en tramos mensuales y los imprime como JSON, para
 * alimentar el `strategy.matrix` del workflow de backfill: cada tramo corre en
 * su propio job de GitHub Actions, en paralelo.
 *
 * Uso: node src/plan-chunks.js 2026-01-01 2026-08-24
 * Sale: [{"id":"2026-01","from":"2026-01-01","to":"2026-01-31"}, ...]
 */
function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function planChunks(from, to) {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new Error('Fechas inválidas');
  if (start > end) throw new Error('La fecha de inicio es posterior a la de fin');

  const chunks = [];
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth();

  while (true) {
    const monthStart = new Date(Date.UTC(y, m, 1));
    const monthEnd = new Date(Date.UTC(y, m, lastDayOfMonth(y, m)));
    const chunkFrom = monthStart < start ? start : monthStart;
    const chunkTo = monthEnd > end ? end : monthEnd;

    chunks.push({
      id: `${y}-${String(m + 1).padStart(2, '0')}`,
      from: chunkFrom.toISOString().slice(0, 10),
      to: chunkTo.toISOString().slice(0, 10),
    });

    if (monthEnd >= end) break;
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }
  return chunks;
}

if (require.main === module) {
  const [from, to] = process.argv.slice(2);
  process.stdout.write(JSON.stringify(planChunks(from, to)));
}

module.exports = { planChunks };

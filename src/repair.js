'use strict';

/**
 * Vuelve a buscar SOLO los pedidos que quedaron sin traer.
 *
 * Cuando el detalle de un pedido falla tras todos los reintentos, fetch-day.js
 * igual escribe el archivo del día (para no perder los ~2000 que sí salieron) y
 * deja anotados los IDs caídos en `failedOrderIds`. Como el archivo existe, un
 * re-run del backfill saltea ese día — así que sin este script esos pedidos se
 * perderían para siempre.
 *
 * Este script recorre los días con `failedOrderIds`, pide únicamente esos IDs,
 * los suma al agregado ya guardado y limpia la lista. Es idempotente: correrlo
 * de más no duplica nada, porque solo procesa lo que sigue marcado como fallado.
 *
 * Uso:
 *   node src/repair.js                       # todos los días con pendientes
 *   node src/repair.js 2026-01-01 2026-01-31 # solo ese rango
 */
const fs = require('fs');
const path = require('path');

const { getOrder, forEachLimit } = require('./vtex-client');
const { accFromDayFile, applyOrderToAcc, finalizeDay, OUT_DIR, DETAIL_CONCURRENCY } = require('./fetch-day');

const MAX_PASSES = Number(process.env.REPAIR_PASSES || 2);

function listDayFiles(from, to) {
  if (!fs.existsSync(OUT_DIR)) return [];
  return fs
    .readdirSync(OUT_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.slice(0, 10))
    .filter((d) => (!from || d >= from) && (!to || d <= to))
    .sort();
}

async function repairDay(date) {
  const file = path.join(OUT_DIR, `${date}.json`);
  const day = JSON.parse(fs.readFileSync(file, 'utf8'));
  const pending = day.failedOrderIds || [];
  if (!pending.length) return null;

  const acc = accFromDayFile(day);
  const stillFailed = [];
  let recovered = 0;

  await forEachLimit(pending, DETAIL_CONCURRENCY, async (orderId) => {
    let full;
    try {
      full = await getOrder(orderId);
    } catch {
      stillFailed.push(orderId);
      return;
    }
    // Un pedido que no es del canal web se considera resuelto igual: se pudo
    // consultar y quedó claro que no cuenta. Lo que no se puede es dejarlo
    // pendiente para siempre.
    applyOrderToAcc(acc, full);
    recovered += 1;
  });

  const out = finalizeDay(acc, {
    date,
    scanned: day.scanned,
    detailsRequested: day.detailsRequested,
    failedOrderIds: stillFailed,
    unknownStatuses: day.unknownStatuses || [],
    statusCounts: day.statusCounts || {},
  });
  fs.writeFileSync(file, JSON.stringify(out));

  return { recovered, stillFailed: stillFailed.length };
}

async function main() {
  const [from, to] = process.argv.slice(2);
  const days = listDayFiles(from, to);
  if (!days.length) {
    console.log('No hay días para revisar.');
    return;
  }

  let totalRecovered = 0;
  let totalPending = 0;

  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    let passRecovered = 0;
    let passPending = 0;
    const touched = [];

    for (const date of days) {
      const res = await repairDay(date);
      if (!res) continue;
      touched.push(`${date} (+${res.recovered}${res.stillFailed ? `, quedan ${res.stillFailed}` : ''})`);
      passRecovered += res.recovered;
      passPending += res.stillFailed;
    }

    if (!touched.length) {
      if (pass === 1) console.log('✓ No había pedidos pendientes de reintentar.');
      break;
    }

    console.log(`Pasada ${pass}: recuperados ${passRecovered} · pendientes ${passPending}`);
    for (const t of touched) console.log(`   ${t}`);
    totalRecovered += passRecovered;
    totalPending = passPending;
    if (!passPending) break;
  }

  if (totalPending) {
    console.warn(`⚠ Quedan ${totalPending} pedidos sin recuperar tras ${MAX_PASSES} pasadas. ` +
      'Siguen anotados en los archivos diarios; volver a correr este script más tarde los reintenta.');
  } else if (totalRecovered) {
    console.log(`✓ Todo recuperado (${totalRecovered} pedidos).`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('repair falló:', err.message);
    process.exit(1);
  });
}

module.exports = { repairDay, listDayFiles };

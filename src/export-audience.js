'use strict';

/**
 * PRIVADO — genera el mapeo hash -> email de los clientes del canal web en un
 * rango de fechas, para poder convertir una audiencia armada en el dashboard
 * (que trabaja con hashes) en una lista de mails real.
 *
 * ⚠ La salida CONTIENE DATOS PERSONALES. Por eso:
 *   - se escribe en private-out/, que está en .gitignore;
 *   - el workflow que lo corre la sube como ARTIFACT de GitHub Actions
 *     (solo accesible para quien tiene acceso al repo), nunca a docs/;
 *   - nunca debe commitearse ni publicarse en el sitio.
 *
 * Costo: el email solo viene en el detalle de cada pedido, y el pipeline
 * público a propósito no lo guarda. Así que esto vuelve a pedirle a VTEX el
 * detalle del rango pedido — es tan caro como una pasada de backfill. Por eso
 * toma un rango y conviene correrlo por tramos, no sobre todo el historial.
 *
 * Uso: node src/export-audience.js 2026-08-01 2026-08-24
 */
const fs = require('fs');
const path = require('path');

const { iterateAllOrders, getOrder, forEachLimit } = require('./vtex-client');
const { orderChannel, isIncludedStatus } = require('./classify');
const { customerHash } = require('./customer-key');
const { arDayRange } = require('./fetch-day');

const channelMap = require('../config/channel-map.json');
const statusFilter = require('../config/status-filter.json');

const OUT_DIR = path.join(__dirname, '..', 'private-out');

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

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const [from, to] = process.argv.slice(2);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) {
    console.error('Uso: node src/export-audience.js YYYY-MM-DD YYYY-MM-DD');
    process.exit(1);
  }

  const CONCURRENCY = Number(process.env.DETAIL_CONCURRENCY || 20);
  const map = new Map(); // hash -> { email, orders }

  for (const date of eachDate(from, to)) {
    const { fromISO, toISO } = arDayRange(date);

    const ids = [];
    for await (const summary of iterateAllOrders({ fromISO, toISO })) {
      if (isIncludedStatus(summary, statusFilter)) ids.push(summary.orderId);
    }

    let dayCount = 0;
    await forEachLimit(ids, CONCURRENCY, async (orderId) => {
      let full;
      try {
        full = await getOrder(orderId);
      } catch {
        return;
      }
      if (orderChannel(full, channelMap) !== 'web') return;

      const hash = customerHash(full);
      const email = full.clientProfileData?.email;
      if (!hash || !email) return;
      const existing = map.get(hash);
      if (existing) existing.orders += 1;
      else map.set(hash, { email, orders: 1 });
      dayCount += 1;
    });

    console.log(`  ✓ ${date} (${dayCount} pedidos web · ${map.size} clientes acumulados)`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `hash-email-${from}_${to}.csv`);
  const lines = ['hash,email,pedidos'];
  for (const [hash, v] of map) lines.push([hash, csvCell(v.email), v.orders].join(','));
  fs.writeFileSync(outPath, lines.join('\n') + '\n');

  console.log(`\n✅ ${outPath}`);
  console.log(`   ${map.size} clientes únicos. CONTIENE PII — no commitear, no publicar.`);
}

main().catch((err) => {
  console.error('export-audience falló:', err.message);
  process.exit(1);
});

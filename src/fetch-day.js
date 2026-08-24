'use strict';

/**
 * Trae y clasifica TODOS los pedidos del canal web de un día calendario
 * argentino (UTC-3), y escribe docs/data/web/daily/YYYY-MM-DD.json con los
 * agregados por segmento (food/non-food/marketplace/quickcommerce). No pisa
 * el archivo si ya existe, salvo --force (así el backfill es resumible: si se
 * corta a mitad de camino, retomar solo vuelve a pedir los días faltantes).
 *
 * Uso: node src/fetch-day.js 2026-08-24 [--force]
 */
const fs = require('fs');
const path = require('path');

const { iterateAllOrders, getOrder } = require('./vtex-client');
const { orderChannel, isIncludedStatus, classifyOrder } = require('./classify');
const { customerHash } = require('./customer-key');

const channelMap = require('../config/channel-map.json');
const statusFilter = require('../config/status-filter.json');
const segmentMap = require('../config/segment-map.json');

const SEGMENTS = segmentMap.tabs.list;
const OUT_DIR = path.join(__dirname, '..', 'docs', 'data', 'web', 'daily');

function arDayRange(dateStr) {
  // Medianoche AR (UTC-3) del día `dateStr` hasta medianoche AR del día siguiente.
  const from = new Date(`${dateStr}T03:00:00.000Z`);
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  return { fromISO: from.toISOString(), toISO: to.toISOString() };
}

function emptySegmentAgg() {
  return { orders: 0, gmv: 0, units: 0, customerCounts: {}, segmentParticipation: {} };
}

function defaultMarketingSegment(order) {
  return order.clientProfileData?.customerClass || order.marketingData?.utmSource || 'sin_segmento';
}

async function fetchDay(dateStr) {
  const { fromISO, toISO } = arDayRange(dateStr);
  const segments = Object.fromEntries(SEGMENTS.map((s) => [s, emptySegmentAgg()]));
  const unknownStatuses = new Set();
  let scanned = 0;
  let webOrders = 0;

  for await (const summary of iterateAllOrders({ fromISO, toISO })) {
    scanned += 1;

    if (!statusFilter.includeStatuses.includes(summary.status) && !statusFilter.excludeStatuses.includes(summary.status)) {
      unknownStatuses.add(summary.status);
    }
    if (!isIncludedStatus(summary, statusFilter)) continue;

    const full = await getOrder(summary.orderId);
    if (orderChannel(full, channelMap) !== 'web') continue;
    webOrders += 1;

    const view = classifyOrder(full, segmentMap);
    const agg = segments[view.bucket];
    agg.orders += 1;
    agg.gmv += view.gmv;
    for (const item of view.items) agg.units += Number(item.quantity) || 0;

    const hash = customerHash(full);
    if (hash) agg.customerCounts[hash] = (agg.customerCounts[hash] || 0) + 1;

    const seg = defaultMarketingSegment(full);
    agg.segmentParticipation[seg] = agg.segmentParticipation[seg] || { orders: 0, gmv: 0 };
    agg.segmentParticipation[seg].orders += 1;
    agg.segmentParticipation[seg].gmv += view.gmv;
  }

  return {
    date: dateStr,
    generatedAt: new Date().toISOString(),
    scanned,
    webOrders,
    unknownStatuses: [...unknownStatuses],
    segments,
  };
}

async function main() {
  const dateArg = process.argv[2];
  const force = process.argv.includes('--force');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateArg || '')) {
    console.error('Uso: node src/fetch-day.js YYYY-MM-DD [--force]');
    process.exit(1);
  }

  const outPath = path.join(OUT_DIR, `${dateArg}.json`);
  if (fs.existsSync(outPath) && !force) {
    console.log(`Ya existe ${outPath}, salteando (usar --force para rehacerlo).`);
    return;
  }

  console.log(`Procesando ${dateArg}...`);
  const day = await fetchDay(dateArg);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(day, null, 2));
  console.log(`OK ${dateArg}: escaneados=${day.scanned} web=${day.webOrders}`);
  if (day.unknownStatuses.length) console.warn('Statuses desconocidos:', day.unknownStatuses);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('fetch-day falló:', err.message);
    process.exit(1);
  });
}

module.exports = { fetchDay, arDayRange };

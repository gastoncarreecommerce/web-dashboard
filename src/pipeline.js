'use strict';

const fs = require('fs');
const path = require('path');

const { iterateAllOrders, getOrder } = require('./vtex-client');
const { orderChannel, isIncludedStatus, splitOrderByCategory } = require('./classify');
const { computeAllMetrics } = require('./metrics');

const channelMap = require('../config/channel-map.json');
const statusFilter = require('../config/status-filter.json');
const categoryMap = require('../config/category-map.json');

const TARGET_CHANNEL = process.env.PIPELINE_CHANNEL || 'web';
const LOOKBACK_DAYS = Number(process.env.PIPELINE_LOOKBACK_DAYS || 400); // ventana amplia para repurchase/frecuencia

async function fetchAndClassifyOrders() {
  const to = new Date();
  const from = new Date(to.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const buckets = { food: [], 'non-food': [] };
  const unknownStatuses = new Set();
  let scanned = 0;
  let matchedChannel = 0;

  for await (const summary of iterateAllOrders({ fromISO: from.toISOString(), toISO: to.toISOString() })) {
    scanned += 1;
    const channel = orderChannel(summary, channelMap);
    if (channel !== TARGET_CHANNEL) continue;
    matchedChannel += 1;

    if (!statusFilter.includeStatuses.includes(summary.status) && !statusFilter.excludeStatuses.includes(summary.status)) {
      unknownStatuses.add(summary.status);
    }
    if (!isIncludedStatus(summary, statusFilter)) continue;

    const full = await getOrder(summary.orderId);
    const views = splitOrderByCategory(full, categoryMap);
    for (const v of views) buckets[v.bucket].push(v);
  }

  return { buckets, scanned, matchedChannel, unknownStatuses: [...unknownStatuses] };
}

function writeJson(relPath, data) {
  const outPath = path.join(__dirname, '..', relPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
}

async function main() {
  const { buckets, scanned, matchedChannel, unknownStatuses } = await fetchAndClassifyOrders();

  for (const bucket of ['food', 'non-food']) {
    const metrics = computeAllMetrics(buckets[bucket]);
    writeJson(`docs/data/${TARGET_CHANNEL}/${bucket}/metrics.json`, {
      generatedAt: new Date().toISOString(),
      channel: TARGET_CHANNEL,
      bucket,
      lookbackDays: LOOKBACK_DAYS,
      mixedOrderStrategy: categoryMap.mixedOrderStrategy,
      ...metrics,
    });
  }

  writeJson(`docs/data/${TARGET_CHANNEL}/_meta/run-info.json`, {
    generatedAt: new Date().toISOString(),
    channel: TARGET_CHANNEL,
    scannedOrders: scanned,
    matchedChannelOrders: matchedChannel,
    unknownStatuses,
    warning:
      unknownStatuses.length > 0
        ? 'Hay statuses de VTEX no clasificados en config/status-filter.json — revisar y agregarlos a include/exclude.'
        : null,
  });

  console.log(`Pipeline OK. Canal=${TARGET_CHANNEL}. Escaneados=${scanned}. Del canal=${matchedChannel}.`);
  if (unknownStatuses.length) {
    console.warn('Statuses desconocidos encontrados:', unknownStatuses);
  }
}

main().catch((err) => {
  console.error('Pipeline falló:', err.message);
  process.exit(1);
});

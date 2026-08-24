'use strict';

const fs = require('fs');
const path = require('path');

const { iterateAllOrders, getOrder } = require('./vtex-client');
const { orderChannel, isIncludedStatus, classifyOrder } = require('./classify');
const { computeAllMetrics } = require('./metrics');

const channelMap = require('../config/channel-map.json');
const statusFilter = require('../config/status-filter.json');
const segmentMap = require('../config/segment-map.json');

const TARGET_CHANNEL = process.env.PIPELINE_CHANNEL || 'web';
const LOOKBACK_DAYS = Number(process.env.PIPELINE_LOOKBACK_DAYS || 400); // ventana amplia para repurchase/frecuencia
const SEGMENTS = segmentMap.tabs.list;

async function fetchAndClassifyOrders() {
  const to = new Date();
  const from = new Date(to.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  const buckets = Object.fromEntries(SEGMENTS.map((s) => [s, []]));
  const unknownStatuses = new Set();
  let scanned = 0;
  let matchedChannel = 0;
  let unknownChannel = 0;

  for await (const summary of iterateAllOrders({ fromISO: from.toISOString(), toISO: to.toISOString() })) {
    scanned += 1;

    // El status SÍ viene en el resumen de /orders (list), así que filtramos acá antes de
    // pagar el costo de traer el detalle completo.
    if (!statusFilter.includeStatuses.includes(summary.status) && !statusFilter.excludeStatuses.includes(summary.status)) {
      unknownStatuses.add(summary.status);
    }
    if (!isIncludedStatus(summary, statusFilter)) continue;

    // customData.customApps (de donde sale el canal web/app) NO viene en el resumen de list,
    // solo en el detalle de /orders/{id} — por eso el filtro de canal va DESPUÉS de traerlo
    // (igual que en AppDash: filtra por customData del detail, nunca del summary).
    const full = await getOrder(summary.orderId);
    const channel = orderChannel(full, channelMap);
    if (channel === 'unknown') unknownChannel += 1;
    if (channel !== TARGET_CHANNEL) continue;
    matchedChannel += 1;

    const view = classifyOrder(full, segmentMap);
    buckets[view.bucket].push(view);
  }

  return { buckets, scanned, matchedChannel, unknownChannel, unknownStatuses: [...unknownStatuses] };
}

function writeJson(relPath, data) {
  const outPath = path.join(__dirname, '..', relPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
}

async function main() {
  const { buckets, scanned, matchedChannel, unknownChannel, unknownStatuses } = await fetchAndClassifyOrders();

  for (const bucket of SEGMENTS) {
    const metrics = computeAllMetrics(buckets[bucket]);
    writeJson(`docs/data/${TARGET_CHANNEL}/${bucket}/metrics.json`, {
      generatedAt: new Date().toISOString(),
      channel: TARGET_CHANNEL,
      bucket,
      label: segmentMap.tabs.labels[bucket],
      lookbackDays: LOOKBACK_DAYS,
      ...metrics,
    });
  }

  writeJson(`docs/data/${TARGET_CHANNEL}/_meta/run-info.json`, {
    generatedAt: new Date().toISOString(),
    channel: TARGET_CHANNEL,
    scannedOrders: scanned,
    matchedChannelOrders: matchedChannel,
    unknownChannelOrders: unknownChannel,
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

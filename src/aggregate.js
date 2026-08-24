'use strict';

/**
 * Lee todos los archivos docs/data/web/daily/YYYY-MM-DD.json disponibles desde
 * START_DATE (config/pipeline-config.json) hasta hoy, los suma, y escribe
 * docs/data/web/<segmento>/metrics.json — un archivo por pestaña, listo para
 * que el dashboard lo consuma. Se corre después de fetch-day.js en cada corrida
 * diaria (ver .github/workflows/webdash-pipeline.yml).
 */
const fs = require('fs');
const path = require('path');

const { computeAllMetricsFromAggregate } = require('./metrics');
const segmentMap = require('../config/segment-map.json');
const pipelineConfig = require('../config/pipeline-config.json');

const SEGMENTS = segmentMap.tabs.list;
const DAILY_DIR = path.join(__dirname, '..', 'docs', 'data', 'web', 'daily');

function emptyAgg() {
  return {
    gmv: 0,
    orders: 0,
    customerCounts: new Map(),
    segmentParticipation: {},
    monthToDate: { gmv: 0, orders: 0 },
  };
}

function mergeDayIntoAgg(agg, daySegment, isCurrentMonth) {
  agg.gmv += daySegment.gmv;
  agg.orders += daySegment.orders;
  if (isCurrentMonth) {
    agg.monthToDate.gmv += daySegment.gmv;
    agg.monthToDate.orders += daySegment.orders;
  }
  for (const [hash, count] of Object.entries(daySegment.customerCounts || {})) {
    agg.customerCounts.set(hash, (agg.customerCounts.get(hash) || 0) + count);
  }
  for (const [seg, v] of Object.entries(daySegment.segmentParticipation || {})) {
    agg.segmentParticipation[seg] = agg.segmentParticipation[seg] || { orders: 0, gmv: 0 };
    agg.segmentParticipation[seg].orders += v.orders;
    agg.segmentParticipation[seg].gmv += v.gmv;
  }
}

function listAvailableDays(startDate) {
  if (!fs.existsSync(DAILY_DIR)) return [];
  return fs
    .readdirSync(DAILY_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, 10))
    .filter((d) => d >= startDate)
    .sort();
}

function writeJson(relPath, data) {
  const outPath = path.join(__dirname, '..', relPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
}

function main() {
  const startDate = pipelineConfig.detailWindowStartDate;
  const days = listAvailableDays(startDate);
  const now = new Date();
  const currentMonthPrefix = now.toISOString().slice(0, 7); // YYYY-MM

  const aggs = Object.fromEntries(SEGMENTS.map((s) => [s, emptyAgg()]));
  const missingDays = [];
  let scannedTotal = 0;
  const unknownStatuses = new Set();

  // Detectar huecos entre startDate y el último día disponible (no hasta "hoy":
  // el día de hoy todavía no cerró, así que no se espera que exista).
  const lastAvailable = days[days.length - 1];
  if (lastAvailable) {
    let d = new Date(`${startDate}T00:00:00Z`);
    const end = new Date(`${lastAvailable}T00:00:00Z`);
    const available = new Set(days);
    while (d <= end) {
      const ds = d.toISOString().slice(0, 10);
      if (!available.has(ds)) missingDays.push(ds);
      d = new Date(d.getTime() + 86400000);
    }
  }

  for (const date of days) {
    const day = JSON.parse(fs.readFileSync(path.join(DAILY_DIR, `${date}.json`), 'utf8'));
    scannedTotal += day.scanned || 0;
    for (const s of day.unknownStatuses || []) unknownStatuses.add(s);
    const isCurrentMonth = date.slice(0, 7) === currentMonthPrefix;
    for (const seg of SEGMENTS) {
      mergeDayIntoAgg(aggs[seg], day.segments[seg] || { gmv: 0, orders: 0, customerCounts: {}, segmentParticipation: {} }, isCurrentMonth);
    }
  }

  for (const seg of SEGMENTS) {
    const metrics = computeAllMetricsFromAggregate(aggs[seg], { referenceDate: now });
    writeJson(`docs/data/web/${seg}/metrics.json`, {
      generatedAt: now.toISOString(),
      channel: 'web',
      bucket: seg,
      label: segmentMap.tabs.labels[seg],
      detailWindowStartDate: startDate,
      daysAggregated: days.length,
      ...metrics,
    });
  }

  writeJson('docs/data/web/_meta/run-info.json', {
    generatedAt: now.toISOString(),
    channel: 'web',
    detailWindowStartDate: startDate,
    daysAggregated: days.length,
    lastAvailableDay: lastAvailable || null,
    missingDays,
    scannedOrdersTotal: scannedTotal,
    unknownStatuses: [...unknownStatuses],
    warning:
      missingDays.length > 0
        ? `Faltan ${missingDays.length} días entre ${startDate} y ${lastAvailable} — correr el backfill para completarlos.`
        : unknownStatuses.size > 0
          ? 'Hay statuses de VTEX no clasificados en config/status-filter.json.'
          : null,
  });

  console.log(`Agregado OK. Días sumados: ${days.length}. Días faltantes: ${missingDays.length}.`);
}

main();

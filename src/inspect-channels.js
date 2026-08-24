'use strict';

/**
 * Herramienta de investigación (no forma parte del pipeline productivo).
 * Trae una muestra de pedidos recientes y vuelca en config/channel-map.report.json
 * los valores reales observados de salesChannel / origin / marketingData.utmSource,
 * para poder completar config/channel-map.json con certeza en vez de adivinar.
 *
 * Uso: VTEX_ACCOUNT_NAME=... VTEX_APP_KEY=... VTEX_APP_TOKEN=... node src/inspect-channels.js
 */
const fs = require('fs');
const path = require('path');
const { iterateAllOrders, getOrder, listSalesChannels } = require('./vtex-client');

const SAMPLE_SIZE = Number(process.env.INSPECT_SAMPLE_SIZE || 200);

async function main() {
  const salesChannels = await listSalesChannels().catch((e) => ({
    error: `No se pudo leer /api/catalog_system/pub/saleschannel/list: ${e.message}`,
  }));

  const to = new Date();
  const from = new Date(to.getTime() - 14 * 24 * 60 * 60 * 1000);

  const salesChannelCounts = {};
  const originCounts = {};
  const utmSourceCounts = {};
  let sampled = 0;
  const examples = [];

  for await (const summary of iterateAllOrders({
    fromISO: from.toISOString(),
    toISO: to.toISOString(),
  })) {
    if (sampled >= SAMPLE_SIZE) break;
    let full;
    try {
      full = await getOrder(summary.orderId);
    } catch (e) {
      continue;
    }
    sampled += 1;

    const sc = String(full.salesChannel ?? summary.salesChannel ?? 'unknown');
    const origin = String(full.origin ?? 'unknown');
    const utmSource = String(full.marketingData?.utmSource ?? 'unknown');

    salesChannelCounts[sc] = (salesChannelCounts[sc] || 0) + 1;
    originCounts[origin] = (originCounts[origin] || 0) + 1;
    utmSourceCounts[utmSource] = (utmSourceCounts[utmSource] || 0) + 1;

    if (examples.length < 10) {
      examples.push({
        orderId: full.orderId,
        salesChannel: sc,
        origin,
        utmSource,
        hostname: full.hostname,
        sequence: full.sequence,
      });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    salesChannels,
    windowDays: 14,
    sampledOrders: sampled,
    salesChannelCounts,
    originCounts,
    utmSourceCounts,
    examples,
    howToUse:
      'Cruzar `salesChannels` (nombres reales configurados en el admin de VTEX para cada Id) contra ' +
      '`salesChannelCounts` (volumen real de pedidos por Id en los últimos 14 días) para saber con certeza ' +
      'qué Id corresponde a Web y cuál a App. Completar luego config/channel-map.json con esos IDs.',
  };

  const outPath = path.join(__dirname, '..', 'config', 'channel-map.report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`Reporte escrito en ${outPath}`);
  console.log(JSON.stringify({ salesChannelCounts, originCounts, utmSourceCounts }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

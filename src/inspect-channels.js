'use strict';

/**
 * Herramienta de investigación (no forma parte del pipeline productivo).
 *
 * IMPORTANTE: en esta cuenta, `salesChannel` separa línea de negocio
 * (1 = Main, 3 = Quick Commerce), NO dispositivo/canal de compra — un pedido
 * de salesChannel=1 puede venir tanto de la web como de la app. Por eso este
 * script ya no asume que salesChannel sirve para distinguir web vs app:
 * ahora vuelca pedidos completos (sacando datos personales del cliente) para
 * poder inspeccionar a mano qué campo real marca el origen "app" vs "web"
 * (candidatos típicos en VTEX: marketingData.utmSource/utmMedium,
 * customData.customApps, openTextField, checkinName).
 *
 * Uso: VTEX_ACCOUNT_NAME=... VTEX_APP_KEY=... VTEX_APP_TOKEN=... node src/inspect-channels.js
 */
const fs = require('fs');
const path = require('path');
const { iterateAllOrders, getOrder, listSalesChannels } = require('./vtex-client');
const { orderChannel } = require('./classify');
const channelMap = require('../config/channel-map.json');

const SAMPLE_SIZE = Number(process.env.INSPECT_SAMPLE_SIZE || 200);
const RAW_EXAMPLES = Number(process.env.INSPECT_RAW_EXAMPLES || 8);

function stripPii(order) {
  const { clientProfileData, shippingData, paymentData, ...rest } = order;
  return {
    ...rest,
    clientProfileData: clientProfileData
      ? { customerClass: clientProfileData.customerClass, isCorporate: clientProfileData.isCorporate }
      : undefined,
    shippingData: shippingData ? { logisticsInfo: shippingData.logisticsInfo } : undefined,
    paymentData: paymentData
      ? { transactions: (paymentData.transactions || []).map((t) => ({ payments: (t.payments || []).map((p) => ({ paymentSystem: p.paymentSystem, group: p.group })) })) }
      : undefined,
  };
}

async function main() {
  const salesChannels = await listSalesChannels().catch((e) => ({
    error: `No se pudo leer /api/catalog_system/pub/saleschannel/list: ${e.message}`,
  }));

  const to = new Date();
  const from = new Date(to.getTime() - 14 * 24 * 60 * 60 * 1000);

  const salesChannelCounts = {};
  const originCounts = {};
  const utmSourceCounts = {};
  const utmMediumCounts = {};
  const customAppIdCounts = {};
  const resolvedChannelCounts = {};
  let sampled = 0;
  const rawExamples = [];

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
    const utmMedium = String(full.marketingData?.utmMedium ?? 'unknown');

    salesChannelCounts[sc] = (salesChannelCounts[sc] || 0) + 1;
    originCounts[origin] = (originCounts[origin] || 0) + 1;
    utmSourceCounts[utmSource] = (utmSourceCounts[utmSource] || 0) + 1;
    utmMediumCounts[utmMedium] = (utmMediumCounts[utmMedium] || 0) + 1;

    for (const app of full.customData?.customApps || []) {
      customAppIdCounts[app.id] = (customAppIdCounts[app.id] || 0) + 1;
    }

    const resolved = orderChannel(full, channelMap);
    resolvedChannelCounts[resolved] = (resolvedChannelCounts[resolved] || 0) + 1;

    if (rawExamples.length < RAW_EXAMPLES) {
      rawExamples.push(stripPii(full));
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    salesChannels,
    salesChannelMeaningWarning:
      'salesChannel en esta cuenta = línea de negocio (Main vs Quick Commerce), NO dispositivo. ' +
      'No usar salesChannel para distinguir web vs app.',
    windowDays: 14,
    sampledOrders: sampled,
    salesChannelCounts,
    originCounts,
    utmSourceCounts,
    utmMediumCounts,
    customAppIdCounts,
    resolvedChannelCounts,
    rawExamples,
    howToUse:
      'resolvedChannelCounts ya usa config/channel-map.json (campo customData.customApps[].fields["from-help-info"], ' +
      'formato "from=web"/"from=app") para clasificar cada pedido de la muestra. Si "unknown" es alto, revisar ' +
      'rawExamples para ver por qué esos pedidos no traen el campo (versión vieja de checkout, canal no cubierto, etc).',
  };

  const outPath = path.join(__dirname, '..', 'config', 'channel-map.report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`Reporte escrito en ${outPath}`);
  console.log(
    JSON.stringify(
      { salesChannelCounts, originCounts, utmSourceCounts, utmMediumCounts, customAppIdCounts, resolvedChannelCounts },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

'use strict';

const PLACEHOLDER_RE = /^(REPLACE_WITH_|TBD_PENDING_INVESTIGATION)/;

function assertConfigured(list, configName) {
  if (!Array.isArray(list) || list.length === 0 || list.some((v) => PLACEHOLDER_RE.test(v))) {
    throw new Error(
      `${configName} todavía tiene valores placeholder sin completar. ` +
        'Corré npm run inspect:channels y completá el config correspondiente ' +
        'y completá config/*.json con los IDs reales antes de correr el pipeline.'
    );
  }
}

function assertConfiguredScalar(value, configName) {
  if (!value || PLACEHOLDER_RE.test(value)) {
    throw new Error(
      `${configName} todavía tiene un valor placeholder sin completar. ` +
        'Completá config/channel-map.json antes de correr el pipeline.'
    );
  }
}

/**
 * Busca en order.customData.customApps el item con id === appId y devuelve
 * el valor crudo de fields[fieldName] (ej. customApps[{id:'from-help-info', fields:{from:'web'}}] -> 'web').
 * Devuelve null si el pedido no trae ese customApp (pedidos previos a que se empezara a trackear esto).
 */
function extractCustomAppFieldValue(order, appId, fieldName) {
  const customApps = order.customData?.customApps || [];
  const app = customApps.find((a) => a.id === appId);
  const raw = app?.fields?.[fieldName];
  return raw == null ? null : String(raw).trim();
}

/**
 * 'app' solo si el campo dice explícitamente eso; cualquier otro caso (otro valor,
 * o el campo no existe — pedidos de antes de que existiera la app) es 'web'.
 * Misma regla que AppDash: `if (getCustomAppFrom(detail) !== 'app') continue`.
 */
function orderChannel(order, channelMap) {
  const appId = channelMap.customAppsField?.appId;
  const fieldName = channelMap.customAppsField?.fieldName;
  assertConfiguredScalar(appId, 'channel-map.json > customAppsField.appId');
  assertConfiguredScalar(fieldName, 'channel-map.json > customAppsField.fieldName');
  assertConfiguredScalar(channelMap.appValue, 'channel-map.json > appValue');

  const value = extractCustomAppFieldValue(order, appId, fieldName);
  return value === channelMap.appValue ? 'app' : 'web';
}

function isIncludedStatus(order, statusFilter) {
  const status = order.status;
  if (statusFilter.includeStatuses.includes(status)) return true;
  if (statusFilter.excludeStatuses.includes(status)) return false;
  return false; // status desconocido: excluido por defecto (ver policy en el config)
}

/**
 * Clasifica el PEDIDO COMPLETO (no por línea de ítem) en uno de los 4 segmentos
 * de negocio, replicando 1:1 la lógica real de AppDash (fetch-orders.js#categorizeOrder):
 * primero Quick Commerce (por salesChannel), después Marketplace (si algún item lo
 * vende un seller 3rd-party), después Non Food (seller interno carrefourar0899),
 * y si no matchea nada, Food. Mutuamente excluyentes: cada pedido cae en un solo segmento.
 */
function classifySegment(order, segmentMap) {
  assertConfiguredScalar(segmentMap.qcSalesChannelId, 'segment-map.json > qcSalesChannelId');
  assertConfiguredScalar(segmentMap.nonFoodSellerId, 'segment-map.json > nonFoodSellerId');
  assertConfigured(segmentMap.marketplaceSellerIds, 'segment-map.json > marketplaceSellerIds');

  const sc = String(order.salesChannel ?? '');
  if (sc === segmentMap.qcSalesChannelId) return 'quickcommerce';

  const sellers = new Set((order.items || []).map((i) => i.seller).filter(Boolean));
  for (const s of sellers) {
    if (segmentMap.marketplaceSellerIds.includes(s)) return 'marketplace';
  }
  if (sellers.has(segmentMap.nonFoodSellerId)) return 'non-food';
  return 'food';
}

/**
 * Devuelve la "vista" del pedido para el pipeline: { bucket, segment, order, items, gmv, weight }.
 * weight siempre 1 (a diferencia del enfoque anterior por categoryId, acá no hay prorrateo:
 * el pedido entero pertenece a un solo segmento, igual que en AppDash).
 * gmv = order.value / 100 (mismo criterio que AppDash, no la suma de sellingPrice*quantity de items,
 * para que el GMV incluya descuentos/envío tal como los prorratea VTEX en `value`).
 */
function classifyOrder(order, segmentMap) {
  const segment = classifySegment(order, segmentMap);
  const gmv = typeof order.value === 'number' ? order.value / 100 : 0;
  return { bucket: segment, segment, order, items: order.items || [], gmv, weight: 1 };
}

module.exports = { orderChannel, isIncludedStatus, classifySegment, classifyOrder };

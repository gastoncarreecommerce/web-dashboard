'use strict';

/**
 * Módulo de métricas compartido entre las 4 pestañas de WebDash (food, non-food,
 * marketplace, quickcommerce). No conoce nada de "canal" ni "segmento": recibe
 * agregados ya armados y calcula las métricas de negocio sobre eso.
 *
 * Dos formas de alimentarlo:
 * - computeAllMetrics(views): a partir de una lista de pedidos completos en memoria
 *   (útil para tests / volúmenes chicos). views: [{ order, gmv, weight }].
 * - computeAllMetricsFromAggregate(agg): a partir de un agregado ya sumado día a
 *   día (ver src/fetch-day.js), sin tener que guardar cada pedido en memoria —
 *   necesario acá porque WebDash puede acumular cientos de miles de pedidos de
 *   historial y no es viable tenerlos todos cargados a la vez.
 *   agg: { gmv, orders, customerCounts: Map<hash, count>, segmentParticipation: {seg: {gmv, orders}}, monthToDate: {gmv, orders} }
 */

function customerKey(order) {
  return order.clientProfileData?.email?.toLowerCase() || order.clientProfileData?.userProfileId || 'unknown';
}

function monthKey(dateStr) {
  return dateStr.slice(0, 7); // YYYY-MM
}

function gmvAndOrders(views) {
  const gmv = views.reduce((s, v) => s + v.gmv, 0);
  const orders = views.reduce((s, v) => s + v.weight, 0);
  return { gmv, orders };
}

function customerCountsFromViews(views) {
  const byCustomer = new Map();
  for (const v of views) {
    const key = customerKey(v.order);
    byCustomer.set(key, (byCustomer.get(key) || 0) + v.weight);
  }
  return byCustomer;
}

/** Repurchase rate = % de clientes con >= 2 pedidos sobre el total de clientes con >= 1 pedido. */
function repurchaseRateFromCounts(customerCounts) {
  const totalCustomers = customerCounts.size;
  if (totalCustomers === 0) return 0;
  let repeaters = 0;
  for (const n of customerCounts.values()) if (n >= 2) repeaters++;
  return repeaters / totalCustomers;
}

/** Frecuencia de compra promedio = pedidos / clientes únicos. */
function purchaseFrequencyFromCounts(customerCounts) {
  const totalCustomers = customerCounts.size;
  if (totalCustomers === 0) return 0;
  let totalOrders = 0;
  for (const n of customerCounts.values()) totalOrders += n;
  return totalOrders / totalCustomers;
}

function repurchaseRate(views) {
  return repurchaseRateFromCounts(customerCountsFromViews(views));
}

function purchaseFrequency(views) {
  return purchaseFrequencyFromCounts(customerCountsFromViews(views));
}

/** Basket size promedio = GMV total / cantidad de pedidos. */
function averageBasketSize(gmv, orders) {
  if (orders === 0) return 0;
  return gmv / orders;
}

function defaultSegmentFn(order) {
  return order.clientProfileData?.customerClass || order.marketingData?.utmSource || 'sin_segmento';
}

/** Participación por segmento a partir de una lista de vistas (uso en memoria / tests). */
function segmentParticipation(views, segmentFn = defaultSegmentFn) {
  const bySegment = {};
  const { gmv: totalGmv } = gmvAndOrders(views);
  for (const v of views) {
    const seg = segmentFn(v.order) || 'sin_segmento';
    bySegment[seg] = bySegment[seg] || { gmv: 0, orders: 0 };
    bySegment[seg].gmv += v.gmv;
    bySegment[seg].orders += v.weight;
  }
  return withGmvShare(bySegment, totalGmv);
}

/** Igual que segmentParticipation pero a partir de un agregado ya sumado (sin recorrer pedidos). */
function withGmvShare(bySegment, totalGmv) {
  const out = {};
  for (const [seg, v] of Object.entries(bySegment)) {
    out[seg] = { ...v, gmvShare: totalGmv > 0 ? v.gmv / totalGmv : 0 };
  }
  return out;
}

/**
 * Proyección mensual: escala el GMV/pedidos acumulados del mes en curso por
 * días_del_mes / días_transcurridos. gmv/orders acá deben ser SOLO los del mes
 * en curso (el caller filtra qué días entran), no el total del período completo.
 */
function monthlyProjectionFromTotals(gmv, orders, { referenceDate = new Date(), monthStart } = {}) {
  const start = monthStart ? new Date(monthStart) : new Date(referenceDate.getFullYear(), referenceDate.getMonth(), 1);
  const daysElapsed = Math.max(1, Math.ceil((referenceDate - start) / 86400000) + 1);
  const daysInMonth = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  const factor = daysInMonth / daysElapsed;
  return {
    daysElapsed,
    daysInMonth,
    actualGmv: gmv,
    actualOrders: orders,
    projectedGmv: gmv * factor,
    projectedOrders: orders * factor,
  };
}

function monthlyProjection(views, options = {}) {
  const { gmv, orders } = gmvAndOrders(views);
  return monthlyProjectionFromTotals(gmv, orders, options);
}

function computeAllMetrics(views, options = {}) {
  const { gmv, orders } = gmvAndOrders(views);
  return {
    gmv,
    orders,
    repurchaseRate: repurchaseRate(views),
    purchaseFrequency: purchaseFrequency(views),
    averageBasketSize: averageBasketSize(gmv, orders),
    segmentParticipation: segmentParticipation(views, options.segmentFn),
    monthlyProjection: monthlyProjection(views, options),
  };
}

/**
 * agg: {
 *   gmv, orders,                          // totales de todo el período acumulado
 *   customerCounts: Map<hash, count>,     // pedidos por cliente, mergeado de todos los días
 *   segmentParticipation: { seg: {gmv, orders} },  // ya sumado día a día
 *   monthToDate: { gmv, orders },         // solo los días del mes en curso, para la proyección
 * }
 */
function computeAllMetricsFromAggregate(agg, options = {}) {
  return {
    gmv: agg.gmv,
    orders: agg.orders,
    repurchaseRate: repurchaseRateFromCounts(agg.customerCounts),
    purchaseFrequency: purchaseFrequencyFromCounts(agg.customerCounts),
    averageBasketSize: averageBasketSize(agg.gmv, agg.orders),
    segmentParticipation: withGmvShare(agg.segmentParticipation, agg.gmv),
    monthlyProjection: monthlyProjectionFromTotals(agg.monthToDate.gmv, agg.monthToDate.orders, options),
  };
}

module.exports = {
  customerKey,
  monthKey,
  gmvAndOrders,
  customerCountsFromViews,
  repurchaseRateFromCounts,
  purchaseFrequencyFromCounts,
  repurchaseRate,
  purchaseFrequency,
  averageBasketSize,
  segmentParticipation,
  withGmvShare,
  monthlyProjectionFromTotals,
  monthlyProjection,
  computeAllMetrics,
  computeAllMetricsFromAggregate,
};

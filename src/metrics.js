'use strict';

/**
 * Módulo de métricas compartido entre AppDash y WebDash (y entre las pestañas
 * Food / Non Food de WebDash). No conoce nada de "canal" ni "food/non-food":
 * recibe una lista de "vistas de pedido" ya filtradas/clasificadas y calcula
 * las mismas métricas de negocio sobre lo que le pasen.
 *
 * Vista de pedido esperada (una por bucket, ver src/classify.js#splitOrderByCategory):
 * {
 *   order: <pedido crudo VTEX>,
 *   items: [...],
 *   gmv: number,       // en la moneda del pedido, ya prorrateado si aplica
 *   weight: number,     // 1 en modo line-item, fracción en modo prorate
 * }
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

/**
 * Repurchase rate = % de clientes con >= 2 pedidos en el período sobre el total de clientes con >= 1 pedido.
 */
function repurchaseRate(views) {
  const byCustomer = new Map();
  for (const v of views) {
    const key = customerKey(v.order);
    byCustomer.set(key, (byCustomer.get(key) || 0) + v.weight);
  }
  const totalCustomers = byCustomer.size;
  if (totalCustomers === 0) return 0;
  const repeaters = [...byCustomer.values()].filter((n) => n >= 2).length;
  return repeaters / totalCustomers;
}

/**
 * Frecuencia de compra promedio = pedidos ponderados / clientes únicos.
 */
function purchaseFrequency(views) {
  const byCustomer = new Map();
  for (const v of views) {
    const key = customerKey(v.order);
    byCustomer.set(key, (byCustomer.get(key) || 0) + v.weight);
  }
  const totalCustomers = byCustomer.size;
  if (totalCustomers === 0) return 0;
  const totalOrders = [...byCustomer.values()].reduce((s, n) => s + n, 0);
  return totalOrders / totalCustomers;
}

/**
 * Basket size promedio = GMV total / cantidad de pedidos ponderada.
 */
function averageBasketSize(views) {
  const { gmv, orders } = gmvAndOrders(views);
  if (orders === 0) return 0;
  return gmv / orders;
}

/**
 * Participación por segmento: agrupa GMV y pedidos por un `segmentFn(order) -> string`.
 * Por default segmenta por clientProfileData.customerClass si existe, si no por 'sin_segmento'.
 */
function segmentParticipation(views, segmentFn = defaultSegmentFn) {
  const bySegment = {};
  const { gmv: totalGmv } = gmvAndOrders(views);
  for (const v of views) {
    const seg = segmentFn(v.order) || 'sin_segmento';
    bySegment[seg] = bySegment[seg] || { gmv: 0, orders: 0 };
    bySegment[seg].gmv += v.gmv;
    bySegment[seg].orders += v.weight;
  }
  for (const seg of Object.keys(bySegment)) {
    bySegment[seg].gmvShare = totalGmv > 0 ? bySegment[seg].gmv / totalGmv : 0;
  }
  return bySegment;
}

function defaultSegmentFn(order) {
  return order.clientProfileData?.customerClass || order.marketingData?.utmSource || 'sin_segmento';
}

/**
 * Proyección mensual simple: toma el GMV/pedidos acumulados del mes en curso (visto en `views`,
 * ya filtrado por el caller a partir de monthStart) y lo escala por días_del_mes / días_transcurridos.
 */
function monthlyProjection(views, { referenceDate = new Date(), monthStart } = {}) {
  const start = monthStart ? new Date(monthStart) : new Date(referenceDate.getFullYear(), referenceDate.getMonth(), 1);
  const daysElapsed = Math.max(1, Math.ceil((referenceDate - start) / 86400000) + 1);
  const daysInMonth = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  const { gmv, orders } = gmvAndOrders(views);
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

function computeAllMetrics(views, options = {}) {
  const { gmv, orders } = gmvAndOrders(views);
  return {
    gmv,
    orders,
    repurchaseRate: repurchaseRate(views),
    purchaseFrequency: purchaseFrequency(views),
    averageBasketSize: averageBasketSize(views),
    segmentParticipation: segmentParticipation(views, options.segmentFn),
    monthlyProjection: monthlyProjection(views, options),
  };
}

module.exports = {
  customerKey,
  monthKey,
  gmvAndOrders,
  repurchaseRate,
  purchaseFrequency,
  averageBasketSize,
  segmentParticipation,
  monthlyProjection,
  computeAllMetrics,
};

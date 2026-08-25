'use strict';

/**
 * Normalización de provincias argentinas y extracción de la tienda que
 * despachó el pedido.
 *
 * VTEX guarda `shippingData.address.state` como texto libre cargado en el
 * checkout: llega "CABA", "Capital Federal", "Ciudad Autónoma de Buenos
 * Aires", "cordoba", "Córdoba" y variantes con y sin tilde. Sin normalizar,
 * el mapa mostraría la misma provincia partida en cinco pedazos.
 */

/** Código ISO 3166-2:AR -> nombre canónico. Es la clave que usa el mapa. */
const PROVINCES = {
  'AR-C': 'Ciudad Autónoma de Buenos Aires',
  'AR-B': 'Buenos Aires',
  'AR-K': 'Catamarca',
  'AR-H': 'Chaco',
  'AR-U': 'Chubut',
  'AR-X': 'Córdoba',
  'AR-W': 'Corrientes',
  'AR-E': 'Entre Ríos',
  'AR-P': 'Formosa',
  'AR-Y': 'Jujuy',
  'AR-L': 'La Pampa',
  'AR-F': 'La Rioja',
  'AR-M': 'Mendoza',
  'AR-N': 'Misiones',
  'AR-Q': 'Neuquén',
  'AR-R': 'Río Negro',
  'AR-A': 'Salta',
  'AR-J': 'San Juan',
  'AR-D': 'San Luis',
  'AR-Z': 'Santa Cruz',
  'AR-S': 'Santa Fe',
  'AR-G': 'Santiago del Estero',
  'AR-V': 'Tierra del Fuego',
  'AR-T': 'Tucumán',
};

/** Texto sin tildes, minúsculas, espacios colapsados. */
function norm(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Variantes observadas y esperables -> código ISO.
const ALIASES = {};
const alias = (code, ...names) => names.forEach((n) => (ALIASES[norm(n)] = code));

alias('AR-C', 'CABA', 'C.A.B.A.', 'Capital Federal', 'Ciudad Autonoma de Buenos Aires',
  'Ciudad de Buenos Aires', 'Ciudad Autónoma de Buenos Aires', 'Buenos Aires (CABA)', 'CF');
alias('AR-B', 'Buenos Aires', 'Provincia de Buenos Aires', 'Bs As', 'Bs. As.', 'BSAS', 'GBA', 'PBA');
alias('AR-K', 'Catamarca');
alias('AR-H', 'Chaco');
alias('AR-U', 'Chubut');
alias('AR-X', 'Cordoba', 'Córdoba');
alias('AR-W', 'Corrientes');
alias('AR-E', 'Entre Rios', 'Entre Ríos');
alias('AR-P', 'Formosa');
alias('AR-Y', 'Jujuy');
alias('AR-L', 'La Pampa');
alias('AR-F', 'La Rioja');
alias('AR-M', 'Mendoza');
alias('AR-N', 'Misiones');
alias('AR-Q', 'Neuquen', 'Neuquén');
alias('AR-R', 'Rio Negro', 'Río Negro');
alias('AR-A', 'Salta');
alias('AR-J', 'San Juan');
alias('AR-D', 'San Luis');
alias('AR-Z', 'Santa Cruz');
alias('AR-S', 'Santa Fe', 'Santa Fé');
alias('AR-G', 'Santiago del Estero', 'Sgo del Estero', 'Sgo. del Estero');
alias('AR-V', 'Tierra del Fuego', 'Tierra del Fuego, Antartida e Islas del Atlantico Sur', 'TDF');
alias('AR-T', 'Tucuman', 'Tucumán');

/** Código ISO de la provincia del pedido, o null si no se pudo determinar. */
function provinceCode(order) {
  const raw = order?.shippingData?.address?.state;
  if (!raw) return null;
  const n = norm(raw);
  if (ALIASES[n]) return ALIASES[n];
  // Coincidencia parcial: cubre cosas como "Provincia de Córdoba".
  for (const [key, code] of Object.entries(ALIASES)) {
    if (key.length >= 5 && (n.includes(key) || key.includes(n))) return code;
  }
  return null;
}

/**
 * Tienda que despachó el pedido.
 *
 * Los pedidos reales traen el dato dentro de logisticsInfo:
 *   courierId:   "0198_DOM3_IE"                              -> código 0198
 *   courierName: "Envío a Domicilio 3  198 - Market Cabildo" -> nombre "Market Cabildo"
 * y en retiro en tienda aparece además pickupStoreInfo.friendlyName.
 * Se prioriza el pickup point cuando existe, porque ahí la tienda es explícita.
 */
function orderStore(order) {
  const li = order?.shippingData?.logisticsInfo || [];

  for (const l of li) {
    const pu = l?.pickupStoreInfo;
    if (pu?.isPickupStore && pu.friendlyName) {
      return { code: String(l.deliveryIds?.[0]?.courierId || pu.friendlyName).split('_')[0], name: String(pu.friendlyName).trim() };
    }
  }

  for (const l of li) {
    for (const d of l?.deliveryIds || []) {
      const code = String(d.courierId || '').split('_')[0];
      const cn = String(d.courierName || '');
      const dash = cn.lastIndexOf(' - ');
      const name = dash >= 0 ? cn.slice(dash + 3).trim() : cn.trim();
      if (code || name) return { code: code || 'sin_codigo', name: name || code };
    }
    if (l?.deliveryCompany) {
      const cn = String(l.deliveryCompany);
      const dash = cn.lastIndexOf(' - ');
      if (dash >= 0) return { code: 'sin_codigo', name: cn.slice(dash + 3).trim() };
    }
  }
  return null;
}

module.exports = { PROVINCES, provinceCode, orderStore, normText: norm };

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
 * Extrae el nombre de tienda de un texto tipo courierName. VTEX carga ahí el
 * código y el prefijo del método de envío pegados al nombre, con separador
 * "-" a veces con espacios ("Envío a domicilio 0009 - Hiper Cba Colón") y a
 * veces sin ellos ("Envío a Domicilio 6001-Express Maestro Vidal") — usar
 * solo `lastIndexOf(' - ')` deja pasar el string entero sin cortar en el
 * segundo caso, y el prefijo "Envío a Domicilio 6001-" quedaba pegado
 * adelante del nombre real en el ranking de tiendas.
 * Si no hay nombre después del último guion (p.ej. "Envío a Domicilio 3",
 * un bucket genérico sin tienda puntual), devuelve null: mejor no atribuirlo
 * a ninguna tienda que mostrar el texto del método de envío como si lo fuera.
 */
function extractDeliveryStoreName(raw) {
  const cn = String(raw || '').trim();
  if (!cn) return null;
  const m = cn.match(/.*-\s*(.+)$/);
  const name = (m ? m[1] : cn).trim();
  // "Envío a Domicilio", "Envío a Sede", etc: prefijo del método de envío sin
  // ningún nombre de tienda pegado después (no había guion para cortar).
  if (!name || /^env[ií]o a \S+\s*$/i.test(name)) return null;
  return name;
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
      const name = extractDeliveryStoreName(d.courierName);
      if (code && name) return { code, name };
    }
    if (l?.deliveryCompany) {
      const name = extractDeliveryStoreName(l.deliveryCompany);
      if (name) return { code: 'sin_codigo', name };
    }
  }
  return null;
}

module.exports = { PROVINCES, provinceCode, orderStore, extractDeliveryStoreName, normText: norm };

'use strict';

const crypto = require('crypto');

/**
 * VTEX anonimiza el email POR PEDIDO: lo devuelve como
 *   juan@gmail.com-A1B2C3.ct.vtex.com.br
 * donde el sufijo cambia en cada orden. Si se hashea así tal cual, cada pedido
 * produce un "cliente" distinto: la recompra da 0, la frecuencia da 1.0 y las
 * cohortes muestran a todo el mundo como nuevo. Hay que sacar ese sufijo antes
 * de identificar al cliente — es lo mismo que hace AppDash en
 * scripts/comercial-lib.mjs#realEmail.
 */
const VTEX_ORDER_SUFFIX = /-[^-@]*\.ct\.vtex\.com\.br$/i;

/** Devuelve el email real (sin el sufijo por-orden), o null. Nunca se persiste. */
function realEmail(raw) {
  if (!raw) return null;
  const clean = String(raw).replace(VTEX_ORDER_SUFFIX, '').toLowerCase().trim();
  return clean || null;
}

/**
 * Identificador estable del cliente para los archivos públicos.
 *
 * AppDash persiste el email en texto plano en sus daily rows; acá no, porque
 * estos archivos son públicos: se guarda un SHA-256 truncado (16 hex = 64 bits).
 * Alcanza para contar clientes únicos y recompra sin poder revertirlo, y a este
 * volumen el riesgo de colisión es despreciable para una métrica agregada.
 */
function customerHash(order) {
  const key = realEmail(order.clientProfileData?.email) || order.clientProfileData?.userProfileId || '';
  if (!key) return null;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

module.exports = { customerHash, realEmail };

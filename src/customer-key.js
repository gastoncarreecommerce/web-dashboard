'use strict';

const crypto = require('crypto');

/**
 * AppDash persiste el email en texto plano en docs/data/daily/*-rows.json (público
 * en GitHub Pages). Acá se decidió NO replicar eso: los archivos diarios de WebDash
 * son públicos y van a acumularse durante meses, así que en vez de email plano
 * guardamos un hash truncado (SHA-256, primeros 16 hex = 64 bits). Alcanza para
 * contar clientes únicos y repurchase sin poder revertir el hash a un email real,
 * y el riesgo de colisión a este volumen (cientos de miles de pedidos) es
 * insignificante para una métrica agregada como esta.
 */
function customerHash(order) {
  const raw = order.clientProfileData?.email?.toLowerCase().trim() || order.clientProfileData?.userProfileId || '';
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

module.exports = { customerHash };

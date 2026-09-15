'use strict';

/**
 * Separa los cupones combinados en data/daily/*.json sin volver a pedirle
 * nada a VTEX. VTEX manda TODOS los cupones de un pedido en un solo string
 * separado por comas ("LECHE5K,ENVIOGRATIS,SUPER26"); fetch-day.js usaba ese
 * string entero como clave, así que cada combinación distinta de cupones
 * quedaba contada como si fuera "un cupón" propio en vez de sumar a cada
 * cupón individual. La clave ya guardada ES el string crudo, así que alcanza
 * con volver a separarla acá — no hace falta re-descargar nada.
 *
 * Uso: node scripts/repair-coupons.js
 * Después: node src/aggregate.js (para que catalog.json refleje el cambio).
 */
const fs = require('fs');
const path = require('path');

const DAILY_DIR = path.join(__dirname, '..', 'data', 'daily');

function splitCoupons(segCoupons) {
  const out = {};
  let changed = false;
  for (const [key, v] of Object.entries(segCoupons)) {
    const parts = key.split(',').map((c) => c.trim()).filter(Boolean);
    if (parts.length > 1) changed = true;
    for (const code of parts) {
      const e = (out[code] = out[code] || { orders: 0, gmv: 0, units: 0 });
      e.orders += v.orders || 0;
      e.gmv += v.gmv || 0;
      e.units += v.units || 0;
    }
  }
  return { out, changed };
}

function main() {
  const files = fs.readdirSync(DAILY_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  let filesChanged = 0, combosSplit = 0;

  for (const f of files) {
    const p = path.join(DAILY_DIR, f);
    const day = JSON.parse(fs.readFileSync(p, 'utf8'));
    let fileChanged = false;

    for (const seg of Object.values(day.segments || {})) {
      if (!seg.coupons) continue;
      const { out, changed } = splitCoupons(seg.coupons);
      if (changed) {
        seg.coupons = out;
        fileChanged = true;
        combosSplit += 1;
      }
    }

    if (fileChanged) {
      fs.writeFileSync(p, JSON.stringify(day));
      filesChanged += 1;
    }
  }

  console.log(`✓ ${filesChanged} archivos tocados · ${combosSplit} combinaciones de cupones separadas`);
}

main();

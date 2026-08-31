'use strict';

/**
 * Re-limpia los nombres de tienda ya guardados en data/daily/*.json sin volver
 * a pedirle nada a VTEX. orderStore() (src/geo.js) tenía un bug: cuando el
 * courierName venía con el guion pegado sin espacios ("Envío a Domicilio
 * 6001-Express Maestro Vidal"), no lo detectaba y guardaba el string entero
 * como "nombre de tienda" — así aparecía "Envío a Domicilio ..." en vez del
 * nombre real en el mapa/ranking. El texto original quedó guardado tal cual
 * en day.stores[code].name, así que alcanza con volver a pasarlo por la
 * misma extracción ya corregida — no hace falta re-descargar nada de VTEX.
 *
 * Uso: node scripts/repair-store-names.js
 * Después: node src/aggregate.js (para que geo.json/orders/** reflejen el cambio).
 */
const fs = require('fs');
const path = require('path');
const { extractDeliveryStoreName } = require('../src/geo');

const DAILY_DIR = path.join(__dirname, '..', 'data', 'daily');
const JUNK_RE = /^env[ií]os? a \S+/i;

function main() {
  const files = fs.readdirSync(DAILY_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  let filesChanged = 0, renamed = 0, dropped = 0;

  for (const f of files) {
    const p = path.join(DAILY_DIR, f);
    const day = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!day.stores) continue;
    let changed = false;

    for (const [code, s] of Object.entries(day.stores)) {
      if (!s.name || !JUNK_RE.test(s.name)) continue;
      const clean = extractDeliveryStoreName(s.name);
      if (clean) {
        s.name = clean;
        renamed += 1;
      } else {
        delete day.stores[code];
        dropped += 1;
      }
      changed = true;
    }

    if (changed) {
      fs.writeFileSync(p, JSON.stringify(day));
      filesChanged += 1;
    }
  }

  console.log(`✓ ${filesChanged} archivos tocados · ${renamed} nombres corregidos · ${dropped} entradas genéricas sin tienda eliminadas`);
}

main();

'use strict';

/**
 * Genera docs/ar-map.js: los contornos de las 24 provincias argentinas ya
 * proyectados y simplificados, como paths SVG listos para dibujar.
 *
 * Se corre UNA VEZ y el resultado se commitea. Motivos:
 *  - el sitio tiene CSP estricta y no puede cargar librerías de mapas de un CDN;
 *  - el GeoJSON de origen (Natural Earth 10m) pesa 39MB y sería absurdo
 *    servírselo al navegador para dibujar 24 polígonos.
 *
 * Fuente: Natural Earth admin-1 (dominio público), que trae los códigos
 * ISO 3166-2 (AR-B, AR-C, …) — los mismos que usa src/geo.js para clasificar
 * la provincia de cada pedido, así que el cruce es directo.
 *
 * Las Islas Malvinas son parte de la provincia de Tierra del Fuego, Antártida
 * e Islas del Atlántico Sur (Ley 26.651 de cartografía nacional) — cualquier
 * mapa que se publique en la Argentina las tiene que mostrar así. Natural
 * Earth las trae como país aparte en el dataset admin-0 (con otra soberanía),
 * así que hay que agregarlas a mano al contorno de Tierra del Fuego.
 *
 * Uso: node scripts/build-ar-map.js <ne_10m_admin_1_states_provinces.geojson> [ne_10m_admin_0_countries.geojson]
 */
const fs = require('fs');
const path = require('path');

const W = 1000; // ancho del viewBox; el alto sale de la proporción real
const TOLERANCE = 0.9; // en unidades del viewBox: ~1px

/** Mercator. Para un país tan largo en latitud como Argentina evita el
 *  achatamiento del sur que produce una proyección plana. */
function mercator(lon, lat) {
  const x = (lon * Math.PI) / 180;
  const y = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  return [x, y];
}

/** Douglas-Peucker: descarta los puntos que no cambian la silueta. */
function simplify(points, tol) {
  if (points.length < 3) return points;
  const sq = tol * tol;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;

  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxD = 0, idx = -1;
    const [x1, y1] = points[first], [x2, y2] = points[last];
    const dx = x2 - x1, dy = y2 - y1;
    const len = dx * dx + dy * dy;

    for (let i = first + 1; i < last; i++) {
      const [px, py] = points[i];
      let t = len ? ((px - x1) * dx + (py - y1) * dy) / len : 0;
      t = Math.max(0, Math.min(1, t));
      const ex = x1 + t * dx - px, ey = y1 + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > sq && idx > 0) {
      keep[idx] = 1;
      stack.push([first, idx], [idx, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function ringsOf(geom) {
  if (geom.type === 'Polygon') return geom.coordinates;
  if (geom.type === 'MultiPolygon') return geom.coordinates.flat();
  return [];
}

function main() {
  const src = process.argv[2];
  if (!src || !fs.existsSync(src)) {
    console.error('Uso: node scripts/build-ar-map.js <ne_10m_admin_1_states_provinces.geojson>');
    process.exit(1);
  }

  const gj = JSON.parse(fs.readFileSync(src, 'utf8'));
  const feats = gj.features.filter((f) => f.properties.adm0_a3 === 'ARG' && f.properties.iso_3166_2);
  if (!feats.length) { console.error('No se encontraron provincias argentinas.'); process.exit(1); }

  // Malvinas: rings extra que se suman al contorno de Tierra del Fuego (AR-V),
  // no una provincia propia. Natural Earth las llama "Falkland Is." y les
  // pone soberanía británica (GB1); acá se ignora esa atribución a propósito.
  const extraRingsByCode = {};
  const countriesSrc = process.argv[3];
  if (countriesSrc) {
    if (!fs.existsSync(countriesSrc)) { console.error(`No existe ${countriesSrc}`); process.exit(1); }
    const countries = JSON.parse(fs.readFileSync(countriesSrc, 'utf8'));
    const falklands = countries.features.find((f) => /Falkland/i.test(f.properties.NAME || f.properties.ADMIN || ''));
    if (!falklands) {
      console.warn('⚠ No se encontraron las Islas Malvinas en el GeoJSON de países — se genera el mapa sin ellas.');
    } else {
      extraRingsByCode['AR-V'] = ringsOf(falklands.geometry);
      console.log(`Malvinas: ${extraRingsByCode['AR-V'].length} anillo(s) sumados a Tierra del Fuego.`);
    }
  } else {
    console.warn('⚠ Sin el GeoJSON de países (2º argumento): el mapa sale sin las Islas Malvinas.');
  }
  const allExtraRings = Object.values(extraRingsByCode).flat();

  // Bounding box en coordenadas proyectadas, para escalar todo al viewBox.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of [...feats.flatMap((f) => ringsOf(f.geometry)), ...allExtraRings]) {
    for (const [lon, lat] of ring) {
      const [x, y] = mercator(lon, lat);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  const scale = W / (maxX - minX);
  const H = Math.round((maxY - minY) * scale);
  const project = ([lon, lat]) => {
    const [x, y] = mercator(lon, lat);
    return [(x - minX) * scale, (maxY - y) * scale]; // y invertida: SVG crece hacia abajo
  };

  const out = {};
  let pointsBefore = 0, pointsAfter = 0;

  for (const f of feats) {
    const code = f.properties.iso_3166_2;
    const parts = [];
    const rings = [...ringsOf(f.geometry), ...(extraRingsByCode[code] || [])];
    for (const ring of rings) {
      // Islas y recortes minúsculos solo agregan peso.
      if (ring.length < 4) continue;
      const proj = ring.map(project);
      pointsBefore += proj.length;
      const simp = simplify(proj, TOLERANCE);
      if (simp.length < 4) continue;
      pointsAfter += simp.length;
      parts.push('M' + simp.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L') + 'Z');
    }
    if (!parts.length) continue;

    // Centroide aproximado del anillo más grande, para ubicar la etiqueta.
    const biggest = ringsOf(f.geometry).sort((a, b) => b.length - a.length)[0].map(project);
    const cx = biggest.reduce((s, p) => s + p[0], 0) / biggest.length;
    const cy = biggest.reduce((s, p) => s + p[1], 0) / biggest.length;

    out[code] = {
      name: f.properties.name,
      d: parts.join(''),
      cx: Math.round(cx),
      cy: Math.round(cy),
    };
  }

  const dest = path.join(__dirname, '..', 'docs', 'ar-map.js');
  const body = `/* global window */
/**
 * Contornos de las provincias argentinas (Natural Earth admin-1, dominio
 * público), proyectados en Mercator y simplificados con Douglas-Peucker.
 * GENERADO por scripts/build-ar-map.js — no editar a mano.
 */
(function () {
  const W = (window.W = window.W || {});
  W.AR_MAP = { width: ${W}, height: ${H}, provinces: ${JSON.stringify(out)} };
})();
`;
  fs.writeFileSync(dest, body);

  console.log(`✅ ${dest}`);
  console.log(`   ${Object.keys(out).length} provincias · viewBox ${W}×${H}`);
  console.log(`   puntos ${pointsBefore.toLocaleString('es-AR')} → ${pointsAfter.toLocaleString('es-AR')} (${(100 - (pointsAfter / pointsBefore) * 100).toFixed(1)}% menos)`);
  console.log(`   ${(fs.statSync(dest).size / 1024).toFixed(0)}KB`);
}

main();

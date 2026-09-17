/**
 * Convierte el CSV de redirects que exporta VTEX en config/search-redirects.json,
 * y de paso dice cuántos de los términos más buscados quedan explicados.
 *
 * Por qué hace falta: el admin de VTEX (Storefront > Redirecciones) muestra 561
 * redirects de 15 en 15 y solo tiene botón de IMPORTAR, no de exportar. A mano
 * son 38 páginas. El export sale por la CLI de VTEX:
 *
 *     vtex redirects export redirects.csv
 *
 * Después:
 *
 *     node scripts/import-redirects.mjs redirects.csv
 *
 * El CSV de VTEX trae `from` (la ruta de origen), `to` (el destino), `endDate` y
 * `type`. El diagnóstico necesita el TÉRMINO que escribe la persona, no la ruta,
 * así que se deriva del `from`: "/papel-higienico" -> "papel higienico". Es una
 * heurística —el slug no siempre es el término— y por eso el script imprime
 * cuántos de los 200 términos más buscados matchearon y cuáles no, para poder
 * ver si la derivación funcionó antes de creerle al reporte.
 *
 * Los redirects vencidos (endDate en el pasado) se descartan: ya no redirigen.
 */

import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(import.meta.dirname, '..', 'config', 'search-redirects.json');
const DIAG = path.join(import.meta.dirname, '..', 'config', 'search-inspect.report.json');

/** Parser de CSV que respeta comillas y comas adentro de los campos. */
function parseCSV(texto) {
  const filas = [];
  let campo = '', fila = [], enComillas = false;
  for (let i = 0; i < texto.length; i += 1) {
    const c = texto[i];
    if (enComillas) {
      if (c === '"') {
        if (texto[i + 1] === '"') { campo += '"'; i += 1; }
        else enComillas = false;
      } else campo += c;
      continue;
    }
    if (c === '"') { enComillas = true; continue; }
    if (c === ',' || c === ';') { fila.push(campo); campo = ''; continue; }
    if (c === '\n') { fila.push(campo); filas.push(fila); fila = []; campo = ''; continue; }
    if (c === '\r') continue;
    campo += c;
  }
  if (campo || fila.length) { fila.push(campo); filas.push(fila); }
  return filas.filter((f) => f.some((x) => String(x).trim()));
}

/** Ruta -> término buscado. "/papel-higienico" -> "papel higienico" */
function terminoDeRuta(ruta) {
  let r = String(ruta || '').trim();
  try { r = decodeURIComponent(r); } catch { /* ya estaba decodificado */ }
  r = r.split('?')[0].replace(/^\/+|\/+$/g, '');
  // Solo el último segmento: "/busca/papel-higienico" -> "papel-higienico"
  const ultimo = r.split('/').filter(Boolean).pop() || '';
  return ultimo.replace(/[-_]+/g, ' ').trim().toLowerCase();
}

function normalizeTerm(raw) {
  let t = String(raw || '');
  try { t = decodeURIComponent(t.replace(/\+/g, ' ')); } catch { /* ya estaba */ }
  return t.trim().toLowerCase();
}

/** Los términos más buscados, del mismo reporte de GA4 que usa el diagnóstico. */
function topTerminos() {
  if (!fs.existsSync(DIAG)) return [];
  const rep = JSON.parse(fs.readFileSync(DIAG, 'utf8'));
  const intento = rep.searchTermAttempts?.find((a) => a.eventName === 'search' && a.ok && a.sample?.length);
  if (!intento) return [];
  const porTermino = new Map();
  for (const row of intento.sample) {
    const t = normalizeTerm(row.term);
    if (t) porTermino.set(t, (porTermino.get(t) || 0) + row.count);
  }
  return [...porTermino.entries()]
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 200);
}

function main() {
  const archivo = process.argv[2];
  if (!archivo) {
    console.log('Uso: node scripts/import-redirects.mjs <redirects.csv>');
    console.log('');
    console.log('El CSV sale de la CLI de VTEX:  vtex redirects export redirects.csv');
    console.log('(el admin solo tiene "Importar CSV", no exporta)');
    process.exit(1);
  }
  if (!fs.existsSync(archivo)) {
    console.log(`No existe ${archivo}`);
    process.exit(1);
  }

  const filas = parseCSV(fs.readFileSync(archivo, 'utf8'));
  if (!filas.length) { console.log('El CSV está vacío.'); process.exit(1); }

  // La cabecera puede venir en cualquier orden, y con otros nombres según la
  // versión de la CLI: se busca por nombre en vez de por posición.
  const cab = filas[0].map((h) => String(h).trim().toLowerCase());
  const idx = (...nombres) => {
    for (const n of nombres) { const i = cab.indexOf(n); if (i >= 0) return i; }
    return -1;
  };
  const iFrom = idx('from', 'origen', 'path', 'de');
  const iTo = idx('to', 'destino', 'a');
  const iEnd = idx('enddate', 'end_date', 'vencimiento');
  const iType = idx('type', 'tipo');

  if (iFrom < 0 || iTo < 0) {
    console.log(`No encuentro las columnas de origen y destino. Cabecera leída: ${cab.join(' | ')}`);
    console.log('Se esperaba algo como: from,to,endDate,type');
    process.exit(1);
  }

  const hoy = new Date();
  const redirects = [];
  let vencidos = 0, sinTermino = 0;
  const vistos = new Set();

  for (const f of filas.slice(1)) {
    const from = f[iFrom], to = f[iTo];
    if (!from || !to) continue;

    if (iEnd >= 0 && String(f[iEnd]).trim()) {
      const fin = new Date(String(f[iEnd]).trim());
      if (!Number.isNaN(fin.getTime()) && fin < hoy) { vencidos += 1; continue; }
    }

    const term = terminoDeRuta(from);
    if (!term) { sinTermino += 1; continue; }
    if (vistos.has(term)) continue;
    vistos.add(term);
    redirects.push({
      term, url: String(to).trim(), from: String(from).trim(),
      ...(iType >= 0 && f[iType] ? { type: String(f[iType]).trim() } : {}),
    });
  }

  const salida = {
    _origen: [
      `Importado de ${path.basename(archivo)} el ${hoy.toISOString().slice(0, 10)} con`,
      'scripts/import-redirects.mjs. No editar a mano: volver a correr el script.',
      '',
      'El `term` se deriva del último segmento del `from` ("/papel-higienico" ->',
      '"papel higienico"). Es una heurística: el slug no siempre coincide con lo que',
      'la persona escribe. El script imprime cuántos de los 200 términos más',
      'buscados matchearon, para poder ver si sirvió.',
    ],
    generatedAt: hoy.toISOString(),
    source: path.basename(archivo),
    redirects,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(salida, null, 2));

  console.log(`${redirects.length} redirects activos → ${path.relative(process.cwd(), OUT)}`);
  if (vencidos) console.log(`  (${vencidos} descartados por estar vencidos)`);
  if (sinTermino) console.log(`  (${sinTermino} sin término derivable del origen)`);

  // ── ¿Cuánto explica esto? ──────────────────────────────────────────────────
  const top = topTerminos();
  if (!top.length) {
    console.log('\nNo pude leer el top de búsquedas para medir la cobertura.');
    return;
  }
  const conRedirect = top.filter((t) => vistos.has(t.term));
  const volTotal = top.reduce((s, t) => s + t.count, 0);
  const volCubierto = conRedirect.reduce((s, t) => s + t.count, 0);

  console.log(`\n── Cobertura sobre los ${top.length} términos más buscados ──`);
  console.log(`  ${conRedirect.length} tienen redirect (${(volCubierto / volTotal * 100).toFixed(1)}% del volumen de búsqueda)`);
  console.log(`  ${top.length - conRedirect.length} caen en búsqueda real: ahí sí importa la calidad del motor`);

  const sinRedirect = top.filter((t) => !vistos.has(t.term)).slice(0, 15);
  if (sinRedirect.length) {
    console.log('\n  Los de más volumen SIN redirect (el bake-off se decide con estos):');
    for (const t of sinRedirect) console.log(`    ${t.term.padEnd(26)} ${t.count.toLocaleString('es-AR')} búsquedas/mes`);
  }
  if (conRedirect.length) {
    console.log('\n  Ejemplos de los que SÍ tienen redirect:');
    for (const t of conRedirect.slice(0, 8)) {
      const r = redirects.find((x) => x.term === t.term);
      console.log(`    ${t.term.padEnd(26)} → ${r.url}`);
    }
  }
}

main();

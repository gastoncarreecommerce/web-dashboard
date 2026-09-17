'use strict';

/**
 * Consulta VTEX Intelligent Search con unos pocos términos y muestra la
 * respuesta COMPLETA de cada uno, para entender por qué devuelve 0 productos en
 * términos que el Search legacy y Dynamic Yield sí resuelven.
 *
 * El diagnóstico dejó esto:
 *
 *   término            IS    legacy  DY
 *   papel higienico     0      10    1000
 *   queso crema         0      10    1000
 *   manteca             0      10    1000
 *   azucar              0      10    1000
 *   leche            1561      10    1000
 *
 * 99 de los 200 términos más buscados dan 0 en IS. Puede ser (a) que IS esté mal
 * indexado o mal configurado en esta cuenta, (b) que a la llamada le falte algún
 * parámetro —`locale` es el sospechoso principal: si el índice está en es-AR y la
 * consulta va sin locale, el match puede fallar—, o (c) throttling devolviendo
 * 200 con lista vacía. La respuesta cruda distingue los tres casos: IS suele
 * traer `correction`, `queryArgs`, `translated` y `operator`, que dicen cómo
 * interpretó la consulta.
 *
 * Prueba cada término de tres formas para aislar la causa:
 *   1. tal cual lo hace el diagnóstico hoy
 *   2. con `locale=es-AR`
 *   3. con `operator=or` (por si el default `and` exige todas las palabras)
 *
 * No escribe nada: imprime y sale.
 *
 * Uso: VTEX_ACCOUNT_NAME=... node src/is-probe.js [termino ...]
 */

const PAGE_SIZE = 10;
const MAX_CHARS = 1800;
const POR_DEFECTO = ['leche', 'manteca', 'azucar', 'papel higienico', 'queso crema'];

function base() {
  const account = process.env.VTEX_ACCOUNT_NAME;
  if (!account) throw new Error('Falta VTEX_ACCOUNT_NAME');
  const environment = process.env.VTEX_ENVIRONMENT || 'vtexcommercestable';
  return `https://${account}.${environment}.com.br`;
}

const VARIANTES = [
  { nombre: 'como lo hace el diagnostico', extra: '' },
  { nombre: 'con locale=es-AR', extra: '&locale=es-AR' },
  { nombre: 'con operator=or', extra: '&operator=or' },
];

async function probar(termino, variante) {
  const url = `${base()}/api/io/_v/api/intelligent-search/product_search/`
    + `?query=${encodeURIComponent(termino)}&count=${PAGE_SIZE}${variante.extra}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const texto = await res.text();
  let json = null;
  try { json = JSON.parse(texto); } catch { /* se muestra crudo */ }

  const productos = Array.isArray(json?.products) ? json.products : [];
  console.log(`    ${variante.nombre.padEnd(30)} HTTP ${res.status}`
    + `  recordsFiltered=${json?.recordsFiltered ?? 'n/d'}`
    + `  products=${productos.length}`);

  if (productos.length) {
    for (const p of productos.slice(0, 3)) {
      console.log(`        · ${p.productName || p.name || '(sin nombre)'}`);
    }
  }

  // Lo que dice IS sobre cómo entendió la consulta. Es justo lo que distingue
  // "no hay productos" de "no entendí la consulta".
  const pistas = {};
  for (const k of ['correction', 'queryArgs', 'translated', 'operator', 'fuzzy',
                   'locale', 'suggestion', 'banners', 'pagination', 'error', 'message']) {
    if (json && json[k] !== undefined) pistas[k] = json[k];
  }
  if (Object.keys(pistas).length) {
    console.log(`        pistas: ${JSON.stringify(pistas).slice(0, MAX_CHARS)}`);
  }
  if (!json) console.log(`        cuerpo: ${texto.slice(0, 300)}`);
  if (json && !productos.length && !Object.keys(pistas).length) {
    console.log(`        claves de la respuesta: ${Object.keys(json).join(', ')}`);
  }
  return productos.length;
}

async function main() {
  if (!process.env.VTEX_ACCOUNT_NAME) {
    console.log('⚠ Falta VTEX_ACCOUNT_NAME.');
    process.exit(1);
  }
  const terminos = process.argv.slice(2).filter(Boolean);
  const lista = terminos.length ? terminos : POR_DEFECTO;

  console.log(`Intelligent Search · ${base()}\n`);
  const resumen = [];
  for (const t of lista) {
    console.log(`"${t}"`);
    const fila = { termino: t };
    for (const v of VARIANTES) {
      try { fila[v.nombre] = await probar(t, v); }
      catch (e) { console.log(`    ${v.nombre.padEnd(30)} falló: ${e.message}`); fila[v.nombre] = null; }
    }
    resumen.push(fila);
    console.log('');
  }

  console.log('── Resumen (productos devueltos) ──');
  const cols = VARIANTES.map((v) => v.nombre);
  console.log(`  ${'término'.padEnd(20)}${cols.map((c) => c.slice(0, 28).padEnd(30)).join('')}`);
  for (const f of resumen) {
    console.log(`  ${f.termino.padEnd(20)}${cols.map((c) => String(f[c] ?? 'error').padEnd(30)).join('')}`);
  }

  const arreglaLocale = resumen.some((f) => !f[cols[0]] && f[cols[1]]);
  const arreglaOr = resumen.some((f) => !f[cols[0]] && f[cols[2]]);
  console.log('');
  if (arreglaLocale) console.log('→ `locale=es-AR` arregla términos que hoy dan 0: hay que agregarlo a la llamada.');
  if (arreglaOr) console.log('→ `operator=or` arregla términos que hoy dan 0: el default exige todas las palabras.');
  if (!arreglaLocale && !arreglaOr) {
    console.log('→ Ninguna variante cambia nada: el 0 no viene de la llamada. Mirá las pistas');
    console.log('  de arriba y el estado del índice de Intelligent Search en el admin de VTEX.');
  }
}

main().catch((e) => { console.error('is-probe falló:', e.message); process.exit(1); });

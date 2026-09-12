'use strict';

/**
 * Herramienta de investigación (no forma parte del pipeline productivo).
 *
 * Cruza el top de términos buscados de verdad (ya relevado en
 * config/search-inspect.report.json, vía GA4) contra el buscador REAL de
 * VTEX, para marcar cuáles no traen resultados o traen muy pocos — el
 * primer diagnóstico concreto para el módulo "Buscador".
 *
 * Nota honesta: esto usa la API de catálogo pública de VTEX
 * (`/api/catalog_system/pub/products/search`, la misma que ya usa
 * api/product-image.js) en vez de la API nueva de Intelligent Search,
 * porque el contrato exacto de esta ya está probado en este proyecto — no
 * hay que adivinar el formato de la respuesta. Las dos consultan el mismo
 * catálogo, así que "cuántos productos aparecen" es un dato válido en
 * cualquiera de las dos. Si más adelante hace falta algo específico de
 * Intelligent Search (sinónimos, relevancia, "quizás quisiste decir"), se
 * puede sumar aparte una vez confirmado el formato real de esa API.
 *
 * Cómo arregla los términos antes de diagnosticar (el reporte de GA4 tenía
 * dos bugs de tracking visibles a simple vista):
 *   - "Leche" y "leche" contaban aparte → se unifican en minúsculas.
 *   - "papel higienico" y "papel%20higienico" contaban aparte → se
 *     decodifican los espacios antes de sumar.
 *
 * Uso: VTEX_ACCOUNT_NAME=... [VTEX_ENVIRONMENT=...] node src/inspect-search-diagnosis.js
 */
const fs = require('fs');
const path = require('path');

const IN_PATH = path.join(__dirname, '..', 'config', 'search-inspect.report.json');
const OUT_PATH = path.join(__dirname, '..', 'config', 'search-diagnosis.report.json');
const TOP_N = Number(process.env.INSPECT_SEARCH_TOP_N || 200);
const CONCURRENCY = 8;

function baseUrl() {
  const account = process.env.VTEX_ACCOUNT_NAME;
  const environment = process.env.VTEX_ENVIRONMENT || 'vtexcommercestable';
  return `https://${account}.${environment}.com.br`;
}

/** "Leche", "leche", "papel%20higienico" y "papel higienico" tienen que
 * terminar siendo EL MISMO término al sumar volumen de búsqueda. */
function normalizeTerm(raw) {
  let t = raw;
  try { t = decodeURIComponent(t.replace(/\+/g, ' ')); } catch { /* ya estaba decodificado */ }
  return t.trim().toLowerCase();
}

function topSearchTerms(report, n) {
  const searchAttempt = report.searchTermAttempts?.find((a) => a.eventName === 'search' && a.ok && a.sample?.length);
  if (!searchAttempt) return [];
  const byTerm = new Map();
  for (const row of searchAttempt.sample) {
    const term = normalizeTerm(row.term);
    if (!term) continue; // búsquedas vacías (abrir el buscador sin tipear nada): no hay nada que diagnosticar
    byTerm.set(term, (byTerm.get(term) || 0) + row.count);
  }
  return [...byTerm.entries()]
    .map(([term, count]) => ({ term, searchCount: count }))
    .sort((a, b) => b.searchCount - a.searchCount)
    .slice(0, n);
}

async function searchProductCount(term) {
  const url = `${baseUrl()}/api/catalog_system/pub/products/search?ft=${encodeURIComponent(term)}&_from=0&_to=9`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok && res.status !== 206) throw new Error(`VTEX ${res.status}`);
  const products = await res.json().catch(() => []);
  const count = Array.isArray(products) ? products.length : 0;

  // VTEX manda el total real en esta cabecera ("resources 0-9/123"), pero
  // solo cuando corta la respuesta (206) — si no viene, no hay forma de
  // saber si "10" es el total real o si hay muchos más y esta consulta solo
  // pidió los primeros 10. Se marca `capped` para no mostrar un número
  // como si fuera exacto cuando en realidad es "10 o más".
  const range = res.headers.get('resources-content-range'); // "resources 0-9/123"
  const total = range ? Number(range.split('/')[1]) : null;
  const capped = !(Number.isFinite(total));

  return {
    total: Number.isFinite(total) ? total : count,
    capped: capped && count >= 10,
    sample: (products || []).slice(0, 3).map((p) => p.productName).filter(Boolean),
  };
}

async function forEachLimit(items, limit, fn) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

async function main() {
  if (!process.env.VTEX_ACCOUNT_NAME) {
    console.log('⚠ Falta VTEX_ACCOUNT_NAME. Salgo sin error.');
    return;
  }
  if (!fs.existsSync(IN_PATH)) {
    console.log(`⚠ No existe ${path.relative(process.cwd(), IN_PATH)} — corré primero "npm run inspect:search".`);
    return;
  }

  const inputReport = JSON.parse(fs.readFileSync(IN_PATH, 'utf8'));
  const terms = topSearchTerms(inputReport, TOP_N);
  if (!terms.length) {
    console.log('⚠ El reporte de GA4 no tiene términos de búsqueda para diagnosticar.');
    return;
  }
  console.log(`Diagnosticando ${terms.length} términos (top búsquedas reales, ya normalizados) contra VTEX...\n`);

  await forEachLimit(terms, CONCURRENCY, async (t) => {
    try {
      const r = await searchProductCount(t.term);
      t.vtexResults = r.total;
      t.vtexResultsCapped = r.capped; // true: "vtexResults o más" (no se pidió el total real, se cortó en la página)
      t.sampleProducts = r.sample;
      t.status = r.total === 0 ? 'sin_resultados' : r.total < 5 ? 'pocos_resultados' : 'ok';
    } catch (e) {
      t.error = e.message;
      t.status = 'error_consulta';
    }
  });

  terms.sort((a, b) => {
    const rank = { sin_resultados: 0, error_consulta: 1, pocos_resultados: 2, ok: 3 };
    return (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || b.searchCount - a.searchCount;
  });

  for (const t of terms) {
    const tag = { sin_resultados: '✗ SIN RESULTADOS', pocos_resultados: '⚠ pocos resultados', error_consulta: '? error', ok: '✓' }[t.status];
    const productsTxt = t.vtexResults == null ? '—' : `${t.vtexResults}${t.vtexResultsCapped ? '+' : ''}`;
    console.log(`  ${tag.padEnd(20)} "${t.term}" — ${t.searchCount} búsquedas · ${productsTxt} productos`);
  }

  const sinResultados = terms.filter((t) => t.status === 'sin_resultados');
  const pocosResultados = terms.filter((t) => t.status === 'pocos_resultados');
  console.log(`\n${sinResultados.length} de ${terms.length} términos NO traen ningún resultado.`);
  console.log(`${pocosResultados.length} de ${terms.length} traen menos de 5 resultados.`);

  const report = {
    generatedAt: new Date().toISOString(),
    source: 'config/search-inspect.report.json (GA4, evento "search")',
    termsAnalyzed: terms.length,
    summary: {
      sinResultados: sinResultados.length,
      pocosResultados: pocosResultados.length,
      ok: terms.length - sinResultados.length - pocosResultados.length,
    },
    terms,
  };
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
  console.log(`\nReporte guardado en ${path.relative(process.cwd(), OUT_PATH)}`);
}

main().catch((err) => {
  console.error('inspect-search-diagnosis falló:', err.message);
  process.exit(1);
});

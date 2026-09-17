'use strict';

/**
 * Cruza el top de términos buscados de verdad (ya relevado en
 * config/search-inspect.report.json, vía GA4) contra el buscador REAL de
 * VTEX, para marcar cuáles no traen resultados o traen muy pocos, sugerir
 * una corrección verificada cuando existe, y dejar un reporte listo para
 * mostrar en el módulo "Buscador" del dashboard.
 *
 * Nota honesta: esto usa la API de catálogo pública de VTEX
 * (`/api/catalog_system/pub/products/search`, la misma que ya usa
 * api/product-image.js) en vez de la API nueva de Intelligent Search,
 * porque el contrato exacto de esta ya está probado en este proyecto — no
 * hay que adivinar el formato de la respuesta. Las dos consultan el mismo
 * catálogo, así que "cuántos productos aparecen" es un dato válido en
 * cualquiera de las dos. Si más adelante hace falta algo específico de
 * Intelligent Search (relevancia, "quizás quisiste decir" nativo de VTEX),
 * se puede sumar aparte una vez confirmado el formato real de esa API.
 *
 * Cómo arregla los términos antes de diagnosticar (el reporte de GA4 tenía
 * dos bugs de tracking visibles a simple vista):
 *   - "Leche" y "leche" contaban aparte → se unifican en minúsculas.
 *   - "papel higienico" y "papel%20higienico" contaban aparte → se
 *     decodifican los espacios antes de sumar.
 *
 * Sinónimo sugerido (`suggestion`): para un término sin resultados o con
 * pocos, se generan variantes por errores de tipeo típicos del español
 * (b/v, s/z, y/ll, sin acentos, singular/plural) y se consulta CADA UNA
 * de verdad contra VTEX — solo se guarda como sugerencia si esa variante
 * SÍ trae resultados reales. No es una adivinanza: es una corrección
 * verificada en el momento.
 *
 * "≥5 resultados" no alcanza para decir que un término está OK: VTEX puede
 * devolver 10 productos que no tienen nada que ver (ej. "palta" trayendo
 * shampoo con palta, "huevos" trayendo juguetes de Pascua) — eso cuenta
 * como éxito si solo se mide cantidad, pero es exactamente el tipo de
 * búsqueda que frustra a alguien de verdad. Sin usar IA (todavía no hay una
 * key configurada — ver `assessRelevanceWithAI` más abajo), se mide
 * CONSISTENCIA DE CATEGORÍA: un término de almacén real debería traer
 * resultados concentrados en 1-2 categorías relacionadas. Si los primeros
 * resultados están dispersos en categorías sin relación, es una señal
 * honesta (no perfecta, pero verificable) de que el matching es débil. Un
 * término así se marca `resultados_dispersos`, un escalón por debajo de
 * `ok` aunque la cantidad alcance.
 *
 * Salidas:
 *   - config/search-diagnosis.report.json         reporte completo (interno)
 *   - docs/data/web/search-diagnosis.json          versión recortada para el dashboard
 *   - docs/data/web/search-diagnosis-history.json  una entrada por día corrido (tendencia)
 *
 * Uso: VTEX_ACCOUNT_NAME=... [VTEX_ENVIRONMENT=...] node src/inspect-search-diagnosis.js
 */
const fs = require('fs');
const path = require('path');
const { motoresActivos, vtexCorrection } = require('./search-engines');
const relevanciaIA = require('./search-relevance-ai');

const IN_PATH = path.join(__dirname, '..', 'config', 'search-inspect.report.json');
const OUT_PATH = path.join(__dirname, '..', 'config', 'search-diagnosis.report.json');
const CLIENT_OUT_PATH = path.join(__dirname, '..', 'docs', 'data', 'web', 'search-diagnosis.json');
const HISTORY_PATH = path.join(__dirname, '..', 'docs', 'data', 'web', 'search-diagnosis-history.json');
const TOP_N = Number(process.env.INSPECT_SEARCH_TOP_N || 200);
const TOP_TERMS_SHOWN = 30;
const HISTORY_MAX = 90;
const CONCURRENCY = 8;
const MAX_CANDIDATES_TRIED = 5;
// Con menos de 3 productos con categoría conocida no hay muestra suficiente
// para hablar de "dispersión" — se deja el término como está (no se castiga
// por falta de dato). 60%: al menos 3 de los primeros 5, o 6 de los primeros
// 10, comparten la categoría más frecuente — umbral conservador a propósito,
// para no marcar como "disperso" un término que solo tiene variedad normal
// de marcas dentro del mismo rubro.
const DISPERSION_MIN_SAMPLE = 3;
const DISPERSION_THRESHOLD = 0.6;

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

function stripAccents(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Distancia de edición simple, solo para ordenar candidatos de más a menos parecidos. */
function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

// Confusiones de ortografía típicas del español (no gramática, solo sonido
// parecido / error de tipeo común) — cada una se aplica en las dos
// direcciones porque no sabemos de antemano cuál letra está "mal".
const SPELLING_SWAPS = [[/b/g, 'v'], [/v/g, 'b'], [/s/g, 'z'], [/z/g, 's'], [/y/g, 'll'], [/ll/g, 'y']];

/** Variantes candidatas de un término, para probar contra el catálogo real. */
function candidateCorrections(term) {
  const candidates = new Set();
  const noAccents = stripAccents(term);
  if (noAccents !== term) candidates.add(noAccents);
  for (const [pattern, repl] of SPELLING_SWAPS) {
    const c = term.replace(pattern, repl);
    if (c !== term) candidates.add(c);
  }
  if (term.endsWith('s')) candidates.add(term.slice(0, -1)); // plural → singular
  else candidates.add(`${term}s`); // singular → plural
  candidates.delete(term);
  return [...candidates].sort((a, b) => levenshtein(a, term) - levenshtein(b, term)).slice(0, MAX_CANDIDATES_TRIED);
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

/** Categoría de nivel superior de un producto del catálogo público de VTEX
 * (`categories: ["/Almacén/Lácteos/Quesos/"]`, raíz primero). Devuelve null
 * si el producto no trae esa info — pasa con catálogos más viejos, y no hay
 * que inventar un dato que no está. */
function topLevelCategory(product) {
  const path = Array.isArray(product.categories) ? product.categories[0] : null;
  if (!path) return null;
  const parts = String(path).split('/').filter(Boolean);
  return parts[0] || null;
}

/** Qué tan concentrados están los primeros resultados en una sola categoría.
 * null si no hay muestra suficiente para opinar (ver DISPERSION_MIN_SAMPLE). */
function categoryDispersion(products) {
  const cats = products.map(topLevelCategory).filter(Boolean);
  if (cats.length < DISPERSION_MIN_SAMPLE) return null;
  const counts = {};
  for (const c of cats) counts[c] = (counts[c] || 0) + 1;
  const [dominant, dominantCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return { consistency: dominantCount / cats.length, dominant, categories: [...new Set(cats)] };
}

/** Busca el término en UN motor y devuelve lo que hace falta para juzgarlo.
 *  La forma normalizada la garantiza src/search-engines.js, así que esto ya no
 *  sabe con qué API está hablando. */
async function buscarEn(motor, term) {
  const r = await motor.search(term);
  return {
    total: r.total,
    capped: r.capped,
    sample: r.products.map((p) => p.name).filter(Boolean).slice(0, 3),
    dispersion: categoryDispersion(r.products),
  };
}

/** El veredicto sobre un resultado, separado del bucle para poder aplicarlo
 *  IGUAL a cada motor y después comparar manzanas con manzanas. */
function clasificar(r) {
  if (r.total === 0) return { status: 'sin_resultados' };
  if (r.total < 5) return { status: 'pocos_resultados' };
  if (r.dispersion && r.dispersion.consistency < DISPERSION_THRESHOLD) {
    return {
      status: 'resultados_dispersos',
      categoryConsistency: r.dispersion.consistency,
      dominantCategory: r.dispersion.dominant,
      resultCategories: r.dispersion.categories,
    };
  }
  return { status: 'ok' };
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

// Qué motor manda. Lo define main() a partir de SEARCH_ENGINES; el resto se
// usa solo para comparar. Módulo-global para no pasarlo por seis firmas.
let MOTOR_PRIMARIO = null;
let MOTORES = [];
let aiDiferido = null;

/** Prueba, EN EL MOTOR PRIMARIO de verdad, las variantes candidatas de un término fallido.
 * Devuelve la primera que trae resultados reales, o null si ninguna sirvió. */
async function findVerifiedSuggestion(term) {
  for (const candidate of candidateCorrections(term)) {
    try {
      const r = await buscarEn(MOTOR_PRIMARIO, candidate);
      if (r.total > 0) return { term: candidate, vtexResults: r.total, vtexResultsCapped: r.capped };
    } catch { /* esta variante no respondió, se sigue probando la próxima */ }
  }
  return null;
}

function recommendation(t) {
  if (t.status === 'ok') return null;
  if (t.status === 'error_consulta') return 'No se pudo consultar VTEX para este término — reintentar en la próxima corrida.';
  const vol = `${t.searchCount.toLocaleString('es-AR')} búsquedas/mes`;
  if (t.status === 'resultados_dispersos') {
    return `Trae ${Math.round(t.categoryConsistency * 100)}% de resultados de "${t.dominantCategory}" y el resto de categorías sin relación (${(t.resultCategories || []).filter((c) => c !== t.dominantCategory).join(', ')}) — revisar si el buscador está completando con coincidencias débiles en vez de lo que la gente busca (${vol}).`;
  }
  if (t.suggestion) {
    return t.status === 'sin_resultados'
      ? `Alta prioridad: agregar "${t.term}" como sinónimo de "${t.suggestion.term}" en VTEX (búsqueda real que sí tiene stock) — ${vol} van hoy a una página vacía.`
      : `Agregar "${t.term}" como sinónimo de "${t.suggestion.term}" para ampliar de ${t.vtexResults} a ${t.suggestion.vtexResults} resultados (${vol}).`;
  }
  return t.status === 'sin_resultados'
    ? `Revisar manualmente (${vol} sin resultado y sin variante cercana con stock): puede faltar el producto en catálogo, ser una marca no vendida, o requerir un sinónimo que no es un simple error de tipeo.`
    : `Solo ${t.vtexResults} resultado(s) para ${vol}: revisar stock/variantes disponibles de este producto.`;
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

  const { activos, omitidos } = motoresActivos();
  if (!activos.length) {
    console.log('⚠ Ningún motor de búsqueda disponible:');
    for (const o of omitidos) console.log(`   · ${o.id}: ${o.motivo}`);
    return;
  }
  MOTORES = activos;
  MOTOR_PRIMARIO = activos[0];
  console.log(`Motor primario: ${MOTOR_PRIMARIO.label}`);
  if (activos.length > 1) console.log(`Comparando contra: ${activos.slice(1).map((e) => e.label).join(', ')}`);
  for (const o of omitidos) console.log(`   (omitido ${o.id}: ${o.motivo})`);

  const inputReport = JSON.parse(fs.readFileSync(IN_PATH, 'utf8'));
  const terms = topSearchTerms(inputReport, TOP_N);
  if (!terms.length) {
    console.log('⚠ El reporte de GA4 no tiene términos de búsqueda para diagnosticar.');
    return;
  }
  console.log(`Diagnosticando ${terms.length} términos (top búsquedas reales, ya normalizados) contra VTEX...\n`);

  await forEachLimit(terms, CONCURRENCY, async (t) => {
    // Cada motor se consulta por separado y se juzga con el MISMO criterio.
    // El veredicto del término lo fija el motor primario (el que corre en el
    // sitio); los demás quedan al lado para poder comparar.
    t.engines = {};
    for (const motor of MOTORES) {
      try {
        const r = await buscarEn(motor, t.term);
        const v = clasificar(r);
        t.engines[motor.id] = {
          results: r.total, resultsCapped: r.capped, sampleProducts: r.sample, ...v,
        };
      } catch (e) {
        t.engines[motor.id] = { status: 'error_consulta', error: e.message };
      }
    }

    const p = t.engines[MOTOR_PRIMARIO.id];
    t.status = p.status;
    t.vtexResults = p.results ?? null;
    t.vtexResultsCapped = !!p.resultsCapped;
    t.sampleProducts = p.sampleProducts || [];
    if (p.error) t.error = p.error;
    if (p.categoryConsistency != null) {
      t.categoryConsistency = p.categoryConsistency;
      t.dominantCategory = p.dominantCategory;
      t.resultCategories = p.resultCategories;
    }

  });

  // ── Relevancia semántica con IA ───────────────────────────────────────────
  // Va DESPUES del bucle y en un solo lote: 200 llamadas de a una serían 200
  // requests interactivos al doble de precio. Solo se juzgan los terminos que
  // trajeron productos (sin resultados no hay nada que juzgar) y que las reglas
  // no condenaron ya: si un termino no trae NADA, la IA no aporta.
  const paraIA = terms
    .filter((t) => (t.sampleProducts || []).length > 0)
    .map((t) => ({ term: t.term, products: t.sampleProducts }));

  if (relevanciaIA.habilitado()) {
    const { veredictos, diferido } = await relevanciaIA.analizarRelevancia(paraIA);
    for (const t of terms) {
      const v = veredictos.get(t.term);
      if (!v) continue;
      t.aiRelevance = v;
      // La IA puede DEGRADAR un veredicto pero nunca mejorarlo: si las reglas
      // dijeron "sin resultados", eso es un hecho medido y no lo discute nadie.
      // Al reves si: un termino con 40 productos que no tienen nada que ver
      // esta roto, aunque la cantidad y la categoria den bien.
      if (t.status === 'ok' && v.veredicto === 'irrelevante') t.status = 'resultados_irrelevantes';
    }
    if (diferido) aiDiferido = diferido;
  } else {
    console.log(`  IA de relevancia apagada: ${relevanciaIA.porQueNo()}`);
  }

  // La corrección NATIVA del motor: es la que de verdad va a ver el usuario en
  // el sitio, a diferencia de las variantes que este script genera a mano.
  if (MOTOR_PRIMARIO.id.startsWith('vtex')) {
    const conProblema = terms.filter((t) => t.status === 'sin_resultados' || t.status === 'pocos_resultados');
    await forEachLimit(conProblema, CONCURRENCY, async (t) => {
      try {
        const c = await vtexCorrection(t.term);
        if (c?.corregido && c.termino) t.nativeCorrection = c.termino;
      } catch { /* la corrección es un extra: si falla, el diagnóstico sigue igual */ }
    });
  }

  // Sinónimo sugerido: solo vale la pena buscarlo (y gastar más consultas a
  // VTEX) para los términos que ya fallaron — son pocos frente al total.
  const failing = terms.filter((t) => t.status === 'sin_resultados' || t.status === 'pocos_resultados');
  await forEachLimit(failing, CONCURRENCY, async (t) => {
    t.suggestion = await findVerifiedSuggestion(t.term);
  });
  for (const t of terms) t.recommendation = recommendation(t);

  terms.sort((a, b) => {
    const rank = { sin_resultados: 0, error_consulta: 1, pocos_resultados: 2, resultados_irrelevantes: 3, resultados_dispersos: 4, ok: 5 };
    return (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || b.searchCount - a.searchCount;
  });

  for (const t of terms) {
    const tag = {
      sin_resultados: '✗ SIN RESULTADOS', pocos_resultados: '⚠ pocos resultados',
      resultados_dispersos: '⚠ resultados dispersos', resultados_irrelevantes: '✗ IRRELEVANTES',
      error_consulta: '? error', ok: '✓',
    }[t.status];
    const productsTxt = t.vtexResults == null ? '—' : `${t.vtexResults}${t.vtexResultsCapped ? '+' : ''}`;
    const sugTxt = t.suggestion ? ` → probá "${t.suggestion.term}" (${t.suggestion.vtexResults} productos)` : '';
    const dispTxt = t.status === 'resultados_dispersos' ? ` (${Math.round(t.categoryConsistency * 100)}% "${t.dominantCategory}")` : '';
    console.log(`  ${tag.padEnd(24)} "${t.term}" — ${t.searchCount} búsquedas · ${productsTxt} productos${dispTxt}${sugTxt}`);
  }

  const sinResultados = terms.filter((t) => t.status === 'sin_resultados');
  const pocosResultados = terms.filter((t) => t.status === 'pocos_resultados');
  const resultadosDispersos = terms.filter((t) => t.status === 'resultados_dispersos');
  const resultadosIrrelevantes = terms.filter((t) => t.status === 'resultados_irrelevantes');
  console.log(`\n${sinResultados.length} de ${terms.length} términos NO traen ningún resultado.`);
  console.log(`${pocosResultados.length} de ${terms.length} traen menos de 5 resultados.`);
  console.log(`${resultadosDispersos.length} de ${terms.length} traen ≥5 resultados pero dispersos en categorías sin relación.`);

  const totalSearches = terms.reduce((s, t) => s + t.searchCount, 0);
  // "Búsquedas perdidas" pesa por volumen real de búsqueda, no por cantidad
  // de términos — un solo término de altísimo volumen roto pesa lo que tiene
  // que pesar, en vez de licuarse como "1 de 200". Los resultados dispersos
  // cuentan acá también: no son "sin resultados", pero es la misma frustración
  // real para quien busca algo puntual y encuentra productos que no tienen que ver.
  const lostSearches = [...sinResultados, ...pocosResultados, ...resultadosDispersos, ...resultadosIrrelevantes]
    .reduce((s, t) => s + t.searchCount, 0);

  const summary = {
    sinResultados: sinResultados.length,
    pocosResultados: pocosResultados.length,
    resultadosDispersos: resultadosDispersos.length,
    resultadosIrrelevantes: resultadosIrrelevantes.length,
    ok: terms.length - sinResultados.length - pocosResultados.length
        - resultadosDispersos.length - resultadosIrrelevantes.length,
    totalSearches,
    lostSearches,
  };

  const report = {
    generatedAt: new Date().toISOString(),
    source: 'config/search-inspect.report.json (GA4, evento "search")',
    engine: MOTOR_PRIMARIO.id,
    engineLabel: MOTOR_PRIMARIO.label,
    enginesCompared: MOTORES.map((e) => ({ id: e.id, label: e.label })),
    termsAnalyzed: terms.length,
    summary,
    comparison: compararMotores(terms),
    ai: {
      activa: relevanciaIA.habilitado(),
      motivo: relevanciaIA.porQueNo(),
      modelo: relevanciaIA.habilitado() ? relevanciaIA.MODELO : null,
      loteDiferido: aiDiferido,
      juzgados: terms.filter((t) => t.aiRelevance).length,
    },
    terms,
  };
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
  console.log(`\nReporte guardado en ${path.relative(process.cwd(), OUT_PATH)}`);

  writeClientReport(report);
  updateHistory(summary, terms.length);
}

/**
 * Motor contra motor, pesado por volumen de búsqueda. null con un solo motor.
 *
 * `mejoresQue` es lo que de verdad importa para decidir: en cuántas búsquedas
 * reales (no en cuántos términos) el otro motor le contesta bien a la gente y
 * el primario no. Contar términos licuaría un término de altísimo volumen
 * roto como "1 de 200".
 */
function compararMotores(terms) {
  if (MOTORES.length < 2) return null;
  const malo = (st) => st === 'sin_resultados' || st === 'pocos_resultados' || st === 'resultados_dispersos';
  const out = { primario: MOTOR_PRIMARIO.id, motores: {} };

  for (const motor of MOTORES) {
    const conteo = { ok: 0, sin_resultados: 0, pocos_resultados: 0, resultados_dispersos: 0, error_consulta: 0 };
    let busquedasMalas = 0;
    for (const t of terms) {
      const st = t.engines?.[motor.id]?.status;
      if (st in conteo) conteo[st] += 1;
      if (malo(st)) busquedasMalas += t.searchCount;
    }
    out.motores[motor.id] = { label: motor.label, ...conteo, busquedasMalas };
  }

  for (const motor of MOTORES) {
    if (motor.id === MOTOR_PRIMARIO.id) continue;
    const gana = [], pierde = [];
    let busquedasGanadas = 0, busquedasPerdidas = 0;
    for (const t of terms) {
      const a = t.engines?.[MOTOR_PRIMARIO.id]?.status;
      const b = t.engines?.[motor.id]?.status;
      if (!a || !b || a === b) continue;
      if (malo(a) && !malo(b)) {
        gana.push({ term: t.term, searchCount: t.searchCount, primario: a, otro: b });
        busquedasGanadas += t.searchCount;
      } else if (!malo(a) && malo(b)) {
        pierde.push({ term: t.term, searchCount: t.searchCount, primario: a, otro: b });
        busquedasPerdidas += t.searchCount;
      }
    }
    const orden = (x, y) => y.searchCount - x.searchCount;
    out.motores[motor.id].mejoresQue = {
      gana: gana.sort(orden).slice(0, 20), pierde: pierde.sort(orden).slice(0, 20),
      terminosGanados: gana.length, terminosPerdidos: pierde.length,
      busquedasGanadas, busquedasPerdidas,
    };
  }
  return out;
}

/** Recomendaciones generales (no por término) para el panel del dashboard. */
function globalRecommendations(summary) {
  const recs = [];
  if (summary.sinResultados > 0) {
    recs.push(`${summary.sinResultados} término(s) no traen ningún resultado — priorizalos por volumen, son los que más gente frustra.`);
  }
  if (summary.lostSearches > 0) {
    const pct = summary.totalSearches ? (summary.lostSearches / summary.totalSearches) * 100 : 0;
    recs.push(`Se estima que ${summary.lostSearches.toLocaleString('es-AR')} búsquedas del último mes (${pct.toFixed(1)}% de las analizadas) terminaron en 0 o muy pocos resultados.`);
  }
  if (summary.pocosResultados > 0) {
    recs.push(`${summary.pocosResultados} término(s) traen menos de 5 productos — revisar stock/variantes o sumar sinónimos amplía el catálogo visible sin cambiar nada del lado de marketing.`);
  }
  if (summary.resultadosDispersos > 0) {
    recs.push(`${summary.resultadosDispersos} término(s) traen suficientes productos pero de categorías sin relación entre sí — el buscador probablemente está completando con coincidencias débiles en vez de lo que la gente realmente busca.`);
  }
  if (!recs.length) {
    recs.push('No se detectaron términos de alto volumen sin resultados en esta corrida — seguir ampliando la muestra hacia la cola larga para encontrar casos menos frecuentes.');
  }
  return recs;
}

/** Versión recortada del reporte, solo lo que necesita el dashboard (docs/). */
function writeClientReport(report) {
  const topTerms = [...report.terms]
    .sort((a, b) => b.searchCount - a.searchCount)
    .slice(0, TOP_TERMS_SHOWN)
    .map((t) => ({ term: t.term, searchCount: t.searchCount, status: t.status }));

  const problems = report.terms
    .filter((t) => t.status !== 'ok')
    .map((t) => ({
      term: t.term,
      searchCount: t.searchCount,
      status: t.status,
      vtexResults: t.vtexResults ?? null,
      vtexResultsCapped: !!t.vtexResultsCapped,
      sampleProducts: t.sampleProducts || [],
      suggestion: t.suggestion || null,
      nativeCorrection: t.nativeCorrection || null,
      aiRelevance: t.aiRelevance || null,
      categoryConsistency: t.categoryConsistency ?? null,
      dominantCategory: t.dominantCategory || null,
      resultCategories: t.resultCategories || null,
      recommendation: t.recommendation,
    }));

  const client = {
    generatedAt: report.generatedAt,
    engine: report.engine,
    engineLabel: report.engineLabel,
    enginesCompared: report.enginesCompared,
    comparison: report.comparison,
    ai: report.ai,
    termsAnalyzed: report.termsAnalyzed,
    summary: report.summary,
    recommendations: globalRecommendations(report.summary),
    topTerms,
    problems,
  };
  fs.mkdirSync(path.dirname(CLIENT_OUT_PATH), { recursive: true });
  fs.writeFileSync(CLIENT_OUT_PATH, JSON.stringify(client, null, 2));
  console.log(`Reporte del dashboard guardado en ${path.relative(process.cwd(), CLIENT_OUT_PATH)}`);
}

/** Una entrada por día corrido (se pisa si ya corrió hoy), para ver la tendencia. */
function updateHistory(summary, termsAnalyzed) {
  let history = [];
  if (fs.existsSync(HISTORY_PATH)) {
    try { history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')); } catch { history = []; }
  }
  const today = new Date().toISOString().slice(0, 10);
  const entry = { date: today, termsAnalyzed, ...summary };
  const idx = history.findIndex((h) => h.date === today);
  if (idx >= 0) history[idx] = entry;
  else history.push(entry);
  history = history.slice(-HISTORY_MAX);
  fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
  console.log(`Historial actualizado en ${path.relative(process.cwd(), HISTORY_PATH)} (${history.length} corridas guardadas).`);
}

main().catch((err) => {
  console.error('inspect-search-diagnosis falló:', err.message);
  process.exit(1);
});

'use strict';

/**
 * Le pregunta AL SITIO qué pasa cuando alguien busca cada uno de los términos
 * más buscados: ¿muestra una página de resultados, o redirige a una categoría?
 *
 * Por qué así y no leyendo la configuración. El admin de VTEX tiene 561
 * redirects paginados de 15 en 15 y solo botón de importar, no de exportar. El
 * export sale por la CLI de VTEX, que es una herramienta de desarrollo que no
 * todos tienen ni tienen por qué tener. Y mirar la config tiene un problema de
 * fondo igual: lo que importa no es lo que dice el archivo, es lo que le pasa a
 * la persona que busca. Eso se mide pidiéndole la página y viendo si el
 * servidor responde con un redirect.
 *
 * Cómo funciona: por cada término pide la URL sin seguir el redirect
 * (`redirect: 'manual'`) y mira el status. 301/302 con cabecera Location
 * significa que el término está redirigido, y el Location dice adónde.
 *
 * Prueba DOS formas de URL, porque no sabemos de antemano cuál usa el buscador
 * de este sitio:
 *   · la ruta pelada  /{slug}          (donde se definen los redirects de VTEX)
 *   · la búsqueda     /{slug}?_q=...   (a donde suele ir la caja de búsqueda)
 * Imprime las dos para poder ver cuál refleja el comportamiento real.
 *
 * Escribe config/search-redirects.json solo si se le pasa --escribir. Por
 * defecto imprime y no toca nada.
 *
 * Uso:  STORE_URL=https://www.carrefour.com.ar node src/redirect-probe.js [--escribir] [--top N]
 */

const fs = require('fs');
const path = require('path');

const IN_PATH = path.join(__dirname, '..', 'config', 'search-inspect.report.json');
const OUT_PATH = path.join(__dirname, '..', 'config', 'search-redirects.json');
const CONCURRENCIA = 6;   // suave: es el sitio de producción
const TIMEOUT_MS = 15000;

function normalizeTerm(raw) {
  let t = String(raw || '');
  try { t = decodeURIComponent(t.replace(/\+/g, ' ')); } catch { /* ya estaba */ }
  return t.trim().toLowerCase();
}

/** "papel higienico" -> "papel-higienico" */
function slug(term) {
  return term.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

function topTerminos(n) {
  const rep = JSON.parse(fs.readFileSync(IN_PATH, 'utf8'));
  const intento = rep.searchTermAttempts?.find((a) => a.eventName === 'search' && a.ok && a.sample?.length);
  if (!intento) return [];
  const m = new Map();
  for (const row of intento.sample) {
    const t = normalizeTerm(row.term);
    if (t) m.set(t, (m.get(t) || 0) + row.count);
  }
  return [...m.entries()].map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count).slice(0, n);
}

async function pedir(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: ctrl.signal,
      // Sin User-Agent de navegador algunos storefronts responden distinto.
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WebDash-diagnostico)', Accept: 'text/html' },
    });
    return { status: res.status, location: res.headers.get('location') || null };
  } catch (e) {
    return { status: 0, location: null, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(timer); }
}

async function forEachLimit(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k], k); }
  }));
}

const esRedirect = (r) => r.status >= 300 && r.status < 400 && r.location;

async function main() {
  const base = (process.env.STORE_URL || 'https://www.carrefour.com.ar').replace(/\/+$/, '');
  const escribir = process.argv.includes('--escribir');
  const iTop = process.argv.indexOf('--top');
  const topN = iTop >= 0 ? Number(process.argv[iTop + 1]) || 200 : 200;

  if (!fs.existsSync(IN_PATH)) {
    console.log(`⚠ No existe ${path.relative(process.cwd(), IN_PATH)} — corré primero "npm run inspect:search".`);
    process.exit(1);
  }
  const terminos = topTerminos(topN);
  if (!terminos.length) { console.log('⚠ El reporte de GA4 no tiene términos.'); process.exit(1); }

  console.log(`Sitio: ${base}`);
  console.log(`Probando ${terminos.length} términos, de a ${CONCURRENCIA}. Sin seguir redirects.\n`);

  await forEachLimit(terminos, CONCURRENCIA, async (t) => {
    const s = slug(t.term);
    t.ruta = await pedir(`${base}/${s}`);
    t.busqueda = await pedir(`${base}/${s}?_q=${encodeURIComponent(t.term)}&map=ft`);
  });

  const conRedirect = terminos.filter((t) => esRedirect(t.ruta) || esRedirect(t.busqueda));
  const sinRedirect = terminos.filter((t) => !esRedirect(t.ruta) && !esRedirect(t.busqueda));
  const fallados = terminos.filter((t) => t.ruta.status === 0 && t.busqueda.status === 0);

  const volTotal = terminos.reduce((s, t) => s + t.count, 0);
  const volRedir = conRedirect.reduce((s, t) => s + t.count, 0);

  console.log('── Los que REDIRIGEN ──');
  for (const t of conRedirect.slice(0, 25)) {
    const r = esRedirect(t.ruta) ? t.ruta : t.busqueda;
    const cual = esRedirect(t.ruta) ? 'ruta' : 'búsqueda';
    console.log(`  ${t.term.padEnd(24)} ${String(t.count).padStart(7)} busq.  ${r.status} (${cual}) → ${r.location}`);
  }
  if (conRedirect.length > 25) console.log(`  … y ${conRedirect.length - 25} más`);

  console.log('\n── Los de mas volumen que NO redirigen (acá sí importa el buscador) ──');
  for (const t of sinRedirect.slice(0, 20)) {
    console.log(`  ${t.term.padEnd(24)} ${String(t.count).padStart(7)} busq.  ruta=${t.ruta.status} busqueda=${t.busqueda.status}`);
  }

  console.log('\n── Resumen ──');
  console.log(`  ${conRedirect.length} de ${terminos.length} redirigen  (${(volRedir / volTotal * 100).toFixed(1)}% del volumen de búsqueda)`);
  console.log(`  ${sinRedirect.length} caen en búsqueda real  (${(100 - volRedir / volTotal * 100).toFixed(1)}% del volumen)`);
  if (fallados.length) {
    console.log(`  ${fallados.length} no respondieron (timeout o error de red): no se puede concluir nada de esos.`);
  }

  // Cuál de las dos formas de URL detecta los redirects: dice qué está midiendo
  // de verdad este probe, y si la otra forma habría que descartarla.
  const porRuta = terminos.filter((t) => esRedirect(t.ruta)).length;
  const porBusqueda = terminos.filter((t) => esRedirect(t.busqueda)).length;
  console.log(`\n  Detectados por la ruta pelada: ${porRuta}  ·  por la URL de búsqueda: ${porBusqueda}`);
  if (porRuta && !porBusqueda) {
    console.log('  → Los redirects están en la ruta pero NO en la URL de búsqueda. Ojo: si la caja');
    console.log('    de búsqueda del sitio va a la URL de búsqueda, el cliente NO se redirige y sí');
    console.log('    ve resultados. Hay que confirmar a dónde navega la caja de búsqueda.');
  }

  if (!escribir) {
    console.log('\n(no se escribió nada: agregá --escribir para generar config/search-redirects.json)');
    return;
  }
  const redirects = conRedirect.map((t) => {
    const r = esRedirect(t.ruta) ? t.ruta : t.busqueda;
    return { term: t.term, url: r.location, status: r.status, detectadoEn: esRedirect(t.ruta) ? 'ruta' : 'busqueda' };
  });
  fs.writeFileSync(OUT_PATH, JSON.stringify({
    _origen: [
      `Detectado pidiendole al sitio (${base}) que hace con cada termino, el`,
      `${new Date().toISOString().slice(0, 10)}, con src/redirect-probe.js.`,
      'No es la config de VTEX: es lo que el servidor responde de verdad.',
      'Para actualizarlo, volver a correr el workflow "Redirect probe".',
    ],
    generatedAt: new Date().toISOString(),
    store: base,
    redirects,
  }, null, 2));
  console.log(`\n${redirects.length} redirects → ${path.relative(process.cwd(), OUT_PATH)}`);
}

main().catch((e) => { console.error('redirect-probe falló:', e.message); process.exit(1); });

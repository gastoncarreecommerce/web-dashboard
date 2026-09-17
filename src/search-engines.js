'use strict';

/**
 * Un adaptador por motor de búsqueda, todos devolviendo LA MISMA forma, para
 * que el diagnóstico pueda correr contra cualquiera —o contra varios a la vez
 * y compararlos— sin saber con cuál está hablando.
 *
 * Por qué existe este archivo: el diagnóstico estaba clavado al endpoint
 * `/api/catalog_system/pub/products/search` (el Search LEGACY de VTEX). Eso se
 * eligió a propósito en su momento, porque el contrato de esa API ya estaba
 * probado en este proyecto y el de Intelligent Search había que adivinarlo.
 * Pero si el sitio corre Intelligent Search —que es lo normal hoy—, entonces
 * todo el reporte de "salud del buscador" estaba midiendo un motor que nadie
 * usa. Ya no hay que adivinar: el contrato de IS salió del OpenAPI oficial de
 * VTEX (github.com/vtex/openapi-schemas), y ninguno de sus endpoints pide
 * autenticación.
 *
 * Forma normalizada que devuelve `search()` en todos los motores:
 *
 *   {
 *     total:    number,    // cuántos productos matchean
 *     capped:   boolean,   // true si `total` es "esto o más" y no el total real
 *     products: [{ name, categories: string[] }],
 *     raw:      any,       // la respuesta cruda, para depurar sin volver a pedirla
 *   }
 *
 * `capped` importa: mostrar "10" cuando en realidad es "10 o más" es mentir con
 * un número preciso. Cada adaptador sabe cuándo su motor le dio el total real.
 */

const fs = require('fs');
const path = require('path');

const DY_CONFIG_PATH = path.join(__dirname, '..', 'config', 'dy-search.json');
const PAGE_SIZE = 10; // cuántos productos se traen para juzgar relevancia

function vtexBase() {
  const account = process.env.VTEX_ACCOUNT_NAME;
  if (!account) throw new Error('Falta VTEX_ACCOUNT_NAME');
  const environment = process.env.VTEX_ENVIRONMENT || 'vtexcommercestable';
  return `https://${account}.${environment}.com.br`;
}

/** Normaliza un producto de cualquiera de las dos APIs de VTEX. Las dos traen
 *  `productName` y `categories` como rutas ("/Almacén/Lácteos/Quesos/"), pero
 *  se aceptan los alias por si un catálogo viejo usa otro nombre de campo. */
function normalizeVtexProduct(p) {
  return {
    name: p.productName || p.name || null,
    categories: Array.isArray(p.categories) ? p.categories.map(String) : [],
  };
}

async function getJson(url, init) {
  const res = await fetch(url, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.headers || {}) },
  });
  if (!res.ok && res.status !== 206) {
    const body = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    err.status = res.status;
    throw err;
  }
  return { res, body: await res.json() };
}

// ── VTEX Search legacy (catalog_system) ──────────────────────────────────────
const vtexLegacy = {
  id: 'vtex-legacy',
  label: 'VTEX Search (legacy)',
  disponible: () => Boolean(process.env.VTEX_ACCOUNT_NAME),
  async search(term) {
    const url = `${vtexBase()}/api/catalog_system/pub/products/search`
      + `?ft=${encodeURIComponent(term)}&_from=0&_to=${PAGE_SIZE - 1}`;
    const { res, body } = await getJson(url);
    const products = Array.isArray(body) ? body : [];

    // El total real viene en esta cabecera ("resources 0-9/123"), pero solo
    // cuando la respuesta viene cortada. Sin ella no hay forma de saber si
    // "10" es el total o si hay muchos más.
    const range = res.headers.get('resources-content-range');
    const total = range ? Number(range.split('/')[1]) : NaN;

    return {
      total: Number.isFinite(total) ? total : products.length,
      capped: !Number.isFinite(total) && products.length >= PAGE_SIZE,
      products: products.map(normalizeVtexProduct),
      raw: body,
    };
  },
};

// ── VTEX Intelligent Search ──────────────────────────────────────────────────
// El path lleva un segmento `{facets}` OBLIGATORIO. Sin filtros va vacío, o sea
// que la barra final del path no es un descuido: `/product_search/?query=...`.
const vtexIS = {
  id: 'vtex-is',
  label: 'VTEX Intelligent Search',
  disponible: () => Boolean(process.env.VTEX_ACCOUNT_NAME),
  async search(term) {
    const url = `${vtexBase()}/api/io/_v/api/intelligent-search/product_search/`
      + `?query=${encodeURIComponent(term)}&count=${PAGE_SIZE}`;
    const { body } = await getJson(url);
    const products = Array.isArray(body?.products) ? body.products : [];

    // IS sí devuelve el total exacto en `recordsFiltered`, así que acá no hay
    // que estimar nada: nunca queda `capped`.
    const total = Number(body?.recordsFiltered);

    return {
      total: Number.isFinite(total) ? total : products.length,
      capped: !Number.isFinite(total) && products.length >= PAGE_SIZE,
      products: products.map(normalizeVtexProduct),
      raw: body,
    };
  },
};

// ── Dynamic Yield Experience Search ──────────────────────────────────────────
/**
 * Experience Search de DY va sobre el endpoint `choose` de la Experience API,
 * con un "API Selector Name" por campaña. El cuerpo exacto de un request de
 * búsqueda NO está en ninguna doc pública que se pueda leer, así que este
 * adaptador NO lo adivina: lo lee de `config/dy-search.json`, un archivo que
 * se llena con el request que DY mismo indique, usando `{{query}}` donde va el
 * término.
 *
 * Es a propósito. Inventar la forma del request acá daría uno de dos
 * resultados: un error que confunde, o peor, un reporte con números que
 * parecen válidos y no lo son.
 *
 * config/dy-search.json:
 *   {
 *     "endpoint": "https://dy-api.com/v2/serve/user/choose",
 *     "selector": "<API Selector Name de la campaña de Experience Search>",
 *     "body": { ... el request tal cual, con "{{query}}" donde va el término ... },
 *     "productsPath": "choices.0.variations.0.payload.data.slots",
 *     "totalPath": "choices.0.variations.0.payload.data.totalResults",
 *     "nameKey": "name",
 *     "categoriesKey": "categories"
 *   }
 *
 * La key va en la env var DY_API_KEY (secret), nunca en el archivo.
 */
function leerRuta(obj, ruta) {
  if (!ruta) return undefined;
  let cur = obj;
  for (const parte of String(ruta).split('.')) {
    if (cur == null) return undefined;
    cur = cur[/^\d+$/.test(parte) ? Number(parte) : parte];
  }
  return cur;
}

function dyConfig() {
  if (!fs.existsSync(DY_CONFIG_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(DY_CONFIG_PATH, 'utf8')); } catch { return null; }
}

const dynamicYield = {
  id: 'dy',
  label: 'Dynamic Yield Experience Search',
  disponible() {
    const cfg = dyConfig();
    return Boolean(process.env.DY_API_KEY && cfg?.endpoint && cfg?.body);
  },
  /** Por qué no está disponible, para poder decirlo en vez de fallar mudo. */
  porQueNo() {
    const falta = [];
    if (!process.env.DY_API_KEY) falta.push('la env var DY_API_KEY');
    const cfg = dyConfig();
    if (!cfg) falta.push('el archivo config/dy-search.json');
    else {
      if (!cfg.endpoint) falta.push('"endpoint" en config/dy-search.json');
      if (!cfg.body) falta.push('"body" en config/dy-search.json (el request que indique DY, con {{query}})');
    }
    return falta.join(' y ');
  },
  async search(term) {
    const cfg = dyConfig();
    if (!cfg) throw new Error('Falta config/dy-search.json');

    // El término se sustituye sobre el JSON serializado para que caiga donde
    // sea que DY lo espere, sin que este código tenga que conocer la forma.
    // JSON.stringify del término escapa comillas y demás por nosotros.
    const plantilla = JSON.stringify(cfg.body);
    const esc = JSON.stringify(String(term)).slice(1, -1);
    const body = plantilla.split('{{query}}').join(esc);

    const { body: json } = await getJson(cfg.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'DY-API-Key': process.env.DY_API_KEY },
      body,
    });

    const crudos = leerRuta(json, cfg.productsPath);
    const lista = Array.isArray(crudos) ? crudos : [];
    const total = Number(leerRuta(json, cfg.totalPath));
    const nameKey = cfg.nameKey || 'name';
    const catsKey = cfg.categoriesKey || 'categories';

    return {
      total: Number.isFinite(total) ? total : lista.length,
      capped: !Number.isFinite(total) && lista.length >= PAGE_SIZE,
      products: lista.slice(0, PAGE_SIZE).map((p) => {
        const cats = leerRuta(p, catsKey);
        return {
          name: leerRuta(p, nameKey) || null,
          categories: Array.isArray(cats) ? cats.map(String) : (cats ? [String(cats)] : []),
        };
      }),
      raw: json,
    };
  },
};

const ENGINES = { [vtexLegacy.id]: vtexLegacy, [vtexIS.id]: vtexIS, [dynamicYield.id]: dynamicYield };

/** Los motores pedidos por env (SEARCH_ENGINES="vtex-is,dy"), quedándose solo
 *  con los que de verdad se pueden usar. Por defecto: Intelligent Search, que
 *  es el motor que corre en el sitio. */
function motoresActivos() {
  const pedidos = (process.env.SEARCH_ENGINES || vtexIS.id).split(',').map((s) => s.trim()).filter(Boolean);
  const activos = [];
  const omitidos = [];
  for (const id of pedidos) {
    const e = ENGINES[id];
    if (!e) { omitidos.push({ id, motivo: 'no existe un motor con ese nombre' }); continue; }
    if (!e.disponible()) { omitidos.push({ id, motivo: `falta ${e.porQueNo ? e.porQueNo() : 'configuración'}` }); continue; }
    activos.push(e);
  }
  return { activos, omitidos };
}

// ── Endpoints de IS que no son búsqueda de productos ─────────────────────────

/** Los términos más buscados SEGÚN VTEX. Hasta ahora el top salía solo de GA4;
 *  este es el mismo dato visto por el motor, y las diferencias entre las dos
 *  listas son en sí mismas una señal (un término que VTEX ve mucho y GA4 no,
 *  o al revés, es un problema de tracking). */
async function vtexTopSearches() {
  const { body } = await getJson(`${vtexBase()}/api/io/_v/api/intelligent-search/top_searches`);
  const searches = Array.isArray(body?.searches) ? body.searches : [];
  return searches
    .map((s) => ({ term: String(s.term || '').trim().toLowerCase(), count: Number(s.count) || 0 }))
    .filter((s) => s.term);
}

/** El "quizás quisiste decir" NATIVO de VTEX. El diagnóstico hoy genera
 *  variantes a mano (b/v, s/z, plural/singular) y prueba cada una: eso sigue
 *  sirviendo como red, pero la corrección del propio motor es la que de verdad
 *  va a ver el usuario en el sitio. */
async function vtexCorrection(term) {
  const url = `${vtexBase()}/api/io/_v/api/intelligent-search/correction_search`
    + `?query=${encodeURIComponent(term)}`;
  const { body } = await getJson(url);
  const c = body?.correction;
  if (!c) return null;
  return {
    corregido: Boolean(c.misspelled || c.correction),
    termino: c.text || c.correction || null,
    exacto: c.exact ?? null,
  };
}

/** Qué sugiere el autocomplete al tipear el término. Un término con volumen
 *  alto que no aparece en su propio autocomplete es una fricción real. */
async function vtexAutocomplete(term) {
  const url = `${vtexBase()}/api/io/_v/api/intelligent-search/autocomplete_suggestions`
    + `?query=${encodeURIComponent(term)}`;
  const { body } = await getJson(url);
  const items = Array.isArray(body?.searches) ? body.searches : [];
  return items.map((s) => String(s.term || '').trim()).filter(Boolean);
}

module.exports = {
  ENGINES,
  motoresActivos,
  vtexLegacy,
  vtexIS,
  dynamicYield,
  vtexTopSearches,
  vtexCorrection,
  vtexAutocomplete,
  normalizeVtexProduct,
  leerRuta,
  PAGE_SIZE,
};

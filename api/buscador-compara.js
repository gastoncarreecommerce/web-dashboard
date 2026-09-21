/**
 * GET /api/buscador-compara?q=<termino>
 *
 * Le pregunta el MISMO termino a los tres buscadores y devuelve los productos
 * que cada uno pone primero, con foto, nombre y precio, para poder verlos uno
 * al lado del otro y juzgar con los ojos cual responde mejor.
 *
 * Por que existe este endpoint y no alcanza el reporte batch. El diagnostico
 * diario (src/inspect-search-diagnosis.js) mide 200 terminos y escribe un
 * reporte, pero no se le puede escribir un termino y ver que devuelve cada
 * motor: eso necesita consultar en el momento. Y desde el navegador no se
 * puede, porque los buscadores viven en otro dominio y CORS lo bloquea. Asi
 * que la consulta la hace el servidor, igual que api/competencia.js.
 *
 * Los tres motores:
 *
 *   · VTEX Intelligent Search — el que corre en el sitio hoy.
 *   · VTEX Search (legacy)    — el viejo, por API de catalogo. Queda porque
 *                               hace match por substring y eso se VE: para
 *                               "aceite" devuelve papas fritas Lays.
 *   · Dynamic Yield           — semantico. No filtra, rankea: para cualquier
 *                               consulta puede devolver todo el catalogo
 *                               ordenado por similitud, asi que su total no se
 *                               compara con el de los otros dos. Lo que
 *                               importa es que pone en las primeras
 *                               posiciones, que es justo lo que se ve aca.
 *
 * Tambien devuelve el `redirect` de Intelligent Search. Es la pieza que
 * explicaba el reporte roto: cuando el termino tiene redireccion configurada,
 * IS responde 0 productos Y el destino. Buscar "aceite" en el sitio lleva a
 * /almacen/aceites-y-vinagres, y el cliente nunca ve resultados de busqueda.
 *
 * Queda detras de la sesion del dashboard (lo cubre middleware.js).
 */

import { verifySession } from './_session.js';

const TIMEOUT_MS = 15000;
const CUANTOS = 8;          // productos por motor: los que se ven sin scrollear

function vtexBase() {
  const cuenta = process.env.VTEX_ACCOUNT_NAME;
  if (!cuenta) return null;
  const entorno = process.env.VTEX_ENVIRONMENT || 'vtexcommercestable';
  return `https://${cuenta}.${entorno}.com.br`;
}

async function pedir(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: { Accept: 'application/json', ...(opts.headers || {}) },
    });
    const txt = await r.text();
    let json = null;
    try { json = JSON.parse(txt); } catch { /* no era json */ }
    if (!r.ok) {
      return { error: `HTTP ${r.status}${txt ? `: ${txt.replace(/\s+/g, ' ').slice(0, 180)}` : ''}` };
    }
    return { json };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'la consulta tardó demasiado' : e.message };
  } finally { clearTimeout(t); }
}

/** Un producto de VTEX (catalogo o IS) aplanado a lo que necesita la pantalla. */
function productoVtex(p) {
  const item = p?.items?.[0] || {};
  const seller = (item.sellers || []).find((s) => s?.commertialOffer?.IsAvailable)
    || (item.sellers || [])[0] || {};
  const o = seller.commertialOffer || {};
  const precio = Number.isFinite(o.Price) ? o.Price : null;
  const lista = Number.isFinite(o.ListPrice) ? o.ListPrice : null;
  return {
    nombre: p?.productName || null,
    marca: p?.brand || null,
    // La primera imagen del primer item. Si no hay, la pantalla muestra un
    // placeholder en vez de una imagen rota.
    imagen: item.images?.[0]?.imageUrl || item.imageUrl || null,
    precio,
    // Solo se muestra como "antes" si es mayor: en algunas cuentas ListPrice
    // trae otra cosa (en Cencosud, el precio sin impuestos por 100).
    precioLista: lista != null && precio != null && lista > precio ? lista : null,
    disponible: Boolean(o.IsAvailable),
    url: p?.link || (p?.linkText ? `/${p.linkText}/p` : null),
    categorias: Array.isArray(p?.categories)
      ? p.categories.map((c) => String(c).split('/').filter(Boolean).pop()).filter(Boolean)
      : [],
  };
}

async function intelligentSearch(term) {
  const base = vtexBase();
  if (!base) return { error: 'falta VTEX_ACCOUNT_NAME' };
  // La barra final del path es obligatoria: el segmento de facets va vacio
  // pero tiene que estar.
  const { json, error } = await pedir(`${base}/api/io/_v/api/intelligent-search/product_search/`
    + `?query=${encodeURIComponent(term)}&count=${CUANTOS}`);
  if (error) return { error };
  const prods = Array.isArray(json?.products) ? json.products : [];
  const total = Number(json?.recordsFiltered);
  return {
    total: Number.isFinite(total) ? total : prods.length,
    totalExacto: Number.isFinite(total),
    // Cuando el termino esta redirigido, IS devuelve 0 productos Y el destino.
    redirect: typeof json?.redirect === 'string' && json.redirect ? json.redirect : null,
    productos: prods.map(productoVtex),
  };
}

async function vtexLegacy(term) {
  const base = vtexBase();
  if (!base) return { error: 'falta VTEX_ACCOUNT_NAME' };
  const { json, error } = await pedir(`${base}/api/catalog_system/pub/products/search`
    + `?ft=${encodeURIComponent(term)}&_from=0&_to=${CUANTOS - 1}`);
  if (error) return { error };
  const prods = Array.isArray(json) ? json : [];
  return {
    // El legacy no devuelve el total: se pide una pagina y se sabe "esto o
    // mas". Decirlo, en vez de hacer pasar 8 por el total.
    total: prods.length,
    totalExacto: false,
    productos: prods.map(productoVtex),
  };
}

async function dynamicYield(term) {
  const key = process.env.DY_API_KEY;
  if (!key) return { error: 'falta DY_API_KEY en las variables de entorno' };
  const selector = process.env.DY_SELECTOR || 'Semantic Search';
  // El cuerpo replica el que quedo confirmado contra la API en
  // config/dy-search.json. `context.page.data` es obligatorio aunque vaya
  // vacio, y user/context/selector van en el nivel de arriba (no adentro de
  // `query`): con todo anidado la API responde 422 "request must contain
  // context".
  const { json, error } = await pedir('https://dy-api.com/v2/serve/user/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'DY-API-Key': key },
    body: JSON.stringify({
      user: { active_consent_accepted: true },
      query: { text: term, pagination: { numItems: CUANTOS, offset: 0 } },
      context: { page: { data: [], type: 'OTHER', location: 'https://www.carrefour.com.ar/', locale: 'es_AR' } },
      selector: { name: selector },
      options: { returnAnalyticsMetadata: false, isImplicitClientData: false },
    }),
  });
  if (error) return { error };
  const data = json?.choices?.[0]?.variations?.[0]?.payload?.data;
  const slots = Array.isArray(data?.slots) ? data.slots : [];
  if (!slots.length) {
    const aviso = json?.warnings?.[0]?.message || json?.error?.message;
    return { total: 0, totalExacto: true, productos: [], nota: aviso || null };
  }
  return {
    total: Number(data?.totalNumResults) || slots.length,
    // El total de DY NO es comparable con el de los otros: no filtra, rankea.
    totalComparable: false,
    totalExacto: true,
    productos: slots.slice(0, CUANTOS).map((s) => {
      const d = s?.productData || {};
      const precio = Number(d.price);
      const lista = Number(d.in_stock_price ?? d.list_price);
      return {
        nombre: d.name || null,
        marca: d.brand || null,
        imagen: d.image_url || d.imageUrl || null,
        precio: Number.isFinite(precio) ? precio : null,
        precioLista: Number.isFinite(lista) && Number.isFinite(precio) && lista > precio ? lista : null,
        disponible: d.in_stock !== false,
        url: d.url || null,
        categorias: Array.isArray(d.categories) ? d.categories.slice(-2) : [],
      };
    }),
  };
}

const MOTORES = [
  { id: 'vtex-is', label: 'VTEX Intelligent Search', nota: 'El que corre en el sitio hoy.', fn: intelligentSearch },
  { id: 'dy', label: 'Dynamic Yield', nota: 'Semántico: no filtra, ordena por similitud. Su total no se compara.', fn: dynamicYield },
  { id: 'vtex-legacy', label: 'VTEX Search (legacy)', nota: 'El viejo, por API de catálogo. Hace match por substring.', fn: vtexLegacy },
];

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });
  if (!verifySession(req)) return res.status(401).json({ error: 'No autenticado' });

  const q = String(req.query?.q || '').trim().slice(0, 120);
  if (!q) return res.status(400).json({ error: 'Falta el término a buscar (?q=).' });

  // Los tres en paralelo: el tiempo total es el del mas lento, no la suma.
  const resultados = await Promise.all(MOTORES.map(async (m) => {
    try {
      return { id: m.id, label: m.label, nota: m.nota, ...(await m.fn(q)) };
    } catch (e) {
      return { id: m.id, label: m.label, nota: m.nota, error: e.message };
    }
  }));

  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json({
    termino: q,
    consultadoEn: new Date().toISOString(),
    motores: resultados,
  });
}

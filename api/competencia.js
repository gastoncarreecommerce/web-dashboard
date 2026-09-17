/**
 * GET /api/competencia?eans=779...,779...&tiendas=jumbo,disco
 *
 * Busca un lote de EANs en las tiendas de la competencia y devuelve precio,
 * precio de lista y promociones de cada una.
 *
 * Por qué existe este proxy y no se llama a las tiendas desde el navegador: una
 * página servida en nuestro dominio NO puede pedirle a jumbo.com.ar — CORS lo
 * bloquea, y las APIs públicas de VTEX no mandan cabeceras que lo permitan. Así
 * que el pedido lo hace el servidor.
 *
 * Todas las tiendas son VTEX, así que se usa la MISMA API pública de catálogo
 * que ya usa api/product-image.js contra nuestra cuenta:
 *
 *     /api/catalog_system/pub/products/search?fq=alternateIds_Ean:<ean>
 *
 * Se consulta el dominio público de cada tienda en vez de su `accountName`
 * porque el account name de cada competidor no lo sabemos y no hay por qué
 * adivinarlo: el dominio sirve la misma API.
 *
 * Queda detrás de la sesión del dashboard (lo cubre middleware.js). No es solo
 * por prolijidad: un proxy abierto que consulta sitios de terceros desde nuestro
 * dominio es algo que alguien más va a usar para otra cosa.
 *
 * SOBRE LOS PRECIOS: VTEX devuelve el precio de la política comercial y la
 * región por defecto de cada tienda. Los supermercados tienen precios distintos
 * por zona, así que esto es "el precio que muestra la tienda sin decirle dónde
 * estás", no necesariamente el que vería un cliente de una zona puntual. La
 * respuesta lo aclara en `advertencia` para que la página lo muestre.
 */

import { verifySession } from './_session.js';

// El límite duro de la API de VTEX para `fq` múltiples es generoso, pero pedir
// de a 20 mantiene las URLs manejables y reparte la carga.
const EANS_POR_LOTE = 20;
const MAX_EANS = 300;
const CONCURRENCIA = 4;     // por tienda: son sitios de terceros, no hay que maltratarlos
const TIMEOUT_MS = 20000;

// Arriba de este descuento implicado, el precio de lista se descarta por
// sospechoso (ver el comentario en normalizar()). 70% es holgado: las promos
// reales de supermercado —2do al 70%, 50% en la segunda unidad— dan descuentos
// efectivos por unidad bastante menores.
const UMBRAL_PCT = 70;

export const TIENDAS = {
  carrefour: { nombre: 'Carrefour', dominio: 'https://www.carrefour.com.ar', propia: true },
  jumbo: { nombre: 'Jumbo', dominio: 'https://www.jumbo.com.ar' },
  disco: { nombre: 'Disco', dominio: 'https://www.disco.com.ar' },
  masonline: { nombre: 'Masonline', dominio: 'https://www.masonline.com.ar' },
  dia: { nombre: 'DIA', dominio: 'https://diaonline.supermercadosdia.com.ar' },
};

function pedirConTimeout(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  return fetch(url, {
    signal: ctrl.signal,
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; comparador-precios)' },
  }).finally(() => clearTimeout(t));
}

/** Lo que nos interesa de un producto de VTEX, aplanado. */
function normalizar(producto) {
  const item = producto?.items?.[0] || {};
  // Se elige el seller con oferta disponible; si ninguno está disponible, el
  // primero, para poder mostrar "sin stock" en vez de "no encontrado".
  const sellers = Array.isArray(item.sellers) ? item.sellers : [];
  const conStock = sellers.find((s) => s?.commertialOffer?.IsAvailable
    && (s.commertialOffer.AvailableQuantity || 0) > 0);
  const seller = conStock || sellers[0] || {};
  const o = seller.commertialOffer || {};

  // `Teasers` son las promos que VTEX muestra en la ficha ("2do al 70%", etc.).
  const promos = [
    ...(o.Teasers || []).map((t) => t?.Name).filter(Boolean),
    ...(o.PromotionTeasers || []).map((t) => t?.Name).filter(Boolean),
    ...(o.DiscountHighLight || []).map((d) => d?.Name || d?.name).filter(Boolean),
  ];

  const precio = Number.isFinite(o.Price) ? o.Price : null;
  const lista = Number.isFinite(o.ListPrice) ? o.ListPrice : null;

  // Cuánto descuento implica la lista, si la cuenta da.
  const pct = (precio != null && lista != null && lista > precio)
    ? Math.round((1 - precio / lista) * 1000) / 10
    : null;

  // DESCUENTO IMPLAUSIBLE = CAMPO EQUIVOCADO, no una promoción.
  //
  // En Jumbo y Disco, `ListPrice` devolvia $252.066 para un agua de 2 litros de
  // $3.050: un -98,8%. Ningun supermercado hace eso. Las dos son Cencosud (mismo
  // backend), y en Masonline y DIA el mismo campo daba valores plausibles (-33%,
  // -30%), asi que el problema es que en esas cuentas `ListPrice` contiene otra
  // cosa. Cual es el campo correcto se averigua con src/competencia-probe.js,
  // que imprime todos los campos de precio de cada tienda.
  //
  // Hasta entonces: un precio de lista que implica mas de UMBRAL_PCT de
  // descuento no se muestra, y se marca `listaSospechosa` para que la pagina
  // pueda decir POR QUE falta, en vez de dejar un hueco sin explicacion.
  // Preferir un dato menos antes que un numero inventado.
  const sospechosa = pct != null && pct > UMBRAL_PCT;

  return {
    encontrado: true,
    nombre: producto.productName || null,
    marca: producto.brand || null,
    precio,
    precioLista: sospechosa ? null : lista,
    descuentoPct: sospechosa ? null : pct,
    ...(sospechosa ? { listaSospechosa: { valor: lista, pctImplicado: pct } } : {}),
    disponible: Boolean(o.IsAvailable && (o.AvailableQuantity || 0) > 0),
    promos: [...new Set(promos)],
    unidad: item.unitMultiplier && item.unitMultiplier !== 1 ? item.unitMultiplier : null,
    medida: item.measurementUnit || null,
    url: producto.link || (producto.linkText ? `/${producto.linkText}/p` : null),
    sellerNombre: seller.sellerName || null,
  };
}

/** EAN del producto devuelto, para poder mapear la respuesta al pedido: VTEX no
 *  garantiza el orden ni devuelve un producto por cada `fq` pedido. */
function eansDe(producto) {
  const out = new Set();
  for (const item of producto?.items || []) {
    for (const ean of [item.ean, ...(item.referenceId || []).map((r) => r?.Value)]) {
      if (ean && /^\d{6,14}$/.test(String(ean))) out.add(String(ean));
    }
  }
  return [...out];
}

async function buscarLote(tienda, eans) {
  const fq = eans.map((e) => `fq=alternateIds_Ean:${encodeURIComponent(e)}`).join('&');
  const url = `${tienda.dominio}/api/catalog_system/pub/products/search?${fq}&_from=0&_to=${eans.length * 2}`;
  const r = await pedirConTimeout(url);
  if (!r.ok) {
    const cuerpo = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status}${cuerpo ? `: ${cuerpo.slice(0, 120)}` : ''}`);
  }
  const productos = await r.json();
  return Array.isArray(productos) ? productos : [];
}

async function forEachLimit(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k]); }
  }));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });
  if (!verifySession(req)) return res.status(401).json({ error: 'No autenticado' });

  const crudos = String(req.query?.eans || '')
    .split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  const eans = [...new Set(crudos.filter((e) => /^\d{8,14}$/.test(e)))];
  const invalidos = crudos.filter((e) => !/^\d{8,14}$/.test(e));

  if (!eans.length) {
    return res.status(400).json({
      error: 'sin_eans',
      message: 'No hay ningún EAN válido (8 a 14 dígitos).',
      invalidos: invalidos.slice(0, 20),
    });
  }
  if (eans.length > MAX_EANS) {
    return res.status(400).json({
      error: 'demasiados_eans',
      message: `${eans.length} EANs es mucho para una sola consulta. El máximo es ${MAX_EANS}: la página los manda por tandas.`,
    });
  }

  const pedidas = String(req.query?.tiendas || Object.keys(TIENDAS).join(','))
    .split(',').map((s) => s.trim()).filter(Boolean);
  const tiendas = pedidas.filter((id) => TIENDAS[id]);
  const desconocidas = pedidas.filter((id) => !TIENDAS[id]);
  if (!tiendas.length) {
    return res.status(400).json({
      error: 'sin_tiendas',
      message: `Ninguna tienda válida. Disponibles: ${Object.keys(TIENDAS).join(', ')}`,
    });
  }

  // resultados[ean][tiendaId]
  const resultados = Object.fromEntries(eans.map((e) => [e, {}]));
  const errores = {};

  const lotes = [];
  for (const id of tiendas) {
    for (let i = 0; i < eans.length; i += EANS_POR_LOTE) {
      lotes.push({ id, eans: eans.slice(i, i + EANS_POR_LOTE) });
    }
  }

  await forEachLimit(lotes, CONCURRENCIA, async ({ id, eans: grupo }) => {
    const tienda = TIENDAS[id];
    try {
      const productos = await buscarLote(tienda, grupo);
      for (const p of productos) {
        const fila = normalizar(p);
        if (fila.url && fila.url.startsWith('/')) fila.url = tienda.dominio + fila.url;
        // Un producto puede traer varios EANs (packs, variantes): se asigna a
        // todos los que hayamos pedido.
        for (const ean of eansDe(p)) {
          if (resultados[ean] && !resultados[ean][id]) resultados[ean][id] = fila;
        }
      }
    } catch (e) {
      // El error se guarda por tienda: que Jumbo falle no tiene que tirar abajo
      // la comparación con las demás.
      (errores[id] = errores[id] || []).push(`${grupo.length} EANs: ${e.message}`);
    }
  });

  for (const ean of eans) {
    for (const id of tiendas) {
      if (!resultados[ean][id]) resultados[ean][id] = { encontrado: false };
    }
  }

  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json({
    consultadoEn: new Date().toISOString(),
    tiendas: tiendas.map((id) => ({ id, ...TIENDAS[id] })),
    eans,
    resultados,
    errores,
    ...(invalidos.length ? { invalidos: invalidos.slice(0, 20) } : {}),
    ...(desconocidas.length ? { tiendasDesconocidas: desconocidas } : {}),
    advertencia: 'Los precios son los de la política comercial y región por defecto '
      + 'de cada tienda. Los supermercados varían precio por zona, así que esto es el '
      + 'precio que muestra cada sitio sin indicarle una ubicación.',
  });
}

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
// Mas bajo que antes: ahora cada producto lleva ADEMAS una simulacion de carrito,
// asi que un request con 300 EANs x 5 tiendas serian ~1500 llamadas y la funcion
// se quedaria sin tiempo. La pagina manda por tandas chicas.
const MAX_EANS = 40;
const CONCURRENCIA = 8;
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

/**
 * Simula el carrito con UN item y devuelve el precio con las promociones ya
 * aplicadas, mas el precio anterior y los nombres de las promos.
 *
 * Por que hace falta: el precio promocional NO esta en la API de catalogo. En
 * Jumbo, para el agua Villavicencio 2 L, TODOS los campos de precio del catalogo
 * valen $3.050 (Price, PriceWithoutDiscount, FullSellingPrice) mientras la ficha
 * muestra $1.982,50 con -35%. En VTEX las promociones las calcula el motor de
 * checkout: Carrefour las expone como `Teasers` y por eso se veian, pero Jumbo no
 * manda ninguno. La simulacion devuelve 1982,50 y ademas listPrice 3.050, que es
 * el tachado real — asi que de paso resuelve el ListPrice de $252.066 que traia
 * el catalogo de Cencosud.
 *
 * DOS COSAS QUE NO HAY QUE CONFUNDIR:
 *
 * 1. La simulacion devuelve los precios en CENTAVOS (enteros); el catalogo, en
 *    pesos. Mezclarlas daria precios 100 veces mas grandes.
 *
 * 2. Se simula UN item por llamada, a proposito. Meter 20 productos en el mismo
 *    carrito seria mas rapido, pero las promos que dependen de la composicion
 *    ("2do al 70%", combos entre productos) se activarian y el precio por
 *    producto dejaria de ser el de comprar esa unidad sola — que es justo lo que
 *    se quiere comparar. Un comparador mas lento y correcto le gana a uno rapido
 *    con precios que dependen de que mas habia en la lista.
 */
async function simular(tienda, itemId, sellerId) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${tienda.dominio}/api/checkout/pub/orderForms/simulation?sc=1`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; comparador-precios)',
      },
      body: JSON.stringify({
        items: [{ id: String(itemId), quantity: 1, seller: String(sellerId || '1') }],
        country: 'ARG',
      }),
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const j = await r.json();
    const it = (j.items || [])[0];
    if (!it) return { error: 'la simulación no devolvió el item' };

    const aPesos = (v) => (Number.isFinite(v) ? v / 100 : null);
    // `sellingPrice` es lo que se paga; `price` suele coincidir. Se toma el
    // primero que exista para no depender de un solo nombre.
    const precio = aPesos(it.sellingPrice ?? it.price);
    const lista = aPesos(it.listPrice);
    return {
      precio,
      lista,
      promos: (j.ratesAndBenefitsData?.rateAndBenefitsIdentifiers || [])
        .map((b) => b?.name).filter(Boolean),
    };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(t); }
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
    // Para la simulacion, que es la que trae el precio de verdad.
    _itemId: item.itemId || null,
    _sellerId: seller.sellerId || null,
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

  // Paso 1: el catalogo, que da el producto, el itemId y el seller.
  const aSimular = [];
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
          if (resultados[ean] && !resultados[ean][id]) {
            resultados[ean][id] = fila;
            if (fila._itemId) aSimular.push({ ean, id, fila });
          }
        }
      }
    } catch (e) {
      // El error se guarda por tienda: que Jumbo falle no tiene que tirar abajo
      // la comparación con las demás.
      (errores[id] = errores[id] || []).push(`${grupo.length} EANs: ${e.message}`);
    }
  });

  // Paso 2: la simulacion, que es la que trae el precio real con promociones.
  // El precio del catalogo queda como `precioCatalogo` para poder ver la
  // diferencia, pero el que se muestra es el simulado.
  await forEachLimit(aSimular, CONCURRENCIA, async ({ id, fila }) => {
    const sim = await simular(TIENDAS[id], fila._itemId, fila._sellerId);
    fila.precioCatalogo = fila.precio;

    if (sim.error) {
      // Sin simulacion queda el precio del catalogo, que puede NO ser el que ve
      // el cliente. Se marca para que la pagina lo diga en vez de darlo por
      // bueno.
      fila.simulacionFallo = sim.error;
      return;
    }

    if (sim.precio != null) fila.precio = sim.precio;
    if (sim.lista != null) {
      // La lista de la simulacion reemplaza a la del catalogo: en Cencosud esa
      // venia en $252.066 y aca viene el tachado real.
      fila.precioLista = sim.lista > (fila.precio ?? 0) ? sim.lista : null;
      fila.descuentoPct = fila.precioLista != null
        ? Math.round((1 - fila.precio / fila.precioLista) * 1000) / 10
        : null;
      delete fila.listaSospechosa;
    }
    if (sim.promos.length) fila.promos = [...new Set([...sim.promos, ...(fila.promos || [])])];
    fila.fuentePrecio = 'simulacion';
  });

  // Los internos no viajan al cliente.
  for (const ean of eans) {
    for (const f of Object.values(resultados[ean])) {
      if (f && typeof f === 'object') { delete f._itemId; delete f._sellerId; }
    }
  }

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
    fuente: 'El precio sale de la simulación de carrito de cada tienda (una por producto, '
      + 'de a una unidad), que es donde VTEX aplica las promociones. El catálogo solo da el '
      + 'precio base: para el agua Villavicencio 2 L en Jumbo daba $3.050 cuando la ficha '
      + 'muestra $1.982,50.',
    advertencia: 'Los precios son los de la política comercial y región por defecto '
      + 'de cada tienda. Los supermercados varían precio por zona, así que esto es el '
      + 'precio que muestra cada sitio sin indicarle una ubicación.',
  });
}

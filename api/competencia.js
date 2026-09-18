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
/**
 * Canales de venta a probar, en orden. El `sc=1` estaba hardcodeado y era una
 * SUPOSICION mia: Jumbo y Disco rechazaban todos los items con "Ítem <nombre> no
 * encontrado o no disponible", que es justo lo que contesta VTEX cuando el item
 * no existe en el canal que se le pide. Carrefour, Masonline y DIA si funcionan
 * con 1, asi que el canal no es el mismo en todas las cuentas.
 *
 * Sin `sc` la API usa el canal por defecto de la tienda, que es la opcion mas
 * probable de todas y por eso va primera.
 */
const CANALES = [null, '1', '2', '3'];

// Codigo postal por defecto (CABA). Importa por dos razones distintas:
//
// 1. Cencosud (Jumbo, Disco) tiene CATALOGO REGIONALIZADO: su sitio te pide
//    "Seleccioná el método de entrega" antes de mostrarte precios. El catalogo
//    devuelve el producto igual, pero el checkout responde "Ítem no encontrado o
//    no disponible" porque sin ubicacion no hay quien lo despache. Probar los
//    cuatro canales de venta no alcanzo justamente por esto.
//
// 2. Los precios de supermercado VARIAN POR ZONA. Comparar sin fijar una zona
//    compara cosas distintas, asi que el codigo postal es parte de la pregunta,
//    no un detalle tecnico: la pagina lo deja elegir.
const CP_DEFECTO = process.env.COMPETENCIA_CP || '1425';

/** Las combinaciones a probar, en orden de probabilidad. Se prueban UNA vez por
 *  tienda, no por producto. */
function combinaciones(cp) {
  const out = [];
  for (const sc of CANALES) {
    out.push({ sc, cp });        // con ubicacion primero: es lo que piden las regionalizadas
    if (!sc) out.push({ sc, cp: null });
  }
  out.push({ sc: '1', cp: null });
  // Sin duplicados, manteniendo el orden.
  const vistas = new Set();
  return out.filter((c) => {
    const k = `${c.sc}|${c.cp}`;
    if (vistas.has(k)) return false;
    vistas.add(k);
    return true;
  });
}

const comboTxt = (c) => `sc=${c.sc ?? '(defecto)'} cp=${c.cp ?? '(sin)'}`;

async function simular(tienda, itemId, sellerId, combo) {
  const { sc, cp } = combo || {};
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const qs = sc ? `?sc=${encodeURIComponent(sc)}` : '';
  try {
    const r = await fetch(`${tienda.dominio}/api/checkout/pub/orderForms/simulation${qs}`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; comparador-precios)',
      },
      body: JSON.stringify({
        items: [{ id: String(itemId), quantity: 1, seller: String(sellerId || '1') }],
        country: 'ARG',
        // El codigo postal es lo que le permite al checkout resolver quien
        // despacha. Sin el, una tienda regionalizada rechaza todo.
        ...(cp ? { postalCode: String(cp) } : {}),
      }),
    });
    if (!r.ok) {
      // EL CUERPO ES LO QUE IMPORTA. Antes esto devolvia solo `HTTP ${status}` y
      // se perdia el motivo: VTEX explica en el body por que rechazo la
      // simulacion (canal de venta inexistente, item no disponible, falta la
      // region...). Sin eso, un 400 y un 403 se ven iguales y no hay como
      // saber que arreglar. Se recorta para que no inunde la respuesta.
      const cuerpo = await r.text().catch(() => '');
      return { error: `HTTP ${r.status}${cuerpo ? `: ${cuerpo.replace(/\s+/g, ' ').slice(0, 220)}` : ''}` };
    }
    const j = await r.json();
    const it = (j.items || [])[0];
    if (!it) {
      // Una simulacion puede responder 200 y rechazar el item igual: el motivo
      // viene en `messages`, y sin mostrarlo esto queda en "no devolvio el
      // item", que no dice nada.
      const msgs = (j.messages || []).map((m) => m?.text || m?.code).filter(Boolean);
      return { error: msgs.length ? `rechazado: ${msgs.join(' | ').slice(0, 220)}` : 'la simulación no devolvió el item' };
    }

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

/**
 * Prueba los canales hasta que uno funcione, y devuelve cual fue.
 *
 * Se hace UNA sola vez por tienda y por request: el canal correcto es una
 * propiedad de la cuenta, no del producto, asi que descubrirlo una vez y
 * reusarlo para los otros 93 productos cuesta 3 llamadas extra en el peor caso
 * en vez de 3 por producto.
 */
async function descubrirCombo(tienda, itemId, sellerId, cp) {
  const intentos = [];
  for (const combo of combinaciones(cp)) {
    const r = await simular(tienda, itemId, sellerId, combo);
    if (!r.error) return { combo, primera: r, intentos };
    intentos.push(`${comboTxt(combo)} → ${r.error.slice(0, 90)}`);
  }
  // Se devuelven TODOS los intentos: con esto se ve si fallaron todos por lo
  // mismo (entonces el problema no es el canal ni la zona) o si cambia el
  // motivo, que es la pista de cual knob importa.
  return { combo: null, intentos };
}

/**
 * El precio segun Intelligent Search, que es la API con la que los storefronts
 * VTEX modernos renderizan la ficha.
 *
 * Por que se consulta ademas del catalogo. Para Jumbo y Disco la simulacion de
 * carrito rechaza el item en todas las combinaciones de canal y codigo postal
 * —siempre con el mismo mensaje, lo que descarta esos dos knobs— y el catalogo
 * devuelve el precio base sin la promo: $3.050 para un agua que la ficha muestra
 * a $1.982,50. Si la pagina que el cliente ve muestra $1.982,50, ese numero
 * tiene que salir de alguna API publica, y la candidata natural es la que
 * alimenta esa pagina.
 *
 * Se usa solo como PLAN B, cuando la simulacion falla. Si la simulacion anda, su
 * precio es mejor: es el unico que garantiza tener las promociones aplicadas.
 *
 * La barra final de `product_search/` es obligatoria: el segmento de facets va
 * vacio pero tiene que estar.
 */
async function precioDeIS(tienda, ean) {
  const url = `${tienda.dominio}/api/io/_v/api/intelligent-search/product_search/`
    + `?query=${encodeURIComponent(ean)}&count=5`;
  let j;
  try {
    const r = await pedirConTimeout(url);
    if (!r.ok) {
      const cuerpo = await r.text().catch(() => '');
      return { error: `HTTP ${r.status}${cuerpo ? `: ${cuerpo.replace(/\s+/g, ' ').slice(0, 160)}` : ''}` };
    }
    j = await r.json();
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout' : e.message };
  }

  // Buscar por texto puede traer otros productos: se queda solo con el que
  // realmente tiene ese EAN. Sin este filtro el comparador mostraria el precio
  // de un producto parecido, que es peor que no mostrar nada.
  const prod = (j?.products || []).find((p) => eansDe(p).includes(String(ean)));
  if (!prod) return { error: 'IS no devolvio ese EAN' };

  const item = prod.items?.[0] || {};
  const sellers = Array.isArray(item.sellers) ? item.sellers : [];
  const seller = sellers.find((x) => x?.commertialOffer?.IsAvailable) || sellers[0] || {};
  const o = seller.commertialOffer || {};
  const precio = Number.isFinite(o.Price) ? o.Price : null;
  if (precio == null) return { error: 'IS no trajo precio' };
  const lista = Number.isFinite(o.ListPrice) ? o.ListPrice : null;
  const promos = [
    ...(o.teasers || []).map((t) => t?.name).filter(Boolean),
    ...(o.Teasers || []).map((t) => t?.Name).filter(Boolean),
  ];
  return { precio, lista, promos: [...new Set(promos)] };
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

  // El codigo postal define la zona: los precios de supermercado varian, asi
  // que forma parte de la consulta.
  const cpCrudo = String(req.query?.cp || '').trim();
  const cp = /^\d{4}$/.test(cpCrudo) ? cpCrudo : CP_DEFECTO;

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
  const simErrores = {};   // simErrores[tiendaId][motivo] = cuantas veces
  const canalErrores = {}; // tiendas donde NINGUN canal funciono

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
            fila._tienda = id;
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
  // Los fallos se cuentan AGRUPADOS por tienda y por motivo: cuando falla en
  // todas las celdas de una tienda —lo que paso con Jumbo y Disco— lo que hace
  // falta es el motivo una vez, no una lista de 76 celdas.
  // El precio del catalogo queda como `precioCatalogo` para poder ver la
  // diferencia, pero el que se muestra es el simulado.
  // Primero se descubre el canal de venta de cada tienda con UN producto, y
  // despues se simula el resto con ese canal. El canal es una propiedad de la
  // cuenta, no del producto.
  const comboDe = {};
  const primeras = new Map();
  const porTiendaSim = {};
  for (const x of aSimular) (porTiendaSim[x.id] = porTiendaSim[x.id] || []).push(x);

  await forEachLimit(Object.keys(porTiendaSim), CONCURRENCIA, async (id) => {
    const primero = porTiendaSim[id][0];
    const d = await descubrirCombo(TIENDAS[id], primero.fila._itemId, primero.fila._sellerId, cp);
    comboDe[id] = d.combo;
    if (d.primera) primeras.set(primero, d.primera);
    else canalErrores[id] = d.intentos;
  });

  const resto = aSimular.filter((x) => !primeras.has(x));
  const aplicar = (fila, sim) => {
    fila.precioCatalogo = fila.precio;
    if (sim.error) {
      // Sin simulacion queda el precio del catalogo, que puede NO ser el que ve
      // el cliente. Se marca para que la pagina lo diga en vez de darlo por
      // bueno.
      fila.simulacionFallo = sim.error;
      // Se agrupa por el motivo SIN el nombre del producto. VTEX responde
      // "Ítem <nombre del producto> no encontrado o no disponible", asi que
      // agrupando por el texto exacto los 76 fallos de una tienda daban 76
      // motivos distintos y el aviso se volvia un muro ilegible.
      const motivo = sim.error
        .replace(/Ítem .*? no encontrado/i, 'Ítem no encontrado')
        .replace(/Item .*? not found/i, 'Item not found')
        .slice(0, 160);
      const acc = (simErrores[fila._tienda] = simErrores[fila._tienda] || {});
      acc[motivo] = (acc[motivo] || 0) + 1;
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
  };

  for (const [x, sim] of primeras) aplicar(x.fila, sim);
  await forEachLimit(resto, CONCURRENCIA, async ({ id, fila }) => {
    aplicar(fila, await simular(TIENDAS[id], fila._itemId, fila._sellerId, comboDe[id]));
  });

  // ── Plan B para las filas que la simulacion no pudo cotizar ──────────────
  // Se pregunta a Intelligent Search, que es la API con la que el storefront
  // dibuja la ficha. Si trae un precio DISTINTO al del catalogo, es porque el
  // catalogo no es la fuente de esa pagina y ese es el numero que ve el cliente.
  // Si trae el mismo, no se gana nada y la fila sigue marcada como sin verificar.
  const conFalla = aSimular.filter(({ fila }) => fila.simulacionFallo);
  let porIS = 0;
  const isErrores = {};
  await forEachLimit(conFalla, CONCURRENCIA, async ({ id, ean, fila }) => {
    const r = await precioDeIS(TIENDAS[id], ean);
    if (r.error) {
      const acc = (isErrores[id] = isErrores[id] || {});
      acc[r.error.slice(0, 160)] = (acc[r.error.slice(0, 160)] || 0) + 1;
      return;
    }
    if (r.precio === fila.precioCatalogo) return;  // misma info, no aporta
    fila.precio = r.precio;
    if (r.lista != null && r.lista > r.precio) {
      fila.precioLista = r.lista;
      fila.descuentoPct = Math.round((1 - r.precio / r.lista) * 1000) / 10;
      delete fila.listaSospechosa;
    }
    if (r.promos.length) fila.promos = [...new Set([...r.promos, ...(fila.promos || [])])];
    fila.fuentePrecio = 'intelligent-search';
    delete fila.simulacionFallo;
    porIS += 1;
  });

  // Los internos no viajan al cliente.
  for (const ean of eans) {
    for (const f of Object.values(resultados[ean])) {
      if (f && typeof f === 'object') { delete f._itemId; delete f._sellerId; delete f._tienda; }
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
    simulacionErrores: simErrores,
    // Que combinacion de canal + codigo postal funciono en cada tienda, y en
    // las que ninguna, TODOS los intentos con su error.
    comboPorTienda: Object.fromEntries(Object.entries(comboDe)
      .map(([k, c]) => [k, c ? comboTxt(c) : null])),
    canalErrores,
    codigoPostal: cp,
    simuladas: aSimular.filter((x) => x.fila.fuentePrecio === 'simulacion').length,
    porIS,
    ...(Object.keys(isErrores).length ? { isErrores } : {}),
    aSimular: aSimular.length,
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

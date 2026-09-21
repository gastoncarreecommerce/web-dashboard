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
// Un precio por debajo de esta fraccion de la MEDIANA de las otras tiendas se
// marca como no creible. 35% es holgado a proposito: una promo real de "50% en
// la segunda unidad" no baja de ahi, asi que no se castiga una oferta de
// verdad. Lo que si atrapa es el caso que aparecio: $201 cuando las otras tres
// tiendas decian $2.739, $2.800 y $2.800.
const UMBRAL_DISPAR = 0.35;
// Debajo de esta fraccion del precio de CATALOGO, una cotizacion de la
// simulacion no se cree: el catalogo es el precio base y una promo no lo baja
// al 7%. 0,25 deja pasar hasta un 75% de descuento, que es mas de lo que hace
// cualquier supermercado en una unidad.
const UMBRAL_SIM = 0.25;

export const TIENDAS = {
  carrefour: { nombre: 'Carrefour', dominio: 'https://www.carrefour.com.ar', propia: true },
  jumbo: { nombre: 'Jumbo', dominio: 'https://www.jumbo.com.ar' },
  disco: { nombre: 'Disco', dominio: 'https://www.disco.com.ar' },
  masonline: { nombre: 'Masonline', dominio: 'https://www.masonline.com.ar' },
  dia: { nombre: 'DIA', dominio: 'https://diaonline.supermercadosdia.com.ar' },
};

function pedirConTimeout(url, extra = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  return fetch(url, {
    signal: ctrl.signal,
    headers: {
      Accept: 'application/json',
      // Un User-Agent de navegador de verdad: pidiendo el HTML de la ficha,
      // algunos storefronts responden distinto (o no responden) a un UA raro.
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        + ' (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      ...extra,
    },
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
// Los canales que se prueban cuando la tienda no quiere decir cuales tiene.
// Es el ultimo recurso: lo correcto es PREGUNTARLE (ver canalesDe).
const CANALES_A_CIEGAS = [null, '1', '2', '3'];

// Codigo postal por defecto (CABA). Importa por dos razones distintas:
//
// 1. Cencosud (Jumbo, Disco) tiene CATALOGO REGIONALIZADO: su sitio te pide
//    "Seleccioná el método de entrega" antes de mostrarte precios. El catalogo
//    devuelve el producto igual, pero el checkout puede responder "Ítem no
//    encontrado o no disponible" porque sin ubicacion no hay quien lo despache.
//
// 2. Los precios de supermercado VARIAN POR ZONA. Comparar sin fijar una zona
//    compara cosas distintas, asi que el codigo postal es parte de la pregunta,
//    no un detalle tecnico: la pagina lo deja elegir.
const CP_DEFECTO = process.env.COMPETENCIA_CP || '1425';

/**
 * Le pregunta a la tienda QUE CANALES DE VENTA tiene, en vez de adivinarlos.
 *
 * Por que hace falta. Se venian probando sc=1, 2 y 3, y en Jumbo y Disco los 6
 * intentos fallaban con el mismo mensaje. De eso se habia concluido que el canal
 * quedaba descartado, y ERA UNA CONCLUSION INVALIDA: si el canal correcto es el
 * 7, probar 1, 2 y 3 falla identico. Los mensajes iguales no descartan el canal,
 * descartan esos tres VALORES.
 *
 * Y adivinar no tiene sentido cuando VTEX lo expone: `saleschannel/active` lista
 * los canales activos de la cuenta con su Id. Cencosud corre Jumbo, Disco y Vea
 * en una sola cuenta con una politica comercial por marca, asi que sus ids no
 * tienen por que ser 1, 2 o 3.
 *
 * Si el endpoint no responde (algunas cuentas lo tienen cerrado), se cae a
 * CANALES_A_CIEGAS y la respuesta lo dice, para no hacer pasar una adivinanza
 * por un dato.
 */
async function canalesDe(tienda) {
  try {
    const r = await pedirConTimeout(`${tienda.dominio}/api/catalog_system/pub/saleschannel/active`);
    if (!r.ok) return { canales: CANALES_A_CIEGAS, aCiegas: `HTTP ${r.status}` };
    const j = await r.json();
    if (!Array.isArray(j) || !j.length) return { canales: CANALES_A_CIEGAS, aCiegas: 'lista vacia' };
    const ids = j
      .filter((c) => c && (c.IsActive === undefined || c.IsActive))
      .map((c) => String(c.Id ?? c.id))
      .filter((x) => /^\d+$/.test(x));
    if (!ids.length) return { canales: CANALES_A_CIEGAS, aCiegas: 'sin ids usables' };
    // El canal por defecto (sin `sc`) se prueba primero: es el que usa el sitio
    // cuando no le decis nada, y en la mayoria de las tiendas alcanza.
    return { canales: [null, ...ids], aCiegas: null, nombres: j.map((c) => `${c.Id}=${c.Name || '?'}`) };
  } catch (e) {
    return { canales: CANALES_A_CIEGAS, aCiegas: e.name === 'AbortError' ? 'timeout' : e.message };
  }
}

/**
 * Le pide a la tienda que SELLERS despachan en un codigo postal.
 *
 * Esto es la pieza que faltaba. Cencosud (Jumbo, Disco) tiene catalogo
 * regionalizado: su sitio te obliga a elegir metodo de entrega antes de
 * mostrarte precios. En ese esquema el seller del catalogo NO es el que
 * despacha; hay que resolver una region para la direccion y usar los sellers
 * que esa region devuelve.
 *
 * Los tres sintomas encajan con esto y con nada mas:
 *
 *   · El catalogo y Intelligent Search devuelven 3.050 en TODOS los campos,
 *     sin teasers, mientras la ficha muestra 1.982,50. Es el precio sin region.
 *   · La simulacion responde "Ítem no encontrado o no disponible" con seller 1.
 *     No es que el item no exista: es que el seller 1 no despacha ahi.
 *   · Omitir el seller da CHK0024 "Identificador de vendedor de item invalido",
 *     o sea que el checkout SI valida sellers.
 *   · Carrefour, Masonline y DIA cotizan con seller 1 porque no estan
 *     regionalizadas: un solo seller sirve a todo el pais.
 *
 * Ademas corrige algo que se habia dado por probado: el seller nunca se habia
 * comparado con otro valor. El `sellerId` del catalogo ES "1", el mismo que el
 * literal, asi que probar los dos era probar uno.
 *
 * El `regionId` que devuelve tambien sirve para pedirle a Intelligent Search el
 * precio de esa region, que es el que muestra la ficha.
 */
async function regionDe(tienda, cp) {
  if (!cp) return { error: 'sin codigo postal no hay region que pedir' };
  const url = `${tienda.dominio}/api/checkout/pub/regions`
    + `?country=ARG&postalCode=${encodeURIComponent(cp)}`;
  try {
    const r = await pedirConTimeout(url);
    if (!r.ok) {
      const cuerpo = await r.text().catch(() => '');
      return { error: `HTTP ${r.status}${cuerpo ? `: ${cuerpo.replace(/\s+/g, ' ').slice(0, 160)}` : ''}` };
    }
    const j = await r.json();
    const regiones = Array.isArray(j) ? j : [];
    // Se juntan los sellers de todas las regiones devueltas: una direccion
    // puede tener varias (retiro en tienda, envio a domicilio) y cualquiera
    // sirve para cotizar.
    const sellers = [...new Set(regiones.flatMap((x) => (x?.sellers || [])
      .map((sl) => String(sl?.id ?? sl?.sellerId ?? '')).filter(Boolean)))];
    const regionId = regiones.find((x) => x?.id)?.id || null;
    if (!sellers.length) return { error: 'la region no devolvio sellers', regionId };
    return { regionId, sellers };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout' : e.message };
  }
}

/** Las combinaciones a probar, en orden de probabilidad. Se prueban UNA vez por
 *  tienda, no por producto. */
function combinaciones(cp, canales = CANALES_A_CIEGAS, sellers = [null]) {
  const out = [];
  for (const seller of sellers) {
    for (const sc of canales) {
      out.push({ sc, cp, seller });   // con ubicacion primero: la piden las regionalizadas
      if (!sc) out.push({ sc, cp: null, seller });
    }
  }
  // Sin duplicados, manteniendo el orden.
  const vistas = new Set();
  return out.filter((c) => {
    const k = `${c.sc}|${c.cp}|${c.seller}`;
    if (vistas.has(k)) return false;
    vistas.add(k);
    return true;
  });
}

const comboTxt = (c) => `sc=${c.sc ?? '(defecto)'} cp=${c.cp ?? '(sin)'}`
  + (c.seller ? ` seller=${c.seller}` : '');

async function simular(tienda, itemId, sellerId, combo) {
  const { sc, cp, seller } = combo || {};
  // El seller de la combinacion gana: viene de la region, que es quien sabe
  // quien despacha. El del catalogo es el de ultimo recurso.
  const elSeller = seller || sellerId || '1';
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
        items: [{ id: String(itemId), quantity: 1, seller: String(elSeller) }],
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
async function descubrirCombo(tienda, itemId, sellerId, cp, precioCatalogo, porPeso) {
  const intentos = [];
  const { canales, aCiegas, nombres } = await canalesDe(tienda);
  // EL SELLER DEL CATALOGO VA PRIMERO. Los de la region quedan como respaldo.
  //
  // Estaban al reves, y eso rompio Masonline: paso a cotizar con
  // `masonlineprod0006` (el seller que devuelve la region para el CP 1425) en
  // vez del `1` del catalogo, y ese seller tiene otra lista de precios. En 29
  // productos devolvio entre el 5% y el 18% del precio real —el jabon Dove a
  // $201 cuando la ficha dice $2.739— con el nombre del producto correcto, asi
  // que no era un problema de mapeo.
  //
  // El seller del catalogo es el que la tienda muestra en su propia ficha, que
  // es justamente el precio que se quiere comparar. Los de la region solo
  // sirven si ese no puede cotizar.
  const reg = await regionDe(tienda, cp);
  const sellers = reg.sellers ? [sellerId || '1', ...reg.sellers] : [null];
  for (const combo of combinaciones(cp, canales, sellers)) {
    const r = await simular(tienda, itemId, sellerId, combo);
    // UNA COMBINACION QUE COTIZA UN PRECIO IMPOSIBLE NO SIRVE.
    //
    // El precio del catalogo es el base: una promocion lo baja, pero no al 7%.
    // Si la simulacion devuelve muchisimo menos, ese seller o ese canal esta
    // mirando otra lista de precios, y hay que seguir probando en vez de
    // quedarse con el primero que responda 200.
    // Los productos por peso quedan afuera: su precio de catalogo es POR KILO
    // y la simulacion cotiza la unidad minima, asi que comparar los dos numeros
    // no compara lo mismo. Rechazaba "Manzana roja x kg" y "Queso cremoso horma
    // x kg" de Carrefour, que estaban bien.
    if (!r.error && precioCatalogo > 0 && r.precio != null && !porPeso
      && r.precio < precioCatalogo * UMBRAL_SIM) {
      intentos.push(`${comboTxt(combo)} → cotizó ${r.precio} con el catálogo en ${precioCatalogo}`
        + ` (${Math.round(r.precio / precioCatalogo * 100)}%): otra lista de precios`);
      continue;
    }
    if (!r.error) return { combo, primera: r, intentos, canales: nombres, region: reg };
    intentos.push(`${comboTxt(combo)} → ${r.error.slice(0, 90)}`);
  }
  // Que canales se probaron y de donde salio la lista: sin esto no se puede
  // distinguir "probe los canales que la tienda dice tener y ninguno anda" de
  // "adivine tres numeros y ninguno era".
  intentos.push(reg.error
    ? `(la tienda no dio sellers para el CP ${cp}: ${reg.error})`
    : `(sellers que despachan en el CP ${cp}: ${reg.sellers.join(', ')} · regionId ${reg.regionId || '(sin)'})`);
  intentos.push(aCiegas
    ? `(la tienda no quiso listar sus canales: ${aCiegas} — se probaron a ciegas ${canales.map((c) => c ?? 'defecto').join(', ')})`
    : `(canales que la tienda declara activos: ${(nombres || []).join(' · ')})`);
  // Se devuelven TODOS los intentos: con esto se ve si fallaron todos por lo
  // mismo (entonces el problema no es el canal ni la zona) o si cambia el
  // motivo, que es la pista de cual knob importa.
  return { combo: null, intentos, canales: nombres, region: reg };
}

/**
 * El precio que MUESTRA la ficha, leido del JSON-LD de la propia pagina.
 *
 * Esta es la fuente correcta, y se tardo en encontrarla porque no es una API.
 *
 * El recorrido: para Jumbo y Disco el catalogo, Intelligent Search y la
 * simulacion devuelven 3.050 en todos sus campos —tambien con las cookies del
 * navegador— mientras la ficha muestra $1.982,5 con -35%. No era regional (sin
 * ubicacion elegida el precio se muestra igual) ni cuestion de sesion. Buscando
 * el numero DENTRO de los datos de la pagina aparecio en un solo lugar: el
 * bloque <script type="application/ld+json"> que VTEX renderiza para los
 * buscadores, con la forma de schema.org:
 *
 *     {"sku":"405993","gtin":"7799155000197",
 *      "offers":{"@type":"Offer","price":1982.5,"priceCurrency":"ARS"}}
 *
 * `offers.price` ES el precio que ve el cliente. Y no es una particularidad de
 * Cencosud: el JSON-LD lo renderizan todas las tiendas VTEX, asi que sirve
 * igual para cualquiera.
 *
 * Se verifica el `gtin` o el `sku` contra lo pedido: la ficha trae mas
 * productos (relacionados, gondola) y leer el precio de otro seria peor que no
 * mostrar nada.
 *
 * Cuesta una descarga de HTML por producto, asi que se usa solo donde la
 * simulacion no pudo cotizar.
 */
async function precioDeFicha(tienda, url, ean, itemId) {
  if (!url) return { error: 'el catalogo no dio el link de la ficha' };
  const abs = url.startsWith('http')
    ? url
    : `${tienda.dominio}${url.startsWith('/') ? '' : '/'}${url}`;
  let html;
  try {
    const r = await pedirConTimeout(abs, { Accept: 'text/html,application/xhtml+xml' });
    if (!r.ok) return { error: `HTTP ${r.status} al pedir la ficha` };
    html = await r.text();
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout al pedir la ficha' : e.message };
  }

  const bloques = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => { try { return JSON.parse(m[1]); } catch { return null; } })
    .filter(Boolean);
  if (!bloques.length) return { error: 'la ficha no trae JSON-LD' };

  // Un JSON-LD puede venir como objeto, como lista, o envuelto en @graph.
  const candidatos = [];
  const juntar = (x) => {
    if (Array.isArray(x)) return x.forEach(juntar);
    if (!x || typeof x !== 'object') return;
    candidatos.push(x);
    if (x['@graph']) juntar(x['@graph']);
  };
  bloques.forEach(juntar);

  const esNuestro = (p) => {
    const gt = String(p.gtin || p.gtin13 || p.gtin14 || p.ean || '');
    const sk = String(p.sku || p.productID || '');
    if (gt && gt === String(ean)) return true;
    if (sk && itemId && sk === String(itemId)) return true;
    return false;
  };

  const productos = candidatos.filter((x) => /product/i.test(String(x['@type'] || '')));
  // El del EAN pedido; si ninguno se identifica y hay uno solo, ese es el
  // principal de la ficha.
  const prod = productos.find(esNuestro) || (productos.length === 1 ? productos[0] : null);
  if (!prod) {
    return { error: productos.length
      ? `la ficha trae ${productos.length} productos y ninguno coincide con el EAN ni el SKU`
      : 'la ficha no trae un Product en el JSON-LD' };
  }

  // `offers` puede ser Offer (price) o AggregateOffer (lowPrice/highPrice).
  const ofertas = (Array.isArray(prod.offers) ? prod.offers : [prod.offers]).filter(Boolean);
  let precio = null;
  for (const o of ofertas) {
    const v = [o.price, o.lowPrice, o.priceSpecification?.price]
      .map(Number).find((x) => Number.isFinite(x) && x > 0);
    if (v != null) { precio = v; break; }
  }
  if (precio == null) return { error: 'el JSON-LD no trae precio en offers' };
  return { precio, nombre: prod.name || null };
}

/**
 * Cuando hay descuento pero la tienda no publica el nombre de la promocion, se
 * describe el descuento.
 *
 * Por que hace falta para todas las tiendas y no solo para las que se resuelven
 * por la ficha: Masonline devolvia 10 productos con precio anterior y un
 * descuento real del 25% al 46%, y la columna de promociones vacia en las 65
 * filas. Se leia como "esta tienda no tiene promociones", cuando lo que pasa es
 * que no publica los nombres: su simulacion no manda
 * `ratesAndBenefitsData` y su catalogo no manda teasers. Jumbo y Disco estan
 * igual.
 *
 * Decir "−33%" no es lo mismo que decir "2do al 50%", y se aclara: el tamano
 * del descuento es un hecho, el nombre no lo tenemos.
 */
function describirPromoSinNombre(fila) {
  if ((fila.promos || []).length) return;            // ya tiene nombre de verdad
  const antes = fila.precioLista;
  if (!Number.isFinite(antes) || !Number.isFinite(fila.precio) || antes <= fila.precio) return;
  const off = Math.round((1 - fila.precio / antes) * 100);
  if (off < 1) return;
  fila.promos = [`−${off}% (la tienda no publica el nombre)`];
  fila.promoSinNombre = true;
}

/** Lo que nos interesa de un producto de VTEX, aplanado. */
function normalizar(producto, eanPedido) {
  // EL ITEM DEL EAN PEDIDO, no el primero. Un producto de VTEX puede tener
  // varios SKUs (la unidad y el pack de 3, tamanos distintos), cada uno con su
  // EAN y su precio. Leyendo siempre items[0] se mostraba el precio de la
  // variante que la tienda pusiera primero, que no es necesariamente la que se
  // pidio.
  const item = (eanPedido && itemDelEan(producto, eanPedido)) || producto?.items?.[0] || {};
  // Se elige el seller con oferta disponible; si ninguno está disponible, el
  // primero, para poder mostrar "sin stock" en vez de "no encontrado".
  const sellers = Array.isArray(item.sellers) ? item.sellers : [];
  const conStock = sellers.find((s) => s?.commertialOffer?.IsAvailable
    && (s.commertialOffer.AvailableQuantity || 0) > 0);
  const seller = conStock || sellers[0] || {};
  const o = seller.commertialOffer || {};

  // Las promos que VTEX muestra en la ficha ("2do al 70%", "Tarjeta Carrefour
  // 15%"). Se leen las dos formas de cada campo: el catalogo las devuelve con
  // la clave en mayuscula y otras APIs de VTEX en minuscula, y quedarse con una
  // sola perdia promos sin motivo.
  const nombreDePromo = (x) => x?.Name || x?.name || x?.Title || x?.title || null;
  const promos = [
    ...(o.Teasers || o.teasers || []).map(nombreDePromo),
    ...(o.PromotionTeasers || o.promotionTeasers || []).map(nombreDePromo),
    ...(o.DiscountHighLight || o.discountHighlight || o.discountHighLight || []).map(nombreDePromo),
  ].filter(Boolean);

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
    // Si el EAN pedido no aparece en ningun SKU y se uso el primero, la fila
    // queda marcada: es la diferencia entre "este es el precio de lo que
    // pediste" y "este es el precio de algo parecido".
    ...(eanPedido && !itemDelEan(producto, eanPedido)
      ? { eanNoCoincide: `Ningún SKU de este producto declara el EAN ${eanPedido}` }
      : {}),
    // Para la simulacion, que es la que trae el precio de verdad.
    _itemId: item.itemId || null,
    _sellerId: seller.sellerId || null,
  };
}

/**
 * Los EANs de un producto, para poder mapear la respuesta al pedido: VTEX no
 * garantiza el orden ni devuelve un producto por cada `fq` pedido.
 *
 * ACA ESTABA EL BUG DE LOS PRECIOS RAROS. Antes esto aceptaba, como si fuera un
 * EAN, cualquier `referenceId` de 6 a 14 digitos:
 *
 *     for (const ean of [item.ean, ...(item.referenceId || []).map((r) => r?.Value)])
 *
 * `referenceId` en VTEX NO es el EAN: es el codigo interno de referencia de la
 * tienda, y en muchas cuentas es un numero de largo parecido. Asi que un
 * producto cualquiera cuyo codigo interno coincidiera con un EAN pedido se
 * quedaba con esa fila, y el comparador mostraba el precio REAL pero DE OTRO
 * PRODUCTO. Por eso el numero se veia coherente —$201 con $233 tachado y
 * -13,7%— mientras la ficha de la tienda decia $2.739: no era un error de
 * escala, era otro producto.
 *
 * Ahora solo cuenta `item.ean`, mas las entradas de `referenceId` cuya CLAVE
 * dice explicitamente que es un EAN. Un codigo interno sin etiqueta se ignora:
 * preferible no encontrar el producto y decirlo, antes que mostrar el precio de
 * otra cosa.
 */
function eansDe(producto) {
  const out = new Set();
  const valido = (x) => x && /^\d{8,14}$/.test(String(x));
  for (const item of producto?.items || []) {
    if (valido(item.ean)) out.add(String(item.ean));
    for (const r of item.referenceId || []) {
      if (/ean|gtin/i.test(String(r?.Key || '')) && valido(r?.Value)) out.add(String(r.Value));
    }
  }
  return [...out];
}

/** El item (SKU) que tiene ese EAN. Null si ninguno lo tiene. */
function itemDelEan(producto, ean) {
  const buscado = String(ean);
  for (const item of producto?.items || []) {
    if (String(item.ean || '') === buscado) return item;
    if ((item.referenceId || []).some((r) => /ean|gtin/i.test(String(r?.Key || ''))
      && String(r?.Value || '') === buscado)) return item;
  }
  return null;
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
        // Se normaliza UNA VEZ POR EAN, no una vez por producto: el SKU
        // correcto —y por lo tanto el precio— depende de cual se pidio.
        for (const ean of eansDe(p)) {
          if (resultados[ean] && !resultados[ean][id]) {
            const fila = normalizar(p, ean);
            if (fila.url && fila.url.startsWith('/')) fila.url = tienda.dominio + fila.url;
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

  // ── Segunda pasada: los que el lote no pudo mapear ──────────────────────
  // El lote pide varios EANs juntos y despues hay que adivinar cual producto
  // corresponde a cual EAN, leyendolo del producto. Eso falla cuando la tienda
  // tiene el EAN SOLO en `alternateIds` y no en el campo `ean` del SKU: VTEX lo
  // encuentra igual (la consulta es por alternateIds_Ean) pero la respuesta no
  // lo dice, y con la regla estricta nueva ese producto se descarta.
  //
  // Preguntando de a un EAN el mapeo es inequivoco: lo que vuelva es de ese
  // EAN y de ningun otro. Solo se hace para los que faltan, asi que en el caso
  // normal no cuesta ninguna llamada extra.
  const faltantes = [];
  for (const ean of eans) {
    for (const id of tiendas) {
      if (!resultados[ean][id]) faltantes.push({ ean, id });
    }
  }
  let recuperados = 0;
  await forEachLimit(faltantes, CONCURRENCIA, async ({ ean, id }) => {
    const tienda = TIENDAS[id];
    try {
      const productos = await buscarLote(tienda, [ean]);
      const p = productos[0];
      if (!p) return;                       // esa tienda no lo tiene, y ya esta
      const fila = normalizar(p, ean);
      if (fila.url && fila.url.startsWith('/')) fila.url = tienda.dominio + fila.url;
      // Se anota como recuperado por consulta individual: si el SKU no declara
      // el EAN, `normalizar` ya lo dejo marcado con eanNoCoincide.
      fila.porConsultaIndividual = true;
      resultados[ean][id] = fila;
      fila._tienda = id;
      if (fila._itemId) aSimular.push({ ean, id, fila });
      recuperados += 1;
    } catch (e) {
      (errores[id] = errores[id] || []).push(`EAN ${ean}: ${e.message}`);
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
    // Se le pasa el precio del catalogo para que pueda descartar una
    // combinacion que cotiza un precio imposible.
    const d = await descubrirCombo(TIENDAS[id], primero.fila._itemId,
      primero.fila._sellerId, cp, primero.fila.precio, Boolean(primero.fila.unidad));
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
      return;
    }
    // La misma guarda, por fila. El descubrimiento valida la combinacion con UN
    // producto y las otras 93 la reusan, asi que si en alguna la simulacion
    // cotiza un precio imposible hay que atajarlo aca tambien: es la red que
    // habria evitado las 29 filas de Masonline a un decimo del precio.
    if (sim.precio != null && fila.precioCatalogo > 0 && !fila.unidad
      && sim.precio < fila.precioCatalogo * UMBRAL_SIM) {
      fila.simulacionFallo = `la simulación cotizó ${sim.precio} con el catálogo en `
        + `${fila.precioCatalogo} (${Math.round(sim.precio / fila.precioCatalogo * 100)}%)`;
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
    describirPromoSinNombre(fila);
  };

  for (const [x, sim] of primeras) aplicar(x.fila, sim);
  await forEachLimit(resto, CONCURRENCIA, async ({ id, fila }) => {
    aplicar(fila, await simular(TIENDAS[id], fila._itemId, fila._sellerId, comboDe[id]));
  });

  // ── Plan B: el precio que muestra la ficha ──────────────────────────────
  // Para las filas que la simulacion no pudo cotizar se lee el JSON-LD de la
  // ficha, que es donde esta el precio que ve el cliente.
  //
  // Antes aca se consultaba Intelligent Search. Se saco: devolvia exactamente
  // los mismos campos que el catalogo en las cinco tiendas —incluso con las
  // cookies del navegador— asi que rescataba 1 fila de 152 y costaba una
  // llamada por cada una.
  const conFalla = aSimular.filter(({ fila }) => fila.simulacionFallo);
  let porFicha = 0;
  // Por tienda, no solo el total: sin esto la pagina no puede distinguir "esta
  // tienda no cotiza pero la ficha la cubre" de "esta tienda quedo sin precios".
  const porFichaDe = {};
  const fichaErrores = {};
  await forEachLimit(conFalla, CONCURRENCIA, async ({ id, ean, fila }) => {
    const r = await precioDeFicha(TIENDAS[id], fila.url, ean, fila._itemId);
    if (r.error) {
      const acc = (fichaErrores[id] = fichaErrores[id] || {});
      acc[r.error.slice(0, 160)] = (acc[r.error.slice(0, 160)] || 0) + 1;
      return;
    }
    fila.precio = r.precio;
    // El `Price` del catalogo pasa a ser el precio TACHADO: para el agua de
    // Jumbo el catalogo daba 3.050 y la ficha muestra 1.982,5 tachando 3.050.
    // Eso da el -35% que se ve en pantalla.
    const base = fila.precioCatalogo;
    if (Number.isFinite(base) && base > r.precio) {
      fila.precioLista = base;
      fila.descuentoPct = Math.round((1 - r.precio / base) * 1000) / 10;
    } else {
      fila.precioLista = null;
      fila.descuentoPct = null;
    }
    // `ListPrice` de Cencosud no es un precio de lista: la ficha dice "PRECIO
    // SIN IMPUESTOS NACIONALES: $2.520,66" y el campo traia 252.066, o sea el
    // mismo numero en centavos. Por eso daba -98,8%. No se usa nunca mas.
    delete fila.listaSospechosa;
    delete fila.simulacionFallo;
    fila.fuentePrecio = 'ficha';
    // El NOMBRE de la promocion no esta en ninguna API publica de estas
    // cuentas: el catalogo de Cencosud no manda teasers y el JSON-LD de la
    // ficha solo trae el precio. Pero que HAY una promo, y de cuanto, si se
    // puede decir: es la diferencia entre el precio de la ficha y el del
    // catalogo. Se deja anotado asi en vez de dejar la celda de promos vacia,
    // que se leia como "esta tienda no tiene promociones".
    describirPromoSinNombre(fila);
    porFicha += 1;
    porFichaDe[id] = (porFichaDe[id] || 0) + 1;
  });

  // ── Precios que no se sostienen al lado de los demas ────────────────────
  // Un precio muchisimo mas bajo que el de todas las otras tiendas casi nunca
  // es una promocion: es el precio de otro producto, o un campo mal leido. Se
  // marca y no compite por el "mas barato", en vez de coronarlo ganador.
  //
  // Esto es una RED, no el arreglo: el arreglo es que el EAN mapee al SKU
  // correcto (ver eansDe e itemDelEan). Existe porque el caso que lo destapo
  // —Masonline a $201 contra $2.739, $2.800 y $2.800— pasaba por todas las
  // validaciones anteriores: el precio y su descuento eran coherentes entre si,
  // solo que de otro producto.
  for (const ean of eans) {
    const filas = tiendas.map((id) => resultados[ean]?.[id])
      .filter((f) => f && f.encontrado && Number.isFinite(f.precio) && f.precio > 0);
    if (filas.length < 3) continue;   // con dos tiendas no hay mediana que valga
    const ordenados = filas.map((f) => f.precio).sort((a, b) => a - b);
    const mediana = ordenados.length % 2
      ? ordenados[(ordenados.length - 1) / 2]
      : (ordenados[ordenados.length / 2 - 1] + ordenados[ordenados.length / 2]) / 2;
    for (const f of filas) {
      if (f.precio >= mediana * UMBRAL_DISPAR) continue;
      f.precioDisparatado = {
        mediana,
        pctDeLaMediana: Math.round(f.precio / mediana * 1000) / 10,
      };
    }
  }

  // ── Que quedo realmente sin precio ──────────────────────────────────────
  // Se agrupa DESPUES del plan B, no durante la simulacion. Antes se reportaba
  // el fallo de la simulacion aunque la ficha hubiera resuelto la fila: la
  // pagina avisaba en rojo que 152 productos mostraban el precio del catalogo
  // sin promociones cuando 148 ya tenian el precio bueno. Un paso intermedio
  // que falla y se recupera no es un problema del resultado.
  for (const { fila } of aSimular) {
    if (!fila.simulacionFallo) continue;
    // Se agrupa por el motivo SIN el nombre del producto. VTEX responde
    // "Ítem <nombre del producto> no encontrado o no disponible", asi que
    // agrupando por el texto exacto los 76 fallos de una tienda daban 76
    // motivos distintos y el aviso se volvia un muro ilegible.
    const motivo = String(fila.simulacionFallo)
      .replace(/Ítem .*? no encontrado/i, 'Ítem no encontrado')
      .replace(/Item .*? not found/i, 'Item not found')
      .slice(0, 160);
    const acc = (simErrores[fila._tienda] = simErrores[fila._tienda] || {});
    acc[motivo] = (acc[motivo] || 0) + 1;
  }

  // Los intentos de canal y zona son diagnostico: solo interesan si esa tienda
  // ADEMAS quedo sin precio. Si la ficha la resolvio, no hay nada que mirar.
  for (const id of Object.keys(canalErrores)) {
    if (!simErrores[id]) delete canalErrores[id];
  }

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
    porFicha,
    porFichaPorTienda: porFichaDe,
    recuperadosIndividual: recuperados,
    ...(Object.keys(fichaErrores).length ? { fichaErrores } : {}),
    aSimular: aSimular.length,
    ...(invalidos.length ? { invalidos: invalidos.slice(0, 20) } : {}),
    ...(desconocidas.length ? { tiendasDesconocidas: desconocidas } : {}),
    fuente: 'El precio sale de la simulación de carrito de cada tienda, que es donde VTEX '
      + 'aplica las promociones. Donde la simulación no cotiza, se lee el precio del JSON-LD '
      + 'de la ficha, que es el que muestra la página: para el agua Villavicencio 2 L en Jumbo '
      + 'el catálogo da $3.050 y la ficha $1.982,50.',
    // Esto ya no es cierto y se corrige: ahora se pide para un codigo postal y,
    // en las tiendas que resuelven sellers por zona, se usa el que despacha ahi.
    advertencia: `Los precios se piden para el código postal ${cp}. Los supermercados varían `
      + 'precio por zona, así que cambiando el CP cambian los números.',
  });
}

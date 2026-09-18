'use strict';

/**
 * Averigua DE DONDE saca cada tienda el precio que muestra en su ficha.
 *
 * Estado del problema. El comparador toma el precio de la simulacion de carrito,
 * que es donde VTEX aplica las promociones, y eso funciona para Carrefour,
 * Masonline y DIA. Para Jumbo y Disco (las dos de Cencosud) la simulacion
 * rechaza el item con "no encontrado o no disponible" en las 6 combinaciones de
 * canal de venta y codigo postal que se probaron, todas con el mismo mensaje.
 * Que el mensaje sea IDENTICO en las 6 descarta canal y zona: si alguno de esos
 * dos fuera el problema, al menos una combinacion daria un error distinto.
 *
 * Y el catalogo tampoco sirve para esas dos: para el agua de 2 L en Jumbo TODOS
 * los campos de precio del catalogo valen 3.050 mientras la ficha muestra
 * 1.982,50 con -35%.
 *
 * Asi que quedan tres hipotesis, y esta corrida prueba LAS TRES A LA VEZ para no
 * gastar una corrida por cada una:
 *
 *   H1 · El precio del catalogo cambia segun la politica comercial. El catalogo
 *        sin `sc` devuelve la politica por defecto; la ficha del sitio puede
 *        estar usando otra. Se pide el catalogo con sc=1,2,3 y se compara.
 *
 *   H2 · La ficha no lee el catalogo. Los storefronts VTEX modernos renderizan
 *        con Intelligent Search, no con catalog_system, y el precio que IS
 *        devuelve puede venir ya con la promocion aplicada. Si 1.982,50 esta en
 *        algun lado, lo mas probable es que sea aca: es la API que alimenta la
 *        pagina que el usuario nos mostro.
 *
 *   H3 · El seller que se le manda a la simulacion no es el correcto. Se prueba
 *        el sellerId del catalogo, el "1" literal, y SIN campo seller.
 *
 * El criterio de exito es uno solo y no se negocia: que aparezca el numero que
 * muestra la ficha. Por eso imprime el `link` de cada producto — el campo bueno
 * es el que coincide con el sitio, no el que parece razonable.
 *
 * No escribe nada: imprime y sale.
 *
 * Uso: node src/competencia-probe.js [ean ...]
 */

const TIENDAS = {
  carrefour: { nombre: 'Carrefour', dominio: 'https://www.carrefour.com.ar' },
  jumbo: { nombre: 'Jumbo', dominio: 'https://www.jumbo.com.ar' },
  disco: { nombre: 'Disco', dominio: 'https://www.disco.com.ar' },
  masonline: { nombre: 'Masonline', dominio: 'https://www.masonline.com.ar' },
  dia: { nombre: 'DIA', dominio: 'https://diaonline.supermercadosdia.com.ar' },
};

const CAMPOS = ['Price', 'ListPrice', 'PriceWithoutDiscount', 'FullSellingPrice', 'SellingPrice', 'spotPrice'];
const POR_DEFECTO = ['7799155000197', '7792799000097', '7792798014019'];
const TIMEOUT_MS = 20000;
const CP = process.env.COMPETENCIA_CP || '1425';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const plata = (n) => (typeof n === 'number'
  ? n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  : String(n));

async function pedir(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: { Accept: 'application/json', 'User-Agent': UA, ...(opts.headers || {}) },
    });
    const txt = await r.text();
    let json = null;
    try { json = JSON.parse(txt); } catch { /* no era json */ }
    return { ok: r.ok, status: r.status, json, txt };
  } catch (e) {
    return { ok: false, status: 0, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(t); }
}

/** Todos los campos de precio de una oferta, en una linea. */
function ofertaEnUnaLinea(o) {
  const vals = CAMPOS.filter((c) => o[c] !== undefined).map((c) => `${c}=${plata(o[c])}`);
  const otros = Object.entries(o)
    .filter(([k, v]) => typeof v === 'number' && !CAMPOS.includes(k) && /price|value/i.test(k))
    .map(([k, v]) => `${k}=${plata(v)}`);
  return [...vals, ...otros].join('  ') || '(sin campos de precio)';
}

// ── H1 · el catalogo con cada politica comercial ────────────────────────────
async function h1Catalogo(tienda, ean) {
  console.log('\n    H1 · catalogo por politica comercial');
  for (const sc of [null, 1, 2, 3]) {
    const url = `${tienda.dominio}/api/catalog_system/pub/products/search`
      + `?fq=alternateIds_Ean:${encodeURIComponent(ean)}${sc ? `&sc=${sc}` : ''}`;
    const r = await pedir(url);
    const etq = `sc=${sc ?? '(defecto)'}`.padEnd(13);
    if (!r.ok) { console.log(`      ${etq} HTTP ${r.status || r.error}`); continue; }
    const p = (r.json || [])[0];
    if (!p) { console.log(`      ${etq} no lo tiene`); continue; }
    for (const item of (p.items || []).slice(0, 1)) {
      for (const s of (item.sellers || [])) {
        const o = s.commertialOffer || {};
        console.log(`      ${etq} seller=${s.sellerId} (${s.sellerName || '?'})`
          + `${o.IsAvailable ? '' : ' SIN-STOCK'}  ${ofertaEnUnaLinea(o)}`);
        const teasers = [...(o.Teasers || []), ...(o.PromotionTeasers || [])].map((x) => x?.Name).filter(Boolean);
        if (teasers.length) console.log(`      ${' '.repeat(13)} teasers: ${teasers.join(' | ')}`);
      }
    }
  }
}

// ── H2 · Intelligent Search, que es lo que renderiza la ficha ───────────────
async function h2IntelligentSearch(tienda, ean) {
  console.log('\n    H2 · Intelligent Search (la API que usa el storefront)');
  // La barra final es obligatoria: el segmento de facets va vacio pero tiene
  // que estar. Se prueban dos formas de pedirlo porque no todas las cuentas
  // indexan el EAN como texto buscable.
  const urls = [
    `${tienda.dominio}/api/io/_v/api/intelligent-search/product_search/?query=${encodeURIComponent(ean)}&count=3`,
    `${tienda.dominio}/api/io/_v/api/intelligent-search/product_search/alternateIds_Ean/${encodeURIComponent(ean)}?count=3`,
  ];
  for (const url of urls) {
    const r = await pedir(url);
    const etq = url.includes('?query=') ? 'query=ean  ' : 'facet=ean   ';
    if (!r.ok) {
      console.log(`      ${etq} HTTP ${r.status || r.error}`
        + (r.txt ? `: ${String(r.txt).replace(/\s+/g, ' ').slice(0, 120)}` : ''));
      continue;
    }
    const prods = r.json?.products || [];
    console.log(`      ${etq} ${r.json?.recordsFiltered ?? prods.length} resultado(s)`);
    for (const p of prods.slice(0, 1)) {
      console.log(`      ${' '.repeat(12)} "${p.productName}"  link=${p.link || p.linkText || '?'}`);
      for (const item of (p.items || []).slice(0, 1)) {
        for (const s of (item.sellers || [])) {
          const o = s.commertialOffer || {};
          console.log(`      ${' '.repeat(12)} seller=${s.sellerId}  ${ofertaEnUnaLinea(o)}`);
          const tz = (o.teasers || o.Teasers || []).map((x) => x?.name || x?.Name).filter(Boolean);
          if (tz.length) console.log(`      ${' '.repeat(12)} teasers: ${tz.join(' | ')}`);
        }
      }
      // priceRange es lo que el storefront usa para el "desde/hasta" de la ficha.
      if (p.priceRange) {
        const pr = p.priceRange;
        console.log(`      ${' '.repeat(12)} priceRange: selling=${JSON.stringify(pr.sellingPrice)} list=${JSON.stringify(pr.listPrice)}`);
      }
    }
  }
}

// ── H3 · la simulacion, variando el seller ──────────────────────────────────
async function h3Simulacion(tienda, itemId, sellerCatalogo) {
  console.log('\n    H3 · simulacion de carrito, variando el seller');
  // Tres formas de identificar al vendedor: el id que dio el catalogo, el "1"
  // literal (el default de VTEX), y omitir el campo para que VTEX lo resuelva.
  const sellers = [
    { etq: `seller=${sellerCatalogo} (catalogo)`, v: sellerCatalogo },
    { etq: 'seller=1 (default VTEX)', v: '1' },
    { etq: 'sin campo seller', v: undefined },
  ];
  for (const sc of [null, 1]) {
    for (const s of sellers) {
      if (s.v === undefined && sc === null) { /* igual se prueba */ }
      const url = `${tienda.dominio}/api/checkout/pub/orderForms/simulation`
        + (sc ? `?sc=${sc}` : '');
      const item = { id: String(itemId), quantity: 1 };
      if (s.v !== undefined && s.v !== null) item.seller = String(s.v);
      const r = await pedir(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [item], country: 'ARG', postalCode: CP }),
      });
      const etq = `      sc=${String(sc ?? '(def)').padEnd(5)} ${s.etq.padEnd(28)}`;
      if (!r.ok) {
        console.log(`${etq} HTTP ${r.status || r.error}`
          + (r.txt ? `: ${String(r.txt).replace(/\s+/g, ' ').slice(0, 140)}` : ''));
        continue;
      }
      const it = (r.json?.items || [])[0];
      if (!it) {
        const msgs = (r.json?.messages || []).map((m) => m?.text || m?.code).filter(Boolean);
        console.log(`${etq} 200 sin item — ${msgs.length ? msgs.join(' | ').slice(0, 140) : '(sin messages)'}`);
        continue;
      }
      // La simulacion devuelve CENTAVOS, al contrario del catalogo que da pesos.
      const c = (v) => (typeof v === 'number' ? plata(v / 100) : String(v));
      const campos = ['price', 'listPrice', 'sellingPrice', 'priceWithoutDiscount']
        .filter((k) => it[k] !== undefined).map((k) => `${k}=${c(it[k])}`).join('  ');
      const benes = (r.json?.ratesAndBenefitsData?.rateAndBenefitsIdentifiers || [])
        .map((b) => b?.name).filter(Boolean);
      console.log(`${etq} OK  ${campos}${benes.length ? `  promos: ${benes.join(' | ')}` : ''}`);
    }
  }
}

async function main() {
  const eans = process.argv.slice(2).filter((x) => /^\d{8,14}$/.test(x));
  const lista = eans.length ? eans : POR_DEFECTO;
  console.log(`Codigo postal: ${CP}  ·  EANs: ${lista.join(', ')}`);

  for (const ean of lista) {
    console.log(`\n${'='.repeat(78)}\nEAN ${ean}`);

    for (const tienda of Object.values(TIENDAS)) {
      console.log(`\n  ${'─'.repeat(70)}\n  ${tienda.nombre}`);

      // Primero el catalogo pelado, para tener itemId, sellerId y el link de la
      // ficha. Sin esto no se puede simular nada.
      const r = await pedir(`${tienda.dominio}/api/catalog_system/pub/products/search`
        + `?fq=alternateIds_Ean:${encodeURIComponent(ean)}`);
      const p = (r.json || [])[0];
      if (!r.ok) { console.log(`    catalogo: HTTP ${r.status || r.error}`); continue; }
      if (!p) { console.log('    no lo tiene'); continue; }
      const item = (p.items || [])[0] || {};
      const seller = (item.sellers || []).find((s) => s?.commertialOffer?.IsAvailable)
        || (item.sellers || [])[0] || {};
      console.log(`    "${p.productName}"`);
      console.log(`    ficha:  ${p.link || '(sin link)'}`);
      console.log(`    itemId: ${item.itemId}  ·  sellerId: ${seller.sellerId}`
        + `  ·  sellerName: ${seller.sellerName || '?'}`
        + `  ·  sellers: ${(item.sellers || []).map((s) => s.sellerId).join(', ')}`);

      await h1Catalogo(tienda, ean);
      await h2IntelligentSearch(tienda, ean);
      if (item.itemId) await h3Simulacion(tienda, item.itemId, seller.sellerId);
    }
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log('COMO LEER ESTO');
  console.log('');
  console.log('Lo unico que importa: en que linea aparece el precio que muestra la ficha.');
  console.log('Abri el link de Jumbo que imprime arriba, mira el precio grande, y busca ese');
  console.log('numero en la salida. La seccion donde aparezca es la API que hay que usar.');
  console.log('');
  console.log('  · Si aparece en H1 con un sc distinto  -> el comparador tiene que pedir el');
  console.log('    catalogo con ese sc por tienda.');
  console.log('  · Si aparece en H2 (Intelligent Search) -> la ficha no lee el catalogo, y el');
  console.log('    comparador tiene que leer IS. Es la hipotesis mas probable para Cencosud:');
  console.log('    es la API que alimenta la pagina que se ve en pantalla.');
  console.log('  · Si aparece en H3 con algun seller    -> era el seller, y alcanza con');
  console.log('    corregir como se elige.');
  console.log('  · Si NO aparece en ninguna -> el descuento se aplica mas adelante (carrito,');
  console.log('    medio de pago o precio por zona con geocoordenadas) y entonces no se puede');
  console.log('    obtener por API. En ese caso el comparador tiene que DECIRLO en vez de');
  console.log('    mostrar un precio que no es el que ve el cliente.');
}

main().catch((e) => { console.error('competencia-probe fallo:', e.message); process.exit(1); });

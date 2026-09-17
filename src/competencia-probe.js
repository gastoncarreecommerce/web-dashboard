'use strict';

/**
 * Muestra TODOS los campos de precio que devuelve cada tienda para unos pocos
 * EANs, para saber cuál hay que leer en vez de adivinar.
 *
 * Por qué existe. El comparador mostraba, para Jumbo y Disco, un precio de lista
 * de $252.066 con un −98,8% de descuento en un agua de 2 litros. Eso no es una
 * promoción: es el campo equivocado. Estaba leyendo `ListPrice`, que en esas
 * cuentas (Jumbo y Disco son Cencosud, mismo backend) contiene otra cosa —
 * mientras que en Masonline y DIA daba valores plausibles (−33%, −30%).
 *
 * VTEX devuelve varios campos de precio por oferta y no todos significan lo
 * mismo en todas las cuentas: `Price`, `ListPrice`, `PriceWithoutDiscount`,
 * `SellingPrice`, `spotPrice`, y a veces `PriceValidUntil` o `Installments`.
 * Este script los imprime todos, por seller, para poder compararlos con lo que
 * muestra la ficha del producto en el sitio y elegir el correcto por tienda.
 *
 * También imprime el `link` de cada producto, así se puede abrir la ficha real y
 * comparar contra lo que se ve en pantalla. Eso es el paso que no se puede
 * saltear: el campo correcto es el que coincide con el sitio, no el que parece
 * razonable.
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

// Los que interesan para decidir. Se listan explícitamente para que el reporte
// tenga columnas estables, y aparte se muestra cualquier otro campo numérico
// que traiga la oferta, por si alguna cuenta usa uno propio.
const CAMPOS = ['Price', 'ListPrice', 'PriceWithoutDiscount', 'SellingPrice', 'spotPrice', 'priceWithoutDiscount'];

const POR_DEFECTO = ['7799155000197', '7792799000097', '7792798014019'];
const TIMEOUT_MS = 20000;

/**
 * La simulacion de carrito de VTEX. Es el unico lugar donde aparecen las
 * promociones aplicadas.
 *
 * Por que hace falta: la corrida anterior mostro que en Jumbo TODOS los campos
 * de precio del catalogo valen 3.050 (Price, PriceWithoutDiscount,
 * FullSellingPrice) mientras la ficha muestra $1.982,50 con -35%. O sea que el
 * precio promocional NO esta en la API de catalogo. En VTEX las promociones las
 * calcula el motor de checkout, no el catalogo: Carrefour las expone como
 * `Teasers` y por eso se veian, pero Jumbo no manda ninguno.
 *
 * OJO con las unidades: la simulacion devuelve los precios en CENTAVOS (enteros),
 * al contrario del catalogo que los da en pesos. Por eso se divide por 100 al
 * mostrar; confundir las dos escalas daria precios 100 veces mas grandes.
 */
async function simular(tienda, itemId, sellerId) {
  const url = `${tienda.dominio}/api/checkout/pub/orderForms/simulation?sc=1`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; comparador-probe)',
      },
      body: JSON.stringify({
        items: [{ id: String(itemId), quantity: 1, seller: String(sellerId || '1') }],
        country: 'ARG',
      }),
    });
    if (!r.ok) {
      const cuerpo = await r.text().catch(() => '');
      return { error: `HTTP ${r.status}${cuerpo ? `: ${cuerpo.slice(0, 160)}` : ''}` };
    }
    return await r.json();
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(t); }
}

function pedir(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  return fetch(url, {
    signal: ctrl.signal,
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; comparador-probe)' },
  }).finally(() => clearTimeout(t));
}

const plata = (n) => (typeof n === 'number' ? n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(n));

async function main() {
  const eans = process.argv.slice(2).filter((x) => /^\d{8,14}$/.test(x));
  const lista = eans.length ? eans : POR_DEFECTO;

  for (const ean of lista) {
    console.log(`\n${'='.repeat(78)}\nEAN ${ean}`);

    for (const [id, tienda] of Object.entries(TIENDAS)) {
      const url = `${tienda.dominio}/api/catalog_system/pub/products/search`
        + `?fq=alternateIds_Ean:${encodeURIComponent(ean)}`;
      let productos;
      try {
        const r = await pedir(url);
        if (!r.ok) { console.log(`\n  ${tienda.nombre}: HTTP ${r.status}`); continue; }
        productos = await r.json();
      } catch (e) { console.log(`\n  ${tienda.nombre}: ${e.name === 'AbortError' ? 'timeout' : e.message}`); continue; }

      if (!Array.isArray(productos) || !productos.length) {
        console.log(`\n  ${tienda.nombre}: no lo tiene`);
        continue;
      }

      const p = productos[0];
      console.log(`\n  ${tienda.nombre} — ${p.productName}`);
      console.log(`    ficha: ${p.link || '(sin link)'}`);

      for (const item of (p.items || []).slice(0, 2)) {
        console.log(`    item ${item.itemId || ''} ${item.name || ''}`
          + `  unitMultiplier=${item.unitMultiplier} medida=${item.measurementUnit || '?'}`);

        for (const s of (item.sellers || [])) {
          const o = s.commertialOffer || {};
          const dis = o.IsAvailable ? `stock ${o.AvailableQuantity}` : 'SIN STOCK';
          console.log(`      seller "${s.sellerName || s.sellerId}" (${dis})${s.sellerDefault ? ' [default]' : ''}`);

          for (const c of CAMPOS) {
            if (o[c] !== undefined) console.log(`         ${c.padEnd(22)} ${plata(o[c])}`);
          }
          // Cualquier otro campo numérico de la oferta, por si alguna cuenta usa
          // un nombre que no está en la lista de arriba.
          const otros = Object.entries(o)
            .filter(([k, v]) => typeof v === 'number' && !CAMPOS.includes(k) && /price|value|cost/i.test(k));
          for (const [k, v] of otros) console.log(`         ${(k + ' (extra)').padEnd(22)} ${plata(v)}`);

          const teasers = [...(o.Teasers || []), ...(o.PromotionTeasers || [])].map((t) => t?.Name).filter(Boolean);
          console.log(`         teasers del catalogo: ${teasers.length ? teasers.join(' | ') : '(ninguno)'}`);

          // ── La simulacion, que es donde viven las promociones ──────────────
          const sim = await simular(tienda, item.itemId, s.sellerId);
          if (sim.error) { console.log(`         SIMULACION: ${sim.error}`); continue; }

          const it = (sim.items || [])[0];
          if (!it) {
            console.log('         SIMULACION: no devolvio el item'
              + (sim.messages?.length ? ` — ${sim.messages.map((m) => m.text).join(' | ')}` : ''));
            continue;
          }
          // Centavos -> pesos.
          const c = (v) => (typeof v === 'number' ? plata(v / 100) : String(v));
          console.log('         SIMULACION (los precios vienen en centavos, se dividen por 100):');
          for (const k of ['price', 'listPrice', 'sellingPrice', 'priceWithoutDiscount']) {
            if (it[k] !== undefined) console.log(`            ${k.padEnd(20)} ${c(it[k])}`);
          }
          if (it.priceDefinition) {
            const pd = it.priceDefinition;
            if (pd.calculatedSellingPrice !== undefined) console.log(`            calculatedSellingPrice ${c(pd.calculatedSellingPrice)}`);
            if (pd.total !== undefined) console.log(`            total                ${c(pd.total)}`);
          }
          const benes = (sim.ratesAndBenefitsData?.rateAndBenefitsIdentifiers || [])
            .map((b) => b?.name).filter(Boolean);
          console.log(`            promociones aplicadas: ${benes.length ? benes.join(' | ') : '(ninguna)'}`);
          const desc = (sim.totals || []).find((x) => x.id === 'Discounts');
          if (desc && desc.value) console.log(`            descuento total      ${c(desc.value)}`);
        }
      }
    }
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log('Qué buscar: el precio que muestra la ficha del sitio.');
  console.log('');
  console.log('La corrida anterior mostró que en Jumbo TODOS los campos de precio del');
  console.log('catálogo valen $3.050, mientras la ficha muestra $1.982,50 con −35%. O sea');
  console.log('que el precio promocional NO está en el catálogo: en VTEX las promociones');
  console.log('las calcula el motor de checkout. Por eso ahora se simula el carrito.');
  console.log('');
  console.log('Si la SIMULACIÓN de Jumbo devuelve 1982,50 en alguno de sus campos, ese es');
  console.log('el precio que hay que mostrar, y el comparador tiene que simular además de');
  console.log('consultar el catálogo. Si tampoco aparece, el descuento se aplica más');
  console.log('adelante (carrito o medio de pago) y entonces no hay forma de obtenerlo');
  console.log('por API: habría que decirlo en la página en vez de mostrar un precio que');
  console.log('no es el que ve el cliente.');
}

main().catch((e) => { console.error('competencia-probe falló:', e.message); process.exit(1); });

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
          if (teasers.length) console.log(`         promos: ${teasers.join(' | ')}`);
        }
      }
    }
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log('Qué hacer con esto: abrir la ficha de cada producto en el sitio y ver qué');
  console.log('precio muestra como "precio" y cuál como "precio anterior/tachado". El campo');
  console.log('correcto es el que COINCIDE con la ficha, no el que parece razonable.');
  console.log('');
  console.log('El comparador leía ListPrice y para Jumbo y Disco eso daba $252.066 con');
  console.log('un -98,8% en un agua de 2 litros. Con este listado se ve qué campo usar');
  console.log('en cada tienda.');
}

main().catch((e) => { console.error('competencia-probe falló:', e.message); process.exit(1); });

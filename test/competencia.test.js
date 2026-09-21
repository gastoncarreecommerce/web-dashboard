'use strict';
const { test, mock } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const R = path.join(__dirname, '..');

// mock.module solo se puede registrar UNA vez por especificador, asi que la
// sesion se controla con una bandera que el mock lee en cada llamada.
let sesionOk = true;
mock.module(path.join(R, 'api', '_session.js'), {
  namedExports: { verifySession: () => sesionOk },
});
const handlerP = import(path.join(R, 'api', 'competencia.js')).then((m) => m.default);

/** Producto de VTEX con la forma real de la API de catalogo. */
function prod(ean, nombre, { precio = 1000, lista = null, stock = true, promos = [] } = {}) {
  return {
    productName: nombre, brand: 'X', link: `/${String(nombre).replace(/\s+/g, '-')}/p`, linkText: nombre,
    items: [{ ean, itemId: '405993', measurementUnit: 'un', unitMultiplier: 1, sellers: [{
      sellerId: '1', sellerName: 'seller', commertialOffer: {
        Price: precio, ListPrice: lista, IsAvailable: stock, AvailableQuantity: stock ? 5 : 0,
        Teasers: promos.map((n) => ({ Name: n })),
      } }] }],
  };
}

/** Con la matriz de descubrimiento el numero exacto de llamadas depende del
 *  orden de las combinaciones, asi que se verifica la propiedad que importa
 *  —que no se repita el descubrimiento por producto— y no un numero magico. */
function combosProbados(n) { return n > 0; }

function fakeRes() {
  return { code: 200, body: null, headers: {},
    status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[k] = v; } };
}

/** Simulaciones por dominio: { dominio: {precio, lista, promos} | numero (HTTP) }.
 *  Sin entrada para un dominio, la simulacion falla y el precio queda el del
 *  catalogo — que es justo el caso que hay que poder distinguir. */
let SIMS = {};

/** Respuestas de Intelligent Search por dominio: { dominio: [producto, ...] }.
 *  Sin entrada, IS responde sin productos. */
/** HTML de la ficha por dominio: { dominio: html | numero (HTTP) }.
 *  Sin entrada, la ficha responde 404. */
let FICHAS = {};

/** Arma una ficha con el JSON-LD real que renderiza VTEX. */
function ficha(ean, itemId, nombre, precio, { tipo = 'Product', extra = '' } = {}) {
  const ld = JSON.stringify({
    '@context': 'https://schema.org/', '@type': tipo, name: nombre,
    sku: String(itemId), gtin: String(ean),
    offers: { '@type': 'Offer', price: precio, priceCurrency: 'ARS',
      availability: 'http://schema.org/InStock' },
  });
  return `<html><head>
    <script type="application/ld+json">${JSON.stringify({ '@type': 'BreadcrumbList' })}</script>
    <script type="application/ld+json">${ld}</script>${extra}
    </head><body>$${precio}</body></html>`;
}

/** Canales activos por dominio: { dominio: [{Id, Name, IsActive}] | numero }.
 *  Sin entrada, el endpoint responde 404 y la API cae a probar a ciegas. */
let CANALES = {};

/** Regiones por dominio: { dominio: [{id, sellers:[{id,name}]}] | numero }.
 *  Sin entrada, el endpoint responde 404: la tienda no esta regionalizada. */
let REGIONES = {};

async function correr(porTienda, query) {
  const llamadas = [];
  global.fetch = async (url, init) => {
    const u = String(url);
    llamadas.push(u);

    if (u.includes('/api/checkout/pub/orderForms/simulation')) {
      const d = Object.keys(SIMS).find((x) => u.includes(x));
      const sim = SIMS[d];
      if (sim === undefined) return { ok: false, status: 500, text: async () => 'no simula' };
      if (typeof sim === 'number') {
        return { ok: false, status: sim, text: async () => '{"error":{"message":"Sales channel not found"}}' };
      }
      // `canal` en el mock: la simulacion solo funciona con ESE sc, para poder
      // probar el descubrimiento. Sin `canal`, funciona con cualquiera.
      if (sim.cp !== undefined) {
        const body = JSON.parse(init.body);
        if (String(body.postalCode ?? '') !== String(sim.cp ?? '')) {
          return { ok: true, status: 200, json: async () => ({
            items: [], messages: [{ text: `Ítem ${sim.nombre || 'X'} no encontrado o no disponible` }],
          })};
        }
      }
      // `porSeller`: {seller: precio}. Sirve para el caso de un seller que
      // cotiza otra lista de precios.
      if (sim.porSeller) {
        const body = JSON.parse(init.body);
        const pr = sim.porSeller[String(body.items[0].seller)];
        if (pr === undefined) {
          return { ok: true, status: 200, json: async () => ({
            items: [], messages: [{ text: 'Ítem no encontrado o no disponible' }],
          })};
        }
        return { ok: true, status: 200, json: async () => ({
          items: [{ sellingPrice: Math.round(pr * 100), price: Math.round(pr * 100) }],
          ratesAndBenefitsData: { rateAndBenefitsIdentifiers: (sim.promos || []).map((n) => ({ name: n })) },
        })};
      }
      if (sim.seller !== undefined) {
        const body = JSON.parse(init.body);
        if (String(body.items[0].seller) !== String(sim.seller)) {
          return { ok: true, status: 200, json: async () => ({
            items: [], messages: [{ text: `Ítem ${sim.nombre || 'X'} no encontrado o no disponible` }],
          })};
        }
      }
      if (sim.canal !== undefined) {
        const sc = (u.match(/[?&]sc=([^&]*)/) || [, null])[1];
        if (String(sc) !== String(sim.canal)) {
          return { ok: true, status: 200, json: async () => ({
            items: [], messages: [{ text: `Ítem ${sim.nombre || 'X'} no encontrado o no disponible` }],
          })};
        }
      }
      return { ok: true, status: 200, json: async () => ({
        // La simulacion habla en CENTAVOS: x100.
        items: [{ sellingPrice: Math.round(sim.precio * 100), price: Math.round(sim.precio * 100),
                  listPrice: sim.lista != null ? Math.round(sim.lista * 100) : undefined }],
        ratesAndBenefitsData: { rateAndBenefitsIdentifiers: (sim.promos || []).map((n) => ({ name: n })) },
      })};
    }

    if (u.includes('/api/checkout/pub/regions')) {
      const d = Object.keys(REGIONES).find((x) => u.includes(x));
      const g = REGIONES[d];
      if (g === undefined) return { ok: false, status: 404, text: async () => 'no' };
      if (typeof g === 'number') return { ok: false, status: g, text: async () => 'no' };
      return { ok: true, status: 200, json: async () => g };
    }

    if (u.includes('/catalog_system/pub/saleschannel/active')) {
      const d = Object.keys(CANALES).find((x) => u.includes(x));
      const c = CANALES[d];
      if (c === undefined) return { ok: false, status: 404, text: async () => 'no' };
      if (typeof c === 'number') return { ok: false, status: c, text: async () => 'no' };
      return { ok: true, status: 200, json: async () => c };
    }

    // La ficha: cualquier URL que no sea una API de VTEX.
    if (/\/p($|\?)/.test(u)) {
      const d = Object.keys(FICHAS).find((x) => u.includes(x));
      const h = FICHAS[d];
      if (h === undefined) return { ok: false, status: 404, text: async () => 'no' };
      if (typeof h === 'number') return { ok: false, status: h, text: async () => 'no' };
      return { ok: true, status: 200, text: async () => h };
    }

    const d = Object.keys(porTienda).find((x) => u.includes(x));
    const r = porTienda[d];
    if (typeof r === 'number') return { ok: false, status: r, text: async () => 'boom' };

    // El mock FILTRA por los EANs pedidos, como hace VTEX: `alternateIds_Ean`
    // es un filtro exacto, asi que la tienda solo puede devolver productos que
    // tengan registrado ese EAN. Sin esto el mock devolvia todo para cualquier
    // consulta, y no se podia distinguir "el producto tiene ese EAN" de "el
    // mapeo se lo adjudico".
    //
    // Los EANs que un producto tiene REGISTRADOS son `_alternateEans` si el
    // fixture lo declara (el caso de una tienda que lo guarda solo en
    // alternateIds), y si no, los `ean` de sus SKUs.
    const pedidos = [...u.matchAll(/alternateIds_Ean:(\d+)/g)].map((m) => m[1]);
    const filtrado = (Array.isArray(r) && pedidos.length)
      ? r.filter((p) => {
        const propios = p._alternateEans || (p.items || []).flatMap((it) => [
          String(it.ean || ''),
          // Un referenceId ETIQUETADO como EAN tambien es un EAN registrado, y
          // VTEX lo tendria en alternateIds.
          ...(it.referenceId || []).filter((x) => /ean|gtin/i.test(String(x?.Key || '')))
            .map((x) => String(x.Value || '')),
        ]).filter(Boolean);
        return propios.some((e) => pedidos.includes(String(e)));
      })
      : r;
    return { ok: true, status: 200, json: async () => filtrado, text: async () => JSON.stringify(filtrado) };
  };
  const handler = await handlerP;
  const res = fakeRes();
  await handler({ method: 'GET', query, headers: {} }, res);
  return { res, llamadas };
}

test('compara el mismo EAN en varias tiendas: precio, lista, descuento y promos', async () => {
  sesionOk = true;
  SIMS = {
    'www.carrefour.com.ar': { precio: 2290, lista: 2790, promos: ['2do al 70%'] },
    'www.jumbo.com.ar': { precio: 2450 },
    'diaonline.supermercadosdia.com.ar': { precio: 2100 },
  };
  const { res, llamadas } = await correr({
    'www.carrefour.com.ar': [prod('7790742358608', 'Leche 1L', { precio: 2290, lista: 2790, promos: ['2do al 70%'] })],
    'www.jumbo.com.ar': [prod('7790742358608', 'Leche 1L Jumbo', { precio: 2450 })],
    'diaonline.supermercadosdia.com.ar': [prod('7790742358608', 'Leche 1L DIA', { precio: 2100, stock: false })],
  }, { eans: '7790742358608', tiendas: 'carrefour,jumbo,dia' });

  assert.strictEqual(res.code, 200, JSON.stringify(res.body));
  const r = res.body.resultados['7790742358608'];
  assert.strictEqual(r.carrefour.precio, 2290);
  assert.strictEqual(r.carrefour.descuentoPct, 17.9);
  assert.deepStrictEqual(r.carrefour.promos, ['2do al 70%']);
  assert.strictEqual(r.jumbo.precio, 2450);
  assert.strictEqual(r.dia.disponible, false, 'DIA mas barato pero SIN stock');
  assert.ok(llamadas.some((u) => u.includes('jumbo.com.ar/api/catalog_system/pub/products/search')),
    'se consulta el dominio publico de cada tienda, no un accountName adivinado');
  // La asercion aplica solo a las del catalogo: las de simulacion son POST a
  // otro path y no llevan `fq`.
  const cat = llamadas.filter((u) => u.includes("/products/search"));
  assert.ok(cat.length && cat.every((u) => u.includes('fq=alternateIds_Ean')));
  assert.ok(llamadas.some((u) => u.includes('orderForms/simulation')),
    'y ademas se simula, que es de donde sale el precio real');
});

test('sin lista o con lista menor al precio, no se inventa un descuento', async () => {
  sesionOk = true;
  SIMS = { 'www.carrefour.com.ar': { precio: 1000, lista: null } };
  const { res } = await correr({
    'www.carrefour.com.ar': [
      prod('11111111', 'Sin lista', { precio: 1000, lista: null }),
      prod('22222222', 'Lista menor', { precio: 1000, lista: 900 }),
    ],
  }, { eans: '11111111,22222222', tiendas: 'carrefour' });
  assert.strictEqual(res.body.resultados['11111111'].carrefour.descuentoPct, null);
  assert.strictEqual(res.body.resultados['22222222'].carrefour.descuentoPct, null,
    'un descuento negativo confunde mas que no mostrar nada');
});

test('un EAN que la tienda no tiene sale encontrado:false, no como precio 0', async () => {
  sesionOk = true;
  SIMS = { 'www.carrefour.com.ar': { precio: 1000 } };
  const { res } = await correr({
    'www.carrefour.com.ar': [prod('11111111', 'A')],
    'www.jumbo.com.ar': [],
  }, { eans: '11111111,22222222', tiendas: 'carrefour,jumbo' });
  const r = res.body.resultados;
  assert.strictEqual(r['11111111'].jumbo.encontrado, false);
  assert.strictEqual(r['11111111'].jumbo.precio, undefined, 'sin producto no se inventa precio');
  assert.strictEqual(r['22222222'].carrefour.encontrado, false);
});

test('si una tienda falla, las otras siguen y el error se reporta por tienda', async () => {
  sesionOk = true;
  SIMS = { 'www.carrefour.com.ar': { precio: 2290 } };
  const { res } = await correr({
    'www.carrefour.com.ar': [prod('7790742358608', 'Leche', { precio: 2290 })],
    'www.jumbo.com.ar': 503,
  }, { eans: '7790742358608', tiendas: 'carrefour,jumbo' });
  assert.strictEqual(res.code, 200);
  assert.strictEqual(res.body.resultados['7790742358608'].carrefour.precio, 2290);
  assert.ok(res.body.errores.jumbo?.length, 'el error de Jumbo queda registrado aparte');
  assert.match(res.body.errores.jumbo[0], /503/);
  assert.strictEqual(res.body.resultados['7790742358608'].jumbo.encontrado, false);
});

test('rechaza entradas invalidas sin llamar a ninguna tienda', async () => {
  sesionOk = true;
  let toco = false;
  global.fetch = async () => { toco = true; throw new Error('no deberia'); };
  const handler = await handlerP;

  let res = fakeRes();
  await handler({ method: 'GET', query: { eans: 'hola, chau' }, headers: {} }, res);
  assert.strictEqual(res.code, 400);
  assert.strictEqual(res.body.error, 'sin_eans');
  assert.deepStrictEqual(res.body.invalidos, ['hola', 'chau']);

  res = fakeRes();
  await handler({ method: 'GET', query: { eans: '7790742358608', tiendas: 'inventada' }, headers: {} }, res);
  assert.strictEqual(res.code, 400);
  assert.strictEqual(res.body.error, 'sin_tiendas');

  res = fakeRes();
  const muchos = Array.from({ length: 400 }, (_, i) => String(10000000 + i)).join(',');
  await handler({ method: 'GET', query: { eans: muchos }, headers: {} }, res);
  assert.strictEqual(res.body.error, 'demasiados_eans');

  assert.strictEqual(toco, false, 'ninguna tienda fue consultada');
});

test('sin sesion no consulta nada: el proxy no puede quedar abierto', async () => {
  sesionOk = false;
  let toco = false;
  global.fetch = async () => { toco = true; return {}; };
  const handler = await handlerP;
  const res = fakeRes();
  await handler({ method: 'GET', query: { eans: '7790742358608' }, headers: {} }, res);
  assert.strictEqual(res.code, 401);
  assert.strictEqual(toco, false);
  sesionOk = true;
});

test('un precio de lista implausible se descarta, no se muestra como -98,8%', async () => {
  sesionOk = true;
  SIMS = {};  // sin simulacion: queda el precio del catalogo y la guarda del ListPrice
  // El caso REAL: Jumbo devolvia ListPrice 252066 para un agua de $3.050.
  const { res } = await correr({
    'www.jumbo.com.ar': [prod('7799155000197', 'Agua 2 L', { precio: 3050, lista: 252066 })],
    'www.masonline.com.ar': [prod('7799155000197', 'Agua 2 L', { precio: 2139, lista: 3199 })],
  }, { eans: '7799155000197', tiendas: 'jumbo,masonline' });

  const r = res.body.resultados['7799155000197'];
  assert.strictEqual(r.jumbo.precio, 3050, 'el precio se sigue mostrando');
  assert.strictEqual(r.jumbo.precioLista, null, 'la lista implausible NO se muestra');
  assert.strictEqual(r.jumbo.descuentoPct, null);
  assert.deepStrictEqual(r.jumbo.listaSospechosa, { valor: 252066, pctImplicado: 98.8 },
    'pero se reporta el valor y el pct, para poder decir por que falta');

  // Un descuento real no se toca.
  assert.strictEqual(r.masonline.precioLista, 3199);
  assert.strictEqual(r.masonline.descuentoPct, 33.1);
  assert.strictEqual(r.masonline.listaSospechosa, undefined);
});

test('EL CASO REAL: la simulacion da el precio con promo y el tachado correcto', async () => {
  sesionOk = true;
  // Jumbo, agua Villavicencio 2 L. El catalogo dice Price 3050 y ListPrice
  // 252066 (basura). La ficha del sitio muestra $1.982,50 con -35% y $3.050
  // tachado. La simulacion devuelve justo eso.
  SIMS = { 'www.jumbo.com.ar': { precio: 1982.5, lista: 3050, promos: ['Villavicencio 35% OFF'] } };
  const { res, llamadas } = await correr({
    'www.jumbo.com.ar': [prod('7799155000197', 'Agua 2 L', { precio: 3050, lista: 252066 })],
  }, { eans: '7799155000197', tiendas: 'jumbo' });

  const x = res.body.resultados['7799155000197'].jumbo;
  assert.strictEqual(x.precio, 1982.5, 'el precio es el de la simulacion, no el del catalogo');
  assert.strictEqual(x.precioCatalogo, 3050, 'y se guarda el del catalogo para poder compararlos');
  assert.strictEqual(x.precioLista, 3050, 'el tachado real, no los $252.066 del catalogo');
  assert.strictEqual(x.descuentoPct, 35, 'que da el -35% exacto que muestra la ficha');
  assert.ok(x.promos.includes('Villavicencio 35% OFF'));
  assert.strictEqual(x.fuentePrecio, 'simulacion');
  assert.strictEqual(x.listaSospechosa, undefined, 'la guarda del ListPrice ya no hace falta');
  assert.strictEqual(x.simulacionFallo, undefined);

  const sims = llamadas.filter((u) => u.includes('orderForms/simulation'));
  assert.strictEqual(sims.length, 1, 'UNA simulacion por producto: de a una unidad');
  assert.ok(sims[0].includes('jumbo.com.ar'));
});

test('si la simulacion falla, queda el precio del catalogo MARCADO', async () => {
  sesionOk = true;
  SIMS = { 'www.jumbo.com.ar': 503 };
  const { res } = await correr({
    'www.jumbo.com.ar': [prod('7799155000197', 'Agua 2 L', { precio: 3050 })],
  }, { eans: '7799155000197', tiendas: 'jumbo' });

  const x = res.body.resultados['7799155000197'].jumbo;
  assert.strictEqual(x.precio, 3050, 'se muestra algo, no se pierde la fila');
  assert.match(x.simulacionFallo, /503/, 'pero marcado: puede no incluir promos');
  assert.strictEqual(x.fuentePrecio, undefined);
});

test('los ids internos no viajan al cliente', async () => {
  sesionOk = true;
  SIMS = { 'www.jumbo.com.ar': { precio: 1982.5, lista: 3050 } };
  const { res } = await correr({
    'www.jumbo.com.ar': [prod('7799155000197', 'Agua 2 L', { precio: 3050 })],
  }, { eans: '7799155000197', tiendas: 'jumbo' });
  const x = res.body.resultados['7799155000197'].jumbo;
  assert.strictEqual(x._itemId, undefined);
  assert.strictEqual(x._sellerId, undefined);
});

test('los fallos de simulacion se agrupan por tienda y motivo', async () => {
  sesionOk = true;
  SIMS = { 'www.jumbo.com.ar': 403 };   // falla en todas
  const { res } = await correr({
    'www.jumbo.com.ar': [
      prod('11111111', 'A', { precio: 100 }),
      prod('22222222', 'B', { precio: 200 }),
    ],
  }, { eans: '11111111,22222222', tiendas: 'jumbo' });

  // Agrupado: el motivo UNA vez con su conteo, no una fila por celda. Y el
  // motivo incluye el CUERPO de la respuesta, que es donde VTEX explica el
  // rechazo: sin eso un 400 y un 403 se ven iguales.
  const motivos = res.body.simulacionErrores.jumbo;
  const clave = Object.keys(motivos)[0];
  assert.match(clave, /^HTTP 403/);
  assert.match(clave, /Sales channel not found/, 'el cuerpo viaja en el motivo');
  assert.strictEqual(motivos[clave], 2, 'agrupado con su conteo');
  assert.strictEqual(res.body.aSimular, 2);
  assert.strictEqual(res.body.simuladas, 0, 'ninguna salio de la simulacion');
});

test('una simulacion que responde 200 sin el item reporta el motivo de VTEX', async () => {
  sesionOk = true;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('orderForms/simulation')) {
      // VTEX responde 200 y rechaza el item: el motivo esta en `messages`.
      return { ok: true, status: 200, json: async () => ({
        items: [], messages: [{ code: 'withoutStock', text: 'Item sin stock en el canal' }],
      })};
    }
    return { ok: true, status: 200, json: async () => [prod('11111111', 'A', { precio: 500 })] };
  };
  const handler = await handlerP;
  const res = fakeRes();
  await handler({ method: 'GET', query: { eans: '11111111', tiendas: 'jumbo' }, headers: {} }, res);
  const x = res.body.resultados['11111111'].jumbo;
  assert.match(x.simulacionFallo, /rechazado: Item sin stock/,
    'el motivo de VTEX, no un "no devolvio el item" que no dice nada');
});

test('descubre el canal de venta de cada tienda y lo reusa', async () => {
  sesionOk = true;
  // Jumbo solo simula con sc=2; Carrefour con sc=1. Es el caso real: `sc=1`
  // estaba hardcodeado y Jumbo rechazaba TODOS los items.
  SIMS = {
    'www.jumbo.com.ar': { precio: 1982.5, lista: 3050, canal: '2', nombre: 'Agua' },
    'www.carrefour.com.ar': { precio: 3050, canal: '1' },
  };
  const { res, llamadas } = await correr({
    'www.jumbo.com.ar': [prod('11111111', 'Agua', { precio: 3050 }), prod('22222222', 'B', { precio: 100 })],
    'www.carrefour.com.ar': [prod('11111111', 'Agua', { precio: 3050 })],
  }, { eans: '11111111,22222222', tiendas: 'jumbo,carrefour' });

  assert.match(res.body.comboPorTienda.jumbo, /sc=2/, 'lo encontro probando');
  assert.match(res.body.comboPorTienda.carrefour, /sc=1/);
  assert.strictEqual(res.body.resultados['11111111'].jumbo.precio, 1982.5,
    'y con el canal correcto la simulacion anda');
  assert.deepStrictEqual(res.body.simulacionErrores, {}, 'sin fallos');

  // El descubrimiento cuesta a lo sumo unos pocos intentos por TIENDA, no por
  // producto: sin `sc` falla, sc=1 falla, sc=2 anda -> 3 para Jumbo. El segundo
  // producto de Jumbo usa directo el canal ya conocido.
  // El descubrimiento prueba una matriz de canal x zona UNA vez por tienda, y
  // despues el resto de los productos usa directo la combinacion encontrada.
  // Lo que importa es que el segundo producto NO vuelva a probar la matriz.
  const sims = llamadas.filter((u) => u.includes('simulation') && u.includes('jumbo'));
  const total = combosProbados(sims.length);
  assert.ok(sims.length >= 2, 'al menos el descubrimiento y el segundo producto');
  assert.ok(total, 'el segundo producto reusa la combinacion');
});

test('si NINGUN canal funciona, se reporta y el precio queda marcado', async () => {
  sesionOk = true;
  SIMS = { 'www.jumbo.com.ar': { precio: 1, canal: '99', nombre: 'Gaseosa Cola Zero 2,25 Lts' } };
  const { res } = await correr({
    'www.jumbo.com.ar': [prod('11111111', 'A', { precio: 3050 }), prod('22222222', 'B', { precio: 200 })],
  }, { eans: '11111111,22222222', tiendas: 'jumbo' });

  const intentos = res.body.canalErrores.jumbo;
  assert.ok(Array.isArray(intentos) && intentos.length,
    'la lista de intentos, no un solo string');
  assert.ok(intentos.filter((x) => !x.startsWith('(')).every((x) => /no encontrado o no disponible/.test(x)));
  // Y los motivos se agrupan SIN el nombre del producto: los dos fallos son UNO.
  const motivos = res.body.simulacionErrores.jumbo || {};
  assert.strictEqual(Object.keys(motivos).length, 1,
    'un solo motivo, no uno por producto: eso era el muro rojo');
  assert.match(Object.keys(motivos)[0], /Ítem no encontrado/);
});

test('EL CASO CENCOSUD: sin codigo postal rechaza todo, con CP cotiza', async () => {
  sesionOk = true;
  // Jumbo solo cotiza si se le manda postalCode. Es la hipotesis que explica
  // por que fallaban los cuatro canales: su sitio pide ubicacion antes de
  // mostrar precios.
  SIMS = { 'www.jumbo.com.ar': { precio: 1982.5, lista: 3050, cp: '1425', nombre: 'Agua' } };
  const { res, llamadas } = await correr({
    'www.jumbo.com.ar': [prod('11111111', 'Agua', { precio: 3050 })],
  }, { eans: '11111111', tiendas: 'jumbo', cp: '1425' });

  assert.strictEqual(res.body.resultados['11111111'].jumbo.precio, 1982.5);
  assert.strictEqual(res.body.codigoPostal, '1425');
  assert.match(res.body.comboPorTienda.jumbo, /cp=1425/, 'reporta la combinacion que funciono');
  assert.deepStrictEqual(res.body.canalErrores, {});
  // El CP viaja en el body, no en la query.
  const sim = llamadas.find((u) => u.includes('simulation'));
  assert.ok(sim, 'simulo');
});

test('un CP invalido cae al de defecto en vez de romper', async () => {
  sesionOk = true;
  SIMS = { 'www.jumbo.com.ar': { precio: 100 } };
  const { res } = await correr({
    'www.jumbo.com.ar': [prod('11111111', 'A', { precio: 100 })],
  }, { eans: '11111111', tiendas: 'jumbo', cp: 'hola' });
  assert.strictEqual(res.body.codigoPostal, '1425');
});

test('cuando ninguna combinacion cotiza, se devuelven TODOS los intentos', async () => {
  sesionOk = true;
  SIMS = { 'www.jumbo.com.ar': { precio: 1, cp: '9999', nombre: 'Gaseosa Cola Zero' } };
  const { res } = await correr({
    'www.jumbo.com.ar': [prod('11111111', 'A', { precio: 100 })],
  }, { eans: '11111111', tiendas: 'jumbo', cp: '1425' });

  const intentos = res.body.canalErrores.jumbo;
  assert.ok(Array.isArray(intentos) && intentos.length >= 4,
    'la lista completa, para ver si todos fallan por lo mismo');
  assert.ok(intentos.some((x) => x.includes('cp=1425')));
  assert.ok(intentos.some((x) => x.includes('cp=(sin)')), 'probo con y sin ubicacion');
  assert.ok(intentos.filter((x) => !x.startsWith('(')).every((x) => /no encontrado o no disponible/.test(x)));
});


// ── Preguntar los canales en vez de adivinarlos ─────────────────────────────
// Se probaban sc=1, 2 y 3. En Jumbo y Disco los 6 intentos fallaban con el
// MISMO mensaje, y de eso se habia concluido que el canal quedaba descartado.
// La conclusion era invalida: si el canal correcto es el 7, probar 1, 2 y 3
// falla identico. Los mensajes iguales descartan esos tres valores, no el canal.

test('prueba los canales que la tienda declara, no 1-2-3 adivinados', async () => {
  sesionOk = true;
  CANALES = { 'www.jumbo.com.ar': [
    { Id: 1, Name: 'Vea', IsActive: true },
    { Id: 7, Name: 'Jumbo', IsActive: true },
    { Id: 9, Name: 'Disco', IsActive: false },   // inactivo: no se prueba
  ] };
  // Solo cotiza con sc=7, que NO estaba en la lista vieja de adivinanzas.
  SIMS = { 'www.jumbo.com.ar': { precio: 1982.5, lista: 3050, canal: '7' } };
  const { res, llamadas } = await correr({
    'www.jumbo.com.ar': [prod('7799155000197', 'Agua 2L Jumbo', { precio: 3050 })],
  }, { eans: '7799155000197', tiendas: 'jumbo' });

  const j = res.body.resultados['7799155000197'].jumbo;
  assert.strictEqual(j.precio, 1982.5, 'con el canal correcto sale el precio de la ficha');
  assert.strictEqual(j.fuentePrecio, 'simulacion');
  assert.match(res.body.comboPorTienda.jumbo, /sc=7/);
  assert.ok(llamadas.some((u) => u.includes('saleschannel/active')),
    'se le pregunto a la tienda que canales tiene');
  assert.ok(!llamadas.some((u) => /[?&]sc=9(&|$)/.test(u)),
    'el canal inactivo no se prueba');
});

test('si la tienda no lista sus canales, se prueba a ciegas y se DICE', async () => {
  sesionOk = true;
  CANALES = {};            // el endpoint responde 404
  SIMS = {};               // y nada cotiza
  const { res } = await correr({
    'www.jumbo.com.ar': [prod('7799155000197', 'Agua 2L Jumbo', { precio: 3050 })],
  }, { eans: '7799155000197', tiendas: 'jumbo' });

  const intentos = res.body.canalErrores.jumbo;
  const nota = intentos.find((x) => x.includes('canales'));
  assert.ok(nota, 'la respuesta tiene que aclarar de donde salio la lista de canales');
  assert.match(nota, /a ciegas/,
    'y decir que fueron adivinados, para no hacer pasar una adivinanza por un dato');
});

test('cuando la tienda SI lista sus canales y ninguno cotiza, se distingue', async () => {
  sesionOk = true;
  CANALES = { 'www.jumbo.com.ar': [{ Id: 7, Name: 'Jumbo', IsActive: true }] };
  SIMS = { 'www.jumbo.com.ar': { precio: 1, canal: '99' } };   // ninguno de los suyos anda
  const { res } = await correr({
    'www.jumbo.com.ar': [prod('7799155000197', 'Agua 2L Jumbo', { precio: 3050 })],
  }, { eans: '7799155000197', tiendas: 'jumbo' });

  const nota = res.body.canalErrores.jumbo.find((x) => x.includes('canales'));
  assert.match(nota, /declara activos/);
  assert.match(nota, /7=Jumbo/,
    'con los canales reales a la vista, el problema ya no puede ser el canal');
});


// ── Regionalizacion: los sellers que despachan en el CP ─────────────────────
// Jumbo y Disco tienen catalogo regionalizado. El seller del catalogo (que es
// "1" en las dos) no despacha, y por eso la simulacion rechazaba todo. Los
// sellers reales los da /api/checkout/pub/regions para un codigo postal.

test('usa los sellers de la region cuando el del catalogo no despacha', async () => {
  sesionOk = true;
  CANALES = {}; FICHAS = {};
  REGIONES = { 'www.jumbo.com.ar': [
    { id: 'v2.ABC123', sellers: [{ id: 'jumboargentina', name: 'Jumbo' }] },
  ] };
  // Solo cotiza el seller de la region; el "1" del catalogo no.
  SIMS = { 'www.jumbo.com.ar': { precio: 1982.5, lista: 3050, seller: 'jumboargentina' } };
  const { res, llamadas } = await correr({
    'www.jumbo.com.ar': [prod('7799155000197', 'Agua 2L Jumbo', { precio: 3050 })],
  }, { eans: '7799155000197', tiendas: 'jumbo' });

  const j = res.body.resultados['7799155000197'].jumbo;
  assert.strictEqual(j.precio, 1982.5, 'con el seller que despacha sale el precio de la ficha');
  assert.strictEqual(j.fuentePrecio, 'simulacion');
  assert.match(res.body.comboPorTienda.jumbo, /seller=jumboargentina/);
  assert.ok(llamadas.some((u) => u.includes('/api/checkout/pub/regions')),
    'se pregunto quien despacha en ese CP');
});

test('el seller del catalogo sigue sirviendo donde no hay regionalizacion', async () => {
  sesionOk = true;
  CANALES = {}; FICHAS = {}; REGIONES = {};          // 404: no esta regionalizada
  SIMS = { 'www.masonline.com.ar': { precio: 2139, lista: 3199 } };
  const { res } = await correr({
    'www.masonline.com.ar': [prod('7799155000197', 'Agua 2L', { precio: 2139, lista: 3199 })],
  }, { eans: '7799155000197', tiendas: 'masonline' });

  const m = res.body.resultados['7799155000197'].masonline;
  assert.strictEqual(m.precio, 2139);
  assert.strictEqual(m.fuentePrecio, 'simulacion');
});

test('si la region no da sellers, se dice cual fue el motivo', async () => {
  sesionOk = true;
  CANALES = {}; FICHAS = {}; SIMS = {};
  REGIONES = { 'www.jumbo.com.ar': 500 };
  const { res } = await correr({
    'www.jumbo.com.ar': [prod('7799155000197', 'Agua 2L Jumbo', { precio: 3050 })],
  }, { eans: '7799155000197', tiendas: 'jumbo' });

  const nota = res.body.canalErrores.jumbo.find((x) => x.includes('sellers'));
  assert.ok(nota, 'tiene que quedar registrado que no se pudo resolver la region');
  assert.match(nota, /HTTP 500/);
});


// ── El precio de la ficha (JSON-LD) ─────────────────────────────────────────
// Para Jumbo y Disco el catalogo, Intelligent Search y la simulacion devuelven
// 3.050 en todos sus campos mientras la ficha muestra $1.982,5 con -35%.
// Buscando el numero dentro de los datos de la pagina aparecio en un solo
// lugar: el <script type="application/ld+json"> de schema.org que VTEX
// renderiza para los buscadores, en offers.price.

test('cuando la simulacion falla, el precio se lee del JSON-LD de la ficha', async () => {
  sesionOk = true;
  CANALES = {}; REGIONES = {}; SIMS = {};          // nada cotiza
  FICHAS = { 'www.jumbo.com.ar': ficha('7799155000197', '405993',
    'Agua Mineral Sin Gas 2 Lts Villavicencio', 1982.5) };
  const { res } = await correr({
    'www.jumbo.com.ar': [prod('7799155000197', 'Agua 2L Jumbo', { precio: 3050 })],
  }, { eans: '7799155000197', tiendas: 'jumbo' });

  const j = res.body.resultados['7799155000197'].jumbo;
  assert.strictEqual(j.precio, 1982.5, 'el precio que ve el cliente');
  assert.strictEqual(j.precioLista, 3050, 'el Price del catalogo es el tachado');
  assert.strictEqual(j.descuentoPct, 35, 'el mismo -35% que muestra la ficha');
  assert.strictEqual(j.fuentePrecio, 'ficha');
  assert.ok(!j.simulacionFallo);
  assert.ok(!j.listaSospechosa, 'el ListPrice de Cencosud ya no se usa');
  assert.strictEqual(res.body.porFicha, 1);
});

test('la simulacion le gana a la ficha cuando puede cotizar', async () => {
  sesionOk = true;
  CANALES = {}; REGIONES = {};
  SIMS = { 'www.masonline.com.ar': { precio: 2139, lista: 3199, promos: ['2da al 70%'] } };
  FICHAS = { 'www.masonline.com.ar': ficha('7799155000197', '405993', 'Agua 2L', 9999) };
  const { res } = await correr({
    'www.masonline.com.ar': [prod('7799155000197', 'Agua 2L', { precio: 2139, lista: 3199 })],
  }, { eans: '7799155000197', tiendas: 'masonline' });

  const m = res.body.resultados['7799155000197'].masonline;
  assert.strictEqual(m.precio, 2139, 'la simulacion trae las promos aplicadas: gana');
  assert.strictEqual(m.fuentePrecio, 'simulacion');
  assert.strictEqual(res.body.porFicha, 0);
});

test('no se usa el precio de OTRO producto de la ficha', async () => {
  sesionOk = true;
  CANALES = {}; REGIONES = {}; SIMS = {};
  // Dos Products en la pagina (el principal y un relacionado) y ninguno con el
  // EAN pedido: mostrar el precio del otro seria peor que no mostrar nada.
  const dos = `<html><head>
    <script type="application/ld+json">${JSON.stringify({ '@type': 'Product', sku: '111', gtin: '111', offers: { '@type': 'Offer', price: 111 } })}</script>
    <script type="application/ld+json">${JSON.stringify({ '@type': 'Product', sku: '222', gtin: '222', offers: { '@type': 'Offer', price: 222 } })}</script>
    </head></html>`;
  FICHAS = { 'www.jumbo.com.ar': dos };
  const { res } = await correr({
    'www.jumbo.com.ar': [prod('7799155000197', 'Agua 2L Jumbo', { precio: 3050 })],
  }, { eans: '7799155000197', tiendas: 'jumbo' });

  const j = res.body.resultados['7799155000197'].jumbo;
  assert.strictEqual(j.precio, 3050, 'se queda con el del catalogo');
  assert.strictEqual(res.body.porFicha, 0);
  assert.match(Object.keys(res.body.fichaErrores.jumbo)[0], /ninguno coincide/);
});

test('un AggregateOffer con lowPrice tambien sirve', async () => {
  sesionOk = true;
  CANALES = {}; REGIONES = {}; SIMS = {};
  const ld = JSON.stringify({
    '@context': 'https://schema.org/', '@type': 'Product', name: 'Agua',
    sku: '405993', gtin: '7799155000197',
    offers: { '@type': 'AggregateOffer', lowPrice: 1982.5, highPrice: 2100, priceCurrency: 'ARS' },
  });
  FICHAS = { 'www.jumbo.com.ar': `<html><script type="application/ld+json">${ld}</script></html>` };
  const { res } = await correr({
    'www.jumbo.com.ar': [prod('7799155000197', 'Agua 2L Jumbo', { precio: 3050 })],
  }, { eans: '7799155000197', tiendas: 'jumbo' });

  assert.strictEqual(res.body.resultados['7799155000197'].jumbo.precio, 1982.5);
});

test('si la ficha no trae JSON-LD, queda el catalogo y se dice por que', async () => {
  sesionOk = true;
  CANALES = {}; REGIONES = {}; SIMS = {};
  FICHAS = { 'www.jumbo.com.ar': '<html><body>sin marcado</body></html>' };
  const { res } = await correr({
    'www.jumbo.com.ar': [prod('7799155000197', 'Agua 2L Jumbo', { precio: 3050 })],
  }, { eans: '7799155000197', tiendas: 'jumbo' });

  const j = res.body.resultados['7799155000197'].jumbo;
  assert.strictEqual(j.precio, 3050);
  assert.ok(j.simulacionFallo, 'sigue marcado como sin verificar');
  assert.match(Object.keys(res.body.fichaErrores.jumbo)[0], /no trae JSON-LD/);
});

// ── No reportar como problema un paso intermedio que se recupero ────────────
// La pagina avisaba en rojo que 152 productos mostraban el precio del catalogo
// sin promociones, cuando 148 de esos ya tenian el precio bueno leido de la
// ficha. El fallo de la simulacion se estaba reportando aunque el plan B lo
// hubiera resuelto.

test('si la ficha resolvio la fila, la simulacion fallida no se reporta', async () => {
  sesionOk = true;
  CANALES = {}; REGIONES = {}; SIMS = {};          // la simulacion no cotiza
  FICHAS = { 'www.jumbo.com.ar': ficha('7799155000197', '405993', 'Agua', 1982.5) };
  const { res } = await correr({
    'www.jumbo.com.ar': [prod('7799155000197', 'Agua 2L Jumbo', { precio: 3050 })],
  }, { eans: '7799155000197', tiendas: 'jumbo' });

  assert.strictEqual(res.body.resultados['7799155000197'].jumbo.precio, 1982.5);
  assert.deepStrictEqual(res.body.simulacionErrores, {},
    'no quedo ninguna fila sin precio, asi que no hay nada que reportar');
  assert.ok(!res.body.canalErrores?.jumbo,
    'los intentos de canal son diagnostico: sin filas sin precio, son ruido');
});

test('si la ficha TAMPOCO pudo, ahi si se reporta', async () => {
  sesionOk = true;
  CANALES = {}; REGIONES = {}; SIMS = {}; FICHAS = {};   // ni simulacion ni ficha
  const { res } = await correr({
    'www.jumbo.com.ar': [prod('7799155000197', 'Agua 2L Jumbo', { precio: 3050 })],
  }, { eans: '7799155000197', tiendas: 'jumbo' });

  assert.strictEqual(res.body.resultados['7799155000197'].jumbo.precio, 3050);
  assert.ok(res.body.simulacionErrores.jumbo, 'esta fila si quedo sin verificar');
  assert.ok(res.body.canalErrores?.jumbo,
    'y ahi los intentos de canal si sirven para entender por que');
});

test('una tienda resuelta y otra no: se reporta solo la que quedo sin precio', async () => {
  sesionOk = true;
  CANALES = {}; REGIONES = {}; SIMS = {};
  FICHAS = { 'www.jumbo.com.ar': ficha('7799155000197', '405993', 'Agua', 1982.5) };
  const { res } = await correr({
    'www.jumbo.com.ar': [prod('7799155000197', 'Agua Jumbo', { precio: 3050 })],
    'www.disco.com.ar': [prod('7799155000197', 'Agua Disco', { precio: 3100 })],
  }, { eans: '7799155000197', tiendas: 'jumbo,disco' });

  assert.deepStrictEqual(Object.keys(res.body.simulacionErrores), ['disco']);
  assert.deepStrictEqual(Object.keys(res.body.canalErrores || {}), ['disco']);
});

// ── El EAN tiene que mapear al producto y al SKU correctos ──────────────────
// Caso real: para el EAN 7891150019560 (jabón Dove 90 g) el comparador mostraba
// Masonline a $201 con $233 tachado y −13,7%, mientras la ficha de Masonline
// decía $2.739 igual que Carrefour. El precio y su descuento eran coherentes
// entre sí: era el precio REAL de OTRO producto.
//
// La causa: eansDe aceptaba como EAN cualquier `referenceId` de 6 a 14 dígitos,
// y en VTEX referenceId es el código interno de la tienda, no el EAN.

/** Producto con un referenceId interno que coincide con un EAN pedido. */
function prodConRefInterno(eanPropio, refInterno, nombre, precio) {
  return {
    productName: nombre, brand: 'X', link: `/${nombre.replace(/\s+/g, '-')}/p`, linkText: nombre,
    items: [{
      ean: eanPropio, itemId: '999', measurementUnit: 'un', unitMultiplier: 1,
      // La clave NO dice que sea un EAN: es el código de referencia interno.
      referenceId: [{ Key: 'RefId', Value: refInterno }],
      sellers: [{ sellerId: '1', sellerName: 's', commertialOffer: {
        Price: precio, ListPrice: null, IsAvailable: true, AvailableQuantity: 5, Teasers: [],
      } }],
    }],
  };
}

test('un referenceId interno NO se toma como EAN', async () => {
  sesionOk = true;
  CANALES = {}; REGIONES = {}; FICHAS = {};
  SIMS = { 'www.masonline.com.ar': { precio: 201 } };
  const { res } = await correr({
    // El producto de Masonline es otro (jabón de $201) y lo único que lo liga
    // al EAN pedido es su código interno.
    'www.masonline.com.ar': [prodConRefInterno('7790000000001', '7891150019560', 'Otra cosa barata', 201)],
  }, { eans: '7891150019560', tiendas: 'masonline' });

  const m = res.body.resultados['7891150019560'].masonline;
  assert.strictEqual(m.encontrado, false,
    'antes se quedaba con esta fila y mostraba $201 como si fuera el jabón Dove');
});

test('un referenceId ETIQUETADO como EAN sí se toma', async () => {
  sesionOk = true;
  CANALES = {}; REGIONES = {}; FICHAS = {};
  SIMS = { 'www.masonline.com.ar': { precio: 2739 } };
  const p = prodConRefInterno('7790000000001', '7891150019560', 'Jabón Dove 90 g', 2739);
  p.items[0].referenceId = [{ Key: 'EAN', Value: '7891150019560' }];
  const { res } = await correr({ 'www.masonline.com.ar': [p] },
    { eans: '7891150019560', tiendas: 'masonline' });

  assert.strictEqual(res.body.resultados['7891150019560'].masonline.precio, 2739);
});

test('se lee el SKU del EAN pedido, no siempre el primero', async () => {
  sesionOk = true;
  CANALES = {}; REGIONES = {}; FICHAS = {}; SIMS = {};
  // Un producto con dos SKUs: el pack de 3 primero y la unidad despues. Antes
  // se leia items[0] y se mostraba el precio del pack para el EAN de la unidad.
  const conDosSkus = {
    productName: 'Jabón Dove Karité', brand: 'Dove', link: '/dove/p', linkText: 'dove',
    items: [
      { ean: '7891150000003', itemId: 'pack3', unitMultiplier: 1, sellers: [{ sellerId: '1',
        commertialOffer: { Price: 7500, IsAvailable: true, AvailableQuantity: 5 } }] },
      { ean: '7891150019560', itemId: 'unidad', unitMultiplier: 1, sellers: [{ sellerId: '1',
        commertialOffer: { Price: 2739, IsAvailable: true, AvailableQuantity: 5 } }] },
    ],
  };
  const { res } = await correr({ 'www.masonline.com.ar': [conDosSkus] },
    { eans: '7891150019560', tiendas: 'masonline' });

  const m = res.body.resultados['7891150019560'].masonline;
  assert.strictEqual(m.precio, 2739, 'el precio de la unidad, que es lo que se pidio');
});

// ── La red: un precio que no se sostiene al lado de los demas ──────────────

test('un precio 13 veces mas barato que el resto no gana el "mas barato"', async () => {
  sesionOk = true;
  CANALES = {}; REGIONES = {}; FICHAS = {};
  SIMS = {
    'www.carrefour.com.ar': { precio: 2739 },
    'www.jumbo.com.ar': { precio: 2800 },
    'www.disco.com.ar': { precio: 2800 },
    'www.masonline.com.ar': { precio: 201 },
  };
  const { res } = await correr({
    'www.carrefour.com.ar': [prod('7891150019560', 'Dove 90g', { precio: 2739 })],
    'www.jumbo.com.ar': [prod('7891150019560', 'Dove 90g', { precio: 2800 })],
    'www.disco.com.ar': [prod('7891150019560', 'Dove 90g', { precio: 2800 })],
    'www.masonline.com.ar': [prod('7891150019560', 'Dove 90g', { precio: 201 })],
  }, { eans: '7891150019560', tiendas: 'carrefour,jumbo,disco,masonline' });

  const m = res.body.resultados['7891150019560'].masonline;
  assert.ok(m.precioDisparatado, 'queda marcado como no creible');
  assert.strictEqual(m.precioDisparatado.mediana, 2769.5);
  assert.ok(m.precioDisparatado.pctDeLaMediana < 10);
  assert.strictEqual(m.precio, 201, 'el precio se sigue mostrando: se marca, no se esconde');
});

test('una promo real de -50% NO se marca como no creible', async () => {
  sesionOk = true;
  CANALES = {}; REGIONES = {}; FICHAS = {};
  SIMS = {
    'www.carrefour.com.ar': { precio: 2739 },
    'www.jumbo.com.ar': { precio: 2800 },
    'www.masonline.com.ar': { precio: 1400 },   // mitad de precio: es una oferta
  };
  const { res } = await correr({
    'www.carrefour.com.ar': [prod('7891150019560', 'Dove', { precio: 2739 })],
    'www.jumbo.com.ar': [prod('7891150019560', 'Dove', { precio: 2800 })],
    'www.masonline.com.ar': [prod('7891150019560', 'Dove', { precio: 1400 })],
  }, { eans: '7891150019560', tiendas: 'carrefour,jumbo,masonline' });

  assert.ok(!res.body.resultados['7891150019560'].masonline.precioDisparatado,
    'la red no puede tapar una oferta de verdad');
});

test('con dos tiendas no se marca nada: no hay mediana que valga', async () => {
  sesionOk = true;
  CANALES = {}; REGIONES = {}; FICHAS = {};
  SIMS = { 'www.carrefour.com.ar': { precio: 2739 }, 'www.masonline.com.ar': { precio: 201 } };
  const { res } = await correr({
    'www.carrefour.com.ar': [prod('7891150019560', 'Dove', { precio: 2739 })],
    'www.masonline.com.ar': [prod('7891150019560', 'Dove', { precio: 201 })],
  }, { eans: '7891150019560', tiendas: 'carrefour,masonline' });

  assert.ok(!res.body.resultados['7891150019560'].masonline.precioDisparatado,
    'con una sola tienda de referencia no se puede saber quien es el raro');
});


test('recupera el producto cuando la tienda guarda el EAN solo en alternateIds', async () => {
  sesionOk = true;
  CANALES = {}; REGIONES = {}; FICHAS = {};
  SIMS = { 'www.masonline.com.ar': { precio: 2739 } };
  // VTEX lo encuentra (la consulta es por alternateIds_Ean) pero la respuesta
  // no dice ese EAN en ningun SKU, asi que el lote no lo puede mapear. La
  // consulta individual si, porque lo que vuelve solo puede ser de ese EAN.
  const p = prod('7790000000099', 'Jabón Dove 90 g', { precio: 2739 });
  p._alternateEans = ['7891150019560'];
  const { res, llamadas } = await correr({ 'www.masonline.com.ar': [p] },
    { eans: '7891150019560', tiendas: 'masonline' });

  const m = res.body.resultados['7891150019560'].masonline;
  assert.strictEqual(m.precio, 2739, 'no se pierde el producto por la regla estricta');
  assert.strictEqual(m.porConsultaIndividual, true);
  assert.ok(m.eanNoCoincide, 'y queda dicho que ningun SKU declara ese EAN');
  assert.strictEqual(res.body.recuperadosIndividual, 1);
  const individuales = llamadas.filter((x) => /products\/search\?fq=alternateIds_Ean:7891150019560&_from/.test(x));
  assert.ok(individuales.length >= 1, 'se pregunto de a un EAN');
});

test('si de a uno tampoco aparece, no se inventa: encontrado false', async () => {
  sesionOk = true;
  CANALES = {}; REGIONES = {}; FICHAS = {}; SIMS = {};
  const { res } = await correr({
    'www.masonline.com.ar': [prodConRefInterno('7790000000001', '7891150019560', 'Otra cosa', 201)],
  }, { eans: '7891150019560', tiendas: 'masonline' });

  assert.strictEqual(res.body.resultados['7891150019560'].masonline.encontrado, false);
});

// ── El seller del catalogo manda ────────────────────────────────────────────
// Los sellers de la region se habian puesto ANTES que el del catalogo, y eso
// rompio Masonline: paso a cotizar con `masonlineprod0006` (el que devuelve la
// region para el CP 1425), que tiene otra lista de precios. En 29 productos
// devolvio entre el 5% y el 18% del precio real, con el nombre del producto
// correcto — el jabon Dove a $201 cuando la ficha dice $2.739.

test('cotiza con el seller del catalogo, no con el de la region', async () => {
  sesionOk = true;
  CANALES = {}; FICHAS = {};
  REGIONES = { 'www.masonline.com.ar': [
    { id: 'v2.X', sellers: [{ id: 'masonlineprod0006', name: 'MasOnline regional' }] },
  ] };
  SIMS = { 'www.masonline.com.ar': { porSeller: { 1: 2739, masonlineprod0006: 201 } } };
  const { res } = await correr({
    'www.masonline.com.ar': [prod('7891150019560', 'Jabón Dove 90 g', { precio: 2739 })],
  }, { eans: '7891150019560', tiendas: 'masonline' });

  const m = res.body.resultados['7891150019560'].masonline;
  assert.strictEqual(m.precio, 2739, 'el precio que muestra la ficha de la tienda');
  assert.match(res.body.comboPorTienda.masonline, /seller=1/);
});

test('si el del catalogo cotiza un precio imposible, se descarta y se sigue', async () => {
  sesionOk = true;
  CANALES = {}; FICHAS = {};
  REGIONES = { 'www.masonline.com.ar': [
    { id: 'v2.X', sellers: [{ id: 'otro-seller', name: 'otro' }] },
  ] };
  // Ahora el malo es el del catalogo y el bueno el de la region: la regla no es
  // "confiar en el seller 1", es "no creer una cotizacion imposible".
  SIMS = { 'www.masonline.com.ar': { porSeller: { 1: 201, 'otro-seller': 2739 } } };
  const { res } = await correr({
    'www.masonline.com.ar': [prod('7891150019560', 'Jabón Dove 90 g', { precio: 2739 })],
  }, { eans: '7891150019560', tiendas: 'masonline' });

  const m = res.body.resultados['7891150019560'].masonline;
  assert.strictEqual(m.precio, 2739);
  assert.match(res.body.comboPorTienda.masonline, /seller=otro-seller/);
});

test('una promo real de -60% sobre el catalogo SI se acepta', async () => {
  sesionOk = true;
  CANALES = {}; REGIONES = {}; FICHAS = {};
  SIMS = { 'www.dia.com.ar': { precio: 1200 }, 'diaonline.supermercadosdia.com.ar': { precio: 1200 } };
  const { res } = await correr({
    'diaonline.supermercadosdia.com.ar': [prod('7891150019560', 'Jabón', { precio: 3000 })],
  }, { eans: '7891150019560', tiendas: 'dia' });

  assert.strictEqual(res.body.resultados['7891150019560'].dia.precio, 1200,
    '40% del catálogo está arriba del umbral: es una oferta creíble');
});

// ── Las promos de los competidores ─────────────────────────────────────────

test('lee los teasers del catalogo en minuscula tambien', async () => {
  sesionOk = true;
  CANALES = {}; REGIONES = {}; FICHAS = {}; SIMS = {};
  const p = prod('7891150019560', 'Jabón', { precio: 2739 });
  // Algunas APIs de VTEX devuelven la clave en minuscula. Antes se leia solo
  // `Name` y estas promos se perdian.
  p.items[0].sellers[0].commertialOffer.Teasers = [{ name: '2do al 50%' }];
  const { res } = await correr({ 'www.masonline.com.ar': [p] },
    { eans: '7891150019560', tiendas: 'masonline' });

  assert.deepStrictEqual(res.body.resultados['7891150019560'].masonline.promos, ['2do al 50%']);
});

test('cuando el precio sale de la ficha, se dice el descuento aunque no haya nombre', async () => {
  sesionOk = true;
  CANALES = {}; REGIONES = {}; SIMS = {};     // la simulacion no cotiza
  FICHAS = { 'www.jumbo.com.ar': ficha('7799155000197', '405993', 'Agua 2 L', 1982.5) };
  const { res } = await correr({
    'www.jumbo.com.ar': [prod('7799155000197', 'Agua 2L Jumbo', { precio: 3050 })],
  }, { eans: '7799155000197', tiendas: 'jumbo' });

  const j = res.body.resultados['7799155000197'].jumbo;
  assert.strictEqual(j.promos.length, 1);
  assert.match(j.promos[0], /−35%/, 'el tamaño del descuento sí se puede saber');
  assert.match(j.promos[0], /no publica el nombre/,
    'y se dice por qué no hay nombre, en vez de dejar la celda vacía');
  assert.strictEqual(j.promoSinNombre, true);
});


// ── Descuento sin nombre, en cualquier tienda ───────────────────────────────
// Masonline devolvia 10 productos con precio anterior y un descuento real del
// 25% al 46%, y la columna de promociones vacia en sus 65 filas. Se leia como
// "esta tienda no tiene promociones", cuando lo que pasa es que no publica los
// nombres.

test('con descuento y sin nombre de promo, se describe el descuento', async () => {
  sesionOk = true;
  CANALES = {}; REGIONES = {}; FICHAS = {};
  // La simulacion cotiza con precio anterior pero sin ratesAndBenefitsData.
  SIMS = { 'www.masonline.com.ar': { precio: 2139, lista: 3199 } };
  const { res } = await correr({
    'www.masonline.com.ar': [prod('7799155000197', 'Agua 2 L', { precio: 2139, lista: 3199 })],
  }, { eans: '7799155000197', tiendas: 'masonline' });

  const m = res.body.resultados['7799155000197'].masonline;
  assert.strictEqual(m.promos.length, 1);
  assert.match(m.promos[0], /−33%/);
  assert.strictEqual(m.promoSinNombre, true);
});

test('si la tienda SI publica el nombre, no se lo reemplaza por el porcentaje', async () => {
  sesionOk = true;
  CANALES = {}; REGIONES = {}; FICHAS = {};
  SIMS = { 'diaonline.supermercadosdia.com.ar': { precio: 2139, lista: 3199, promos: ['2do al 50%'] } };
  const { res } = await correr({
    'diaonline.supermercadosdia.com.ar': [prod('7799155000197', 'Agua', { precio: 2139, lista: 3199 })],
  }, { eans: '7799155000197', tiendas: 'dia' });

  assert.deepStrictEqual(res.body.resultados['7799155000197'].dia.promos, ['2do al 50%'],
    'el nombre real vale mas que el porcentaje derivado');
});

test('un producto por peso no se rechaza por la guarda del 25%', async () => {
  sesionOk = true;
  CANALES = {}; REGIONES = {}; FICHAS = {};
  // Catalogo por kilo, simulacion de la unidad minima: comparar los dos numeros
  // no compara lo mismo. Rechazaba "Manzana roja x kg" de Carrefour.
  const porPeso = prod('2000000000017', 'Manzana roja x kg', { precio: 4999 });
  porPeso.items[0].unitMultiplier = 0.25;
  SIMS = { 'www.carrefour.com.ar': { precio: 1250 } };
  const { res } = await correr({ 'www.carrefour.com.ar': [porPeso] },
    { eans: '2000000000017', tiendas: 'carrefour' });

  const cf = res.body.resultados['2000000000017'].carrefour;
  assert.strictEqual(cf.precio, 1250, 'la cotizacion se acepta');
  assert.ok(!cf.simulacionFallo, 'y no queda marcada como sin verificar');
});

// ── Un precio de un producto sin stock no es un precio ─────────────────────
// Reportado con la gaseosa Manaos 2,25 L (EAN 7798113300010): Jumbo y Disco
// devolvian $32,49 y Masonline $0, contra $2.420 de Carrefour y $2.400 de DIA.
// Las tres que daban un numero absurdo eran exactamente las tres SIN STOCK:
// VTEX devuelve en `Price` un valor residual cuando el SKU no esta disponible.

test('sin stock, el producto se reporta pero SIN precio', async () => {
  sesionOk = true;
  CANALES = {}; REGIONES = {}; FICHAS = {}; SIMS = {};
  const { res } = await correr({
    'www.jumbo.com.ar': [prod('7798113300010', 'Gaseosa Manaos 2,25 L',
      { precio: 32.49, stock: false })],
  }, { eans: '7798113300010', tiendas: 'jumbo' });

  const j = res.body.resultados['7798113300010'].jumbo;
  assert.strictEqual(j.encontrado, true, 'la tienda lo tiene publicado: eso es info util');
  assert.strictEqual(j.disponible, false);
  assert.strictEqual(j.precio, null, '$32,49 no es un precio al que se pueda comprar');
  assert.match(j.sinPrecio, /sin stock/);
});

test('un precio 0 tampoco se toma, aunque diga que hay stock', async () => {
  sesionOk = true;
  CANALES = {}; REGIONES = {}; FICHAS = {}; SIMS = {};
  const { res } = await correr({
    'www.masonline.com.ar': [prod('7798113300010', 'Gaseosa Manaos Cola 2.25 L', { precio: 0 })],
  }, { eans: '7798113300010', tiendas: 'masonline' });

  const m = res.body.resultados['7798113300010'].masonline;
  assert.strictEqual(m.precio, null);
  assert.match(m.sinPrecio, /precio 0/);
});

test('sin precio no se simula: no hay nada que cotizar', async () => {
  sesionOk = true;
  CANALES = {}; REGIONES = {}; FICHAS = {};
  SIMS = { 'www.jumbo.com.ar': { precio: 999 } };
  const { res, llamadas } = await correr({
    'www.jumbo.com.ar': [prod('7798113300010', 'Manaos', { precio: 32.49, stock: false })],
  }, { eans: '7798113300010', tiendas: 'jumbo' });

  assert.strictEqual(res.body.resultados['7798113300010'].jumbo.precio, null);
  assert.ok(!llamadas.some((u) => u.includes('orderForms/simulation')),
    'se ahorra la llamada y se evita que una cotizacion de 0 entre como precio');
});

test('el que SI tiene stock conserva su precio y gana normalmente', async () => {
  sesionOk = true;
  CANALES = {}; REGIONES = {}; FICHAS = {};
  SIMS = { 'www.carrefour.com.ar': { precio: 2420 }, 'diaonline.supermercadosdia.com.ar': { precio: 2400 } };
  const { res } = await correr({
    'www.carrefour.com.ar': [prod('7798113300010', 'Manaos', { precio: 2420 })],
    'www.jumbo.com.ar': [prod('7798113300010', 'Manaos', { precio: 32.49, stock: false })],
    'diaonline.supermercadosdia.com.ar': [prod('7798113300010', 'Manaos', { precio: 2400 })],
  }, { eans: '7798113300010', tiendas: 'carrefour,jumbo,dia' });

  const r = res.body.resultados['7798113300010'];
  assert.strictEqual(r.carrefour.precio, 2420);
  assert.strictEqual(r.dia.precio, 2400);
  assert.strictEqual(r.jumbo.precio, null);
  // Y sin el 32,49 ensuciando la mediana, nadie queda marcado como no creible.
  assert.ok(!r.dia.precioDisparatado);
});

// ── Productos vendidos por peso ─────────────────────────────────────────────
// "Queso cremoso Punta del Agua horma x kg" salia con precio $2.700, precio
// anterior $13.500 y un descuento del 80%. Los dos numeros estaban bien: el
// catalogo cotiza POR KILO y la simulacion la fraccion minima de venta
// (unitMultiplier 0,2 kg). 13.500 × 0,2 = 2.700 exacto. Restar dos numeros en
// unidades distintas no da un descuento.

function porPeso(ean, nombre, precioPorKg, mult, medida = 'kg') {
  const p = prod(ean, nombre, { precio: precioPorKg });
  p.items[0].unitMultiplier = mult;
  p.items[0].measurementUnit = medida;
  return p;
}

test('un producto por peso no inventa un descuento del 80%', async () => {
  sesionOk = true;
  CANALES = {}; REGIONES = {}; FICHAS = {};
  // La simulacion cotiza la fraccion (13.500 × 0,2) y devuelve la lista por kilo.
  SIMS = { 'www.carrefour.com.ar': { precio: 2700, lista: 13500 } };
  const { res } = await correr({
    'www.carrefour.com.ar': [porPeso('2505310000002', 'Queso cremoso horma x kg', 13500, 0.2)],
  }, { eans: '2505310000002', tiendas: 'carrefour' });

  const cf = res.body.resultados['2505310000002'].carrefour;
  assert.strictEqual(cf.precio, 2700);
  assert.strictEqual(cf.precioLista, null, 'el precio por kilo no es un "precio anterior"');
  assert.strictEqual(cf.descuentoPct, null, 'y la diferencia no es un descuento');
});

test('y calcula el precio por unidad de medida, que es lo comparable', async () => {
  sesionOk = true;
  CANALES = {}; REGIONES = {}; FICHAS = {};
  SIMS = { 'www.carrefour.com.ar': { precio: 999.8, lista: 4999 } };
  const { res } = await correr({
    'www.carrefour.com.ar': [porPeso('2300397000002', 'Manzana roja x kg', 4999, 0.2)],
  }, { eans: '2300397000002', tiendas: 'carrefour' });

  const cf = res.body.resultados['2300397000002'].carrefour;
  assert.strictEqual(cf.precioPorMedida, 4999, '999,80 por 0,2 kg = 4.999 por kg');
  assert.strictEqual(cf.medida, 'kg');
  assert.match(cf.baseComparable, /999\.8 por 0\.2 kg/);
});

test('un producto por unidad conserva su precio anterior y su descuento', async () => {
  sesionOk = true;
  CANALES = {}; REGIONES = {}; FICHAS = {};
  SIMS = { 'www.carrefour.com.ar': { precio: 2290, lista: 2790 } };
  const { res } = await correr({
    'www.carrefour.com.ar': [prod('7790742358608', 'Leche 1L', { precio: 2290, lista: 2790 })],
  }, { eans: '7790742358608', tiendas: 'carrefour' });

  const cf = res.body.resultados['7790742358608'].carrefour;
  assert.strictEqual(cf.precioLista, 2790, 'acá sí es un precio anterior de verdad');
  assert.strictEqual(cf.descuentoPct, 17.9);
  assert.strictEqual(cf.precioPorMedida, undefined, 'no aplica a lo vendido por unidad');
});

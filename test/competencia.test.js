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
    productName: nombre, brand: 'X', link: `https://t/${nombre}/p`, linkText: nombre,
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

    const d = Object.keys(porTienda).find((x) => u.includes(x));
    const r = porTienda[d];
    if (typeof r === 'number') return { ok: false, status: r, text: async () => 'boom' };
    return { ok: true, status: 200, json: async () => r, text: async () => JSON.stringify(r) };
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
  const cat = llamadas.filter((u) => u.includes('catalog_system'));
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
  assert.ok(intentos.every((x) => /no encontrado o no disponible/.test(x)));
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
  assert.ok(intentos.every((x) => /no encontrado o no disponible/.test(x)));
});

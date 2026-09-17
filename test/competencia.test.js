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
    items: [{ ean, measurementUnit: 'un', unitMultiplier: 1, sellers: [{
      sellerName: 'seller', commertialOffer: {
        Price: precio, ListPrice: lista, IsAvailable: stock, AvailableQuantity: stock ? 5 : 0,
        Teasers: promos.map((n) => ({ Name: n })),
      } }] }],
  };
}

function fakeRes() {
  return { code: 200, body: null, headers: {},
    status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[k] = v; } };
}

async function correr(porTienda, query) {
  const llamadas = [];
  global.fetch = async (url) => {
    const u = String(url);
    llamadas.push(u);
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
  assert.ok(llamadas.every((u) => u.includes('fq=alternateIds_Ean')));
});

test('sin lista o con lista menor al precio, no se inventa un descuento', async () => {
  sesionOk = true;
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

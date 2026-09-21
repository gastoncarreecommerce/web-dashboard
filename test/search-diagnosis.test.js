'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Se cargan las funciones internas del diagnostico. El modulo no las exporta
// (es un script), asi que se lee el archivo y se evalua en un contexto propio:
// alcanza para probar las decisiones puras, que es lo que importa aca.
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'inspect-search-diagnosis.js'), 'utf8');
const ctx = {
  module: { exports: {} }, exports: {}, console, process,
  require: (x) => (x === './search-engines'
    ? { motoresActivos: () => ({ activos: [], omitidos: [] }), vtexCorrection: async () => null, vtexBase: () => 'https://t' }
    : x === './search-relevance-ai' ? { activo: () => false } : require(x)),
  __dirname: path.join(__dirname, '..', 'src'), fetch: async () => { throw new Error('sin red'); },
};
ctx.global = ctx;
vm.createContext(ctx);
// Se expone lo que hace falta probar agregando un export al final.
vm.runInContext(`${src}\n;globalThis.__pruebas = { clasificar, precisionDelTop, palabrasDe };`, ctx,
  { filename: 'inspect-search-diagnosis.js' });
const { clasificar, precisionDelTop, palabrasDe } = ctx.__pruebas;

const PALABRAS = { id: 'vtex-legacy', cuentaComparable: true };
const SEMANTICO = { id: 'dy', cuentaComparable: false };

// ── La precision del top ────────────────────────────────────────────────────

test('palabrasDe descarta las vacias y lo corto', () => {
  // Los arrays vienen de otro contexto de VM, asi que deepStrictEqual falla por
  // prototipo y no por contenido: se comparan como texto.
  const p = (t) => palabrasDe(t).join(',');
  assert.strictEqual(p('papel higienico'), 'papel,higienico');
  assert.strictEqual(p('dulce de leche'), 'dulce,leche', '"de" no aporta');
  assert.strictEqual(p('Azúcar'), 'azucar', 'sin tildes y en minuscula');
});

test('detecta el caso real: "aceite" contra papas fritas Lays', () => {
  // Esto es lo que devolvia el legacy en la corrida real, y el diagnostico lo
  // tomaba como prueba de que el producto existia y no estaba indexado.
  const sample = [
    { name: 'Papas fritas sabor a jamón serrano Lays 77 g.' },
    { name: 'Snack mix Lays 90 g.' },
  ];
  assert.strictEqual(precisionDelTop('aceite', sample), 0,
    'ninguno menciona aceite: no son prueba de nada');
});

test('un top que si menciona lo buscado da precision alta', () => {
  const sample = [
    { name: 'Papel higiénico hoja simple Carrefour Essential 4 × 80 m.' },
    { name: 'Papel higiénico Elegante 4 u.' },
  ];
  assert.strictEqual(precisionDelTop('papel higienico', sample), 1);
});

test('tambien mira las categorias, no solo el nombre', () => {
  const sample = [{ name: 'Ledesma 500 g', categories: ['Almacén', 'Azúcar'] }];
  assert.strictEqual(precisionDelTop('azucar', sample), 1,
    'el nombre no dice azucar pero la categoria si');
});

// ── Como se juzga cada clase de motor ───────────────────────────────────────

test('un motor semantico NO se juzga por cantidad', () => {
  // DY devolviendo "1000" es todo el catalogo rankeado, no 1000 relevantes.
  const malo = clasificar({ total: 1000, sample: [{ name: 'Agua mineral 2 L' }] }, SEMANTICO, 'azucar');
  assert.strictEqual(malo.status, 'top_irrelevante',
    'con 1000 resultados y agua mineral arriba, no esta resolviendo la busqueda');

  const bien = clasificar({ total: 1000, sample: [{ name: 'Azúcar Ledesma 1 kg' }] }, SEMANTICO, 'azucar');
  assert.strictEqual(bien.status, 'ok');
});

test('un motor semantico nunca puede quedar en "pocos resultados"', () => {
  const r = clasificar({ total: 3, sample: [{ name: 'Azúcar Ledesma' }] }, SEMANTICO, 'azucar');
  assert.strictEqual(r.status, 'ok', 'no filtra, asi que la cantidad no lo juzga');
});

test('un motor de palabras con muchos resultados pero top sin relacion queda mal', () => {
  const r = clasificar({
    total: 10,
    sample: [{ name: 'Papas fritas Lays' }, { name: 'Snack mix' }],
  }, PALABRAS, 'aceite');
  assert.strictEqual(r.status, 'top_irrelevante',
    'devolver 10 cosas que no se buscaron no es "ok"');
  assert.strictEqual(r.precisionTop, 0);
});

test('cero resultados sigue siendo cero, en cualquier motor', () => {
  assert.strictEqual(clasificar({ total: 0, sample: [] }, PALABRAS, 'aceite').status, 'sin_resultados');
  assert.strictEqual(clasificar({ total: 0, sample: [] }, SEMANTICO, 'aceite').status, 'sin_resultados');
});

test('la precision viaja en el resultado para poder reportarla', () => {
  const r = clasificar({
    total: 10,
    sample: [{ name: 'Aceite de girasol Natura 900 ml' }, { name: 'Papas Lays' }],
  }, PALABRAS, 'aceite');
  assert.strictEqual(r.precisionTop, 0.5);
  assert.strictEqual(r.status, 'ok', '50% esta arriba del umbral de 40%');
});

test('sin sample no se inventa una precision', () => {
  const r = clasificar({ total: 10, sample: [] }, PALABRAS, 'aceite');
  assert.strictEqual(r.precisionTop, undefined, 'preferir no medir antes que medir mal');
  assert.strictEqual(r.status, 'ok');
});

// ── El redirect que viene en la respuesta de busqueda ───────────────────────
// Buscar "aceite" en el sitio lleva a /almacen/aceites-y-vinagres, con
// initialQuery y searchState en la URL: el redirect lo hace el navegador, no un
// 301 del servidor. En VTEX eso significa que Intelligent Search devolvio 0
// productos Y el destino en la misma respuesta. El adaptador tiraba ese campo,
// y por eso "aceite" (24.444 busquedas/mes) figuraba como "no esta en el indice".

test('el adaptador de IS devuelve el redirect que trae la respuesta', async () => {
  const { vtexIS } = require(path.join(__dirname, '..', 'src', 'search-engines.js'));
  const previo = { cuenta: process.env.VTEX_ACCOUNT_NAME, fetch: global.fetch };
  process.env.VTEX_ACCOUNT_NAME = 'carrefourar';
  global.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ products: [], recordsFiltered: 0, redirect: '/almacen/aceites-y-vinagres' }),
    text: async () => '{}',
    headers: { get: () => 'application/json' },
  });
  try {
    const r = await vtexIS.search('aceite');
    assert.strictEqual(r.total, 0, 'IS devuelve 0 productos, eso es cierto');
    assert.strictEqual(r.redirect, '/almacen/aceites-y-vinagres',
      'y en la MISMA respuesta dice a donde manda al cliente');
  } finally {
    process.env.VTEX_ACCOUNT_NAME = previo.cuenta;
    global.fetch = previo.fetch;
  }
});

test('sin redirect configurado, el campo queda en null y no se inventa', async () => {
  const { vtexIS } = require(path.join(__dirname, '..', 'src', 'search-engines.js'));
  const previo = { cuenta: process.env.VTEX_ACCOUNT_NAME, fetch: global.fetch };
  process.env.VTEX_ACCOUNT_NAME = 'carrefourar';
  global.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ products: [{ productName: 'Aceite Natura' }], recordsFiltered: 12 }),
    text: async () => '{}',
    headers: { get: () => 'application/json' },
  });
  try {
    const r = await vtexIS.search('aceite');
    assert.strictEqual(r.redirect, null);
    assert.strictEqual(r.total, 12);
  } finally {
    process.env.VTEX_ACCOUNT_NAME = previo.cuenta;
    global.fetch = previo.fetch;
  }
});

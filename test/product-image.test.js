'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const handlerP = import(path.join(__dirname, '..', 'api', 'product-image.js')).then((m) => m.default);

function fakeRes() {
  return { code: 200, body: null, headers: {},
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[k] = v; } };
}

/** VTEX que solo conoce un producto, identificado por un campo y un valor. */
function vtexCon(campo, valor, imagen) {
  const pedidas = [];
  global.fetch = async (u) => {
    pedidas.push(String(u));
    const m = String(u).match(/fq=([^:]+):([^&]+)/);
    const c = m && m[1];
    const v = m && decodeURIComponent(m[2]);
    const hay = c === campo && v === valor;
    return { ok: true, status: 200,
      json: async () => (hay ? [{ items: [{ images: [{ imageUrl: imagen }] }] }] : []) };
  };
  return pedidas;
}

async function pedir(query) {
  const handler = await handlerP;
  const res = fakeRes();
  await handler({ method: 'GET', query, headers: {} }, res);
  return res;
}

// ── Las fotos de marketplace ────────────────────────────────────────────────
// Salian todas con el cuadrito gris de "sin foto". El cliente descartaba todo
// identificador que no fueran 8 a 14 digitos, y los productos de marketplace se
// identifican por el codigo del seller: "LTDRI0714PB0-DRN", "91DB50X3110-NWSN".

test('encuentra un producto de marketplace por su codigo de referencia', async () => {
  process.env.VTEX_ACCOUNT_NAME = 'carrefourar';
  vtexCon('alternateIds_RefId', 'LTDRI0714PB0-DRN', 'https://img/lavarropas.jpg');
  const r = await pedir({ sku: 'LTDRI0714PB0-DRN' });
  assert.strictEqual(r.code, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.image, 'https://img/lavarropas.jpg');
});

test('y tambien sin el sufijo del seller', async () => {
  process.env.VTEX_ACCOUNT_NAME = 'carrefourar';
  // El codigo parece <sku del seller>-<seller>: si el catalogo lo tiene
  // registrado sin el sufijo, hay que encontrarlo igual.
  const pedidas = vtexCon('alternateIds_RefId', '91DB50X3110', 'https://img/tv.jpg');
  const r = await pedir({ sku: '91DB50X3110-NWSN' });
  assert.strictEqual(r.body.image, 'https://img/tv.jpg');
  assert.match(r.body.encontradoPor, /91DB50X3110$/,
    'dice cual de las formas funcionó, para no adivinar después');
  assert.ok(pedidas.length >= 2, 'probó primero con el código completo');
});

test('un EAN sigue buscandose como EAN y en un solo intento', async () => {
  process.env.VTEX_ACCOUNT_NAME = 'carrefourar';
  const pedidas = vtexCon('alternateIds_Ean', '7790742358608', 'https://img/leche.jpg');
  const r = await pedir({ sku: '7790742358608' });
  assert.strictEqual(r.body.image, 'https://img/leche.jpg');
  assert.strictEqual(pedidas.length, 1, 'no se gastan llamadas de más en lo que ya funcionaba');
});

test('el parametro viejo `ean` sigue funcionando', async () => {
  process.env.VTEX_ACCOUNT_NAME = 'carrefourar';
  vtexCon('alternateIds_Ean', '7790742358608', 'https://img/leche.jpg');
  const r = await pedir({ ean: '7790742358608' });
  assert.strictEqual(r.body.image, 'https://img/leche.jpg');
});

test('si no lo encuentra, 404 diciendo que probo', async () => {
  process.env.VTEX_ACCOUNT_NAME = 'carrefourar';
  vtexCon('nada', 'nada', 'x');
  const r = await pedir({ sku: 'NOEXISTE-XX' });
  assert.strictEqual(r.code, 404);
  assert.ok(r.body.probados.length >= 2);
  assert.match(r.headers['Cache-Control'] || '', /max-age/,
    'el "no" se cachea un rato: si no, se reintenta en cada render');
});

test('sin cuenta de VTEX configurada lo dice, no explota', async () => {
  const previo = process.env.VTEX_ACCOUNT_NAME;
  delete process.env.VTEX_ACCOUNT_NAME;
  try {
    const r = await pedir({ sku: '7790742358608' });
    assert.strictEqual(r.code, 404);
    assert.match(r.body.message, /VTEX_ACCOUNT_NAME/);
  } finally { process.env.VTEX_ACCOUNT_NAME = previo; }
});

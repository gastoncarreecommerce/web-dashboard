'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const R = path.join(__dirname, '..');

function correr(resp, termino = 'leche') {
  const pre = path.join(os.tmpdir(), `dyprobe-pre-${process.pid}.js`);
  fs.writeFileSync(pre, `globalThis.fetch = async () => {
    const r = ${JSON.stringify(resp)};
    return { ok:true, status:200, text: async()=>JSON.stringify(r), json: async()=>r };
  };`);
  try {
    return execFileSync('node', ['-r', pre, 'src/dy-probe.js', termino],
      { cwd: R, encoding: 'utf8', env: { ...process.env, DY_API_KEY: 'falsa' } });
  } finally { fs.unlinkSync(pre); }
}

test('el probe encuentra las rutas aunque la respuesta tenga OTRA forma que la supuesta', () => {
  // A proposito distinta de config/dy-search.json: los productos en
  // payload.value.products (no payload.data.slots), el total en numResults (no
  // totalResults) y el nombre anidado en productData.name.
  const out = correr({ choices: [{ id: 1, name: 'Semantic Search', variations: [{ id: 9,
    payload: { type: 'SEARCH', value: { numResults: 58, products: [
      { sku: 'a', productData: { name: 'Leche entera 1L', categories: ['Lacteos'] } },
      { sku: 'b', productData: { name: 'Leche descremada 1L', categories: ['Lacteos'] } },
    ]}}}]}]});
  assert.match(out, /"productsPath": "choices\.0\.variations\.0\.payload\.value\.products"/);
  assert.match(out, /"totalPath": "choices\.0\.variations\.0\.payload\.value\.numResults"/);
  assert.match(out, /"nameKey": "productData\.name"/);
  assert.match(out, /"categoriesKey": "productData\.categories"/);
  assert.match(out, /SUGERENCIAS por heur/, 'tiene que decir que hay que confirmarlas');
});

test('la lista mas poblada gana sobre otras listas del mismo payload', () => {
  const out = correr({ data: {
    facets: [{ name: 'Marca' }, { name: 'Precio' }],           // 2 objetos
    items: [{ name: 'p1' }, { name: 'p2' }, { name: 'p3' }],   // 3 objetos: gana
  }});
  assert.match(out, /"productsPath": "data\.items"/);
});

test('sin ninguna lista de objetos lo dice, no inventa una ruta', () => {
  const out = correr({ choices: [] });
  assert.match(out, /ninguna: la respuesta no trae ninguna lista de objetos/);
  assert.doesNotMatch(out, /"productsPath"/, 'no propone nada si no hay de donde');
});

test('un error HTTP no se confunde con una respuesta vacia', () => {
  const pre = path.join(os.tmpdir(), `dyprobe-err-${process.pid}.js`);
  fs.writeFileSync(pre, `globalThis.fetch = async () => ({ ok:false, status:401,
    text: async()=>JSON.stringify({ error:'Invalid API key' }) });`);
  try {
    execFileSync('node', ['-r', pre, 'src/dy-probe.js', 'leche'],
      { cwd: R, encoding: 'utf8', env: { ...process.env, DY_API_KEY: 'mala' } });
    assert.fail('tenia que salir con codigo distinto de 0');
  } catch (e) {
    assert.match(e.stdout, /HTTP 401/);
    assert.match(e.stdout, /Invalid API key/);
  } finally { fs.unlinkSync(pre); }
});

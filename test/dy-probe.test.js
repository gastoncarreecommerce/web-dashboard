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
  const out = correr({ choices: [{ variations: [{ payload: { data: {
    facets: [{ name: 'Marca' }, { name: 'Precio' }],           // 2 objetos
    items: [{ name: 'p1' }, { name: 'p2' }, { name: 'p3' }],   // 3 objetos: gana
  }}}]}]});
  assert.match(out, /"productsPath": "choices\.0\.variations\.0\.payload\.data\.items"/);
});

test('respondio pero sin ninguna lista de productos: lo dice, no inventa una ruta', () => {
  // choices con contenido (asi el probe avanza) pero el payload no trae ninguna
  // lista de objetos: no hay de donde sacar productsPath.
  const out = correr({ choices: [{ variations: [{ payload: { data: { message: 'sin resultados' } } }] }] });
  assert.match(out, /ninguna: la respuesta no trae ninguna lista de objetos/);
  assert.doesNotMatch(out, /"productsPath"/, 'no propone nada si no hay de donde');
});

test('cookies y warnings NUNCA se ofrecen como productos', () => {
  // Esto paso de verdad en la primera corrida: choices vacio, dos cookies y un
  // warning, y la heuristica propuso "productsPath": "cookies".
  const pre = path.join(os.tmpdir(), `dyprobe-cook-${process.pid}.js`);
  fs.writeFileSync(pre, `globalThis.fetch = async () => {
    const r = { choices: [], cookies: [{name:'_dyid_server',value:'1'},{name:'_dyjsession',value:'2'}],
                warnings: [{code:'W084',message:"The 'dyid' does not match"}] };
    return { ok:true, status:200, text: async()=>JSON.stringify(r), json: async()=>r };
  };`);
  try {
    execFileSync('node', ['-r', pre, 'src/dy-probe.js', 'leche'],
      { cwd: R, encoding: 'utf8', env: { ...process.env, DY_API_KEY: 'falsa' } });
    assert.fail('sin choices tiene que salir con error');
  } catch (e) {
    assert.doesNotMatch(e.stdout, /"productsPath": "cookies"/, 'cookies no son productos');
    assert.match(e.stdout, /W084/, 'muestra el warning, que es la pista real');
    assert.match(e.stdout, /API Selector Name/, 'dice que revisar');
  } finally { fs.unlinkSync(pre); }
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

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
process.env.VTEX_ACCOUNT_NAME = 'carrefourar';
const path=require('path');
const R = path.join(__dirname,'..');

// respuestas tal como las documenta el OpenAPI de VTEX
const IS_RESP = { products: [
  { productName: 'Palta Hass x kg', categories: ['/Frutas y Verduras/Frutas/'] },
  { productName: 'Palta lista para comer', categories: ['/Frutas y Verduras/Frutas/'] },
], recordsFiltered: 37 };
const LEGACY_RESP = [
  { productName: 'Shampoo con palta 400ml', categories: ['/Perfumeria/Cabello/'] },
];

let ultimaUrl = null, ultimoInit = null;
function mockFetch(resp, { status = 200, headers = {} } = {}) {
  global.fetch = async (url, init) => { ultimaUrl = String(url); ultimoInit = init; return {
    ok: status < 400, status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => resp, text: async () => JSON.stringify(resp),
  }; };
}

const E = require(path.join(R,'src','search-engines.js'));

test('Intelligent Search: usa el path con {facets} vacio y el total exacto', async () => {
  mockFetch(IS_RESP);
  const r = await E.vtexIS.search('palta');
  assert.match(ultimaUrl, /\/api\/io\/_v\/api\/intelligent-search\/product_search\/\?query=palta&count=10$/);
  assert.strictEqual(r.total, 37, 'recordsFiltered es el total real');
  assert.strictEqual(r.capped, false, 'IS da el total exacto: nunca capped');
  assert.deepStrictEqual(r.products[0], { name: 'Palta Hass x kg', categories: ['/Frutas y Verduras/Frutas/'] });
});

test('legacy: sin la cabecera de rango, 10 productos es "10 o mas"', async () => {
  const diez = Array.from({length:10},(_,i)=>({productName:`P${i}`,categories:['/X/']}));
  mockFetch(diez);
  const r = await E.vtexLegacy.search('leche');
  assert.strictEqual(r.capped, true, 'sin cabecera y pagina llena -> capped');
  mockFetch(LEGACY_RESP, { headers: {'resources-content-range':'resources 0-9/123'} });
  const r2 = await E.vtexLegacy.search('leche');
  assert.strictEqual(r2.total, 123); assert.strictEqual(r2.capped, false);
});

test('los dos motores de VTEX pueden discrepar, y eso es el punto', async () => {
  mockFetch(IS_RESP);      const a = await E.vtexIS.search('palta');
  mockFetch(LEGACY_RESP, { headers: {'resources-content-range':'resources 0-0/1'} });
  const b = await E.vtexLegacy.search('palta');
  assert.notStrictEqual(a.total, b.total);
  console.log(`   IS: ${a.total} productos (${a.products[0].name}) | legacy: ${b.total} (${b.products[0].name})`);
});

test('top_searches y correction_search', async () => {
  mockFetch({ searches: [{term:'Leche',count:9000},{term:'pan',count:8000},{term:'',count:1}] });
  assert.deepStrictEqual(await E.vtexTopSearches(), [{term:'leche',count:9000},{term:'pan',count:8000}]);
  mockFetch({ correction: { misspelled: true, text: 'queso rallado', exact: false } });
  assert.deepStrictEqual(await E.vtexCorrection('queso rayado'), { corregido:true, termino:'queso rallado', exacto:false });
  mockFetch({});
  assert.strictEqual(await E.vtexCorrection('leche'), null, 'sin correccion -> null');
});

test('DY: sin configurar dice QUE falta, no falla mudo', () => {
  delete process.env.DY_API_KEY;
  // Con la config ya commiteada, lo unico que falta es la key.
  assert.strictEqual(E.dynamicYield.disponible(), false);
  assert.match(E.dynamicYield.porQueNo(), /DY_API_KEY/);

  // Y sin el archivo tampoco, nombra las dos cosas.
  const p = path.join(R, 'config', 'dy-search.json');
  const previo = fs.readFileSync(p, 'utf8');
  fs.unlinkSync(p);
  try {
    delete require.cache[require.resolve(path.join(R,'src','search-engines.js'))];
    const E2 = require(path.join(R,'src','search-engines.js'));
    const por = E2.dynamicYield.porQueNo();
    assert.match(por, /DY_API_KEY/);
    assert.match(por, /dy-search\.json/);
    console.log('   motivo sin nada configurado:', por);
  } finally { fs.writeFileSync(p, previo); }
});

test('DY: con config puesta, sustituye {{query}} y manda la key en el header', async () => {
  const cfg = {
    endpoint: 'https://dy-api.com/v2/serve/user/choose',
    selector: 'mi-search',
    body: { selector:{names:['mi-search']}, context:{ query:'{{query}}' } },
    productsPath: 'choices.0.variations.0.payload.data.slots',
    totalPath: 'choices.0.variations.0.payload.data.totalResults',
    nameKey: 'sku.name', categoriesKey: 'sku.categories',
  };
  // OJO: este test escribe en la MISMA ruta que usa el proyecto de verdad.
  // Antes hacia unlinkSync al terminar y eso BORRABA la config real de DY.
  // Ahora se respalda y se restaura.
  const p = path.join(R,'config','dy-search.json');
  const previo = fs.existsSync(p) ? fs.readFileSync(p,'utf8') : null;
  fs.writeFileSync(p, JSON.stringify(cfg));
  process.env.DY_API_KEY = 'secreta';
  try {
    delete require.cache[require.resolve(path.join(R,'src','search-engines.js'))];
    const E2 = require(path.join(R,'src','search-engines.js'));
    assert.strictEqual(E2.dynamicYield.disponible(), true);
    mockFetch({ choices:[{ variations:[{ payload:{ data:{
      totalResults: 12,
      slots:[{ sku:{ name:'Palta Hass', categories:['Frutas'] } }],
    }}}]}]});
    const r = await E2.dynamicYield.search('palta "premium"');
    assert.strictEqual(ultimoInit.method,'POST');
    assert.strictEqual(ultimoInit.headers['DY-API-Key'],'secreta');
    const enviado = JSON.parse(ultimoInit.body);
    assert.strictEqual(enviado.context.query,'palta "premium"', 'las comillas del termino no rompen el JSON');
    assert.strictEqual(r.total, 12);
    assert.deepStrictEqual(r.products[0], { name:'Palta Hass', categories:['Frutas'] });
  } finally {
    if (previo === null) fs.unlinkSync(p); else fs.writeFileSync(p, previo);
    delete process.env.DY_API_KEY;
  }
});

test('motoresActivos: omite los que no se pueden usar, y dice por que', () => {
  delete require.cache[require.resolve(path.join(R,'src','search-engines.js'))];
  const E3 = require(path.join(R,'src','search-engines.js'));
  process.env.SEARCH_ENGINES = 'vtex-is,vtex-legacy,dy,inventado';
  const { activos, omitidos } = E3.motoresActivos();
  assert.deepStrictEqual(activos.map(e=>e.id), ['vtex-is','vtex-legacy']);
  assert.deepStrictEqual(omitidos.map(o=>o.id), ['dy','inventado']);
  console.log('   omitidos:', omitidos.map(o=>`${o.id} (${o.motivo})`).join(' · '));
  delete process.env.SEARCH_ENGINES;
  assert.deepStrictEqual(E3.motoresActivos().activos.map(e=>e.id), ['vtex-is'], 'default = Intelligent Search');
});

test('DY: la config real sustituye el termino en query.text y nada mas', async () => {
  process.env.DY_API_KEY = 'secreta';
  delete require.cache[require.resolve(path.join(R,'src','search-engines.js'))];
  const E = require(path.join(R,'src','search-engines.js'));
  assert.strictEqual(E.dynamicYield.disponible(), true, 'config/dy-search.json ya esta cargada');
  mockFetch({ choices:[{ variations:[{ payload:{ data:{
    totalResults: 58, slots:[{ sku:{ name:'Leche La Serenisima 1L', categories:['Lacteos'] }}],
  }}}]}]});
  const r = await E.dynamicYield.search('queso rayado');
  const b = JSON.parse(ultimoInit.body);
  assert.strictEqual(b.query.text, 'queso rayado');
  assert.strictEqual(b.selector.name, 'Semantic Search');
  assert.strictEqual(b.context.page.locale, 'es_AR', 'no en_US: se busca en español');
  assert.strictEqual(b.context.page.type, 'OTHER', 'no HOMEPAGE: es una consulta de diagnostico');
  assert.strictEqual(b.query.filters, undefined, 'sin filtros: se mide el motor crudo');
  assert.strictEqual(b.query.pagination.numItems, 10);
  assert.strictEqual(ultimoInit.headers['DY-API-Key'], 'secreta');
  assert.strictEqual(r.total, 58);
  assert.deepStrictEqual(r.products[0], { name:'Leche La Serenisima 1L', categories:['Lacteos'] });
  delete process.env.DY_API_KEY;
});

test('DY: una ruta mal NO se reporta como cero resultados', async () => {
  process.env.DY_API_KEY = 'secreta';
  delete require.cache[require.resolve(path.join(R,'src','search-engines.js'))];
  const E = require(path.join(R,'src','search-engines.js'));
  // Respuesta con OTRA forma: si esto devolviera total 0, el diagnostico diria
  // que DY no encuentra nada cuando en realidad la config esta mal.
  mockFetch({ choices:[{ variations:[{ payload:{ data:{ items:[{name:'x'}], count: 7 } }}]}]});
  await assert.rejects(() => E.dynamicYield.search('leche'), (e) => {
    assert.match(e.message, /productsPath/);
    assert.match(e.message, /no existe en la respuesta/);
    assert.match(e.message, /choices/, 'dice que claves SI trae, para poder corregirlo');
    return true;
  });
  // Un array vacio SI es un resultado valido: no encontro nada.
  mockFetch({ choices:[{ variations:[{ payload:{ data:{ slots:[], totalResults: 0 } }}]}]});
  const r = await E.dynamicYield.search('xkjhsdf');
  assert.strictEqual(r.total, 0, 'lista vacia = cero resultados de verdad');
  delete process.env.DY_API_KEY;
});

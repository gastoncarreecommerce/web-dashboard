'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

const IA = path.join(__dirname, '..', 'src', 'search-relevance-ai.js');

// El SDK no esta instalado todavia (y aunque lo estuviera, no queremos red en
// los tests): se intercepta el require de '@anthropic-ai/sdk'.
function conSdkFalso(fake, fn) {
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === '@anthropic-ai/sdk') return fake;
    return orig.call(this, req, ...rest);
  };
  delete require.cache[require.resolve(IA)];
  try { return fn(require(IA)); }
  finally { Module._load = orig; delete require.cache[require.resolve(IA)]; }
}

function sdkFalso({ status = 'ended', resultados = [], onCreate } = {}) {
  const creados = [];
  const cls = class {
    constructor() {
      this.messages = {
        create: async (p) => ({ model: 'claude-opus-5', stop_reason: 'tool_use', content: [
          { type: 'tool_use', name: 'registrar_relevancia',
            input: { veredicto: 'irrelevante', relevantes: 0, total: 3, motivo: 'son shampoos' } },
        ]}),
        batches: {
          create: async (body) => { creados.push(body); if (onCreate) onCreate(body); return { id: 'batch_1', processing_status: status }; },
          retrieve: async () => ({ processing_status: status }),
          results: async () => resultados[Symbol.iterator](),
        },
      };
    }
  };
  cls.creados = creados;
  return cls;
}

const ok = (term, veredicto, motivo) => ({ custom_id: term, result: { type: 'succeeded', message: {
  model: 'claude-opus-5', content: [{ type:'tool_use', name:'registrar_relevancia',
    input: { veredicto, relevantes: veredicto==='relevante'?3:0, total:3, motivo } }] } } });

test('apagado sin API key: no hace ninguna llamada', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  await conSdkFalso(sdkFalso(), async (m) => {
    assert.strictEqual(m.habilitado(), false);
    assert.match(m.porQueNo(), /ANTHROPIC_API_KEY/);
    const r = await m.analizarRelevancia([{ term:'palta', products:['Shampoo palta'] }]);
    assert.strictEqual(r.veredictos.size, 0);
    assert.match(r.motivo, /ANTHROPIC_API_KEY/);
  });
});

test('el pedido pide salida estructurada, effort bajo y el modelo correcto', () => {
  process.env.ANTHROPIC_API_KEY = 'x';
  conSdkFalso(sdkFalso(), (m) => {
    const p = m.pedido('palta', ['Shampoo con palta']);
    assert.strictEqual(p.model, 'claude-opus-5');
    assert.strictEqual(p.output_config.effort, 'low');
    assert.strictEqual(p.tools[0].strict, true, 'strict:true = argumentos validados contra el schema');
    assert.strictEqual(p.tools[0].input_schema.additionalProperties, false);
    assert.deepStrictEqual(p.tool_choice, { type:'tool', name:'registrar_relevancia' });
    assert.match(p.messages[0].content, /Búsqueda: "palta"/);
    assert.match(p.messages[0].content, /1\. Shampoo con palta/);
  });
  delete process.env.ANTHROPIC_API_KEY;
});

test('lote: cosecha por custom_id y saltea los terminos sin productos', async () => {
  process.env.ANTHROPIC_API_KEY = 'x';
  const fake = sdkFalso({ status:'ended', resultados: [
    ok('pan','relevante','son panes'),
    ok('palta','irrelevante','son shampoos'),
    { custom_id:'roto', result:{ type:'errored' } },
  ]});
  await conSdkFalso(fake, async (m) => {
    const r = await m.analizarRelevancia([
      { term:'palta', products:['Shampoo palta','Crema palta','Jabon palta'] },
      { term:'pan',   products:['Pan lactal'] },
      { term:'vacio', products:[] },              // sin productos: no se manda
    ]);
    const ids = fake.creados[0].requests.map(q=>q.custom_id).sort();
    assert.deepStrictEqual(ids, ['palta','pan'], '"vacio" no se manda: gastar en eso es tirar plata');
    assert.strictEqual(r.veredictos.get('palta').veredicto, 'irrelevante');
    assert.strictEqual(r.veredictos.get('pan').veredicto, 'relevante');
    assert.strictEqual(r.veredictos.has('roto'), false, 'un resultado fallado no inventa veredicto');
  });
  delete process.env.ANTHROPIC_API_KEY;
});

test('si el lote no termina, se difiere en vez de perderse', async () => {
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.SEARCH_AI_MAX_WAIT_MS = '1';
  const estado = path.join(__dirname,'..','config','search-ai-batch.json');
  const fs = require('fs');
  await conSdkFalso(sdkFalso({ status:'in_progress' }), async (m) => {
    const r = await m.analizarRelevancia([{ term:'palta', products:['Shampoo'] }]);
    assert.strictEqual(r.diferido, 'batch_1');
    assert.ok(fs.existsSync(estado), 'el id del lote queda en disco');
    assert.strictEqual(JSON.parse(fs.readFileSync(estado,'utf8')).batchId, 'batch_1');
  });
  fs.unlinkSync(estado);
  delete process.env.SEARCH_AI_MAX_WAIT_MS; delete process.env.ANTHROPIC_API_KEY;
});

test('modo sincronico: respeta un rechazo por seguridad', async () => {
  process.env.ANTHROPIC_API_KEY = 'x'; process.env.SEARCH_AI_SYNC = '1';
  const cls = class { constructor(){ this.messages = {
    create: async () => ({ stop_reason:'refusal', stop_details:{category:'other'}, content:[] }),
    batches:{} }; } };
  await conSdkFalso(cls, async (m) => {
    const r = await m.analizarRelevancia([{ term:'x', products:['y'] }]);
    assert.strictEqual(r.veredictos.size, 0, 'un rechazo no se lee como veredicto');
  });
  delete process.env.SEARCH_AI_SYNC; delete process.env.ANTHROPIC_API_KEY;
});

'use strict';

/**
 * Juicio de relevancia semántica con IA: ¿los productos que devuelve el
 * buscador tienen algo que ver con lo que la persona escribió?
 *
 * Por qué hace falta. El diagnóstico sabe medir CANTIDAD ("¿trae al menos 5
 * resultados?") y CONSISTENCIA DE CATEGORÍA ("¿están todos en el mismo rubro?").
 * Las dos son señales reales pero ciegas al significado: "palta" devolviendo
 * diez shampoos con extracto de palta pasa las dos pruebas —son diez productos,
 * todos de Perfumería— y es exactamente la búsqueda que frustra a alguien que
 * quería una palta. Eso solo lo puede ver algo que entienda qué pidió la
 * persona.
 *
 * Cómo está armado, y por qué así:
 *
 *   · Apagado por defecto. Sin ANTHROPIC_API_KEY no hace NINGUNA llamada y
 *     devuelve un Map vacío; el diagnóstico sigue funcionando igual con sus
 *     reglas. El día que se cargue la key se enciende solo, sin tocar código.
 *
 *   · Batches API. 200 términos es trabajo de lote, no interactivo: nadie está
 *     esperando la respuesta en pantalla. Sale a la MITAD de precio.
 *
 *   · Estado en disco. Un lote puede tardar hasta 24 h (casi siempre menos de
 *     una). Si la corrida del workflow se agota esperando, el id del lote queda
 *     guardado y la corrida siguiente lo levanta en vez de volver a pagarlo.
 *
 *   · Salida estructurada con `strict: true`. El veredicto se lee de los
 *     argumentos de una herramienta validados contra el schema, no parseando
 *     prosa.
 *
 *   · Effort bajo en vez de apagar el pensamiento. Juzgar relevancia es una
 *     tarea simple; apagar el pensamiento en Opus 5 tiene efectos raros
 *     conocidos (se le escapan llamadas a herramientas al texto visible), así
 *     que se baja el effort, que además cuesta menos.
 *
 * Env vars:
 *   ANTHROPIC_API_KEY      la key. Sin ella, todo esto no hace nada.
 *   SEARCH_AI_MODEL        opcional, default claude-opus-5.
 *   SEARCH_AI_MAX_WAIT_MS  cuánto esperar el lote antes de diferirlo (default 15 min).
 *   SEARCH_AI_SYNC=1       no usar lotes: una llamada por término, al toque y
 *                          al doble de precio. Para probar con pocos términos.
 */

const fs = require('fs');
const path = require('path');

const ESTADO_PATH = path.join(__dirname, '..', 'config', 'search-ai-batch.json');
const MODELO = process.env.SEARCH_AI_MODEL || 'claude-opus-5';
const MAX_WAIT_MS = Number(process.env.SEARCH_AI_MAX_WAIT_MS || 15 * 60 * 1000);
const POLL_MS = 15000;
const MAX_TOKENS = 2000; // con pensamiento adaptativo prendido, 256 no alcanza

const HERRAMIENTA = {
  name: 'registrar_relevancia',
  description: 'Registra el veredicto de relevancia para una búsqueda.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      veredicto: {
        type: 'string',
        enum: ['relevante', 'mixto', 'irrelevante'],
        description: 'relevante: casi todos los resultados son lo que la persona buscaba. '
          + 'mixto: hay de los dos. irrelevante: casi ninguno sirve.',
      },
      relevantes: { type: 'integer', description: 'Cuántos de los productos listados sí son lo que la persona buscaba.' },
      total: { type: 'integer', description: 'Cuántos productos se listaron.' },
      motivo: { type: 'string', description: 'Una oración, en español, explicando el veredicto. Nombrá productos concretos.' },
    },
    required: ['veredicto', 'relevantes', 'total', 'motivo'],
  },
};

const SISTEMA = `Sos analista de búsqueda de un supermercado online argentino (Carrefour).

Te doy un término que la gente buscó de verdad y los nombres de los productos que
el buscador devolvió. Decidí cuántos de esos productos son lo que la persona
realmente quería.

Criterios:
- Juzgá por INTENCIÓN de compra, no por coincidencia de palabras. Alguien que
  busca "palta" quiere la fruta; un shampoo con extracto de palta NO sirve,
  aunque diga "palta" en el nombre.
- Un producto que contiene el ingrediente buscado como insumo cuenta solo si es
  plausible que la persona lo quisiera (buscar "queso" y encontrar pizza de
  muzzarella es dudoso; buscar "leche" y encontrar leche chocolatada está bien).
- Marcas, tamaños y variedades distintas del producto correcto SÍ cuentan como
  relevantes: la variedad normal de un rubro no es un problema.
- Si el término es ambiguo en Argentina (por ejemplo "chaucha", "palta", "birra"),
  interpretalo como lo haría alguien haciendo la compra del supermercado.

Registrá el veredicto con la herramienta. No escribas nada más.`;

function prompt(term, productos) {
  const lista = productos.map((p, i) => `${i + 1}. ${p}`).join('\n');
  return `Búsqueda: "${term}"\n\nProductos que devolvió el buscador:\n${lista}`;
}

/** El SDK se requiere tarde y con red: si no está instalado, esto tiene que
 *  degradar a "sin IA", no tirar abajo todo el diagnóstico. */
function cargarSDK() {
  try { return require('@anthropic-ai/sdk'); }
  catch { return null; }
}

function habilitado() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/** Por qué no está corriendo, para poder decirlo en vez de fallar mudo. */
function porQueNo() {
  if (!process.env.ANTHROPIC_API_KEY) return 'falta la env var ANTHROPIC_API_KEY';
  if (!cargarSDK()) return 'falta la dependencia @anthropic-ai/sdk (npm install)';
  return null;
}

function leerVeredicto(mensaje) {
  for (const bloque of mensaje?.content || []) {
    if (bloque.type === 'tool_use' && bloque.name === HERRAMIENTA.name) {
      // Los argumentos vienen validados contra el schema por `strict: true`,
      // pero el escapado del JSON puede variar entre modelos: nunca hay que
      // hacer matching de strings sobre el input serializado.
      const a = bloque.input || {};
      return {
        veredicto: a.veredicto, relevantes: a.relevantes,
        total: a.total, motivo: a.motivo, modelo: mensaje.model || MODELO,
      };
    }
  }
  return null;
}

function pedido(term, productos) {
  return {
    model: MODELO,
    max_tokens: MAX_TOKENS,
    system: SISTEMA,
    output_config: { effort: 'low' },
    tools: [HERRAMIENTA],
    tool_choice: { type: 'tool', name: HERRAMIENTA.name },
    messages: [{ role: 'user', content: prompt(term, productos) }],
  };
}

function leerEstado() {
  if (!fs.existsSync(ESTADO_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(ESTADO_PATH, 'utf8')); } catch { return null; }
}

function guardarEstado(estado) {
  fs.mkdirSync(path.dirname(ESTADO_PATH), { recursive: true });
  fs.writeFileSync(ESTADO_PATH, JSON.stringify(estado, null, 2));
}

function borrarEstado() {
  if (fs.existsSync(ESTADO_PATH)) fs.unlinkSync(ESTADO_PATH);
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** Recorre los resultados de un lote terminado y los mete en `out`. Los
 *  resultados llegan en CUALQUIER orden: se indexan por custom_id, nunca por
 *  posición. */
async function cosechar(client, batchId, out) {
  let ok = 0, fallados = 0;
  for await (const r of await client.messages.batches.results(batchId)) {
    if (r.result?.type !== 'succeeded') { fallados += 1; continue; }
    const v = leerVeredicto(r.result.message);
    if (!v) { fallados += 1; continue; }
    out.set(r.custom_id, v);
    ok += 1;
  }
  return { ok, fallados };
}

/**
 * Devuelve Map<term, veredicto> para los términos pasados.
 *
 * `items`: [{ term, products: string[] }]. Los términos sin productos se
 * saltean: no hay nada que juzgar y gastar una llamada en eso es tirar plata.
 */
async function analizarRelevancia(items) {
  const out = new Map();
  const motivo = porQueNo();
  if (motivo) return { veredictos: out, motivo, diferido: null };

  const Anthropic = cargarSDK();
  const client = new Anthropic();
  const utiles = items.filter((i) => i.term && (i.products || []).length > 0);
  if (!utiles.length) return { veredictos: out, motivo: null, diferido: null };

  // ── Un lote de una corrida anterior que quedó a medias ────────────────────
  const previo = leerEstado();
  if (previo?.batchId) {
    try {
      const b = await client.messages.batches.retrieve(previo.batchId);
      if (b.processing_status === 'ended') {
        const { ok, fallados } = await cosechar(client, previo.batchId, out);
        console.log(`  IA: lote diferido ${previo.batchId} listo — ${ok} veredictos${fallados ? `, ${fallados} sin resultado` : ''}`);
        borrarEstado();
        // Solo faltan los que ese lote no cubrió.
        const faltan = utiles.filter((i) => !out.has(i.term));
        if (!faltan.length) return { veredictos: out, motivo: null, diferido: null };
        utiles.length = 0; utiles.push(...faltan);
      } else {
        console.log(`  IA: el lote ${previo.batchId} sigue procesando (${b.processing_status}) — se espera a la próxima corrida.`);
        return { veredictos: out, motivo: null, diferido: previo.batchId };
      }
    } catch (e) {
      console.warn(`  IA: no se pudo recuperar el lote ${previo.batchId} (${e.message}) — se descarta y se arranca uno nuevo.`);
      borrarEstado();
    }
  }

  // ── Modo sincrónico: sin lotes, para probar con pocos términos ────────────
  if (process.env.SEARCH_AI_SYNC === '1') {
    for (const i of utiles) {
      try {
        const msg = await client.messages.create(pedido(i.term, i.products));
        // Un rechazo por seguridad llega con HTTP 200: hay que mirar
        // stop_reason antes de leer el contenido.
        if (msg.stop_reason === 'refusal') continue;
        const v = leerVeredicto(msg);
        if (v) out.set(i.term, v);
      } catch (e) { console.warn(`  IA: "${i.term}" falló (${e.message})`); }
    }
    return { veredictos: out, motivo: null, diferido: null };
  }

  // ── Lote nuevo ────────────────────────────────────────────────────────────
  const lote = await client.messages.batches.create({
    requests: utiles.map((i) => ({ custom_id: i.term, params: pedido(i.term, i.products) })),
  });
  console.log(`  IA: lote ${lote.id} creado con ${utiles.length} términos (mitad de precio, no interactivo)`);

  const limite = Date.now() + MAX_WAIT_MS;
  let estado = lote.processing_status;
  while (estado !== 'ended' && Date.now() < limite) {
    await dormir(POLL_MS);
    estado = (await client.messages.batches.retrieve(lote.id)).processing_status;
  }

  if (estado !== 'ended') {
    guardarEstado({ batchId: lote.id, creadoEn: new Date().toISOString(), terminos: utiles.length });
    console.log(`  IA: el lote no terminó en ${Math.round(MAX_WAIT_MS / 60000)} min — queda guardado y lo levanta la próxima corrida.`);
    return { veredictos: out, motivo: null, diferido: lote.id };
  }

  const { ok, fallados } = await cosechar(client, lote.id, out);
  console.log(`  IA: ${ok} veredictos${fallados ? `, ${fallados} sin resultado` : ''}`);
  return { veredictos: out, motivo: null, diferido: null };
}

module.exports = {
  analizarRelevancia, habilitado, porQueNo,
  // exportados para poder testear sin red
  HERRAMIENTA, SISTEMA, prompt, pedido, leerVeredicto, MODELO,
};

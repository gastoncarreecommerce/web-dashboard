'use strict';

/**
 * Hace UNA sola llamada real a Experience Search de Dynamic Yield y muestra la
 * respuesta, para poder completar `productsPath` y `totalPath` en
 * config/dy-search.json sin adivinar.
 *
 * Por qué existe: el Playground del panel de DY no llama a la API pública
 * (`choose`) sino a un endpoint interno (`preview`), así que el response que se
 * ve ahí no es el que vamos a recibir desde el servidor. Y la doc de DY no es
 * accesible desde donde corre esto. La única forma honesta de saber la forma
 * real de la respuesta es pedirla una vez y mirarla.
 *
 * No escribe nada ni toca la configuración: imprime y sale. Las rutas que
 * propone son CANDIDATAS, para que una persona confirme cuál es la correcta.
 *
 * Uso:
 *   DY_API_KEY=... node src/dy-probe.js [termino]
 *
 * Si no hay red hacia dy-api.com desde donde lo corras, corrélo en el workflow
 * de GitHub Actions (que sí tiene salida) o desde tu propia máquina.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'dy-search.json');
const MAX_JSON_CHARS = 6000;

// Listas que son parte del SOBRE de la respuesta de DY y nunca son productos.
//
// `cookies` y `warnings`: la primera corrida real devolvio `choices: []` con dos
// cookies y un warning, y la heuristica propuso `"productsPath": "cookies"` —
// plausible y completamente equivocado.
//
// `choices` y `choices.N.variations`: son la estructura del sobre. Son listas de
// objetos, asi que calificaban como candidatas, pero los productos siempre
// estan MAS ADENTRO. Ofrecerlas solo distrae.
const RUTAS_IGNORADAS = [
  /^(cookies|warnings|errors)(\.|$)/,
  /^choices$/,
  /^choices\.\d+\.variations$/,
  // `facets` son los filtros disponibles (categorias con su conteo), no
  // resultados. En la primera corrida que funciono, facets.0.values traia 100
  // categorias contra 10 productos en `slots`, asi que le gano por "la mas
  // poblada" y la heuristica propuso las categorias como si fueran productos.
  /(^|\.)facets(\.|$)/,
];
const ignorada = (ruta) => RUTAS_IGNORADAS.some((r) => r.test(ruta));

/** Cuanto se parece a un producto el primer elemento de la lista. Es lo que
 *  distingue la lista de RESULTADOS de cualquier otra lista de objetos del
 *  payload: contar elementos no alcanza. */
function pintaDeProducto(muestra) {
  const texto = JSON.stringify(muestra || {});
  let puntos = 0;
  for (const re of [/"(sku|skuId|productId|itemId)"/i, /"(name|productName|title)"/i,
                    /"categor/i, /"price/i, /"(image|imageUrl|url)"/i, /"slotId"/i]) {
    if (re.test(texto)) puntos += 1;
  }
  return puntos;
}

/** Todas las rutas que apuntan a una lista de objetos: cualquiera de estas
 *  puede ser la lista de productos. Se ordena por largo descendente porque la
 *  lista de resultados suele ser la más poblada. */
function listasDeObjetos(obj, ruta = '', out = []) {
  if (Array.isArray(obj)) {
    if (obj.length && !ignorada(ruta)
        && obj.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
      out.push({ ruta, largo: obj.length, muestra: obj[0] });
    }
    obj.forEach((v, i) => listasDeObjetos(v, ruta ? `${ruta}.${i}` : String(i), out));
    return out;
  }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) listasDeObjetos(v, ruta ? `${ruta}.${k}` : k, out);
  }
  return out;
}

/** Números que podrían ser el total de resultados. */
function posiblesTotales(obj, ruta = '', out = []) {
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => posiblesTotales(v, ruta ? `${ruta}.${i}` : String(i), out));
    return out;
  }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      const r = ruta ? `${ruta}.${k}` : k;
      if (typeof v === 'number' && /total|count|num|results|found|hits/i.test(k)) out.push({ ruta: r, valor: v });
      posiblesTotales(v, r, out);
    }
  }
  return out;
}

/** Las claves de un producto que podrían ser su nombre y sus categorías. */
function camposDe(producto) {
  const planas = [];
  const rec = (o, ruta) => {
    for (const [k, v] of Object.entries(o || {})) {
      const r = ruta ? `${ruta}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) rec(v, r);
      else planas.push({ ruta: r, valor: v });
    }
  };
  rec(producto, '');
  return {
    nombre: planas.filter((p) => /name|title|nombre|descri/i.test(p.ruta) && typeof p.valor === 'string'),
    categorias: planas.filter((p) => /categor|rubro|taxonom/i.test(p.ruta)),
  };
}

/** Nombres de selector a probar. `choices: []` con HTTP 200 suele significar
 *  que ninguna campaña matchea el nombre del selector, y el nombre exacto solo
 *  lo sabe quien armó la campaña — el panel muestra un título ("Semantic Search
 *  API") que no necesariamente es el API Selector Name. Probar varios en una
 *  corrida sale más barato que una ida y vuelta por cada uno. */
function selectoresAProbar(cfg) {
  const desdeArgv = process.argv.slice(3).filter(Boolean);
  if (desdeArgv.length) return desdeArgv;
  const env = (process.env.DY_SELECTORS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (env.length) return env;
  return [...new Set([cfg.selector, 'Semantic Search API', 'Semantic Search', 'Default Search Experience'].filter(Boolean))];
}

/** Endpoints a probar. El request que da el panel trae un bloque `query` que no
 *  existe en el `choose` estandar, asi que Experience Search probablemente tenga
 *  su propio endpoint. La doc no es accesible desde donde corre esto: se prueban
 *  los candidatos y la API decide. Un 404 o 405 descarta uno al instante. */
function endpointsAProbar(cfg) {
  const env = (process.env.DY_ENDPOINTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (env.length) return env;
  return [...new Set([...(cfg.endpointsAProbar || []), cfg.endpoint].filter(Boolean))];
}

/** Reemplaza el nombre del selector donde sea que esté en el body. En Experience
 *  Search el selector va anidado adentro de `query`, no en el nivel de arriba
 *  como en `choose`, así que se busca en los dos lugares. */
function conSelector(body, nombre) {
  const copia = JSON.parse(JSON.stringify(body));
  const poner = (sel) => {
    if (!sel) return;
    if (Array.isArray(sel.names)) sel.names = [nombre];
    if ('name' in sel) sel.name = nombre;
  };
  poner(copia.selector);
  poner(copia.query?.selector);
  return copia;
}

async function main() {
  const termino = process.argv[2] || 'leche';

  if (!process.env.DY_API_KEY) {
    console.log('⚠ Falta DY_API_KEY. Uso: DY_API_KEY=... node src/dy-probe.js [termino]');
    process.exit(1);
  }
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log(`⚠ No existe ${path.relative(process.cwd(), CONFIG_PATH)}`);
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  const selectores = selectoresAProbar(cfg);
  const endpoints = endpointsAProbar(cfg);
  console.log(`  término: "${termino}"`);
  console.log(`  endpoints a probar: ${endpoints.length}  ·  selectores: ${selectores.map((s) => `"${s}"`).join(', ')}\n`);

  let json = null, elegido = null, endpointElegido = null;
  for (const url of endpoints) {
    console.log(`→ POST ${url}`);
    let endpointVive = true;

    for (const nombre of selectores) {
      const body = JSON.stringify(conSelector(cfg.body, nombre))
        .split('{{query}}').join(JSON.stringify(termino).slice(1, -1));
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'DY-API-Key': process.env.DY_API_KEY },
        body,
      }).catch((e) => ({ ok: false, status: 0, _err: e.message, text: async () => '' }));

      const texto = await res.text().catch(() => '');
      let j = null;
      try { j = JSON.parse(texto); } catch { /* se reporta abajo */ }

      // Un 404/405 es del ENDPOINT, no del selector: no tiene sentido probar
      // los otros nombres contra una URL que no existe.
      if (res.status === 404 || res.status === 405 || res.status === 0) {
        console.log(`    ${res.status === 0 ? `sin conexión (${res._err})` : `HTTP ${res.status}`} — este endpoint no existe, se descarta`);
        endpointVive = false;
        break;
      }

      const choices = Array.isArray(j?.choices) ? j.choices.length : null;
      // Un endpoint de busqueda propio puede devolver los productos sin envolver
      // en `choices`: eso tambien cuenta como que funciono.
      const otrasListas = j ? listasDeObjetos(j).length : 0;
      const warns = (j?.warnings || []).map((w) => `${w.code} ${w.message}`);
      console.log(`    "${nombre}" → HTTP ${res.status}`
        + (choices === null ? ` (sin \`choices\`; ${otrasListas} lista(s) de objetos)` : ` · choices: ${choices}`)
        + (warns.length ? `\n        warnings: ${warns.join(' | ')}` : ''));

      if (!j) { if (texto) console.log(`        cuerpo: ${texto.slice(0, 300)}`); continue; }
      json = j;
      if (res.ok && (choices || (choices === null && otrasListas))) {
        elegido = nombre; endpointElegido = url; break;
      }
    }
    if (elegido) break;
    if (endpointVive) console.log('');
  }

  if (!elegido) {
    console.log('\nNingún selector devolvió resultados. Respuesta de la última prueba:');
    console.log(JSON.stringify(json, null, 2).slice(0, MAX_JSON_CHARS));
    console.log('\nQué revisar, en este orden:');
    console.log('  1. El API Selector Name real de la campaña (en el panel de DY).');
    console.log('     Se puede pasar a mano: node src/dy-probe.js leche "El Nombre Exacto"');
    console.log('  2. Que la experiencia esté PUBLICADA (no solo guardada).');
    console.log('  3. Los warnings de arriba: W084 significa que el dyid no lo generó DY.');
    console.log('  4. Que la API key tenga el ACL "Experience API" y sea server-side.');
    process.exit(1);
  }

  console.log(`\n✓ Funciona: POST ${endpointElegido}  ·  selector "${elegido}"`);
  console.log(`  Poner en config/dy-search.json: "endpoint": ${JSON.stringify(endpointElegido)}, "selector": ${JSON.stringify(elegido)}\n`);

  const crudo = JSON.stringify(json, null, 2);
  console.log('── Respuesta ' + (crudo.length > MAX_JSON_CHARS ? `(primeros ${MAX_JSON_CHARS} de ${crudo.length} caracteres)` : '') + ' ──');
  console.log(crudo.slice(0, MAX_JSON_CHARS));

  // Primero las que PARECEN productos; el largo desempata. Ordenar solo por
  // largo hacia ganar a los facets, que traen muchas mas filas que los
  // resultados.
  const listas = listasDeObjetos(json)
    .map((l) => ({ ...l, pinta: pintaDeProducto(l.muestra) }))
    .sort((a, b) => b.pinta - a.pinta || b.largo - a.largo);
  // Los nombres exactos que usa DY van primero: `count` de un facet tambien
  // matchea el patron generico y hay uno por categoria.
  const totales = posiblesTotales(json)
    .sort((a, b) => (/total(Num)?Results$/i.test(b.ruta) ? 1 : 0) - (/total(Num)?Results$/i.test(a.ruta) ? 1 : 0));

  console.log('\n── Candidatos para productsPath (listas de objetos, la más poblada primero) ──');
  if (!listas.length) console.log('  ninguna: la respuesta no trae ninguna lista de objetos.');
  for (const l of listas.slice(0, 8)) {
    const c = camposDe(l.muestra);
    console.log(`  ${l.ruta}  (${l.largo} elementos, pinta de producto ${l.pinta}/6)`);
    if (c.nombre.length) console.log(`      nameKey candidato: ${c.nombre.map((x) => `${x.ruta} = ${JSON.stringify(x.valor).slice(0, 60)}`).join(' | ')}`);
    if (c.categorias.length) console.log(`      categoriesKey candidato: ${c.categorias.map((x) => x.ruta).join(' | ')}`);
  }

  console.log('\n── Candidatos para totalPath ──');
  if (!totales.length) console.log('  ninguno: no hay ningún número que parezca un total.');
  for (const t of totales.slice(0, 8)) console.log(`  ${t.ruta} = ${t.valor}`);

  if (listas.length) {
    const mejor = listas[0];
    const c = camposDe(mejor.muestra);
    console.log('\n── Lo que habría que poner en config/dy-search.json (CONFIRMAR antes) ──');
    console.log(`  "productsPath": ${JSON.stringify(mejor.ruta)},`);
    if (totales.length) console.log(`  "totalPath": ${JSON.stringify(totales[0].ruta)},`);
    if (c.nombre.length) console.log(`  "nameKey": ${JSON.stringify(c.nombre[0].ruta)},`);
    if (c.categorias.length) console.log(`  "categoriesKey": ${JSON.stringify(c.categorias[0].ruta)}`);
    console.log('\n  Son SUGERENCIAS por heurística (la lista más poblada, la primera clave que');
    console.log('  parece un nombre). Mirá la respuesta de arriba y confirmá que apuntan a los');
    console.log('  productos del resultado y no a otra lista que venga en el mismo payload.');
  }
}

main().catch((e) => {
  console.error('dy-probe falló:', e.message);
  process.exit(1);
});

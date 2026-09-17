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

/** Todas las rutas que apuntan a una lista de objetos: cualquiera de estas
 *  puede ser la lista de productos. Se ordena por largo descendente porque la
 *  lista de resultados suele ser la más poblada. */
function listasDeObjetos(obj, ruta = '', out = []) {
  if (Array.isArray(obj)) {
    if (obj.length && obj.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
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

  const body = JSON.stringify(cfg.body).split('{{query}}').join(JSON.stringify(termino).slice(1, -1));
  console.log(`→ POST ${cfg.endpoint}`);
  console.log(`  selector: ${cfg.selector}  ·  término: "${termino}"\n`);

  const res = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'DY-API-Key': process.env.DY_API_KEY },
    body,
  });

  const texto = await res.text();
  console.log(`← HTTP ${res.status}\n`);

  let json;
  try { json = JSON.parse(texto); }
  catch {
    console.log('La respuesta no es JSON:');
    console.log(texto.slice(0, MAX_JSON_CHARS));
    process.exit(1);
  }

  if (!res.ok) {
    // Un 4xx acá casi siempre es la key, el nombre del selector, o que la
    // experiencia no está publicada. El cuerpo lo dice.
    console.log('La llamada falló. Respuesta completa:');
    console.log(JSON.stringify(json, null, 2).slice(0, MAX_JSON_CHARS));
    process.exit(1);
  }

  const crudo = JSON.stringify(json, null, 2);
  console.log('── Respuesta ' + (crudo.length > MAX_JSON_CHARS ? `(primeros ${MAX_JSON_CHARS} de ${crudo.length} caracteres)` : '') + ' ──');
  console.log(crudo.slice(0, MAX_JSON_CHARS));

  const listas = listasDeObjetos(json).sort((a, b) => b.largo - a.largo);
  const totales = posiblesTotales(json);

  console.log('\n── Candidatos para productsPath (listas de objetos, la más poblada primero) ──');
  if (!listas.length) console.log('  ninguna: la respuesta no trae ninguna lista de objetos.');
  for (const l of listas.slice(0, 8)) {
    const c = camposDe(l.muestra);
    console.log(`  ${l.ruta}  (${l.largo} elementos)`);
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

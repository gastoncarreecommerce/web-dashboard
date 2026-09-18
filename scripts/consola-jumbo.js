/* ───────────────────────────────────────────────────────────────────────────
   PARA PEGAR EN LA CONSOLA DEL NAVEGADOR, EN LA FICHA DE JUMBO

   Busca el precio que muestra la ficha ($1.982,5) DENTRO de los datos que
   cargo la pagina, y dice en que campo esta.

   Por que este enfoque. Las tres APIs publicas de VTEX devuelven 3.050 en
   todos sus campos, incluso con la sesion del navegador, y la ficha igual
   muestra 1.982,5 con -35%. Tambien se descarto que sea regional: no hay
   cookie vtex_segment (ninguna ubicacion elegida) y el precio se muestra
   igual. Pero el numero ESTA en la pantalla, asi que esta en los datos de la
   pagina. En vez de adivinar que endpoint lo trae, se busca el valor y se
   reporta el camino: eso dice el nombre del campo y de que consulta vino.

   Los storefronts VTEX IO dejan su estado en window.__STATE__ (cache de
   Apollo). Si no esta, se busca en el HTML del servidor.

   Como usarlo:
     1. Estar en la ficha del producto que muestra el precio con descuento.
     2. F12 -> Console.
     3. Pegar TODO esto y Enter.
     4. Copiar lo que imprime.

   Solo lee. No cambia nada ni manda nada a ningun lado.
   ─────────────────────────────────────────────────────────────────────────── */
(async () => {
  const log = (...a) => console.log('%c[buscar-precio]', 'color:#2a78d6;font-weight:bold', ...a);

  // El precio de la ficha y sus formas posibles: en pesos, en centavos, con
  // coma, con punto. No se sabe en que escala lo guarda, asi que se buscan
  // todas.
  const OBJETIVO = 1982.5;
  const FORMAS = [OBJETIVO, OBJETIVO * 100, Math.round(OBJETIVO), '1982.5', '1982,5', '198250', '1982'];

  /** Recorre un objeto entero y devuelve los caminos donde aparece el valor. */
  function buscar(raiz, formas, maxProf = 14) {
    const hallados = [];
    const vistos = new WeakSet();
    (function ir(v, camino, prof) {
      if (hallados.length > 40 || prof > maxProf || v == null) return;
      if (typeof v === 'number' || typeof v === 'string') {
        const s = String(v);
        if (formas.some((f) => (typeof f === 'number' ? v === f : s === f || s.includes(f)))) {
          hallados.push({ camino, valor: v });
        }
        return;
      }
      if (typeof v !== 'object') return;
      if (vistos.has(v)) return;
      vistos.add(v);
      for (const k of Object.keys(v)) {
        let hijo; try { hijo = v[k]; } catch { continue; }
        ir(hijo, `${camino}.${k}`, prof + 1);
      }
    })(raiz, '', 0);
    return hallados;
  }

  // ── 1. El estado que la pagina tiene en memoria ──────────────────────────
  const globales = ['__STATE__', '__RUNTIME__', '__APOLLO_STATE__', '__NEXT_DATA__', 'dataLayer'];
  let encontroAlgo = false;
  for (const g of globales) {
    if (!window[g]) continue;
    const h = buscar(window[g], FORMAS);
    log(`window.${g}: ${h.length ? `${h.length} coincidencia(s)` : 'no tiene el numero'}`);
    for (const x of h.slice(0, 12)) log(`   window.${g}${x.camino}  =  ${x.valor}`);
    if (h.length) encontroAlgo = true;
  }
  if (!globales.some((g) => window[g])) {
    log('La pagina no expone __STATE__ ni __RUNTIME__. Se busca en el HTML del servidor.');
  }

  // ── 2. El HTML que sirvio el servidor ────────────────────────────────────
  // Si el numero viene renderizado del servidor, esta ahi con el nombre de su
  // campo al lado, que es justo lo que hace falta saber.
  const html = await (await fetch(location.href, { credentials: 'include' })).text();
  const hits = [];
  for (const m of html.matchAll(/1982[.,]?5?/g)) {
    hits.push(html.slice(Math.max(0, m.index - 160), m.index + 60).replace(/\s+/g, ' '));
    if (hits.length >= 6) break;
  }
  log(`HTML del servidor: ${hits.length ? `${hits.length} aparicion(es) de 1982` : 'NO contiene 1982'}`);
  hits.forEach((h, i) => log(`   [${i + 1}] …${h}…`));

  // ── 3. Los campos de precio que la pagina muestra, tal cual ──────────────
  // Sirve de control: confirma que se esta mirando la ficha correcta.
  const texto = document.body.innerText;
  const lineas = texto.split('\n').filter((l) => /\$\s?[\d.]+/.test(l)).slice(0, 10);
  log('Lineas con precio en la pantalla:'); lineas.forEach((l) => log(`   ${l.trim()}`));

  if (!encontroAlgo && !hits.length) {
    log('El numero no esta ni en el estado ni en el HTML: lo trae una llamada posterior.');
    log('Entonces: abri la pestana Network, filtra por "1982" en el buscador de respuestas');
    log('(Network -> lupa/Search -> escribir 1982) y decime que request aparece.');
  }
})();

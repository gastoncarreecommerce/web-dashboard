/* global window, document, fetch */
/**
 * Vista "Buscador". Responde cuatro preguntas distintas, una por pestaña:
 *
 *   Comparar · ¿qué motor conviene? Se escribe un término y se ven los
 *              productos que pone primero cada buscador, uno al lado del otro,
 *              con foto y precio. Se juzga con los ojos: no hay puntaje.
 *   Negocio  · ¿cómo le va al buscador? Cuánta gente lo usa, cuántos llegan a
 *              ver resultados.
 *   Demanda  · ¿qué busca la gente? Los términos por volumen, para comercial y
 *              surtido.
 *   Problemas· ¿qué está roto? La cola de trabajo priorizada por volumen.
 *
 * Antes esto era una sola pared con la cola de trabajo arriba: una lista de
 * tickets para un desarrollador, no un módulo de buscador.
 *
 * De dónde sale cada dato:
 *   · La comparación es EN VIVO, contra /api/buscador-compara, que le pregunta
 *     el mismo término a los tres motores en el momento. Nada de esto sale de
 *     un reporte: un reporte no te deja escribir un término.
 *   · El resto sale del diagnóstico diario (src/inspect-search-diagnosis.js):
 *     GA4 para lo que busca la gente, los buscadores reales para lo que
 *     devuelven.
 *
 * Esta vista no depende del rango de fechas del resto del dashboard (igual que
 * Audiencias): la ventana la define GA4, últimos 30 días.
 */
(function () {
  const W = (window.W = window.W || {});

  const STATUS_LABEL = {
    redirige_a_plp: 'Redirige a categoría', motor_no_indexa: 'No está en el índice',
    sin_resultados: 'Sin resultados', pocos_resultados: 'Pocos resultados',
    top_irrelevante: 'Top sin relación',
    resultados_dispersos: 'Resultados dispersos', resultados_irrelevantes: 'No es lo que se buscaba',
    error_consulta: 'Error de consulta', ok: 'OK',
  };
  const STATUS_PILL = {
    redirige_a_plp: 'n', motor_no_indexa: 'no', sin_resultados: 'no', pocos_resultados: 'w',
    resultados_dispersos: 'w', top_irrelevante: 'w',
    resultados_irrelevantes: 'no', error_consulta: 'n', ok: 'ok',
  };

  const pill = (s) => `<span class="pill ${STATUS_PILL[s] || 'n'}">${W.esc(STATUS_LABEL[s] || s)}</span>`;

  function recKind(text) {
    if (/alta prioridad|no traen ningún resultado/i.test(text)) return 'bad';
    if (/estima|revisar/i.test(text)) return 'warn';
    return 'info';
  }

  const plata = (n) => (Number.isFinite(n)
    ? `$${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '');

  // ── Pestaña 1: comparar los motores con los ojos ──────────────────────────

  /** Una columna: un motor con los productos que puso primero. */
  function columnaMotor(m) {
    if (m.error) {
      return `<div class="cmpm-col">
        <div class="cmpm-h"><h4>${W.esc(m.label)}</h4><div class="cmpm-nota">${W.esc(m.nota || '')}</div></div>
        <div class="cmpm-err">No se pudo consultar: ${W.esc(m.error)}</div></div>`;
    }
    // El total se muestra distinto según si el motor filtra o no. DY no filtra:
    // rankea, así que su total puede ser todo el catálogo y no se compara con
    // el de los otros dos.
    const total = m.totalComparable === false
      ? `${W.fmtNum(m.total)} productos rankeados`
      : `${W.fmtNum(m.total)}${m.totalExacto === false ? '+' : ''} producto(s)`;

    const prods = (m.productos || []);
    const cuerpo = prods.length
      ? `<ul class="cmpm-l">${prods.map((p, i) => `<li class="cmpm-p">
          <span class="cmpm-pos">${i + 1}</span>
          ${p.imagen
    ? `<img src="${W.esc(p.imagen)}" alt="" loading="lazy">`
    : '<span class="cmpm-sinfoto">sin foto</span>'}
          <span class="cmpm-txt">
            <span class="cmpm-nom">${W.esc(p.nombre || '(sin nombre)')}</span>
            <span class="cmpm-met">
              ${p.precio != null ? `<span class="cmpm-pre">${plata(p.precio)}</span>` : '<span class="muted">sin precio</span>'}
              ${p.precioLista != null ? `<span class="cmpm-ant">${plata(p.precioLista)}</span>` : ''}
              ${p.disponible === false ? ' · sin stock' : ''}
              ${p.categorias?.length ? ` · ${W.esc(p.categorias.join(' / '))}` : ''}
            </span>
          </span>
        </li>`).join('')}</ul>`
      : `<div class="cmpm-vacio">${m.redirect
        ? 'No devuelve productos porque el término está redirigido.'
        : `No devolvió ningún producto.${m.nota ? ` ${W.esc(m.nota)}` : ''}`}</div>`;

    return `<div class="cmpm-col">
      <div class="cmpm-h">
        <h4>${W.esc(m.label)}</h4>
        <div class="cmpm-t">${total}</div>
        <div class="cmpm-nota">${W.esc(m.nota || '')}</div>
      </div>
      ${m.redirect ? `<div class="cmpm-redir"><strong>Redirige a</strong> ${W.esc(m.redirect)}
        — el cliente va a esa categoría y nunca ve una página de resultados.</div>` : ''}
      ${cuerpo}
    </div>`;
  }

  async function comparar(term, destino) {
    destino.innerHTML = '<p class="muted">Preguntándole a los tres buscadores…</p>';
    let data;
    try {
      const r = await fetch(`/api/buscador-compara?q=${encodeURIComponent(term)}`, { cache: 'no-store' });
      data = await r.json();
      if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
    } catch (e) {
      destino.innerHTML = `<div class="ins bad">${W.icon('alert', 16)}<div><p>No se pudo comparar:
        ${W.esc(e.message)}</p></div></div>`;
      return;
    }
    const motores = data.motores || [];
    // Si un motor está sin configurar, se dice qué falta en vez de mostrar una
    // columna vacía sin explicación.
    const faltantes = motores.filter((m) => /falta [A-Z_]+/.test(m.error || ''));
    destino.innerHTML = `
      ${faltantes.length ? `<div class="ins warn">${W.icon('warn', 16)}<div><p>
        ${faltantes.map((m) => `<strong>${W.esc(m.label)}</strong>: ${W.esc(m.error)}`).join('. ')}.
        Se configura como variable de entorno en Vercel.</p></div></div>` : ''}
      <div class="cmpm">${motores.map(columnaMotor).join('')}</div>
      <p class="muted" style="font-size:.75rem;margin-top:.6rem">
        Consulta en vivo a los tres buscadores, ${W.esc(data.termino)} · ${W.timeAgo(data.consultadoEn)}.
        Son los primeros resultados de cada uno, que es lo que ve el cliente.</p>`;
  }

  function tabComparar(el, sugeridos) {
    el.innerHTML = `
      <form class="cmpm-form" id="cmpm-f">
        <input type="text" id="cmpm-q" placeholder="Escribí lo que buscaría un cliente: leche, papel higienico, queso rayado…" autocomplete="off">
        <button class="btn-p" type="submit">${W.icon('search', 14)}Comparar</button>
      </form>
      ${sugeridos.length ? `<div class="cmpm-sug">
        <span class="muted" style="font-size:.76rem;align-self:center">De los más buscados:</span>
        ${sugeridos.map((t) => `<button type="button" data-term="${W.esc(t)}">${W.esc(t)}</button>`).join('')}
      </div>` : ''}
      <div id="cmpm-res"><p class="muted">Escribí un término, o elegí uno de los de arriba.
        Vas a ver los productos que pone primero cada buscador, uno al lado del otro.</p></div>`;

    const res = el.querySelector('#cmpm-res');
    const input = el.querySelector('#cmpm-q');
    const lanzar = (t) => { input.value = t; comparar(t, res); };
    el.querySelector('#cmpm-f').addEventListener('submit', (e) => {
      e.preventDefault();
      const t = input.value.trim();
      if (t) comparar(t, res);
    });
    el.querySelectorAll('.cmpm-sug button').forEach((b) => {
      b.addEventListener('click', () => lanzar(b.dataset.term));
    });
  }

  // ── Pestaña 2: cómo le va al negocio ──────────────────────────────────────

  function tabNegocio(el, report) {
    const u = report.funnel || {};
    // Cada número con su denominador: un porcentaje sin decir "sobre qué" no
    // se puede discutir en una reunión.
    const pct = (a, b) => (b ? a / b : null);
    const kpi = (color, icono, valor, etiqueta, sub) => `
      <div class="kpi"><div class="kpi-t"><span class="kpi-ic" style="background:${color}38;color:${color}">${W.icon(icono, 18)}</span></div>
        <div class="kpi-v">${valor}</div><div class="kpi-l">${etiqueta}</div>
        <div class="kpi-s">${sub}</div></div>`;

    const usaBuscador = pct(u.usuariosBuscaron, u.usuariosTotales);
    const llegaResultados = pct(u.usuariosVieronResultados, u.usuariosBuscaron);

    el.innerHTML = `
      ${u.usuariosBuscaron ? `<div class="kpis">
        ${kpi('#4f46e5', 'search', usaBuscador == null ? '—' : W.fmtPct(usaBuscador, 1),
    'Usa el buscador', `${W.fmtNumC(u.usuariosBuscaron)} de ${W.fmtNumC(u.usuariosTotales)} usuarios, últimos 30 días`)}
        ${kpi(llegaResultados != null && llegaResultados < 0.5 ? '#e34948' : '#1baf7a', 'layers',
    llegaResultados == null ? '—' : W.fmtPct(llegaResultados, 1),
    'Llega a ver resultados', `${W.fmtNumC(u.usuariosVieronResultados)} de los ${W.fmtNumC(u.usuariosBuscaron)} que buscaron`)}
        ${kpi('#2a78d6', 'trendUp', W.fmtNumC(u.busquedas), 'Búsquedas',
    `${u.busquedasPorUsuario ? `${u.busquedasPorUsuario.toFixed(1)} por usuario que busca` : ''} · evento "search" de GA4`)}
        ${kpi('#eda100', 'tag', W.fmtNumC(u.compras), 'Compras del sitio',
    `${W.fmtNumC(u.usuariosCompraron)} usuarios · para dar contexto de escala`)}
      </div>` : ''}

      ${llegaResultados != null && llegaResultados < 0.5 ? `<div class="ins warn">${W.icon('warn', 16)}<div><p>
        <strong>Solo ${W.fmtPct(llegaResultados, 0)} de los que buscan llega a una página de resultados.</strong>
        La explicación más probable no es que el buscador falle: los términos con redirección
        configurada mandan al cliente a una categoría, y una categoría no dispara el evento
        <em>view_search_results</em>. Se puede confirmar mirando cuántos de los términos más
        buscados redirigen, en la pestaña Problemas.</p></div></div>` : ''}

      <div class="ins info">${W.icon('info', 16)}<div><p>
        <strong>Lo que estos números NO dicen.</strong> GA4 no permite, desde su API de datos,
        separar "compraron los que buscaron" de "compraron los que no" — eso necesita segmentos
        por sesión, que la API pública no expone. Así que acá no hay conversión del buscador:
        hay cuánta gente lo usa y cuánta llega a ver resultados. Preferible eso a un número
        de conversión inventado.</p></div></div>

      <div class="card">
        <div class="card-h"><div><h3>Tendencia de problemas</h3>
          <p>términos problemáticos por corrida diaria — si sube, algo empeoró</p></div></div>
        ${W.chart.line({
    labels: (report.historia || []).map((h) => h.date),
    series: [
      { name: 'Sin resultados (términos)', color: '#e34948', values: (report.historia || []).map((h) => h.sinResultados) },
      { name: 'Pocos resultados (términos)', color: '#eda100', values: (report.historia || []).map((h) => h.pocosResultados) },
    ],
    yFmt: W.fmtNum,
  })}
      </div>`;
  }

  // ── Pestaña 3: qué busca la gente ─────────────────────────────────────────

  function tabDemanda(el, report, onComparar) {
    const top = report.topTerms || [];
    const total = top.reduce((s, t) => s + t.searchCount, 0);
    el.innerHTML = `
      <div class="card">
        <div class="card-h">
          <div><h3>Lo que más busca la gente</h3>
            <p>top ${top.length} términos por volumen, últimos 30 días · ${W.fmtNumC(total)} búsquedas en total</p></div>
          <button class="btn" data-export="buscadorTop">${W.icon('download', 14)}XLSX</button>
        </div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>Término</th><th class="num">Búsquedas</th><th class="num">Del total</th>
            <th>Estado</th><th></th></tr></thead>
          <tbody>${top.length ? top.map((t) => `<tr>
              <td>${W.esc(t.term)}</td>
              <td class="num">${W.fmtNum(t.searchCount)}</td>
              <td class="num">${total ? W.fmtPct(t.searchCount / total, 1) : '—'}</td>
              <td>${pill(t.status)}</td>
              <td><button class="btn" data-ver="${W.esc(t.term)}">Comparar motores</button></td>
            </tr>`).join('') : '<tr><td colspan="5" class="muted">Sin datos</td></tr>'}</tbody>
        </table></div>
      </div>`;
    el.querySelectorAll('[data-ver]').forEach((b) => {
      b.addEventListener('click', () => onComparar(b.dataset.ver));
    });
  }

  // ── Pestaña 4: qué está roto ──────────────────────────────────────────────

  function tabProblemas(el, report) {
    const { problems = [], recommendations = [] } = report;
    el.innerHTML = `
      ${recommendations.length ? `<div>
        <div class="ins-h"><h3>Qué hacer</h3><span>lectura automática del diagnóstico</span></div>
        <div class="ins-g">${recommendations.map((r) => `<div class="ins ${recKind(r)}">${
    W.icon(recKind(r) === 'bad' ? 'alert' : recKind(r) === 'warn' ? 'warn' : 'info', 16)
  }<div><p>${W.esc(r)}</p></div></div>`).join('')}</div></div>` : ''}

      <div class="card">
        <div class="card-h">
          <div><h3>Términos con problema</h3>
            <p>ordenados por volumen de búsqueda: primero lo que más gente ve</p></div>
          <button class="btn" data-export="buscadorProblemas">${W.icon('download', 14)}XLSX</button>
        </div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>Término</th><th class="num">Búsquedas</th><th>Estado</th>
            <th class="num">Productos</th><th>Qué hacer</th></tr></thead>
          <tbody>${problems.length ? problems.map((t) => `<tr>
              <td>${W.esc(t.term)}${t.sampleProducts?.length
    ? `<div class="scope">trae: ${W.esc(t.sampleProducts.slice(0, 2)
      .map((p) => (typeof p === 'string' ? p : p?.name) || '?').join(' · '))}</div>` : ''}
                ${t.redirectUrl ? `<div class="scope">→ ${W.esc(t.redirectUrl)}</div>` : ''}</td>
              <td class="num">${W.fmtNum(t.searchCount)}</td>
              <td>${pill(t.status)}</td>
              <td class="num">${t.vtexResults == null ? '—' : `${t.vtexResults}${t.vtexResultsCapped ? '+' : ''}`}</td>
              <td class="scope">${W.esc(t.recommendation || '')}</td>
            </tr>`).join('') : '<tr><td colspan="5" class="muted">Ningún término con problemas en esta corrida 🎉</td></tr>'}</tbody>
        </table></div>
      </div>`;
  }

  // ── La vista ──────────────────────────────────────────────────────────────

  const PESTANAS = [
    { id: 'comparar', label: 'Comparar motores' },
    { id: 'negocio', label: 'Negocio' },
    { id: 'demanda', label: 'Demanda' },
    { id: 'problemas', label: 'Qué está roto' },
  ];

  W.viewBuscador = async function (ctx) {
    const { el } = ctx;
    let report;
    try {
      report = await W.load('search-diagnosis');
    } catch {
      // La comparación en vivo NO necesita el reporte, así que la pestaña
      // sirve igual: se muestra sola en vez de un cartel que bloquea todo.
      el.innerHTML = `<div class="vtabs"><button class="vtab" aria-selected="true">Comparar motores</button></div>
        <div id="bus-cuerpo"></div>
        <p class="muted" style="font-size:.78rem;margin-top:1rem">Todavía no hay diagnóstico diario:
        corré el workflow "WebDash inspect search (GA4)" para llenar las otras pestañas.</p>`;
      tabComparar(el.querySelector('#bus-cuerpo'), []);
      return;
    }
    report.historia = await W.load('search-diagnosis-history').catch(() => []);

    const { summary = {}, topTerms = [], problems = [] } = report;
    ctx.exports.buscadorTop = {
      filename: 'webdash-buscador-mas-buscados.csv',
      headers: ['termino', 'busquedas', 'estado'],
      rows: topTerms.map((t) => [t.term, t.searchCount, STATUS_LABEL[t.status] || t.status]),
    };
    ctx.exports.buscadorProblemas = {
      filename: 'webdash-buscador-problemas.csv',
      headers: ['termino', 'busquedas', 'estado', 'productos', 'redirige_a', 'recomendacion'],
      rows: problems.map((t) => [
        t.term, t.searchCount, STATUS_LABEL[t.status] || t.status,
        t.vtexResults == null ? '' : `${t.vtexResults}${t.vtexResultsCapped ? '+' : ''}`,
        t.redirectUrl || '', t.recommendation || '',
      ]),
    };

    const cuenta = {
      problemas: problems.length,
      demanda: topTerms.length,
    };

    el.innerHTML = `
      <div class="vtabs" id="bus-tabs">${PESTANAS.map((p, i) => `
        <button class="vtab" role="tab" data-tab="${p.id}" aria-selected="${i === 0}">${p.label}${
  cuenta[p.id] ? `<span class="vtab-n">${W.fmtNum(cuenta[p.id])}</span>` : ''}</button>`).join('')}</div>
      <div id="bus-cuerpo"></div>
      <p class="muted" style="font-size:.75rem;margin-top:1rem">
        Diagnóstico automático diario a las 6:00 (hora ARG) · última corrida ${W.timeAgo(report.generatedAt)}
        · ${W.fmtNum(report.termsAnalyzed || 0)} términos medidos.
        La comparación de motores, en cambio, consulta en vivo cada vez que la usás.</p>`;

    const cuerpo = el.querySelector('#bus-cuerpo');
    const sugeridos = topTerms.slice(0, 8).map((t) => t.term);

    const abrir = (id, term) => {
      el.querySelectorAll('#bus-tabs .vtab').forEach((b) => {
        b.setAttribute('aria-selected', String(b.dataset.tab === id));
      });
      if (id === 'comparar') {
        tabComparar(cuerpo, sugeridos);
        if (term) {
          cuerpo.querySelector('#cmpm-q').value = term;
          comparar(term, cuerpo.querySelector('#cmpm-res'));
        }
      } else if (id === 'negocio') tabNegocio(cuerpo, report);
      else if (id === 'demanda') tabDemanda(cuerpo, report, (t) => abrir('comparar', t));
      else tabProblemas(cuerpo, report);
      // Los botones de export no hay que enganchar: app.js escucha el click en
      // document y resuelve por [data-export], así que sirven recién pintados.
    };

    el.querySelectorAll('#bus-tabs .vtab').forEach((b) => {
      b.addEventListener('click', () => abrir(b.dataset.tab));
    });
    abrir('comparar');
  };
})();

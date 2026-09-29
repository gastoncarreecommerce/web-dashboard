/* global window, document, fetch, navigator */
/**
 * Vista "Buscador": lectura y análisis del buscador para analistas de
 * búsqueda y SEO. Arranca por lo que hay que HACER (accionables priorizados
 * por búsquedas afectadas) y deja abajo el detalle para investigar.
 *
 *   Resumen      · salud del buscador, KPIs con variación, accionables.
 *   Tendencias   · qué sube, qué baja y qué es nuevo (semana o mes).
 *   Demanda      · todos los términos, con tendencia, variantes y cómo los
 *                  contesta el buscador. Clic en un término = ficha completa.
 *   Calidad      · qué está roto, agrupado por tipo, y motor contra motor.
 *   Hábitos      · cuándo y desde dónde se busca, y cómo se escribe.
 *   Comparar     · los tres motores en vivo, uno al lado del otro.
 *
 * Datos:
 *   search-insights.json  (src/search-insights.js, GA4) → demanda y hábitos.
 *   search-diagnosis.json (src/inspect-search-diagnosis.js) → cómo contesta
 *                         el buscador a los 200 términos más buscados.
 *   /api/buscador-compara → comparación en vivo.
 * Los dos reportes se cruzan por término normalizado (minúsculas, decodificado).
 */
(function () {
  const W = (window.W = window.W || {});

  const STATUS_LABEL = {
    redirige_a_plp: 'Redirige a categoría', motor_no_indexa: 'No está en el índice',
    sin_resultados: 'Sin resultados', pocos_resultados: 'Pocos resultados',
    top_irrelevante: 'Top sin relación', resultados_dispersos: 'Resultados dispersos',
    resultados_irrelevantes: 'No es lo que se buscaba', error_consulta: 'Error de consulta', ok: 'Responde bien',
  };
  const STATUS_PILL = {
    redirige_a_plp: 'n', motor_no_indexa: 'no', sin_resultados: 'no', pocos_resultados: 'w',
    resultados_dispersos: 'w', top_irrelevante: 'w', resultados_irrelevantes: 'no', error_consulta: 'n', ok: 'ok',
  };
  // Grupos de problema, en el orden en que conviene atacarlos.
  const GROUPS = [
    { k: 'vacio', label: 'No encuentra nada', st: ['sin_resultados', 'motor_no_indexa'], sev: 'bad',
      fix: 'Cargar sinónimos o redirecciones en el buscador; si otro motor sí lo encuentra, revisar la indexación del catálogo.' },
    { k: 'pocos', label: 'Encuentra muy poco', st: ['pocos_resultados'], sev: 'warn',
      fix: 'Ampliar con sinónimos o variantes, y revisar stock de lo que sí aparece.' },
    { k: 'relev', label: 'Encuentra, pero lo que no es', st: ['top_irrelevante', 'resultados_dispersos', 'resultados_irrelevantes'], sev: 'warn',
      fix: 'Ajustar reglas de relevancia o de merchandising para que arriba aparezca lo que se buscó.' },
    { k: 'redir', label: 'Redirige a una categoría', st: ['redirige_a_plp'], sev: 'info',
      fix: 'Validar que la categoría de destino sea la correcta y tenga stock.' },
  ];
  const BAD = new Set(['sin_resultados', 'motor_no_indexa', 'pocos_resultados', 'top_irrelevante', 'resultados_dispersos', 'resultados_irrelevantes']);
  const VAR_KIND = { tilde: 'sin tilde', espacio: 'junto/separado', plural: 'plural', tipeo: 'mal escrito' };
  const DOW = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

  const pill = (s) => (s ? `<span class="pill ${STATUS_PILL[s] || 'n'}">${W.esc(STATUS_LABEL[s] || s)}</span>` : '<span class="muted">sin medir</span>');
  const plata = (n) => (Number.isFinite(n)
    ? `$${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '');
  const delta = (cur, prev) => (prev > 0 ? cur / prev - 1 : cur > 0 ? Infinity : null);
  const fmtDelta = (d) => {
    if (d == null) return '<span class="muted">—</span>';
    if (d === Infinity) return '<span class="sx-d up">nuevo</span>';
    const c = d > 0.05 ? 'up' : d < -0.05 ? 'down' : 'flat';
    return `<span class="sx-d ${c}">${d > 0 ? '↑' : d < 0 ? '↓' : '→'} ${W.fmtPct(Math.abs(d), 0)}</span>`;
  };
  const spark = (w, color = '#4f46e5') => (w && w.some((x) => x > 0) ? W.chart.sparkline(w, color, 90, 24) : '');

  // Estado de la vista (sobrevive a los re-render mientras no se recargue).
  const S = { tab: 'resumen', trendWin: 'semana', q: '', filt: 'todos', page: 1, sort: 'n' };
  let D = null, I = null, byTerm = null, rows = null, invalidRun = false;

  // ── Modelo: un término con todo lo que se sabe de él ─────────────────────
  function buildModel() {
    byTerm = new Map();
    const diag = D?.terms || (D?.problems || []).concat((D?.topTerms || []).filter((t) => t.status === 'ok'));
    // Un "redirect" al login del admin de VTEX no es un redirect del buscador:
    // es el error de las corridas del 22/9 al 29/9 (se consultaba el host
    // interno). Hasta que llegue una corrida nueva, esos términos se muestran
    // como "sin medir" en vez de con un dato falso.
    const bogus = (u) => /\/admin\b|login\.aspx|vtexcommercestable/i.test(String(u || ''));
    for (const t of diag) {
      if (t.status === 'redirige_a_plp' && bogus(t.redirectUrl)) continue;
      byTerm.set(t.term, { ...t });
    }
    invalidRun = diag.length > 0 && byTerm.size === 0;
    rows = [];
    if (I?.terms?.length) {
      for (const t of I.terms) {
        const d = byTerm.get(t.t);
        rows.push({ t: t.t, n: t.n, p: t.p, u: t.u, n7: t.n7, p7: t.p7, w: t.w, f: t.f, v: t.v, of: t.of,
          d: delta(t.n, t.p), d7: delta(t.n7, t.p7), rep: t.u ? t.n / t.u : null, diag: d || null });
      }
      // Términos medidos por el diagnóstico que GA4 no trajo en su top.
      const seen = new Set(rows.map((r) => r.t));
      for (const [t, d] of byTerm) if (!seen.has(t)) rows.push({ t, n: d.searchCount, diag: d, d: null, d7: null });
    } else {
      for (const [t, d] of byTerm) rows.push({ t, n: d.searchCount, diag: d, d: null, d7: null });
    }
    rows.sort((a, b) => b.n - a.n);
    rows.forEach((r, i) => { r.rank = i + 1; });
  }

  // ── Accionables: qué hacer hoy, ordenado por búsquedas afectadas ─────────
  function actions() {
    const out = [];
    const sum = (list, f = (r) => r.n) => list.reduce((s, r) => s + (f(r) || 0), 0);
    const measured = rows.filter((r) => r.diag);

    for (const g of GROUPS) {
      const list = measured.filter((r) => g.st.includes(r.diag.status));
      if (!list.length) continue;
      if (g.k === 'redir') {
        out.push({ sev: 'info', icon: 'layers', impact: sum(list), title: `${list.length} términos redirigen a una categoría`,
          text: `${W.fmtNumC(sum(list))} búsquedas/mes no ven una página de resultados. ${g.fix}`,
          terms: list.slice(0, 6), go: { tab: 'calidad' } });
        continue;
      }
      out.push({ sev: g.sev, icon: g.sev === 'bad' ? 'alert' : 'warn', impact: sum(list),
        title: `${g.label}: ${list.length} término${list.length === 1 ? '' : 's'}`,
        text: `${W.fmtNumC(sum(list))} búsquedas/mes afectadas. ${g.fix}`,
        terms: list.slice(0, 6), go: { tab: 'demanda', filt: 'problema' } });
    }

    if (I) {
      // Sinónimos: variantes mal escritas o junto/separado de términos grandes.
      const syn = rows.filter((r) => r.v?.some((v) => v[2] === 'tipeo' || v[2] === 'espacio'));
      if (syn.length) {
        const vol = sum(syn, (r) => r.v.filter((v) => v[2] === 'tipeo' || v[2] === 'espacio').reduce((s, v) => s + v[1], 0));
        out.push({ sev: 'warn', icon: 'tag', impact: vol, title: `Sinónimos para cargar: ${syn.length} términos con variantes`,
          text: `La gente escribe distinto lo mismo (${W.fmtNumC(vol)} búsquedas/mes en variantes mal escritas o junto/separado). Cargarlas como sinónimo asegura que todas vean los mismos resultados.`,
          terms: syn.slice(0, 6), go: { tab: 'demanda', filt: 'variantes' }, exportKey: 'buscadorSinonimos' });
      }
      const minVol = Math.max(200, (I.totals?.cur || 0) / 4.3 / 2500);
      const up = rows.filter((r) => r.n7 >= minVol && r.d7 != null && r.d7 >= 0.4).sort((a, b) => (b.n7 - b.p7) - (a.n7 - a.p7));
      if (up.length) {
        out.push({ sev: 'good', icon: 'trend', impact: sum(up, (r) => r.n7 - r.p7) * 4.3,
          title: `${up.length} búsquedas en alza esta semana`,
          text: 'Demanda que está creciendo: asegurar stock y precio, destacarlas en home o banners, y crear o reforzar su landing para SEO.',
          terms: up.slice(0, 6), go: { tab: 'tendencias', trendWin: 'semana' } });
      }
      const nuevos = rows.filter((r) => r.d === Infinity && r.n >= minVol * 2);
      if (nuevos.length) {
        out.push({ sev: 'good', icon: 'sparkles', impact: sum(nuevos), title: `${nuevos.length} búsquedas nuevas este mes`,
          text: 'No aparecían el mes anterior. Suelen ser lanzamientos, temporada o algo que se viralizó: revisar que tengamos el producto y que el buscador lo encuentre.',
          terms: nuevos.slice(0, 6), go: { tab: 'tendencias', trendWin: 'mes' } });
      }
      const down = rows.filter((r) => r.p7 >= minVol * 2 && r.d7 != null && r.d7 <= -0.4).sort((a, b) => (a.n7 - a.p7) - (b.n7 - b.p7));
      if (down.length) {
        out.push({ sev: 'warn', icon: 'trendDown', impact: sum(down, (r) => r.p7 - r.n7) * 4.3,
          title: `${down.length} búsquedas cayendo fuerte`,
          text: 'Bajaron 40% o más contra la semana anterior. Si no es estacional, revisar si se quebró stock, cambió el precio o el resultado dejó de ser bueno.',
          terms: down.slice(0, 6), go: { tab: 'tendencias', trendWin: 'semana' } });
      }
      // Frustración: la misma persona repite la búsqueda muchas veces.
      const repAvg = rows.slice(0, 300).filter((r) => r.rep).map((r) => r.rep).sort((a, b) => a - b);
      const med = repAvg[Math.floor(repAvg.length / 2)] || 0;
      const rep = rows.slice(0, 300).filter((r) => r.rep && med && r.rep >= med * 1.6 && r.n >= minVol * 4);
      if (rep.length) {
        out.push({ sev: 'warn', icon: 'refresh', impact: sum(rep), title: `${rep.length} términos que la gente busca una y otra vez`,
          text: `Se buscan ${W.fmtDec(med * 1.6, 1)} veces o más por usuario (lo normal es ${W.fmtDec(med, 1)}). Suele ser señal de que no encuentra lo que quiere a la primera: revisar el top de resultados.`,
          terms: rep.slice(0, 6), go: { tab: 'demanda', filt: 'repite' } });
      }
      const q = I.quality || {};
      const tot = I.totals?.cur || 0;
      if (q.encoded && tot && q.encoded / tot > 0.01) {
        out.push({ sev: 'warn', icon: 'info', impact: q.encoded, title: 'El tag de GA4 guarda términos codificados',
          text: `${W.fmtPct(q.encoded / tot, 1)} de las búsquedas llega como "papel%20higienico" en vez de "papel higienico". Acá se corrige al leer, pero en GA4 esos términos aparecen partidos: pedirle al equipo de analítica que envíe search_term decodificado.`,
          chips: q.encodedTerms.slice(0, 5).map((x) => x[0]), go: null });
      }
      if (q.empty && tot && q.empty / tot > 0.005) {
        out.push({ sev: 'info', icon: 'search', impact: q.empty, title: `${W.fmtNumC(q.empty)} búsquedas vacías`,
          text: 'Se dispara el evento de búsqueda sin texto. Suele ser el botón de la lupa sin escribir nada: conviene mostrar sugerencias o populares al abrir el buscador en vez de una búsqueda vacía.', go: null });
      }
      if (q.numeric && tot && q.numeric / tot > 0.002) {
        out.push({ sev: 'info', icon: 'box', impact: q.numeric, title: 'Hay gente que busca por código',
          text: `${W.fmtNumC(q.numeric)} búsquedas son números largos (EAN o código de producto). Verificar que el EAN esté indexado en el buscador.`,
          chips: q.numericTerms.slice(0, 5).map((x) => x[0]), go: null });
      }
    }
    if (invalidRun) {
      out.unshift({ sev: 'bad', icon: 'alert', impact: Infinity, title: 'El último diagnóstico del buscador no es válido',
        text: 'La corrida consultó una dirección interna de VTEX que manda todo al login del admin, y marcó todos los términos como redirigidos. Ya está corregido: la próxima corrida diaria (6:00) trae el diagnóstico real. Mientras tanto, el estado del buscador se muestra como "sin medir".', go: null });
    }
    if (D?.redirectProbe?.sospechoso) {
      out.unshift({ sev: 'bad', icon: 'alert', impact: Infinity, title: 'La detección de redirecciones falló en la última corrida',
        text: `${D.redirectProbe.sospechoso} El resto del diagnóstico sí es válido.`, go: null });
    }
    const w = { bad: 0, warn: 1, good: 2, info: 3 };
    return out.sort((a, b) => w[a.sev] - w[b.sev] || b.impact - a.impact);
  }

  // ── Exports ──────────────────────────────────────────────────────────────
  function setExports(ctx) {
    ctx.exports.buscadorDemanda = {
      filename: 'webdash-buscador-demanda.csv',
      headers: ['ranking', 'termino', 'busquedas_30d', 'busquedas_30d_anteriores', 'variacion_mes', 'busquedas_7d', 'variacion_semana',
        'busquedas_por_usuario', 'estado_buscador', 'resultados', 'precision_top', 'categoria_dominante', 'variantes', 'recomendacion'],
      rows: rows.map((r) => [r.rank, r.t, r.n, r.p ?? '', r.d == null || r.d === Infinity ? '' : Number(r.d.toFixed(3)),
        r.n7 ?? '', r.d7 == null || r.d7 === Infinity ? '' : Number(r.d7.toFixed(3)), r.rep ? Number(r.rep.toFixed(2)) : '',
        r.diag ? STATUS_LABEL[r.diag.status] || r.diag.status : '', r.diag?.results ?? '', r.diag?.precision ?? '',
        r.diag?.category || '', (r.v || []).map((v) => `${v[0]} (${VAR_KIND[v[2]]})`).join(' | '), r.diag?.recommendation || '']),
    };
    // Formato de sinónimos: una fila por término con sus variantes, listo para
    // cargar en el admin del buscador.
    ctx.exports.buscadorSinonimos = {
      filename: 'webdash-buscador-sinonimos.csv',
      headers: ['termino_principal', 'sinonimos', 'busquedas_en_variantes', 'tipo'],
      rows: rows.filter((r) => r.v?.length).map((r) => [r.t, r.v.map((v) => v[0]).join(', '),
        r.v.reduce((s, v) => s + v[1], 0), [...new Set(r.v.map((v) => VAR_KIND[v[2]]))].join(', ')]),
    };
    ctx.exports.buscadorProblemas = {
      filename: 'webdash-buscador-problemas.csv',
      headers: ['termino', 'busquedas', 'estado', 'productos', 'categoria_dominante', 'redirige_a', 'sugerencia', 'recomendacion'],
      rows: rows.filter((r) => r.diag && r.diag.status !== 'ok').map((r) => [r.t, r.n, STATUS_LABEL[r.diag.status] || r.diag.status,
        r.diag.results ?? '', r.diag.category || '', r.diag.redirectUrl || '', r.diag.suggestion || r.diag.nativeCorrection || '', r.diag.recommendation || '']),
    };
  }

  // ── Pestaña: Resumen ─────────────────────────────────────────────────────
  function termChips(list) {
    return `<div class="sx-chips">${list.map((r) => `<button class="sx-chip" data-term="${W.esc(r.t || r)}">${W.esc(r.t || r)}${r.n ? `<em>${W.fmtNumC(r.n)}</em>` : ''}</button>`).join('')}</div>`;
  }

  function tabResumen() {
    const f = D?.funnel || {};
    const measured = rows.filter((r) => r.diag);
    const volM = measured.reduce((s, r) => s + r.n, 0);
    const volBad = measured.filter((r) => BAD.has(r.diag.status)).reduce((s, r) => s + r.n, 0);
    const health = volM ? 1 - volBad / volM : null;
    const tot = I?.totals;
    const acts = actions();
    const kpi = (icon, label, value, sub, extra = '') => `<div class="tile sx-kpi"><div class="tile-t"><span class="tile-l">${label}</span><span class="tile-ic">${W.icon(icon, 15)}</span></div>
      <div class="tile-v">${value}</div><div class="tile-s">${sub}</div>${extra}</div>`;
    const daily = I?.daily || [];

    return `
      <div class="sx-kpis">
        ${kpi('search', 'Búsquedas (30 días)', tot ? W.fmtNumC(tot.cur) : f.busquedas ? W.fmtNumC(f.busquedas) : '—',
    tot ? `${fmtDelta(delta(tot.cur, tot.prev))} vs. 30 días anteriores` : 'evento "search" de GA4',
    daily.length ? `<div class="tile-spark">${W.chart.sparkline(daily.slice(-30).map((x) => x.s), '#4f46e5', 160, 26)}</div>` : '')}
        ${kpi('users', 'Usa el buscador', f.usuariosTotales ? W.fmtPct(f.usuariosBuscaron / f.usuariosTotales, 1) : '—',
    f.usuariosBuscaron ? `${W.fmtNumC(f.usuariosBuscaron)} usuarios · ${W.fmtDec(f.busquedasPorUsuario || 0, 1)} búsquedas c/u` : '')}
        ${kpi('check', 'Salud del buscador', health == null ? '—' : W.fmtPct(health, 0),
    health == null ? 'sin diagnóstico' : `del volumen de los ${measured.length} términos más buscados se responde bien`,
    health == null ? '' : `<div class="sx-meter"><i style="width:${Math.round(health * 100)}%;background:${health >= 0.85 ? 'var(--pos)' : health >= 0.65 ? 'var(--warn)' : 'var(--neg)'}"></i></div>`)}
        ${kpi('alert', 'Búsquedas con problema', W.fmtNumC(volBad), volM ? `${W.fmtPct(volBad / volM, 1)} de las búsquedas medidas, por mes` : '')}
        ${tot ? kpi('layers', 'Términos distintos', W.fmtNumC(tot.distinct), `los 100 primeros son el ${W.fmtPct(tot.top100 / tot.cur, 0)} del volumen`) : ''}
      </div>

      <div class="sx-sec"><h3>Qué hacer ahora</h3><span>ordenado por gravedad y búsquedas afectadas · clic en un término para ver su ficha</span></div>
      ${acts.length ? `<div class="sx-acts">${acts.map((a, i) => `
        <div class="sx-act ${a.sev}">
          <div class="sx-act-h"><span class="sx-act-ic">${W.icon(a.icon, 16)}</span><h4>${W.esc(a.title)}</h4>
            ${Number.isFinite(a.impact) && a.impact > 0 ? `<span class="sx-imp">${W.fmtNumC(Math.round(a.impact))} búsq./mes</span>` : ''}</div>
          <p>${W.esc(a.text)}</p>
          ${a.terms ? termChips(a.terms) : ''}
          ${a.chips ? `<div class="sx-chips">${a.chips.map((c) => `<span class="sx-chip static">${W.esc(c)}</span>`).join('')}</div>` : ''}
          ${a.go || a.exportKey ? `<div class="sx-act-f">
            ${a.go ? `<button class="btn-s" data-act="${i}">Ver detalle ${W.icon('chevronR', 12)}</button>` : ''}
            ${a.exportKey ? `<button class="btn-s" data-export="${a.exportKey}">${W.icon('download', 12)}Bajar lista de sinónimos</button>` : ''}
          </div>` : ''}
        </div>`).join('')}</div>`
    : '<div class="card"><div class="chart-empty">Nada urgente: el buscador contesta bien a lo más buscado.</div></div>'}

      ${daily.length > 7 ? `<div class="card">
        <div class="card-h"><div><h3>Búsquedas por día</h3><p>últimos ${daily.length} días · búsquedas y usuarios que buscaron</p></div></div>
        ${W.chart.line({ labels: daily.map((x) => x.d), id: 'sx-daily', height: 210,
    series: [{ name: 'Búsquedas', color: '#4f46e5', values: daily.map((x) => x.s), fill: true },
      { name: 'Usuarios que buscaron', color: '#eb6834', values: daily.map((x) => x.su), dashed: true }] })}
      </div>` : ''}`;
  }

  // ── Pestaña: Tendencias ──────────────────────────────────────────────────
  function trendList(title, icon, list, key, color, empty) {
    return `<div class="card sx-trend">
      <div class="card-h"><div><h3>${W.icon(icon, 15)} ${title}</h3></div></div>
      ${list.length ? `<table class="tbl dense"><tbody>${list.map((r) => `<tr class="sx-row" data-term="${W.esc(r.t)}">
        <td><b>${W.esc(r.t)}</b>${r.diag && BAD.has(r.diag.status) ? ` ${pill(r.diag.status)}` : ''}</td>
        <td class="sx-sp">${spark(r.w, color)}</td>
        <td class="num">${W.fmtNum(key === 'semana' ? r.n7 : r.n)}</td>
        <td class="num">${fmtDelta(key === 'semana' ? r.d7 : r.d)}</td>
      </tr>`).join('')}</tbody></table>` : `<div class="chart-empty">${empty}</div>`}
    </div>`;
  }

  function tabTendencias() {
    if (!I) return noInsights();
    const win = S.trendWin;
    const cur = (r) => (win === 'semana' ? r.n7 : r.n) || 0;
    const prev = (r) => (win === 'semana' ? r.p7 : r.p) || 0;
    const minVol = win === 'semana' ? Math.max(150, (I.totals.cur / 4.3) / 3000) : Math.max(500, I.totals.cur / 3000);
    const pool = rows.filter((r) => r.w);
    const up = pool.filter((r) => prev(r) > 0 && cur(r) >= minVol && cur(r) > prev(r) * 1.15)
      .sort((a, b) => (cur(b) - prev(b)) - (cur(a) - prev(a))).slice(0, 15);
    const down = pool.filter((r) => prev(r) >= minVol && cur(r) < prev(r) * 0.85)
      .sort((a, b) => (cur(a) - prev(a)) - (cur(b) - prev(b))).slice(0, 15);
    const nuevos = pool.filter((r) => prev(r) === 0 && cur(r) >= minVol * 0.6).sort((a, b) => cur(b) - cur(a)).slice(0, 15);
    return `
      <div class="sx-bar">
        <div class="seg-ctl">${[['semana', 'Esta semana vs. la anterior'], ['mes', 'Últimos 30 días vs. los 30 anteriores']]
    .map(([k, l]) => `<button data-win="${k}" class="${win === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        <span class="muted">ordenado por búsquedas ganadas o perdidas, no por porcentaje: una suba de 10 a 30 no mueve nada</span>
      </div>
      <div class="sx-trends">
        ${trendList('En alza', 'trend', up, win, '#1baf7a', 'Nada creció de forma notable.')}
        ${trendList('En baja', 'trendDown', down, win, '#e34948', 'Nada cayó de forma notable.')}
        ${trendList('Nuevas', 'sparkles', nuevos, win, '#4f46e5', 'No hay búsquedas nuevas con volumen.')}
      </div>
      <p class="sx-foot">La línea chica es la evolución de las últimas 8 semanas. Qué hacer: lo que sube, tenerlo en stock y visible (home, banners, landing SEO);
        lo que baja sin ser estacional, revisar stock, precio y qué devuelve el buscador.</p>`;
  }

  // ── Pestaña: Demanda ─────────────────────────────────────────────────────
  const FILTERS = [
    ['todos', 'Todos'], ['problema', 'Con problema'], ['alza', 'En alza'], ['baja', 'En baja'],
    ['variantes', 'Con variantes'], ['repite', 'Se repite mucho'], ['redir', 'Redirigen'],
  ];
  function filtered() {
    const q = S.q.trim().toLowerCase();
    const med = (() => { const a = rows.slice(0, 300).filter((r) => r.rep).map((r) => r.rep).sort((x, y) => x - y); return a[Math.floor(a.length / 2)] || 0; })();
    let list = rows.filter((r) => !r.of); // las variantes se ven dentro de su término principal
    if (q) list = rows.filter((r) => r.t.includes(q));
    const f = S.filt;
    if (f === 'problema') list = list.filter((r) => r.diag && BAD.has(r.diag.status));
    else if (f === 'alza') list = list.filter((r) => r.d7 != null && r.d7 >= 0.25 && (r.n7 || 0) >= 50);
    else if (f === 'baja') list = list.filter((r) => r.d7 != null && r.d7 <= -0.25 && (r.p7 || 0) >= 50);
    else if (f === 'variantes') list = list.filter((r) => r.v?.length);
    else if (f === 'repite') list = list.filter((r) => r.rep && med && r.rep >= med * 1.6);
    else if (f === 'redir') list = list.filter((r) => r.diag?.status === 'redirige_a_plp');
    const key = { n: (r) => r.n, d: (r) => (r.d === Infinity ? 99 : r.d ?? -99), d7: (r) => (r.d7 === Infinity ? 99 : r.d7 ?? -99), rep: (r) => r.rep ?? 0 }[S.sort] || ((r) => r.n);
    return list.slice().sort((a, b) => key(b) - key(a));
  }

  function tabDemanda() {
    const list = filtered();
    const shown = list.slice(0, S.page * 50);
    const th = (k, l) => `<th class="num sx-sort${S.sort === k ? ' on' : ''}" data-sort="${k}">${l}${S.sort === k ? ' ↓' : ''}</th>`;
    return `
      <div class="card">
        <div class="card-h">
          <div class="sx-tools">
            <input class="inp sx-q" id="sx-q" type="search" placeholder="Buscar un término…" value="${W.esc(S.q)}" />
            <div class="sx-filters">${FILTERS.map(([k, l]) => `<button class="chip-sm${S.filt === k ? ' on' : ''}" data-filt="${k}">${l}</button>`).join('')}</div>
          </div>
          <button class="btn" data-export="buscadorDemanda">${W.icon('download', 14)}XLSX</button>
        </div>
        <p class="sx-cnt">${W.fmtNum(list.length)} términos${S.q || S.filt !== 'todos' ? ' con este filtro' : ''} · ${W.fmtNumC(list.reduce((s, r) => s + r.n, 0))} búsquedas/mes</p>
        <div class="tbl-wrap"><table class="tbl dense sx-tbl">
          <thead><tr><th class="num">#</th><th>Término</th>${th('n', 'Búsq. 30 d')}${I ? th('d', 'vs. mes ant.') + th('d7', 'vs. sem. ant.') + '<th>8 semanas</th>' + th('rep', 'Por usuario') : ''}<th>Buscador</th><th class="num">Resultados</th><th></th></tr></thead>
          <tbody>${shown.length ? shown.map((r) => `<tr class="sx-row" data-term="${W.esc(r.t)}">
            <td class="num muted">${r.rank}</td>
            <td><b>${W.esc(r.t)}</b>${r.v?.length ? ` <span class="sx-var" title="${W.esc(r.v.map((v) => `${v[0]} (${VAR_KIND[v[2]]})`).join(', '))}">+${r.v.length} variante${r.v.length > 1 ? 's' : ''}</span>` : ''}${r.of ? ` <span class="sx-var">variante de ${W.esc(r.of)}</span>` : ''}</td>
            <td class="num">${W.fmtNum(r.n)}</td>
            ${I ? `<td class="num">${fmtDelta(r.d)}</td><td class="num">${fmtDelta(r.d7)}</td><td class="sx-sp">${spark(r.w)}</td><td class="num">${r.rep ? W.fmtDec(r.rep, 1) : '—'}</td>` : ''}
            <td>${pill(r.diag?.status)}</td>
            <td class="num">${r.diag?.results == null ? '—' : `${W.fmtNum(r.diag.results)}${r.diag.capped ? '+' : ''}`}</td>
            <td class="sx-go">${W.icon('chevronR', 14)}</td>
          </tr>`).join('') : `<tr><td colspan="11" class="muted">Ningún término con este filtro.</td></tr>`}</tbody>
        </table></div>
        ${list.length > shown.length ? `<button class="btn blk" id="sx-more">Mostrar 50 más (${W.fmtNum(list.length - shown.length)} restantes)</button>` : ''}
      </div>
      <p class="sx-foot">"Por usuario" = cuántas veces busca lo mismo cada persona: si es mucho más alto que el resto, probablemente no encuentra a la primera.
        El estado del buscador se mide a diario sobre los ${W.fmtNum(D?.termsAnalyzed || 0)} términos más buscados.</p>`;
  }

  // ── Pestaña: Calidad ─────────────────────────────────────────────────────
  function tabCalidad() {
    if (!D) return '<div class="card"><div class="chart-empty">Todavía no hay diagnóstico del buscador.</div></div>';
    const measured = rows.filter((r) => r.diag);
    const vol = measured.reduce((s, r) => s + r.n, 0);
    const byStatus = {};
    for (const r of measured) byStatus[r.diag.status] = (byStatus[r.diag.status] || 0) + r.n;
    const order = ['ok', 'redirige_a_plp', 'resultados_dispersos', 'top_irrelevante', 'resultados_irrelevantes', 'pocos_resultados', 'motor_no_indexa', 'sin_resultados', 'error_consulta'];
    const COLORS = { ok: '#1baf7a', redirige_a_plp: '#8b93a5', resultados_dispersos: '#eda100', top_irrelevante: '#f0b429', resultados_irrelevantes: '#eb6834', pocos_resultados: '#f5a623', motor_no_indexa: '#e34948', sin_resultados: '#b91c1c', error_consulta: '#cbd5e1' };
    const segs = order.filter((k) => byStatus[k]);
    const cmp = D.comparison;
    const hist = D.historia || [];

    return `
      <div class="card">
        <div class="card-h"><div><h3>Cómo contesta el buscador a lo más buscado</h3>
          <p>${W.esc(D.engineLabel || '')} · ${measured.length} términos · pesado por búsquedas, no por cantidad de términos</p></div>
          <button class="btn" data-export="buscadorProblemas">${W.icon('download', 14)}XLSX</button></div>
        <div class="sx-stack">${segs.map((k) => `<i style="flex:${byStatus[k]};background:${COLORS[k]}" ${W.chart.tip(`<strong>${W.esc(STATUS_LABEL[k])}</strong><span class="tip-row">${W.fmtNumC(byStatus[k])} búsquedas · ${W.fmtPct(byStatus[k] / vol, 1)}</span>`)}></i>`).join('')}</div>
        <div class="legend sx-leg">${segs.map((k) => `<span class="lg"><i style="background:${COLORS[k]}"></i>${W.esc(STATUS_LABEL[k])} <b>${W.fmtPct(byStatus[k] / vol, 0)}</b></span>`).join('')}</div>
      </div>

      ${GROUPS.map((g) => {
    const list = measured.filter((r) => g.st.includes(r.diag.status));
    if (!list.length) return '';
    return `<div class="card">
          <div class="card-h"><div><h3>${W.esc(g.label)} <span class="sx-n">${list.length}</span></h3><p>${W.esc(g.fix)}</p></div></div>
          <div class="tbl-wrap"><table class="tbl dense"><thead><tr><th>Término</th><th class="num">Búsquedas</th><th>Estado</th><th class="num">Resultados</th><th>Qué trae / a dónde va</th></tr></thead>
          <tbody>${list.slice(0, 25).map((r) => `<tr class="sx-row" data-term="${W.esc(r.t)}">
            <td><b>${W.esc(r.t)}</b>${r.diag.suggestion || r.diag.nativeCorrection ? `<div class="scope">probá "${W.esc(r.diag.suggestion || r.diag.nativeCorrection)}"</div>` : ''}</td>
            <td class="num">${W.fmtNum(r.n)}</td><td>${pill(r.diag.status)}</td>
            <td class="num">${r.diag.results == null ? '—' : W.fmtNum(r.diag.results)}</td>
            <td class="scope">${r.diag.redirectUrl ? `→ ${W.esc(r.diag.redirectUrl)}` : W.esc((r.diag.sample || []).slice(0, 2).join(' · ') || otherEngineHint(r) || '—')}</td>
          </tr>`).join('')}</tbody></table></div>
          ${list.length > 25 ? `<p class="sx-foot">y ${list.length - 25} más en el XLSX.</p>` : ''}
        </div>`;
  }).join('')}

      ${cmp?.motores && Object.keys(cmp.motores).length > 1 ? `<div class="card">
        <div class="card-h"><div><h3>Motor contra motor</h3><p>los mismos términos, juzgados con el mismo criterio · la precisión es qué parte del top menciona lo buscado</p></div></div>
        <div class="tbl-wrap"><table class="tbl dense"><thead><tr><th>Motor</th><th class="num">Precisión del top</th><th class="num">Responde bien</th><th class="num">Sin resultados</th><th class="num">Top sin relación / disperso</th><th class="num">Búsquedas mal resueltas</th><th>Contra el actual</th></tr></thead>
        <tbody>${Object.entries(cmp.motores).map(([id, m]) => `<tr>
          <td><b>${W.esc(m.label)}</b>${id === cmp.primario ? ' <span class="pill n">en el sitio</span>' : ''}</td>
          <td class="num">${m.precisionTop == null ? '—' : W.fmtPct(m.precisionTop, 0)}</td>
          <td class="num">${W.fmtNum(m.ok)}</td><td class="num">${W.fmtNum(m.sin_resultados)}</td>
          <td class="num">${W.fmtNum((m.top_irrelevante || 0) + (m.resultados_dispersos || 0))}</td>
          <td class="num"><b>${W.fmtNumC(m.busquedasMalas)}</b></td>
          <td>${m.mejoresQue ? `<span class="sx-d up">mejor en ${W.fmtNumC(m.mejoresQue.busquedasGanadas)}</span> · <span class="sx-d down">peor en ${W.fmtNumC(m.mejoresQue.busquedasPerdidas)}</span>` : '—'}</td>
        </tr>`).join('')}</tbody></table></div>
      </div>` : ''}

      ${hist.length > 1 ? `<div class="card"><div class="card-h"><div><h3>Evolución diaria del diagnóstico</h3><p>búsquedas mal resueltas por corrida — si sube, algo empeoró</p></div></div>
        ${W.chart.line({ labels: hist.map((h) => h.date), id: 'sx-hist', height: 190,
    series: [{ name: 'Búsquedas con problema', color: '#e34948', values: hist.map((h) => h.lostSearches || 0) }] })}</div>` : ''}`;
  }
  function otherEngineHint(r) {
    const e = Object.entries(r.diag.engines || {}).find(([id, x]) => id !== D.engine && x.results > 0 && x.status === 'ok');
    return e ? `${D.comparison?.motores?.[e[0]]?.label || e[0]} sí lo encuentra (${W.fmtNum(e[1].results)} productos)` : '';
  }

  // ── Pestaña: Hábitos ─────────────────────────────────────────────────────
  function tabHabitos() {
    if (!I) return noInsights();
    const H = I.heat || [];
    const max = Math.max(1, ...H.flat());
    // Semana arrancando el lunes.
    const orderDow = [1, 2, 3, 4, 5, 6, 0];
    let best = [0, 0, 0];
    H.forEach((row, d) => row.forEach((v, h) => { if (v > best[2]) best = [d, h, v]; }));
    const dev = I.devices || [];
    const devTot = dev.reduce((s, x) => s + x.s, 0);
    const DEV = { mobile: 'Celular', desktop: 'Computadora', tablet: 'Tablet', smart_tv: 'TV' };
    const t = I.totals || {};
    const cum = [[10, t.top10], [100, t.top100], [1000, t.top1000]];

    return `
      <div class="g2">
        <div class="card">
          <div class="card-h"><div><h3>Cuándo busca la gente</h3><p>búsquedas por día y hora, últimas 4 semanas · pico: ${DOW[best[0]]} a las ${best[1]} h</p></div></div>
          <div class="sx-heat">
            <div></div>${Array.from({ length: 24 }, (_, h) => `<span class="sx-hh">${h % 3 === 0 ? h : ''}</span>`).join('')}
            ${orderDow.map((d) => `<span class="sx-hd">${DOW[d]}</span>${(H[d] || []).map((v, h) => `<i style="--a:${(0.06 + 0.94 * (v / max)).toFixed(3)}" ${W.chart.tip(`<strong>${DOW[d]} ${h}:00</strong><span class="tip-row">${W.fmtNum(v)} búsquedas</span>`)}></i>`).join('')}`).join('')}
          </div>
          <p class="sx-foot">Sirve para programar campañas, mailings y cambios en el buscador: tocar reglas en las horas de menos tráfico, lanzar en las de más.</p>
        </div>
        <div class="card">
          <div class="card-h"><div><h3>Desde dónde busca</h3><p>últimos 30 días</p></div></div>
          <div class="sx-dev">${dev.map((x) => `<div class="sx-dev-r">
            <span class="sx-dev-l">${W.esc(DEV[x.k] || x.k)}</span>
            <span class="au-bar"><i style="width:${devTot ? Math.round((x.s / devTot) * 100) : 0}%"></i></span>
            <span class="sx-dev-n"><b>${W.fmtPct(devTot ? x.s / devTot : 0, 0)}</b> de las búsquedas${x.users ? ` · usa el buscador el ${W.fmtPct(x.su / x.users, 0)} de sus visitantes` : ''}</span>
          </div>`).join('')}</div>
          <h4 class="sx-h4">Cómo escribe</h4>
          <div class="sx-mini">
            <div><b>${t.avgWords ? W.fmtDec(t.avgWords, 1) : '—'}</b><em>palabras por búsqueda</em></div>
            ${cum.map(([k, v]) => `<div><b>${t.cur ? W.fmtPct(v / t.cur, 0) : '—'}</b><em>del volumen en los ${k} términos más buscados</em></div>`).join('')}
          </div>
          <p class="sx-foot">Pocas palabras y mucho volumen concentrado = búsquedas genéricas ("leche", "aceite"): lo que más pesa es el orden del top, no encontrar el producto exacto.</p>
        </div>
      </div>
      ${(I.daily || []).length > 7 ? `<div class="card"><div class="card-h"><div><h3>¿Cuántos llegan a una página de resultados?</h3>
        <p>búsquedas vs. vistas de resultados por día · la diferencia son en gran parte redirecciones a categorías</p></div></div>
        ${W.chart.line({ labels: I.daily.map((x) => x.d), id: 'sx-res', height: 200,
    series: [{ name: 'Búsquedas', color: '#4f46e5', values: I.daily.map((x) => x.s) }, { name: 'Vistas de resultados', color: '#eb6834', values: I.daily.map((x) => x.r), dashed: true }] })}</div>` : ''}`;
  }

  function noInsights() {
    return `<div class="card sx-empty">${W.icon('clock', 22)}<h3>Se completa con la próxima corrida diaria</h3>
      <p>Tendencias, variantes y hábitos salen de GA4 una vez por día (6:00, hora de Argentina). Mañana esta pestaña ya tiene datos.</p></div>`;
  }

  // ── Ficha de un término ──────────────────────────────────────────────────
  function termSheet(term) {
    const r = rows.find((x) => x.t === term) || { t: term, n: 0, diag: byTerm.get(term) };
    const d = r.diag;
    const back = document.createElement('div');
    back.className = 'modal-back';
    const weeks = (I?.weeks || []).map((w) => `S${w.slice(-2)}`);
    back.innerHTML = `<div class="modal-card sx-sheet" role="dialog" aria-label="Ficha de ${W.esc(term)}">
      <div class="modal-hero"><span class="mi">${W.icon('search', 20)}</span>
        <div><h3>"${W.esc(term)}"</h3><p>puesto ${r.rank || '—'} en búsquedas · ${d ? W.esc(STATUS_LABEL[d.status] || d.status) : 'sin medir en el diagnóstico'}</p></div>
        <button class="au-x" data-close>${W.icon('close', 16)}</button></div>
      <div class="modal-body sx-sheet-b">
        <div class="sx-mini">
          <div><b>${W.fmtNum(r.n)}</b><em>búsquedas (30 días)</em></div>
          ${r.p != null ? `<div><b>${fmtDelta(r.d)}</b><em>vs. 30 días anteriores</em></div>` : ''}
          ${r.n7 != null ? `<div><b>${fmtDelta(r.d7)}</b><em>esta semana vs. la anterior</em></div>` : ''}
          ${r.rep ? `<div><b>${W.fmtDec(r.rep, 1)}</b><em>veces por usuario</em></div>` : ''}
        </div>
        ${r.w?.some((x) => x) ? W.chart.line({ labels: weeks, id: 'sx-sheet-ch', height: 150, xFmt: (x) => x, tipTitle: (x) => `Semana ${x.slice(1)}`,
    series: [{ name: 'Búsquedas', color: '#4f46e5', values: r.w, fill: true }] }) : ''}
        ${d ? `<h4 class="sx-h4">Qué contesta el buscador</h4>
          <div class="sx-kv">
            <span>Estado</span><span>${pill(d.status)}</span>
            <span>Resultados</span><span>${d.results == null ? '—' : `${W.fmtNum(d.results)}${d.capped ? '+' : ''}`}</span>
            ${d.precision != null ? `<span>Precisión del top</span><span>${W.fmtPct(d.precision, 0)} menciona lo buscado</span>` : ''}
            ${d.category ? `<span>Categoría dominante</span><span>${W.esc(d.category)}${d.consistency != null ? ` (${W.fmtPct(d.consistency, 0)})` : ''}</span>` : ''}
            ${d.redirectUrl ? `<span>Redirige a</span><span class="sx-url">${W.esc(d.redirectUrl)}</span>` : ''}
            ${d.suggestion || d.nativeCorrection ? `<span>Probá</span><span>"${W.esc(d.suggestion || d.nativeCorrection)}"</span>` : ''}
          </div>
          ${d.sample?.length ? `<div class="sx-sample"><em>Primeros resultados</em><ol>${d.sample.map((s) => `<li>${W.esc(s)}</li>`).join('')}</ol></div>` : ''}
          ${Object.keys(d.engines || {}).length > 1 ? `<div class="sx-engs">${Object.entries(d.engines).map(([id, e]) => `<div><em>${W.esc(D.comparison?.motores?.[id]?.label || id)}</em>${pill(e.status)}<span>${e.results == null ? '' : `${W.fmtNum(e.results)} productos`}</span></div>`).join('')}</div>` : ''}
          ${d.recommendation ? `<p class="sx-rec">${W.icon('info', 14)}${W.esc(d.recommendation)}</p>` : ''}` : ''}
        ${r.f?.length > 1 || r.v?.length ? `<h4 class="sx-h4">Cómo lo escribe la gente</h4>
          <div class="sx-chips">${(r.f || []).map((x) => `<span class="sx-chip static">${W.esc(x[0])}<em>${W.fmtNumC(x[1])}</em></span>`).join('')}
          ${(r.v || []).map((v) => `<span class="sx-chip static var">${W.esc(v[0])}<em>${W.fmtNumC(v[1])} · ${VAR_KIND[v[2]]}</em></span>`).join('')}</div>
          ${r.v?.length ? `<button class="btn-s" data-copy="${W.esc([r.t, ...r.v.map((v) => v[0])].join(', '))}">${W.icon('save', 12)}Copiar como sinónimos</button>` : ''}` : ''}
        <div class="sx-sheet-f"><button class="btn-p" data-compare="${W.esc(term)}">${W.icon('search', 14)}Comparar los motores en vivo</button></div>
      </div></div>`;
    document.body.appendChild(back);
    const close = () => { back.remove(); document.removeEventListener('keydown', esc); };
    const esc = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', esc);
    back.addEventListener('click', (e) => {
      if (e.target === back || e.target.closest('[data-close]')) close();
      const cp = e.target.closest('[data-copy]');
      if (cp) { navigator.clipboard?.writeText(cp.dataset.copy).then(() => W.toast('Copiado: pegalo en los sinónimos del buscador.', 'good')); }
      const cm = e.target.closest('[data-compare]');
      if (cm) { close(); S.tab = 'comparar'; S.compareTerm = cm.dataset.compare; W.render(); }
    });
  }

  // ── Pestaña: Comparar (en vivo) ──────────────────────────────────────────
  function columnaMotor(m) {
    if (m.error) {
      return `<div class="cmpm-col"><div class="cmpm-h"><h4>${W.esc(m.label)}</h4><div class="cmpm-nota">${W.esc(m.nota || '')}</div></div>
        <div class="cmpm-err">No se pudo consultar: ${W.esc(m.error)}</div></div>`;
    }
    const total = m.totalComparable === false
      ? `${W.fmtNum(m.total)} productos rankeados`
      : `${W.fmtNum(m.total)}${m.totalExacto === false ? '+' : ''} producto(s)`;
    const prods = (m.productos || []);
    const cuerpo = prods.length
      ? `<ul class="cmpm-l">${prods.map((p, i) => `<li class="cmpm-p">
          <span class="cmpm-pos">${i + 1}</span>
          ${p.imagen ? `<img src="${W.esc(p.imagen)}" alt="" loading="lazy">` : '<span class="cmpm-sinfoto">sin foto</span>'}
          <span class="cmpm-txt"><span class="cmpm-nom">${W.esc(p.nombre || '(sin nombre)')}</span>
            <span class="cmpm-met">
              ${p.precio != null ? `<span class="cmpm-pre">${plata(p.precio)}</span>` : '<span class="muted">sin precio</span>'}
              ${p.precioLista != null ? `<span class="cmpm-ant">${plata(p.precioLista)}</span>` : ''}
              ${p.disponible === false ? ' · sin stock' : ''}
              ${p.categorias?.length ? ` · ${W.esc(p.categorias.join(' / '))}` : ''}
            </span></span></li>`).join('')}</ul>`
      : `<div class="cmpm-vacio">${m.redirect ? 'No devuelve productos porque el término está redirigido.' : `No devolvió ningún producto.${m.nota ? ` ${W.esc(m.nota)}` : ''}`}</div>`;
    return `<div class="cmpm-col"><div class="cmpm-h"><h4>${W.esc(m.label)}</h4><div class="cmpm-t">${total}</div><div class="cmpm-nota">${W.esc(m.nota || '')}</div></div>
      ${m.redirect ? `<div class="cmpm-redir"><strong>Redirige a</strong> ${W.esc(m.redirect)} — el cliente va a esa categoría y nunca ve una página de resultados.</div>` : ''}
      ${cuerpo}</div>`;
  }

  async function comparar(term, destino) {
    destino.innerHTML = '<p class="muted">Preguntándole a los tres buscadores…</p>';
    let data;
    try {
      const r = await fetch(`/api/buscador-compara?q=${encodeURIComponent(term)}`, { cache: 'no-store' });
      data = await r.json();
      if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
    } catch (e) {
      destino.innerHTML = `<div class="ins bad">${W.icon('alert', 16)}<div><p>No se pudo comparar: ${W.esc(e.message)}</p></div></div>`;
      return;
    }
    const motores = data.motores || [];
    const faltantes = motores.filter((m) => /falta [A-Z_]+/.test(m.error || ''));
    destino.innerHTML = `
      ${faltantes.length ? `<div class="ins warn">${W.icon('warn', 16)}<div><p>${faltantes.map((m) => `<strong>${W.esc(m.label)}</strong>: ${W.esc(m.error)}`).join('. ')}. Se configura como variable de entorno en Vercel.</p></div></div>` : ''}
      <div class="cmpm">${motores.map(columnaMotor).join('')}</div>
      <p class="muted" style="font-size:.75rem;margin-top:.6rem">Consulta en vivo a los tres buscadores, ${W.esc(data.termino)} · ${W.timeAgo(data.consultadoEn)}.</p>`;
  }

  function tabComparar() {
    const sug = rows.slice(0, 8).map((r) => r.t);
    return `<form class="cmpm-form" id="cmpm-f">
        <input type="text" id="cmpm-q" placeholder="Escribí lo que buscaría un cliente: leche, papel higienico, queso rayado…" autocomplete="off" value="${W.esc(S.compareTerm || '')}">
        <button class="btn-p" type="submit">${W.icon('search', 14)}Comparar</button>
      </form>
      ${sug.length ? `<div class="cmpm-sug"><span class="muted" style="font-size:.76rem;align-self:center">De los más buscados:</span>
        ${sug.map((t) => `<button type="button" data-cterm="${W.esc(t)}">${W.esc(t)}</button>`).join('')}</div>` : ''}
      <div id="cmpm-res"><p class="muted">Escribí un término, o elegí uno de los de arriba. Vas a ver los productos que pone primero cada buscador, uno al lado del otro.</p></div>`;
  }

  // ── La vista ─────────────────────────────────────────────────────────────
  const TABS = [
    { id: 'resumen', label: 'Resumen', icon: 'sparkles' },
    { id: 'tendencias', label: 'Tendencias', icon: 'trend' },
    { id: 'demanda', label: 'Demanda', icon: 'layers' },
    { id: 'calidad', label: 'Calidad', icon: 'check' },
    { id: 'habitos', label: 'Hábitos', icon: 'clock' },
    { id: 'comparar', label: 'Comparar motores', icon: 'search' },
  ];

  W.viewBuscador = async function (ctx) {
    const { el } = ctx;
    if (!rows) {
      el.innerHTML = '<div class="loading">Cargando el análisis del buscador…</div>';
      [D, I] = await Promise.all([
        W.load('search-diagnosis').catch(() => null),
        W.load('search-insights').catch(() => null),
      ]);
      if (D) D.historia = await W.load('search-diagnosis-history').catch(() => []);
      buildModel();
    }
    setExports(ctx);
    const nProb = rows.filter((r) => r.diag && BAD.has(r.diag.status)).length;
    const body = { resumen: tabResumen, tendencias: tabTendencias, demanda: tabDemanda, calidad: tabCalidad, habitos: tabHabitos, comparar: tabComparar }[S.tab]();

    el.innerHTML = `
      <div class="seg-ctl sx-tabs">${TABS.map((t) => `<button data-tab="${t.id}" class="${S.tab === t.id ? 'on' : ''}">${W.icon(t.icon, 14)}${t.label}${t.id === 'calidad' && nProb ? ` <span class="au-count">${nProb}</span>` : ''}</button>`).join('')}</div>
      ${body}
      <p class="sx-src">Demanda: GA4, ${I ? `actualizado ${W.timeAgo(I.generatedAt)}` : 'todavía sin inteligencia de búsqueda'} · Diagnóstico: ${D ? `${W.fmtNum(D.termsAnalyzed || 0)} términos, ${W.timeAgo(D.generatedAt)}` : 'sin corrida'}
        · La comparación de motores consulta en vivo.</p>`;

    wire(el);
    if (S.tab === 'comparar' && S.compareTerm) { comparar(S.compareTerm, el.querySelector('#cmpm-res')); }
  };

  function wire(el) {
    el.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { S.tab = b.dataset.tab; S.compareTerm = ''; W.render(); }));
    el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
      const a = actions()[Number(b.dataset.act)];
      if (!a?.go) return;
      Object.assign(S, { page: 1, q: '' }, a.go);
      W.render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }));
    el.querySelectorAll('[data-term]').forEach((b) => b.addEventListener('click', () => termSheet(b.dataset.term)));
    el.querySelectorAll('[data-win]').forEach((b) => b.addEventListener('click', () => { S.trendWin = b.dataset.win; W.render(); }));
    el.querySelectorAll('[data-filt]').forEach((b) => b.addEventListener('click', () => { S.filt = b.dataset.filt; S.page = 1; W.render(); }));
    el.querySelectorAll('[data-sort]').forEach((b) => b.addEventListener('click', () => { S.sort = b.dataset.sort; W.render(); }));
    el.querySelector('#sx-more')?.addEventListener('click', () => { S.page += 1; W.render(); });
    const q = el.querySelector('#sx-q');
    if (q) {
      let t;
      q.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => {
          S.q = q.value; S.page = 1;
          const pos = q.selectionStart;
          W.render().then(() => { const n = document.getElementById('sx-q'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } });
        }, 200);
      });
    }
    const f = el.querySelector('#cmpm-f');
    if (f) {
      const input = el.querySelector('#cmpm-q');
      const res = el.querySelector('#cmpm-res');
      f.addEventListener('submit', (e) => { e.preventDefault(); const t = input.value.trim(); if (t) { S.compareTerm = t; comparar(t, res); } });
      el.querySelectorAll('[data-cterm]').forEach((b) => b.addEventListener('click', () => { input.value = b.dataset.cterm; S.compareTerm = b.dataset.cterm; comparar(b.dataset.cterm, res); }));
    }
  }
})();

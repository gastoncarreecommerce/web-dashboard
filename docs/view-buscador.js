/* global window, document */
/**
 * Vista "Buscador": diagnóstico del buscador del sitio, para entender por
 * qué viene golpeando el NPS y qué hacer al respecto.
 *
 * De dónde sale cada dato (nada se inventa acá, todo viene ya calculado por
 * src/inspect-search-diagnosis.js):
 *   - "qué busca la gente" → GA4, evento "search" del sitio web.
 *   - "si esa búsqueda encuentra algo" → catálogo REAL de VTEX, consultado
 *     con el mismo término (misma API que usa la miniatura de producto).
 *   - "sinónimo sugerido" → variantes por errores de tipeo típicos del
 *     español, cada una VERIFICADA contra VTEX antes de sugerirse (no es
 *     una adivinanza).
 *   - "tendencia" → una foto por día, guardada en cada corrida automática.
 *
 * Esta vista no depende del rango de fechas/segmento del resto del
 * dashboard (igual que Audiencias): la ventana de análisis la define GA4
 * (últimos 30 días), no el selector de arriba.
 */
(function () {
  const W = (window.W = window.W || {});

  const STATUS_LABEL = {
    redirige_a_plp: 'Redirige a categoría', motor_no_indexa: 'No está en el índice', sin_resultados: 'Sin resultados', pocos_resultados: 'Pocos resultados',
    resultados_dispersos: 'Resultados dispersos', resultados_irrelevantes: 'No es lo que se buscaba',
    error_consulta: 'Error de consulta', ok: 'OK',
  };
  const STATUS_PILL = {
    redirige_a_plp: 'n', motor_no_indexa: 'no', sin_resultados: 'no', pocos_resultados: 'w', resultados_dispersos: 'w',
    resultados_irrelevantes: 'no', error_consulta: 'n', ok: 'ok',
  };

  function pill(status) {
    return `<span class="pill ${STATUS_PILL[status] || 'n'}">${W.esc(STATUS_LABEL[status] || status)}</span>`;
  }

  function recKind(text) {
    if (/alta prioridad|no traen ningún resultado/i.test(text)) return 'bad';
    if (/estima|revisar/i.test(text)) return 'warn';
    return 'info';
  }

  W.viewBuscador = async function (ctx) {
    const { el } = ctx;
    let report, history;
    try {
      report = await W.load('search-diagnosis');
    } catch {
      el.innerHTML = `<div class="empty"><h2>Todavía no hay diagnóstico del buscador</h2>
        <p>Corré el workflow "WebDash inspect search (GA4)" (o esperá la corrida automática diaria) para generar el primer reporte.</p></div>`;
      return;
    }
    history = await W.load('search-diagnosis-history').catch(() => []);

    const { summary, topTerms = [], problems = [], recommendations = [] } = report;
    const lostPct = summary.totalSearches ? summary.lostSearches / summary.totalSearches : 0;
    // Ponderado por VOLUMEN de búsqueda, no por cantidad de términos: un solo
    // término de altísimo volumen roto tiene que pesar lo que pesa de verdad,
    // en vez de licuarse como "1 de 200 términos" (99,5% "sano" con el NPS
    // del buscador por el piso era exactamente ese problema).
    const healthPct = summary.totalSearches ? 1 - lostPct : (report.termsAnalyzed ? summary.ok / report.termsAnalyzed : 0);
    const healthColor = healthPct >= 0.95 ? '#1baf7a' : healthPct >= 0.85 ? '#eda100' : '#e34948';

    ctx.exports.buscadorTop = {
      filename: 'webdash-buscador-mas-buscados.csv',
      headers: ['termino', 'busquedas', 'estado'],
      rows: topTerms.map((t) => [t.term, t.searchCount, STATUS_LABEL[t.status] || t.status]),
    };
    ctx.exports.buscadorProblemas = {
      filename: 'webdash-buscador-problemas.csv',
      headers: ['termino', 'busquedas', 'estado', 'productos_vtex', 'sinonimo_sugerido', 'productos_sinonimo', 'recomendacion'],
      rows: problems.map((t) => [
        t.term, t.searchCount, STATUS_LABEL[t.status] || t.status,
        t.vtexResults == null ? '' : `${t.vtexResults}${t.vtexResultsCapped ? '+' : ''}`,
        t.suggestion?.term || '', t.suggestion?.vtexResults ?? '', t.recommendation || '',
      ]),
    };

    const histLabels = history.map((h) => h.date);
    const histSeries = [
      { name: 'Búsquedas sin resultado (términos)', color: '#e34948', values: history.map((h) => h.sinResultados) },
      { name: 'Pocos resultados (términos)', color: '#eda100', values: history.map((h) => h.pocosResultados) },
    ];

    el.innerHTML = `
      <div class="kpis">
        <div class="kpi"><div class="kpi-t"><span class="kpi-ic" style="background:${healthColor}38;color:${healthColor}">${W.icon('search', 18)}</span></div>
          <div class="kpi-v">${W.fmtPct(healthPct, 0)}</div><div class="kpi-l">Salud del buscador</div>
          <div class="kpi-s">ponderado por volumen de búsqueda · ${W.fmtNum(summary.ok)} de ${W.fmtNum(report.termsAnalyzed)} términos sin problemas detectados</div></div>
        <div class="kpi"><div class="kpi-t"><span class="kpi-ic" style="background:#e3494838;color:#e34948">${W.icon('ban', 18)}</span></div>
          <div class="kpi-v">${W.fmtNum(summary.sinResultados)}</div><div class="kpi-l">Términos sin resultados</div>
          <div class="kpi-s">${summary.pocosResultados} con menos de 5 productos · ${summary.resultadosDispersos || 0} con resultados dispersos</div></div>
        <div class="kpi"><div class="kpi-t"><span class="kpi-ic" style="background:#eda10038;color:#eda100">${W.icon('trendDown', 18)}</span></div>
          <div class="kpi-v">${W.fmtNumC(summary.lostSearches)}</div><div class="kpi-l">Búsquedas potencialmente perdidas</div>
          <div class="kpi-s">${W.fmtPct(lostPct)} de las búsquedas analizadas, últimos 30 días</div></div>
        <div class="kpi"><div class="kpi-t"><span class="kpi-ic" style="background:#2a78d638;color:#2a78d6">${W.icon('layers', 18)}</span></div>
          <div class="kpi-v">${W.fmtNumC(summary.totalSearches)}</div><div class="kpi-l">Búsquedas analizadas</div>
          <div class="kpi-s">top ${W.fmtNum(report.termsAnalyzed)} términos por volumen · GA4, últimos 30 días</div></div>
      </div>

      ${recommendations.length ? `<div>
        <div class="ins-h"><h3>Qué hacer</h3><span>lectura automática del diagnóstico</span></div>
        <div class="ins-g">${recommendations
          .map((r) => `<div class="ins ${recKind(r)}">${W.icon(recKind(r) === 'bad' ? 'alert' : recKind(r) === 'warn' ? 'warn' : 'info', 16)}<div><p>${W.esc(r)}</p></div></div>`)
          .join('')}</div></div>` : ''}

      <div class="card">
        <div class="card-h"><div><h3>Tendencia</h3><p>términos problemáticos por corrida diaria — si sube, algo empeoró; si baja, las correcciones funcionaron</p></div></div>
        ${W.chart.line({ labels: histLabels, series: histSeries, yFmt: W.fmtNum })}
      </div>

      <div class="card">
        <div class="card-h">
          <div><h3>Términos más buscados</h3><p>top ${topTerms.length} por volumen, últimos 30 días</p></div>
          <button class="btn" data-export="buscadorTop">${W.icon('download', 14)}XLSX</button>
        </div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>Término</th><th class="num">Búsquedas</th><th>Estado</th></tr></thead>
          <tbody>${topTerms.length ? topTerms.map((t) => `<tr>
              <td>${W.esc(t.term)}</td>
              <td class="num">${W.fmtNum(t.searchCount)}</td>
              <td>${pill(t.status)}</td>
            </tr>`).join('') : '<tr><td colspan="3" class="muted">Sin datos</td></tr>'}</tbody>
        </table></div>
      </div>

      <div class="card">
        <div class="card-h">
          <div><h3>Problemas detectados</h3><p>términos sin resultados o con pocos — con sinónimo sugerido (verificado contra VTEX) cuando se encontró uno</p></div>
          <button class="btn" data-export="buscadorProblemas">${W.icon('download', 14)}XLSX</button>
        </div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>Término</th><th class="num">Búsquedas</th><th>Estado</th><th class="num">Productos</th><th>Sinónimo sugerido</th><th>Recomendación</th></tr></thead>
          <tbody>${problems.length ? problems.map((t) => `<tr>
              <td>${W.esc(t.term)}${t.sampleProducts?.length ? `<div class="scope">${W.esc(t.sampleProducts.slice(0, 2).join(' · '))}</div>` : ''}</td>
              <td class="num">${W.fmtNum(t.searchCount)}</td>
              <td>${pill(t.status)}</td>
              <td class="num">${t.vtexResults == null ? '—' : `${t.vtexResults}${t.vtexResultsCapped ? '+' : ''}`}</td>
              <td>${t.suggestion ? `<span class="pill ok">${W.esc(t.suggestion.term)}</span> <span class="scope">${t.suggestion.vtexResults} productos</span>` : '<span class="muted">—</span>'}</td>
              <td class="scope">${W.esc(t.recommendation || '')}</td>
            </tr>`).join('') : '<tr><td colspan="6" class="muted">Ningún término con problemas en esta corrida 🎉</td></tr>'}</tbody>
        </table></div>
      </div>

      <p class="muted" style="font-size:.75rem;margin-top:.4rem">
        Diagnóstico automático · se actualiza todos los días a las 6:00 (hora ARG) · última corrida ${W.timeAgo(report.generatedAt)}.
        Fuente: GA4 (búsquedas reales del sitio) cruzado contra el catálogo real de VTEX.
      </p>`;
  };
})();

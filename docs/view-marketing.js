/* global window, document */
/**
 * Vista "Marketing": atribución por utmSource de VTEX, con detalle y
 * comparación contra el período anterior. Es la misma fuente de datos que
 * antes vivía como una tabla más al final del Dashboard — acá tiene su
 * propia página para poder mirarla sin competir con el resto de métricas.
 *
 * Nota de alcance: hoy solo se puede atribuir lo que VTEX manda en
 * marketingData.utmSource. Cuando se conecte Google Ads (o el conector que
 * sea) para traer spend/clicks/CPA por campaña, esta vista es donde va a
 * sumarse esa columna — la estructura ya deja lugar para eso.
 */
(function () {
  const W = (window.W = window.W || {});

  W.viewMarketing = async function (ctx) {
    const { range, bucket, el } = ctx;
    const daily = await W.load('daily-summary');

    if (!daily.days.length) {
      el.innerHTML = `<div class="empty"><h2>Todavía no hay datos</h2><p>Corré el backfill inicial (ver README).</p></div>`;
      return;
    }

    const cur = W.sumRange(daily, bucket, range);
    const prevRange = W.previousRange(range);
    const prev = W.sumRange(daily, bucket, prevRange);
    const scopeTxt = `${W.fmtDayLong(range.from)} → ${W.fmtDayLong(range.to)} · ${bucket === 'all' ? 'todos los segmentos' : W.SEGMENT_LABEL[bucket]}`;

    const rows = Object.entries(cur.marketing).map(([source, v]) => ({ source, ...v })).sort((a, b) => b.gmv - a.gmv);
    const prevBySource = Object.fromEntries(Object.entries(prev.marketing).map(([k, v]) => [k, v]));
    const total = rows.reduce((s, r) => s + r.gmv, 0);
    const totalOrders = rows.reduce((s, r) => s + r.orders, 0);
    const direct = rows.find((r) => /^(sin_atribucion|direct|none|\(none\))$/i.test(r.source));
    const attributed = totalOrders - (direct?.orders || 0);

    ctx.exports.marketingDetail = {
      filename: `webdash-marketing-${range.from}_${range.to}.csv`,
      headers: ['fuente', 'pedidos', 'gmv', 'ticket', 'share_gmv'],
      rows: rows.map((r) => [r.source, r.orders, Math.round(r.gmv), Math.round(W.ticket(r.gmv, r.orders)), (r.gmv / (total || 1)).toFixed(4)]),
    };

    const top5 = rows.filter((r) => r !== direct).slice(0, 5);

    el.innerHTML = `
      <div class="kpis">
        <div class="kpi"><div class="kpi-t"><span class="kpi-ic" style="background:#2a78d626;color:#2a78d6">${W.icon('globe', 18)}</span></div>
          <div class="kpi-v">${W.fmtNum(rows.length)}</div><div class="kpi-l">Fuentes distintas</div><div class="kpi-s">${scopeTxt}</div></div>
        <div class="kpi"><div class="kpi-t"><span class="kpi-ic" style="background:#1baf7a26;color:#1baf7a">${W.icon('trend', 18)}</span></div>
          <div class="kpi-v">${W.fmtPct(totalOrders ? attributed / totalOrders : 0)}</div><div class="kpi-l">Pedidos con atribución</div>
          <div class="kpi-s">${direct ? `${W.fmtPct(direct.orders / (totalOrders || 1))} sin fuente identificada` : ''}</div></div>
        <div class="kpi"><div class="kpi-t"><span class="kpi-ic" style="background:#eb683426;color:#eb6834">${W.icon('money', 18)}</span></div>
          <div class="kpi-v">${W.fmtMoneyC(total)}</div><div class="kpi-l">GMV atribuible</div><div class="kpi-s">${W.fmtNumC(totalOrders)} pedidos</div></div>
        <div class="kpi"><div class="kpi-t"><span class="kpi-ic" style="background:#4a3aa726;color:#4a3aa7">${W.icon('ticket', 18)}</span></div>
          <div class="kpi-v">${W.fmtMoney(W.ticket(total, totalOrders))}</div><div class="kpi-l">Ticket promedio</div><div class="kpi-s">de pedidos con fuente</div></div>
      </div>

      <div class="card">
        <div class="card-h"><div><h3>Top 5 fuentes</h3><p>${scopeTxt} · sin contar tráfico directo/sin atribuir</p></div></div>
        ${top5.length ? W.chart.barsH({
          items: top5.map((r, i) => ({ label: r.source, value: r.gmv, sub: `${W.fmtNum(r.orders)} pedidos`, color: W.SERIES[i % W.SERIES.length] })),
          valueFmt: W.fmtMoneyC,
        }) : '<div class="chart-empty">Sin datos de marketing para este filtro.</div>'}
      </div>

      <div class="card">
        <div class="card-h">
          <div><h3>Todas las fuentes</h3><p>atribución por utmSource · variación vs. período anterior</p></div>
          <button class="btn" data-export="marketingDetail">${W.icon('download', 14)}XLSX</button>
        </div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>Fuente</th><th class="num">Pedidos</th><th class="num">GMV</th><th class="num">Ticket</th><th class="num">vs. período anterior</th><th style="width:22%">% GMV</th></tr></thead>
          <tbody>${rows.length ? rows.map((r) => {
            const p = prevBySource[r.source];
            const dGmv = p ? W.delta(r.gmv, p.gmv) : undefined;
            return `<tr>
              <td>${W.esc(r.source)}</td>
              <td class="num">${W.fmtNum(r.orders)}</td>
              <td class="num">${W.fmtMoney(r.gmv)}</td>
              <td class="num">${W.fmtMoney(W.ticket(r.gmv, r.orders))}</td>
              <td class="num">${dGmv !== undefined ? W.deltaBadge(dGmv) : '<span class="muted">—</span>'}</td>
              <td><div class="barcell"><span class="bartrack"><span class="barfill" style="width:${(r.gmv / (total || 1)) * 100}%"></span></span><b>${W.fmtPct(r.gmv / (total || 1))}</b></div></td>
            </tr>`;
          }).join('') : '<tr><td colspan="6" class="muted">Sin datos en este rango</td></tr>'}</tbody>
        </table></div>
      </div>

      <div class="card">
        <div class="card-h"><div><h3>Google Ads y pauta paga</h3>
          <p>todavía no conectado — cuando se sume, acá va a verse inversión, clics y CPA por campaña junto al GMV que ya se atribuye por UTM</p></div></div>
        <div class="chart-empty">Sin conexión configurada todavía.</div>
      </div>`;
  };
})();

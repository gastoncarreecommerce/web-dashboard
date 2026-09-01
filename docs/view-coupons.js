/* global window, document */
/**
 * Vista "Cupones": qué cupones se usan, cuánto pesan y quién nunca los usa.
 *
 * El ranking de cupones respeta el rango de fechas y el segmento elegidos
 * (sale de daily-summary, igual que el resto de Analítica). Los indicadores
 * de cliente (nunca usó cupón, % de pedidos con cupón) son de la BASE
 * COMPLETA — igual que en Audiencias — porque el dato de "pedidos con
 * cupón" por cliente vive en el índice de audiencias, que es histórico y no
 * se puede recortar por fecha sin perder precisión.
 */
(function () {
  const W = (window.W = window.W || {});

  const SEG_ALL = 'all';
  const segsOf = (bucket) => (bucket === SEG_ALL ? W.SEGMENTS : [bucket]);

  W.viewCoupons = async function (ctx) {
    const { range, bucket, el } = ctx;
    const daily = await W.load('daily-summary');
    const idx = await W.load('audience-index').catch(() => null);

    if (!daily.days.length) {
      el.innerHTML = `<div class="empty"><h2>Todavía no hay datos</h2><p>Corré el backfill inicial (ver README).</p></div>`;
      return;
    }

    const cur = W.sumRange(daily, bucket, range);
    const prevRange = W.previousRange(range);
    const prev = W.sumRange(daily, bucket, prevRange);
    const scopeTxt = `${W.fmtDayLong(range.from)} → ${W.fmtDayLong(range.to)} · ${bucket === SEG_ALL ? 'todos los segmentos' : W.SEGMENT_LABEL[bucket]}`;

    const coupons = Object.entries(cur.coupons).map(([code, v]) => ({ code, ...v })).sort((a, b) => b.gmv - a.gmv);
    const prevCoupons = Object.entries(prev.coupons).map(([code, v]) => ({ code, ...v }));
    const prevByCode = Object.fromEntries(prevCoupons.map((c) => [c.code, c]));
    const totalCouponGmv = coupons.reduce((s, c) => s + c.gmv, 0);
    const totalCouponOrders = coupons.reduce((s, c) => s + c.orders, 0);

    // ── Indicadores de cliente: base completa histórica ─────────────────────
    let neverUsed = 0, everUsed = 0, lifetimeOrders = 0, lifetimeCouponOrders = 0;
    if (idx?.count) {
      for (let i = 0; i < idx.count; i++) {
        const o = idx.o[i], cp = idx.cp ? idx.cp[i] : 0;
        if (!o) continue;
        lifetimeOrders += o;
        lifetimeCouponOrders += cp;
        if (cp > 0) everUsed++; else neverUsed++;
      }
    }
    const hasClientData = idx?.count > 0;

    const noCatalog = !cur.hasCatalog;
    const catalogWarn = noCatalog
      ? `<span class="scope" ${W.chart.tip('El corte por segmento del catálogo se agregó al pipeline después del backfill. Hasta que se vuelva a procesar el historial, este panel queda vacío para no mostrar números equivocados.')}>${W.icon('warn', 11)} sin datos por segmento</span>`
      : '';

    ctx.exports.coupons = {
      filename: `webdash-cupones-${range.from}_${range.to}.csv`,
      headers: ['cupon', 'pedidos', 'gmv', 'ticket', 'share_gmv'],
      rows: coupons.map((c) => [c.code, c.orders, Math.round(c.gmv), Math.round(W.ticket(c.gmv, c.orders)), (c.gmv / (totalCouponGmv || 1)).toFixed(4)]),
    };

    const kpi = ({ icon, label, value, sub, color }) => `<div class="kpi">
      <div class="kpi-t"><span class="kpi-ic" style="background:${color}26;color:${color}">${W.icon(icon, 18)}</span></div>
      <div class="kpi-v">${value}</div>
      <div class="kpi-l">${W.esc(label)}</div>
      ${sub ? `<div class="kpi-s">${sub}</div>` : ''}
    </div>`;

    el.innerHTML = `
      <div class="kpis">
        ${kpi({ icon: 'tag', label: 'Cupones distintos usados', value: W.fmtNum(coupons.length), color: '#2a78d6', sub: scopeTxt })}
        ${kpi({ icon: 'ticket', label: 'Pedidos con cupón (líneas)', value: W.fmtNumC(totalCouponOrders), color: '#eb6834',
          sub: `${W.fmtMoneyC(totalCouponGmv)} de GMV asociado` })}
        ${hasClientData ? kpi({ icon: 'percent', label: '% de pedidos con cupón', value: W.fmtPct(lifetimeOrders ? lifetimeCouponOrders / lifetimeOrders : 0),
          color: '#1baf7a', sub: 'histórico de toda la base' }) : ''}
        ${hasClientData ? kpi({ icon: 'shield', label: 'Clientes que nunca usaron cupón', value: W.fmtNumC(neverUsed),
          color: '#4a3aa7', sub: `${W.fmtPct(neverUsed + everUsed ? neverUsed / (neverUsed + everUsed) : 0)} de la base` }) : ''}
      </div>

      <div class="card">
        <div class="card-h">
          <div><h3>Ranking de cupones</h3><p>${scopeTxt} ${catalogWarn}
            <span class="scope" ${W.chart.tip('Un pedido puede traer más de un cupón a la vez (VTEX los guarda separados por coma) — cada cupón se cuenta acá individualmente, así que la suma de pedidos puede superar el total de pedidos del período.')}>${W.icon('info', 11)} un pedido puede sumar a varios cupones</span></p></div>
          <button class="btn" data-export="coupons">${W.icon('download', 14)}XLSX</button>
        </div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>#</th><th>Cupón</th><th class="num">Pedidos</th><th class="num">GMV</th><th class="num">Ticket</th><th class="num">vs. período anterior</th><th style="width:18%">% del GMV con cupón</th></tr></thead>
          <tbody>${coupons.length ? coupons.slice(0, 100).map((c, i) => {
            const p = prevByCode[c.code];
            const dOrders = p ? W.delta(c.orders, p.orders) : undefined;
            return `<tr>
              <td class="muted">${i + 1}</td>
              <td><code>${W.esc(c.code)}</code></td>
              <td class="num">${W.fmtNum(c.orders)}</td>
              <td class="num">${W.fmtMoney(c.gmv)}</td>
              <td class="num">${W.fmtMoney(W.ticket(c.gmv, c.orders))}</td>
              <td class="num">${dOrders !== undefined ? W.deltaBadge(dOrders) : '<span class="muted">—</span>'}</td>
              <td><div class="barcell"><span class="bartrack"><span class="barfill" style="width:${(c.gmv / (totalCouponGmv || 1)) * 100}%"></span></span><b>${W.fmtPct(c.gmv / (totalCouponGmv || 1))}</b></div></td>
            </tr>`;
          }).join('') : '<tr><td colspan="7" class="muted">Sin cupones en este rango</td></tr>'}</tbody>
        </table></div>
        ${coupons.length > 100 ? `<p class="muted" style="font-size:.75rem;padding-top:.6rem">Mostrando 100 de ${W.fmtNum(coupons.length)} — el XLSX trae todos.</p>` : ''}
      </div>

      ${!hasClientData ? `<div class="card"><div class="card-h"><div><h3>Clientes y cupones</h3>
        <p>Todavía no hay perfiles de cliente para cruzar con cupones — corré el backfill para habilitar esta parte.</p></div></div></div>` : ''}`;
  };
})();

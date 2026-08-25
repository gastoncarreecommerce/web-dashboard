/* global window, document */
/** Vista "Analítica": detalle por segmento, productos, categorías, cupones, cohortes. */
(function () {
  const W = (window.W = window.W || {});

  let productQuery = '';

  W.viewAnalytics = async function (ctx) {
    const { range, el } = ctx;
    const daily = await W.load('daily-summary');
    const catalog = await W.load('catalog').catch(() => null);
    const cohorts = await W.load('cohorts').catch(() => null);

    if (!daily.days.length) {
      el.innerHTML = `<div class="empty"><h2>Todavía no hay datos</h2><p>Corré el backfill inicial (ver README).</p></div>`;
      return;
    }

    const cur = W.sumRange(daily, 'all', range);
    const prevRange = W.previousRange(range);
    const prev = W.sumRange(daily, 'all', prevRange);

    // ── 1. Comparativa de segmentos ─────────────────────────────────────────
    const segRows = W.SEGMENTS.map((s) => {
      const c = cur.bySegment[s];
      const p = prev.bySegment[s];
      return {
        seg: s,
        label: W.SEGMENT_LABEL[s],
        color: W.SEGMENT_COLOR[s],
        orders: c.orders,
        gmv: c.gmv,
        units: c.units,
        ticket: W.ticket(c.gmv, c.orders),
        upo: W.unitsPerOrder(c.units, c.orders),
        share: cur.gmv ? c.gmv / cur.gmv : 0,
        dOrders: W.delta(c.orders, p.orders),
        dGmv: W.delta(c.gmv, p.gmv),
        dTicket: W.delta(W.ticket(c.gmv, c.orders), W.ticket(p.gmv, p.orders)),
      };
    }).sort((a, b) => b.gmv - a.gmv);

    ctx.exports.segments = {
      filename: `webdash-segmentos-${range.from}_${range.to}.csv`,
      headers: ['segmento', 'pedidos', 'gmv', 'unidades', 'ticket', 'unidades_por_pedido', 'share_gmv', 'var_pedidos', 'var_gmv'],
      rows: segRows.map((r) => [r.label, r.orders, Math.round(r.gmv), Math.round(r.units), Math.round(r.ticket),
        r.upo.toFixed(2), r.share.toFixed(4), r.dOrders == null ? '' : r.dOrders.toFixed(4), r.dGmv == null ? '' : r.dGmv.toFixed(4)]),
    };

    // ── 2..5 Catálogo (ventana completa, no filtrable por rango) ────────────
    const products = catalog?.products || [];
    const filtered = productQuery
      ? products.filter((p) => (p.name + ' ' + p.sku + ' ' + p.dept).toLowerCase().includes(productQuery.toLowerCase()))
      : products;

    ctx.exports.products = {
      filename: `webdash-productos-${catalog?.from || ''}_${catalog?.to || ''}.csv`,
      headers: ['sku', 'producto', 'departamento', 'unidades', 'gmv', 'lineas_pedido'],
      rows: products.map((p) => [p.sku, p.name, p.dept, p.qty, p.gmv, p.orders]),
    };
    ctx.exports.categories = {
      filename: `webdash-categorias-${catalog?.from || ''}_${catalog?.to || ''}.csv`,
      headers: ['categoria', 'lineas_pedido', 'unidades', 'gmv'],
      rows: (catalog?.categories || []).map((c) => [c.name, c.orders, c.units, c.gmv]),
    };
    ctx.exports.coupons = {
      filename: `webdash-cupones-${catalog?.from || ''}_${catalog?.to || ''}.csv`,
      headers: ['cupon', 'pedidos', 'gmv', 'ticket'],
      rows: (catalog?.coupons || []).map((c) => [c.code, c.orders, c.gmv, Math.round(W.ticket(c.gmv, c.orders))]),
    };

    const catalogNote = catalog
      ? `<span class="scope" ${W.chart.tip('Estos paneles se calculan sobre toda la ventana de datos, no sobre el rango de fechas de arriba: el pipeline guarda el catálogo agregado, no día por día.')}>ventana completa ${W.fmtDay(catalog.from)} → ${W.fmtDay(catalog.to)}</span>`
      : '';

    const couponTotalOrders = (catalog?.coupons || []).reduce((s, c) => s + c.orders, 0);
    const totalOrdersWindow = daily.days.reduce((s, d) => s + W.SEGMENTS.reduce((a, seg) => a + (d.segments[seg]?.orders || 0), 0), 0);
    const couponPenetration = totalOrdersWindow ? couponTotalOrders / totalOrdersWindow : 0;

    // ── 6. Cohortes ─────────────────────────────────────────────────────────
    let cohortHtml = '<div class="chart-empty">Sin datos de cohortes todavía.</div>';
    if (cohorts?.cohortMonths?.length) {
      const rows = cohorts.cohortMonths.map(W.fmtMonth);
      const cols = cohorts.activeMonths.map(W.fmtMonth);
      cohortHtml = W.chart.heatmap({
        rows, cols,
        matrix: cohorts.matrix,
        cellPct: true,
        rowSub: cohorts.cohortSizes.map((n) => `${W.fmtNumC(n)} clientes`),
        tipFmt: (r, c, v, t) => `<strong>Cohorte ${r} · mes ${c}</strong><span class="tip-row"><b>${W.fmtNum(v)}</b> clientes activos (${W.fmtPct(t)} de la cohorte)</span>`,
      });
    }

    // ── Estados de pedido (del listado de VTEX: incluye los que no cuentan) ──
    const canc = W.cancellations(cur.statusStats);
    const INCLUDED = ['invoiced', 'invoice', 'handling', 'ready-for-handling', 'shipped', 'order-accepted', 'payment-approved'];
    const statusRows = Object.entries(cur.statusStats || {})
      .map(([status, v]) => ({
        status, orders: v.orders, gmv: v.gmv,
        counts: INCLUDED.includes(status),
        cancelled: W.CANCELLED_STATUSES.includes(status),
      }))
      .sort((a, b) => b.orders - a.orders);

    ctx.exports.statuses = {
      filename: `webdash-estados-${range.from}_${range.to}.csv`,
      headers: ['estado', 'cuenta_para_metricas', 'es_cancelacion', 'pedidos', 'monto'],
      rows: statusRows.map((r) => [r.status, r.counts ? 'si' : 'no', r.cancelled ? 'si' : 'no', r.orders, Math.round(r.gmv)]),
    };

    const hourly = catalog?.hourly || [];
    const maxHour = Math.max(1, ...hourly);
    const dow = catalog?.dayOfWeek || [];
    const maxDow = Math.max(1, ...dow.map((d) => d.avgOrders));

    el.innerHTML = `
      <div class="card">
        <div class="card-h">
          <div><h3>Comparativa de segmentos</h3><p>${W.fmtDayLong(range.from)} → ${W.fmtDayLong(range.to)} · variaciones vs. período anterior</p></div>
          <button class="btn" data-export="segments">${W.icon("download",14)}CSV</button>
        </div>
        <div class="split">
          <table class="tbl">
            <thead><tr><th>Segmento</th><th class="num">Pedidos</th><th class="num">GMV</th><th class="num">Ticket</th><th class="num">U./pedido</th><th class="num">Share</th></tr></thead>
            <tbody>${segRows.map((r) => `<tr>
                <td><span class="dot" style="background:${r.color}"></span>${W.esc(r.label)}</td>
                <td class="num">${W.fmtNum(r.orders)} ${W.deltaBadge(r.dOrders)}</td>
                <td class="num">${W.fmtMoneyC(r.gmv)} ${W.deltaBadge(r.dGmv)}</td>
                <td class="num">${W.fmtMoney(r.ticket)} ${W.deltaBadge(r.dTicket)}</td>
                <td class="num">${W.fmtDec(r.upo, 1)}</td>
                <td class="num">${W.fmtPct(r.share)}</td>
              </tr>`).join('')}</tbody>
          </table>
          <div class="split-side">
            ${W.chart.donut({
              items: segRows.filter((r) => r.gmv > 0).map((r) => ({ label: r.label, value: r.gmv, color: r.color })),
              centerValue: W.fmtMoneyC(cur.gmv), centerLabel: 'GMV total',
            })}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <div><h3>Productos más vendidos</h3><p>ranking por GMV ${catalogNote}</p></div>
          <div class="card-a">
            <input class="inp inp-search" id="prod-search" type="search" placeholder="Buscar producto…" value="${W.esc(productQuery)}" />
            <button class="btn" data-export="products">${W.icon("download",14)}CSV</button>
          </div>
        </div>
        ${W.chart.barsH({
          items: filtered.slice(0, 15).map((p) => ({ label: p.name, sub: p.dept, value: p.gmv })),
          valueFmt: W.fmtMoneyC, color: '#2a78d6',
        })}
        <details class="more"><summary>Ver tabla completa (${W.fmtNum(filtered.length)} productos)</summary>
          <table class="tbl dense">
            <thead><tr><th>#</th><th>Producto</th><th>Departamento</th><th class="num">Unidades</th><th class="num">GMV</th></tr></thead>
            <tbody>${filtered.slice(0, 200).map((p, i) => `<tr>
                <td class="muted">${i + 1}</td><td>${W.esc(p.name)}</td><td class="muted">${W.esc(p.dept)}</td>
                <td class="num">${W.fmtNum(p.qty)}</td><td class="num">${W.fmtMoney(p.gmv)}</td></tr>`).join('')}</tbody>
          </table>
          ${filtered.length > 200 ? '<p class="muted">Mostrando los primeros 200 — exportá el CSV para la lista completa.</p>' : ''}
        </details>
      </div>

      <div class="g2">
        <div class="card">
          <div class="card-h">
            <div><h3>Categorías</h3><p>GMV por departamento ${catalogNote}</p></div>
            <button class="btn" data-export="categories">${W.icon("download",14)}CSV</button>
          </div>
          ${W.chart.barsH({
            items: (catalog?.categories || []).slice(0, 12).map((c, i) => ({
              label: c.name, value: c.gmv, sub: `${W.fmtNum(c.units)} unidades`, color: W.SERIES[i % W.SERIES.length],
            })),
            valueFmt: W.fmtMoneyC,
          })}
        </div>

        <div class="card">
          <div class="card-h"><div><h3>Medios de pago</h3><p>participación por GMV ${catalogNote}</p></div></div>
          ${W.chart.donut({
            items: (catalog?.payments || []).slice(0, 6).map((p, i) => ({ label: p.group, value: p.gmv, color: W.SERIES[i % W.SERIES.length] })),
            centerValue: W.fmtNumC((catalog?.payments || []).reduce((s, p) => s + p.orders, 0)), centerLabel: 'pedidos',
          })}
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <div><h3>Estados de pedido</h3>
          <p>${W.fmtDayLong(range.from)} → ${W.fmtDayLong(range.to)} · todos los pedidos del canal, incluidos los que no cuentan para las métricas</p></div>
          <button class="btn" data-export="statuses">${W.icon("download",14)}CSV</button>
        </div>
        <div class="strip">
          <div><span>${W.fmtPct(canc.rate)}</span><em>tasa de cancelación</em></div>
          <div><span>${W.fmtNumC(canc.cancelledOrders)}</span><em>pedidos cancelados</em></div>
          <div><span>${W.fmtMoneyC(canc.cancelledGmv)}</span><em>monto no facturado</em></div>
        </div>
        <table class="tbl">
          <thead><tr><th>Estado</th><th>Cuenta para métricas</th><th class="num">Pedidos</th><th class="num">Monto</th><th style="width:20%">% pedidos</th></tr></thead>
          <tbody>${statusRows.length ? statusRows.map((r) => `<tr>
              <td><code>${W.esc(r.status)}</code></td>
              <td>${r.counts
                ? '<span class="pill ok">Sí</span>'
                : r.cancelled ? '<span class="pill no">No · cancelado</span>' : '<span class="pill n">No</span>'}</td>
              <td class="num">${W.fmtNum(r.orders)}</td>
              <td class="num">${W.fmtMoney(r.gmv)}</td>
              <td><div class="barcell"><span class="bartrack"><span class="barfill" style="width:${(r.orders / (canc.totalOrders || 1)) * 100}%;background:${r.counts ? 'var(--pos)' : r.cancelled ? 'var(--neg)' : 'var(--ink-3)'}"></span></span><b>${W.fmtPct(r.orders / (canc.totalOrders || 1))}</b></div></td>
            </tr>`).join('') : '<tr><td colspan="5" class="muted">Sin datos en este rango</td></tr>'}</tbody>
        </table>
      </div>

      <div class="card">
        <div class="card-h">
          <div><h3>Cupones</h3><p>uso y volumen asociado ${catalogNote}</p></div>
          <button class="btn" data-export="coupons">${W.icon("download",14)}CSV</button>
        </div>
        <div class="strip">
          <div><span>${W.fmtPct(couponPenetration)}</span><em>de los pedidos usó cupón</em></div>
          <div><span>${W.fmtNum((catalog?.coupons || []).length)}</span><em>cupones distintos activos</em></div>
          <div><span>${W.fmtMoneyC(cur.discount)}</span><em>descuento en el rango seleccionado</em></div>
        </div>
        <table class="tbl">
          <thead><tr><th>Cupón</th><th class="num">Pedidos</th><th class="num">GMV asociado</th><th class="num">Ticket</th><th style="width:22%">Volumen</th></tr></thead>
          <tbody>${(catalog?.coupons || []).length
            ? catalog.coupons.slice(0, 25).map((c) => {
                const max = catalog.coupons[0].gmv || 1;
                return `<tr><td><code>${W.esc(c.code)}</code></td><td class="num">${W.fmtNum(c.orders)}</td>
                  <td class="num">${W.fmtMoney(c.gmv)}</td><td class="num">${W.fmtMoney(W.ticket(c.gmv, c.orders))}</td>
                  <td><div class="barcell"><span class="bartrack"><span class="barfill" style="width:${(c.gmv / max) * 100}%"></span></span></div></td></tr>`;
              }).join('')
            : '<tr><td colspan="5" class="muted">No se registraron cupones en la ventana de datos.</td></tr>'}</tbody>
        </table>
      </div>

      <div class="card">
        <div class="card-h">
          <div><h3>Retención por cohorte</h3>
          <p>de cada grupo de clientes según su mes de primera compra, qué % volvió a comprar en los meses siguientes</p></div>
        </div>
        ${cohortHtml}
        <p class="muted">La diagonal siempre es 100% (el mes en que la cohorte nació). Lo que importa es cuánto se sostiene hacia la derecha:
        si cae fuerte en el mes+1, el problema es la segunda compra, no la adquisición.</p>
      </div>

      <div class="g2">
        <div class="card">
          <div class="card-h"><div><h3>Distribución horaria</h3><p>pedidos por hora del día (AR) ${catalogNote}</p></div></div>
          <div class="vbars">${hourly.map((n, h) => `<div class="vbar" ${W.chart.tip(`<strong>${String(h).padStart(2, '0')}:00</strong><span class="tip-row"><b>${W.fmtNum(n)}</b> pedidos</span>`)}>
              <span class="vbar-f" style="height:${(n / maxHour) * 100}%"></span>
              <em>${h % 3 === 0 ? String(h).padStart(2, '0') : ''}</em></div>`).join('')}</div>
        </div>

        <div class="card">
          <div class="card-h"><div><h3>Día de la semana</h3><p>promedio de pedidos por día ${catalogNote}</p></div></div>
          <div class="vbars wide">${dow.map((d, i) => `<div class="vbar" ${W.chart.tip(`<strong>${W.DOW_LABELS[i]}</strong><span class="tip-row"><b>${W.fmtNum(d.avgOrders)}</b> pedidos promedio · ${d.days} días</span>`)}>
              <span class="vbar-f" style="height:${(d.avgOrders / maxDow) * 100}%;background:${i === 0 || i === 6 ? '#eda100' : '#2a78d6'}"></span>
              <em>${W.DOW_LABELS[i]}</em></div>`).join('')}</div>
        </div>
      </div>`;

    const search = document.getElementById('prod-search');
    if (search) {
      search.addEventListener('input', (e) => {
        productQuery = e.target.value;
        const pos = e.target.selectionStart;
        W.render().then(() => {
          const s2 = document.getElementById('prod-search');
          if (s2) { s2.focus(); s2.setSelectionRange(pos, pos); }
        });
      });
    }
  };
})();

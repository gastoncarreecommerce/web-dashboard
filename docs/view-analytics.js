/* global window, document */
/**
 * Vista "Analítica": todo responde al rango de fechas y al segmento elegidos
 * arriba. Antes el catálogo se calculaba sobre la ventana completa y no se
 * podía cortar por segmento — ahora el pipeline lo guarda por segmento y por
 * día, así que estos paneles filtran de verdad.
 *
 * Excepción declarada en la UI: el ranking de productos se agrega por MES
 * (250 SKUs × 4 segmentos × 236 días sería un archivo inmanejable para el
 * navegador), así que respeta el segmento y los meses tocados por el rango.
 *
 * El mapa de Argentina + ranking de tiendas se mudó a su propia pestaña
 * ("Tiendas", ver docs/view-tiendas.js) — competía por espacio con todo lo
 * demás acá y quedaba gigante en una pantalla ya llena.
 */
(function () {
  const W = (window.W = window.W || {});

  let productQuery = '';
  let catLevel = 'n3';     // 'n1' (departamento) | 'n2' (rubro) | 'n3' (detalle)
  let segMetric = 'gmv';   // 'gmv' | 'orders' — comparativa de segmentos
  let prodMetric = 'gmv';  // ranking de productos
  let catMetric = 'gmv';   // ranking de categorías
  let payMetric = 'gmv';   // donut de medios de pago
  const CAT_LEVEL = {
    n1: { key: 'categoriesN1', label: 'N1' },
    n2: { key: 'categoriesN2', label: 'N2' },
    n3: { key: 'categories', label: 'N3' },
  };
  let payLevel = 'group'; // 'group' (creditCard/débito/…) | 'brand' (Visa/Mastercard/…) | 'installments' (cuotas)
  const PAY_LEVEL = {
    group: { key: 'payments', label: 'Grupo', field: 'group' },
    brand: { key: 'paymentBrands', label: 'Marca', field: 'brand' },
    installments: { key: 'installments', label: 'Cuotas', field: 'label' },
  };

  /**
   * Imagen real del producto, desde el catálogo de VTEX — vía
   * /api/product-image (server-side, ver api/product-image.js) en vez de
   * pegarle directo a VTEX desde el navegador, porque VTEX no manda headers
   * CORS para ese endpoint. El sku que guarda VTEX suele ser el EAN/código
   * de barras de góndola — si no tiene forma de EAN (8 a 14 dígitos) ni vale
   * la pena intentarlo. Best-effort: cualquier falla (sin red, producto sin
   * imagen, timeout) cae a null y se muestra un placeholder — nunca rompe el
   * panel de productos. Cacheado en memoria: no se repite en cada re-render.
   */
  const productImgCache = new Map();
  async function resolveProductImg(sku) {
    if (productImgCache.has(sku)) return productImgCache.get(sku);
    if (!/^\d{8,14}$/.test(String(sku || ''))) { productImgCache.set(sku, null); return null; }
    let url = null;
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(`/api/product-image?ean=${encodeURIComponent(sku)}`, { signal: ctrl.signal });
      clearTimeout(to);
      if (res.ok) {
        const data = await res.json();
        url = data?.image || null;
      }
    } catch { /* sin red, timeout, o VTEX no tiene el producto — se sigue sin imagen */ }
    productImgCache.set(sku, url);
    return url;
  }

  const SEG_ALL = 'all';
  const segsOf = (bucket) => (bucket === SEG_ALL ? W.SEGMENTS : [bucket]);

  // ── Vista ─────────────────────────────────────────────────────────────────
  W.viewAnalytics = async function (ctx) {
    const { range, bucket, el } = ctx;
    const daily = await W.load('daily-summary');
    const cohorts = await W.load('cohorts').catch(() => null);
    const productsFile = await W.load('products').catch(() => null);

    if (!daily.days.length) {
      el.innerHTML = `<div class="empty"><h2>Todavía no hay datos</h2><p>Corré el backfill inicial (ver README).</p></div>`;
      return;
    }

    const cur = W.sumRange(daily, bucket, range);
    const prevRange = W.previousRange(range);
    const prev = W.sumRange(daily, bucket, prevRange);
    const all = W.sumRange(daily, 'all', range);
    const segLabel = bucket === SEG_ALL ? 'todos los segmentos' : W.SEGMENT_LABEL[bucket];
    const scopeTxt = `${W.fmtDayLong(range.from)} → ${W.fmtDayLong(range.to)} · ${segLabel}`;

    // ── Comparativa de segmentos (siempre los 4, para poder compararlos) ────
    const segRows = W.SEGMENTS.map((s) => {
      const c = all.bySegment[s], p = prev.bySegment[s] || { gmv: 0, orders: 0, units: 0 };
      return {
        seg: s, label: W.SEGMENT_LABEL[s], color: W.SEGMENT_COLOR[s],
        orders: c.orders, gmv: c.gmv, units: c.units,
        ticket: W.ticket(c.gmv, c.orders), upo: W.unitsPerOrder(c.units, c.orders),
        share: all.gmv ? c.gmv / all.gmv : 0,
        dOrders: W.delta(c.orders, p.orders), dGmv: W.delta(c.gmv, p.gmv),
      };
    }).sort((a, b) => b[segMetric] - a[segMetric]);

    // ── Productos: por segmento, sumando los meses que toca el rango ────────
    const months = [...new Set((daily.days || [])
      .filter((d) => d.date >= range.from && d.date <= range.to)
      .map((d) => d.date.slice(0, 7)))];
    const prodMap = {};
    for (const s of segsOf(bucket)) {
      for (const m of months) {
        for (const p of productsFile?.segments?.[s]?.[m] || []) {
          const e = (prodMap[p.sku] = prodMap[p.sku] || { sku: p.sku, name: p.name, dept: p.dept, qty: 0, gmv: 0, orders: 0 });
          e.qty += p.qty; e.gmv += p.gmv; e.orders += p.orders;
        }
      }
    }
    const products = Object.values(prodMap).sort((a, b) => b[prodMetric] - a[prodMetric]);
    const filtered = productQuery
      ? products.filter((p) => `${p.name} ${p.sku} ${p.dept}`.toLowerCase().includes(productQuery.toLowerCase()))
      : products;
    const topProductImgs = await Promise.all(filtered.slice(0, 10).map((p) => resolveProductImg(p.sku)));

    const categories = Object.entries(cur[CAT_LEVEL[catLevel].key] || {}).map(([name, v]) => ({ name, ...v })).sort((a, b) => b[catMetric] - a[catMetric]);
    const payments = Object.entries(cur[PAY_LEVEL[payLevel].key] || {}).map(([name, v]) => ({ name, ...v })).sort((a, b) => b[payMetric] - a[payMetric]);
    const hasPayDetail = Object.keys(cur.paymentBrands || {}).length > 0;
    const noCatalog = !cur.hasCatalog;

    // ── Estados de pedido (siempre del canal completo: vienen del listado) ──
    const canc = W.cancellations(all.statusStats);
    const INCLUDED = ['invoiced', 'invoice', 'handling', 'ready-for-handling', 'shipped', 'order-accepted', 'payment-approved'];
    const statusRows = Object.entries(all.statusStats || {})
      .map(([status, v]) => ({ status, ...v, counts: INCLUDED.includes(status), cancelled: W.CANCELLED_STATUSES.includes(status) }))
      .sort((a, b) => b.orders - a.orders);

    // ── Exportaciones ───────────────────────────────────────────────────────
    const tag = `${range.from}_${range.to}_${bucket}`;
    ctx.exports.segments = {
      filename: `webdash-segmentos-${tag}.csv`,
      headers: ['segmento', 'pedidos', 'gmv', 'unidades', 'ticket', 'unidades_por_pedido', 'share_gmv'],
      rows: segRows.map((r) => [r.label, r.orders, Math.round(r.gmv), Math.round(r.units), Math.round(r.ticket), Number(r.upo.toFixed(2)), r.share]),
    };
    ctx.exports.products = {
      filename: `webdash-productos-${tag}.csv`,
      headers: ['sku', 'producto', 'departamento', 'unidades', 'gmv', 'lineas_pedido'],
      rows: products.map((p) => [p.sku, p.name, p.dept, p.qty, p.gmv, p.orders]),
    };
    ctx.exports.categories = {
      filename: `webdash-categorias-${CAT_LEVEL[catLevel].key}-${tag}.csv`,
      headers: ['categoria', 'lineas_pedido', 'unidades', 'gmv'],
      rows: categories.map((c) => [c.name, c.orders, Math.round(c.units), Math.round(c.gmv)]),
    };
    ctx.exports.statuses = {
      filename: `webdash-estados-${range.from}_${range.to}.csv`,
      headers: ['estado', 'cuenta_para_metricas', 'es_cancelacion', 'pedidos', 'monto'],
      rows: statusRows.map((r) => [r.status, r.counts ? 'si' : 'no', r.cancelled ? 'si' : 'no', r.orders, Math.round(r.gmv)]),
    };

    const maxHour = Math.max(1, ...cur.hourly);
    const catalogWarn = noCatalog
      ? `<span class="scope" ${W.chart.tip('El corte por segmento del catálogo se agregó al pipeline después del backfill. Hasta que se vuelva a procesar el historial, estos paneles quedan vacíos para no mostrar números equivocados.')}>${W.icon('warn', 11)} sin datos por segmento</span>`
      : '';

    el.innerHTML = `
      <div class="card">
        <div class="card-h">
          <div><h3>Comparativa de segmentos</h3><p>${W.fmtDayLong(range.from)} → ${W.fmtDayLong(range.to)} · variación vs. período anterior</p></div>
          <div class="card-a">${W.metricToggle(segMetric, 'segmetric')}<button class="btn" data-export="segments">${W.icon('download', 14)}XLSX</button></div>
        </div>
        <div class="split">
          <div class="tbl-wrap"><table class="tbl">
            <thead><tr><th>Segmento</th><th class="num">Pedidos</th><th class="num">GMV</th><th class="num">Ticket</th><th class="num">U./pedido</th><th class="num">Share</th></tr></thead>
            <tbody>${segRows.map((r) => `<tr>
                <td><span class="dot" style="background:${r.color}"></span>${W.esc(r.label)}</td>
                <td class="num">${W.fmtNum(r.orders)} ${W.deltaBadge(r.dOrders)}</td>
                <td class="num">${W.fmtMoneyC(r.gmv)} ${W.deltaBadge(r.dGmv)}</td>
                <td class="num">${W.fmtMoney(r.ticket)}</td>
                <td class="num">${W.fmtDec(r.upo, 1)}</td>
                <td class="num">${W.fmtPct(r.share)}</td></tr>`).join('')}</tbody>
          </table></div>
          <div>${W.chart.donut({
            items: segRows.filter((r) => r[segMetric] > 0).map((r) => ({ label: r.label, value: r[segMetric], color: r.color })),
            valueFmt: W.metricFmt(segMetric),
            centerValue: W.metricFmt(segMetric)(segMetric === 'gmv' ? all.gmv : all.orders), centerLabel: segMetric === 'gmv' ? 'GMV total' : 'Pedidos totales',
          })}</div>
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <div><h3>Top 10 productos más vendidos</h3><p>${scopeTxt}
            <span class="scope" ${W.chart.tip('El ranking se agrega por mes: el rango se redondea a los meses que toca. Para el día exacto está el detalle crudo en data/daily.')}>por mes</span></p></div>
          <div class="card-a">
            <input class="inp inp-search" id="prod-search" type="search" placeholder="Buscar producto…" value="${W.esc(productQuery)}" />
            ${W.metricToggle(prodMetric, 'prodmetric')}
            <button class="btn" data-export="products">${W.icon('download', 14)}XLSX (todos)</button>
          </div>
        </div>
        ${filtered.length ? W.chart.barsH({ items: filtered.slice(0, 10).map((p, i) => ({ label: p.name, sub: p.dept, value: p[prodMetric], img: topProductImgs[i] })), valueFmt: W.metricFmt(prodMetric), color: 'var(--s1)' })
          : '<div class="chart-empty">Sin productos para este filtro.</div>'}
        ${filtered.length > 10 ? `<p class="muted" style="font-size:.75rem;padding-top:.6rem">Mostrando 10 de ${W.fmtNum(filtered.length)} — el XLSX trae todos los que matchean la búsqueda.</p>` : ''}
      </div>

      <div class="g2">
        <div class="card">
          <div class="card-h">
            <div><h3>Categorías</h3><p>${scopeTxt} ${catalogWarn}</p></div>
            <div class="card-a">
              <div class="seg-ctl">
                ${Object.entries(CAT_LEVEL).map(([k, v]) =>
                  `<button data-catlevel="${k}" class="${catLevel === k ? 'on' : ''}">${v.label}</button>`).join('')}
              </div>
              ${W.metricToggle(catMetric, 'catmetric')}
              <button class="btn" data-export="categories">${W.icon('download', 14)}XLSX</button>
            </div>
          </div>
          ${categories.length ? W.chart.barsH({
            items: categories.slice(0, 12).map((c, i) => ({ label: c.name, value: c[catMetric], sub: `${W.fmtNum(c.units)} unidades`, color: W.SERIES[i % W.SERIES.length] })),
            valueFmt: W.metricFmt(catMetric),
          }) : '<div class="chart-empty">Sin datos de categorías para este filtro.</div>'}
        </div>

        <div class="card">
          <div class="card-h">
            <div><h3>Medios de pago</h3><p>${scopeTxt} ${catalogWarn}
              ${!hasPayDetail ? `<span class="scope" ${W.chart.tip('El detalle por marca de tarjeta y cuotas se empezó a guardar después de este cambio: los días previos solo tienen el grupo (crédito/débito/etc).')}>${W.icon('info', 11)} marca/cuotas: desde hoy</span>` : ''}</p></div>
            <div class="card-a">
              <div class="seg-ctl">
                ${Object.entries(PAY_LEVEL).map(([k, v]) =>
                  `<button data-paylevel="${k}" class="${payLevel === k ? 'on' : ''}">${v.label}</button>`).join('')}
              </div>
              ${W.metricToggle(payMetric, 'paymetric')}
            </div>
          </div>
          ${payments.length ? W.chart.donut({
            items: payments.slice(0, 8).map((p, i) => ({ label: p.name, value: p[payMetric], color: W.SERIES[i % W.SERIES.length] })),
            valueFmt: W.metricFmt(payMetric),
            centerValue: W.metricFmt(payMetric)(payments.reduce((s, p) => s + p[payMetric], 0)), centerLabel: W.METRIC_LABEL[payMetric].toLowerCase(),
          }) : '<div class="chart-empty">Sin datos de medios de pago para este filtro.</div>'}
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <div><h3>Estados de pedido</h3><p>${W.fmtDayLong(range.from)} → ${W.fmtDayLong(range.to)} · todos los pedidos del canal, incluidos los que no cuentan</p></div>
          <div class="card-a">
            <button class="btn" data-export="statuses">${W.icon('download', 14)}XLSX (resumen)</button>
            <button class="btn-p" id="xlsx-statuses-detail" ${W.chart.tip('Un Excel con una pestaña por estado (Todos, Facturados, Cancelados, etc.) y el detalle de cada pedido: número, fecha, tienda, mail y monto. Solo incluye pedidos procesados después de este cambio — los de antes no tienen el estado guardado por pedido.')}>${W.icon('layers', 14)}XLSX con detalle por pedido</button>
          </div>
        </div>
        <div class="strip">
          <div><span>${W.fmtPct(canc.rate)}</span><em>tasa de cancelación</em></div>
          <div><span>${W.fmtNumC(canc.cancelledOrders)}</span><em>pedidos cancelados</em></div>
          <div><span>${W.fmtMoneyC(canc.cancelledGmv)}</span><em>monto no facturado</em></div>
        </div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>Estado</th><th>Cuenta</th><th class="num">Pedidos</th><th class="num">Monto</th><th style="width:18%">% pedidos</th></tr></thead>
          <tbody>${statusRows.length ? statusRows.map((r) => `<tr><td><code>${W.esc(r.status)}</code></td>
              <td>${r.counts ? '<span class="pill ok">Sí</span>' : r.cancelled ? '<span class="pill no">No · cancelado</span>' : '<span class="pill n">No</span>'}</td>
              <td class="num">${W.fmtNum(r.orders)}</td><td class="num">${W.fmtMoney(r.gmv)}</td>
              <td><div class="barcell"><span class="bartrack"><span class="barfill" style="width:${(r.orders / (canc.totalOrders || 1)) * 100}%;background:${r.counts ? 'var(--pos)' : r.cancelled ? 'var(--neg)' : 'var(--ink-4)'}"></span></span><b>${W.fmtPct(r.orders / (canc.totalOrders || 1))}</b></div></td></tr>`).join('')
            : '<tr><td colspan="5" class="muted">Sin datos</td></tr>'}</tbody>
        </table></div>
      </div>

      <div class="card">
        <div class="card-h"><div><h3>Retención por cohorte</h3>
          <p>de cada grupo según su mes de primera compra, qué % volvió en los meses siguientes · base completa</p></div></div>
        ${cohorts?.cohortMonths?.length ? W.chart.heatmap({
          rows: cohorts.cohortMonths.map(W.fmtMonth), cols: cohorts.activeMonths.map(W.fmtMonth),
          matrix: cohorts.matrix, cellPct: true,
          rowSub: cohorts.cohortSizes.map((n) => `${W.fmtNumC(n)} clientes`),
          tipFmt: (r, c, v, t) => `<strong>Cohorte ${r} · mes ${c}</strong><span class="tip-row"><b>${W.fmtNum(v)}</b> activos (${W.fmtPct(t)})</span>`,
        }) : '<div class="chart-empty">Sin datos de cohortes todavía.</div>'}
      </div>

      <div class="card">
        <div class="card-h"><div><h3>Distribución horaria</h3><p>${scopeTxt} ${catalogWarn}</p></div></div>
        ${cur.hourly.some((n) => n) ? '' : '<div class="chart-empty">Sin datos horarios para este filtro.</div>'}
        <div class="vbars"${cur.hourly.some((n) => n) ? '' : ' hidden'}>${cur.hourly.map((n, h) => `<div class="vbar" ${W.chart.tip(`<strong>${String(h).padStart(2, '0')}:00</strong><span class="tip-row"><b>${W.fmtNum(n)}</b> pedidos</span>`)}>
          <span class="vbar-f" style="height:${(n / maxHour) * 100}%"></span><em>${h % 3 === 0 ? String(h).padStart(2, '0') : ''}</em></div>`).join('')}</div>
      </div>`;

    wire(ctx, months);
  };

  function wire(ctx, months) {
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

    document.querySelectorAll('[data-catlevel]').forEach((b) =>
      b.addEventListener('click', () => { catLevel = b.dataset.catlevel; W.render(); }));

    document.querySelectorAll('[data-paylevel]').forEach((b) =>
      b.addEventListener('click', () => { payLevel = b.dataset.paylevel; W.render(); }));

    document.querySelectorAll('[data-segmetric]').forEach((b) =>
      b.addEventListener('click', () => { segMetric = b.dataset.segmetric; W.render(); }));
    document.querySelectorAll('[data-prodmetric]').forEach((b) =>
      b.addEventListener('click', () => { prodMetric = b.dataset.prodmetric; W.render(); }));
    document.querySelectorAll('[data-catmetric]').forEach((b) =>
      b.addEventListener('click', () => { catMetric = b.dataset.catmetric; W.render(); }));
    document.querySelectorAll('[data-paymetric]').forEach((b) =>
      b.addEventListener('click', () => { payMetric = b.dataset.paymetric; W.render(); }));

    document.getElementById('xlsx-statuses-detail')?.addEventListener('click', async () => {
      const btn = document.getElementById('xlsx-statuses-detail');
      btn.disabled = true;
      try {
        const [perMonth, emailMap] = await Promise.all([
          Promise.all(months.map((m) => W.load(`order-index/${m}`).catch(() => []))),
          W.loadEmailMap(),
        ]);
        const all = perMonth.flat().filter((o) => {
          const day = W.arDateOf(o.t);
          return day >= ctx.range.from && day <= ctx.range.to;
        });
        if (!all.length) { W.toast('No hay pedidos con detalle por estado en este rango todavía.', 'bad'); return; }

        const CANCELLED = W.CANCELLED_STATUSES;
        const INVOICED = ['invoiced', 'invoice', 'handling', 'ready-for-handling', 'shipped', 'order-accepted', 'payment-approved'];
        const toRows = (list) => [
          ['Pedido', 'Fecha', 'Tienda', 'Segmento', 'Mail', 'Estado', 'GMV'],
          ...list.map((o) => [
            o.id,
            new Date(o.t).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }),
            o.s, o.sg,
            (o.h && emailMap?.get(o.h)?.email) || '',
            o.st || 'sin dato',
            o.g,
          ]),
        ];

        const sheets = [{ name: 'Todos', rows: toRows(all) }];
        const facturados = all.filter((o) => INVOICED.includes(o.st));
        const cancelados = all.filter((o) => CANCELLED.includes(o.st));
        if (facturados.length) sheets.push({ name: 'Facturados', rows: toRows(facturados) });
        if (cancelados.length) sheets.push({ name: 'Cancelados', rows: toRows(cancelados) });

        // Un pestaña por cada otro estado real (hasta 10, para no llenar el
        // archivo de pestañas si VTEX manda estados poco frecuentes).
        const otherStatuses = [...new Set(all.map((o) => o.st).filter((s) => s && !INVOICED.includes(s) && !CANCELLED.includes(s)))];
        for (const st of otherStatuses.slice(0, 10)) {
          sheets.push({ name: st.slice(0, 31), rows: toRows(all.filter((o) => o.st === st)) });
        }

        W.downloadXLSX(`webdash-estados-detalle-${ctx.range.from}_${ctx.range.to}.xlsx`, sheets);
        W.toast(`Exportados ${W.fmtNum(all.length)} pedidos en ${sheets.length} pestañas.`, 'good');
      } finally {
        btn.disabled = false;
      }
    });
  }
})();

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
 */
(function () {
  const W = (window.W = window.W || {});

  let productQuery = '';
  let selectedProv = null; // provincia abierta en el mapa
  let mapMetric = 'gmv';   // 'gmv' | 'orders'

  const SEG_ALL = 'all';
  const segsOf = (bucket) => (bucket === SEG_ALL ? W.SEGMENTS : [bucket]);

  // ── Geografía ─────────────────────────────────────────────────────────────
  /** Suma el geo.json dentro del rango y del segmento elegidos. */
  function sumGeo(geo, range, bucket) {
    const prov = {}, stores = {};
    const segs = segsOf(bucket);
    for (const d of geo.days || []) {
      if (d.date < range.from || d.date > range.to) continue;
      for (const [code, row] of Object.entries(d.prov || {})) {
        for (const s of segs) {
          const v = row[s];
          if (!v) continue;
          const e = (prov[code] = prov[code] || { orders: 0, gmv: 0 });
          e.orders += v[0]; e.gmv += v[1];
        }
      }
      for (const [code, row] of Object.entries(d.stores || {})) {
        for (const s of segs) {
          const v = row[s];
          if (!v) continue;
          const e = (stores[code] = stores[code] || { orders: 0, gmv: 0 });
          e.orders += v[0]; e.gmv += v[1];
        }
      }
    }
    return { prov, stores };
  }

  function renderMap(geo, agg, metric) {
    const M = W.AR_MAP;
    if (!M) return '<div class="chart-empty">No se pudo cargar el mapa.</div>';

    const vals = Object.values(agg.prov).map((v) => v[metric]);
    const max = Math.max(1, ...vals);
    const fmt = metric === 'gmv' ? W.fmtMoneyC : W.fmtNumC;
    const fmtFull = metric === 'gmv' ? W.fmtMoney : W.fmtNum;

    const paths = Object.entries(M.provinces).map(([code, p]) => {
      const v = agg.prov[code];
      const t = v ? v[metric] / max : 0;
      const fill = v ? W.chart.rampColor(0.15 + t * 0.85) : 'var(--surface-3)';
      const on = selectedProv === code;
      const tip = v
        ? `<strong>${W.esc(p.name)}</strong><span class="tip-row">Pedidos <b>${W.fmtNum(v.orders)}</b></span><span class="tip-row">GMV <b>${W.fmtMoney(v.gmv)}</b></span>`
        : `<strong>${W.esc(p.name)}</strong><span class="tip-row">Sin pedidos en este rango</span>`;
      return `<path class="prov${on ? ' on' : ''}" data-prov="${code}" d="${p.d}" fill="${fill}" ${W.chart.tip(tip)}/>`;
    }).join('');

    const ranked = Object.entries(agg.prov)
      .map(([code, v]) => ({ code, name: M.provinces[code]?.name || code, ...v }))
      .sort((a, b) => b[metric] - a[metric]);

    return `<div class="mapwrap">
      <div class="mapbox">
        <svg viewBox="0 0 ${M.width} ${M.height}" class="armap" role="img" aria-label="Mapa de Argentina por provincia">${paths}</svg>
        <div class="maplegend">
          <span>${fmt(0)}</span>
          <i style="background:linear-gradient(90deg, ${W.chart.rampColor(0.15)}, ${W.chart.rampColor(1)})"></i>
          <span>${fmt(max)}</span>
        </div>
      </div>
      <div class="maprank">
        <table class="tbl dense">
          <thead><tr><th>Provincia</th><th class="num">Pedidos</th><th class="num">GMV</th></tr></thead>
          <tbody>${ranked.length ? ranked.map((r) => `<tr class="provrow${selectedProv === r.code ? ' on' : ''}" data-prov="${r.code}">
              <td>${W.esc(r.name)}</td><td class="num">${W.fmtNum(r.orders)}</td><td class="num">${W.fmtMoneyC(r.gmv)}</td></tr>`).join('')
            : '<tr><td colspan="3" class="muted">Sin datos geográficos en este rango</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
  }

  function renderStores(geo, agg, provCode) {
    const M = W.AR_MAP;
    const rows = Object.entries(agg.stores)
      .map(([code, v]) => ({ code, name: geo.stores?.[code]?.name || code, prov: geo.stores?.[code]?.prov || null, ...v }))
      .filter((r) => !provCode || r.prov === provCode)
      .sort((a, b) => b.gmv - a.gmv);

    const title = provCode
      ? `Tiendas de ${W.esc(M.provinces[provCode]?.name || provCode)}`
      : 'Tiendas (todas las provincias)';

    return { rows, html: `<div class="card">
      <div class="card-h">
        <div><h3>${title}</h3><p>${W.fmtNum(rows.length)} tiendas · ordenadas por GMV${provCode ? ' · hacé clic en el mapa para cambiar de provincia' : ''}</p></div>
        <div class="card-a">
          ${provCode ? '<button class="btn" id="clear-prov">Ver todas</button>' : ''}
          <button class="btn-p" id="xlsx-stores">${W.icon('download', 14)}Exportar XLSX</button>
        </div>
      </div>
      <table class="tbl">
        <thead><tr><th>#</th><th>Tienda</th><th>Provincia</th><th class="num">Pedidos</th><th class="num">GMV</th><th class="num">Ticket</th><th style="width:18%">Participación</th></tr></thead>
        <tbody>${rows.length ? rows.slice(0, 60).map((r, i) => {
          const share = rows[0].gmv ? r.gmv / rows[0].gmv : 0;
          return `<tr><td class="muted">${i + 1}</td><td>${W.esc(r.name)}</td>
            <td class="muted">${W.esc(M.provinces[r.prov]?.name || '—')}</td>
            <td class="num">${W.fmtNum(r.orders)}</td><td class="num">${W.fmtMoney(r.gmv)}</td>
            <td class="num">${W.fmtMoney(W.ticket(r.gmv, r.orders))}</td>
            <td><div class="barcell"><span class="bartrack"><span class="barfill" style="width:${share * 100}%"></span></span></div></td></tr>`;
        }).join('') : '<tr><td colspan="7" class="muted">Sin tiendas en este rango</td></tr>'}</tbody>
      </table>
      ${rows.length > 60 ? `<p class="muted" style="font-size:.75rem;padding-top:.6rem">Mostrando 60 de ${W.fmtNum(rows.length)} — el XLSX trae todas.</p>` : ''}
    </div>` };
  }

  // ── Vista ─────────────────────────────────────────────────────────────────
  W.viewAnalytics = async function (ctx) {
    const { range, bucket, el } = ctx;
    const daily = await W.load('daily-summary');
    const cohorts = await W.load('cohorts').catch(() => null);
    const geo = await W.load('geo').catch(() => null);
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
    }).sort((a, b) => b.gmv - a.gmv);

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
    const products = Object.values(prodMap).sort((a, b) => b.gmv - a.gmv);
    const filtered = productQuery
      ? products.filter((p) => `${p.name} ${p.sku} ${p.dept}`.toLowerCase().includes(productQuery.toLowerCase()))
      : products;

    const categories = Object.entries(cur.categories).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.gmv - a.gmv);
    const coupons = Object.entries(cur.coupons).map(([code, v]) => ({ code, ...v })).sort((a, b) => b.gmv - a.gmv);
    const payments = Object.entries(cur.payments).map(([group, v]) => ({ group, ...v })).sort((a, b) => b.gmv - a.gmv);
    const noCatalog = !cur.hasCatalog;

    // ── Estados de pedido (siempre del canal completo: vienen del listado) ──
    const canc = W.cancellations(all.statusStats);
    const INCLUDED = ['invoiced', 'invoice', 'handling', 'ready-for-handling', 'shipped', 'order-accepted', 'payment-approved'];
    const statusRows = Object.entries(all.statusStats || {})
      .map(([status, v]) => ({ status, ...v, counts: INCLUDED.includes(status), cancelled: W.CANCELLED_STATUSES.includes(status) }))
      .sort((a, b) => b.orders - a.orders);

    // ── Geo ─────────────────────────────────────────────────────────────────
    const geoAgg = geo ? sumGeo(geo, range, bucket) : null;
    const hasGeo = geoAgg && Object.keys(geoAgg.prov).length > 0;
    const storesPanel = hasGeo ? renderStores(geo, geoAgg, selectedProv) : null;

    // ── Exportaciones ───────────────────────────────────────────────────────
    const tag = `${range.from}_${range.to}_${bucket}`;
    ctx.exports.segments = {
      filename: `webdash-segmentos-${tag}.csv`,
      headers: ['segmento', 'pedidos', 'gmv', 'unidades', 'ticket', 'unidades_por_pedido', 'share_gmv'],
      rows: segRows.map((r) => [r.label, r.orders, Math.round(r.gmv), Math.round(r.units), Math.round(r.ticket), r.upo.toFixed(2), r.share.toFixed(4)]),
    };
    ctx.exports.products = {
      filename: `webdash-productos-${tag}.csv`,
      headers: ['sku', 'producto', 'departamento', 'unidades', 'gmv', 'lineas_pedido'],
      rows: products.map((p) => [p.sku, p.name, p.dept, p.qty, p.gmv, p.orders]),
    };
    ctx.exports.categories = {
      filename: `webdash-categorias-${tag}.csv`,
      headers: ['categoria', 'lineas_pedido', 'unidades', 'gmv'],
      rows: categories.map((c) => [c.name, c.orders, Math.round(c.units), Math.round(c.gmv)]),
    };
    ctx.exports.coupons = {
      filename: `webdash-cupones-${tag}.csv`,
      headers: ['cupon', 'pedidos', 'gmv', 'ticket'],
      rows: coupons.map((c) => [c.code, c.orders, Math.round(c.gmv), Math.round(W.ticket(c.gmv, c.orders))]),
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
          <button class="btn" data-export="segments">${W.icon('download', 14)}CSV</button>
        </div>
        <div class="split">
          <table class="tbl">
            <thead><tr><th>Segmento</th><th class="num">Pedidos</th><th class="num">GMV</th><th class="num">Ticket</th><th class="num">U./pedido</th><th class="num">Share</th></tr></thead>
            <tbody>${segRows.map((r) => `<tr>
                <td><span class="dot" style="background:${r.color}"></span>${W.esc(r.label)}</td>
                <td class="num">${W.fmtNum(r.orders)} ${W.deltaBadge(r.dOrders)}</td>
                <td class="num">${W.fmtMoneyC(r.gmv)} ${W.deltaBadge(r.dGmv)}</td>
                <td class="num">${W.fmtMoney(r.ticket)}</td>
                <td class="num">${W.fmtDec(r.upo, 1)}</td>
                <td class="num">${W.fmtPct(r.share)}</td></tr>`).join('')}</tbody>
          </table>
          <div>${W.chart.donut({
            items: segRows.filter((r) => r.gmv > 0).map((r) => ({ label: r.label, value: r.gmv, color: r.color })),
            centerValue: W.fmtMoneyC(all.gmv), centerLabel: 'GMV total',
          })}</div>
        </div>
      </div>

      ${hasGeo ? `<div class="card">
        <div class="card-h">
          <div><h3>Ventas por provincia</h3><p>${scopeTxt} · hacé clic en una provincia para ver sus tiendas</p></div>
          <div class="card-a">
            <div class="seg-ctl">
              <button data-metric="gmv" class="${mapMetric === 'gmv' ? 'on' : ''}">GMV</button>
              <button data-metric="orders" class="${mapMetric === 'orders' ? 'on' : ''}">Pedidos</button>
            </div>
          </div>
        </div>
        ${renderMap(geo, geoAgg, mapMetric)}
      </div>
      ${storesPanel.html}`
      : `<div class="card"><div class="card-h"><div><h3>Ventas por provincia</h3>
          <p>Provincia y tienda se empezaron a capturar después del backfill. Al reprocesar el historial aparece el mapa acá.</p></div></div></div>`}

      <div class="card">
        <div class="card-h">
          <div><h3>Productos más vendidos</h3><p>${scopeTxt}
            <span class="scope" ${W.chart.tip('El ranking se agrega por mes: el rango se redondea a los meses que toca. Para el día exacto está el detalle crudo en data/daily.')}>por mes</span></p></div>
          <div class="card-a">
            <input class="inp inp-search" id="prod-search" type="search" placeholder="Buscar producto…" value="${W.esc(productQuery)}" />
            <button class="btn" data-export="products">${W.icon('download', 14)}CSV</button>
          </div>
        </div>
        ${W.chart.barsH({ items: filtered.slice(0, 15).map((p) => ({ label: p.name, sub: p.dept, value: p.gmv })), valueFmt: W.fmtMoneyC, color: 'var(--s1)' })}
        <details class="more"><summary>Ver tabla completa (${W.fmtNum(filtered.length)} productos)</summary>
          <table class="tbl dense">
            <thead><tr><th>#</th><th>Producto</th><th>Departamento</th><th class="num">Unidades</th><th class="num">GMV</th></tr></thead>
            <tbody>${filtered.slice(0, 200).map((p, i) => `<tr><td class="muted">${i + 1}</td><td>${W.esc(p.name)}</td>
              <td class="muted">${W.esc(p.dept)}</td><td class="num">${W.fmtNum(p.qty)}</td><td class="num">${W.fmtMoney(p.gmv)}</td></tr>`).join('')}</tbody>
          </table>
        </details>
      </div>

      <div class="g2">
        <div class="card">
          <div class="card-h">
            <div><h3>Categorías</h3><p>${scopeTxt} ${catalogWarn}</p></div>
            <button class="btn" data-export="categories">${W.icon('download', 14)}CSV</button>
          </div>
          ${categories.length ? W.chart.barsH({
            items: categories.slice(0, 12).map((c, i) => ({ label: c.name, value: c.gmv, sub: `${W.fmtNum(c.units)} unidades`, color: W.SERIES[i % W.SERIES.length] })),
            valueFmt: W.fmtMoneyC,
          }) : '<div class="chart-empty">Sin datos de categorías para este filtro.</div>'}
        </div>

        <div class="card">
          <div class="card-h"><div><h3>Medios de pago</h3><p>${scopeTxt} ${catalogWarn}</p></div></div>
          ${payments.length ? W.chart.donut({
            items: payments.slice(0, 6).map((p, i) => ({ label: p.group, value: p.gmv, color: W.SERIES[i % W.SERIES.length] })),
            centerValue: W.fmtNumC(payments.reduce((s, p) => s + p.orders, 0)), centerLabel: 'pedidos',
          }) : '<div class="chart-empty">Sin datos de medios de pago para este filtro.</div>'}
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <div><h3>Cupones</h3><p>${scopeTxt} ${catalogWarn}</p></div>
          <button class="btn" data-export="coupons">${W.icon('download', 14)}CSV</button>
        </div>
        <div class="strip">
          <div><span>${W.fmtPct(cur.orders ? coupons.reduce((s, c) => s + c.orders, 0) / cur.orders : 0)}</span><em>de los pedidos usó cupón</em></div>
          <div><span>${W.fmtNum(coupons.length)}</span><em>cupones distintos</em></div>
          <div><span>${W.fmtMoneyC(all.discount)}</span><em>descuento del período</em></div>
        </div>
        <table class="tbl">
          <thead><tr><th>Cupón</th><th class="num">Pedidos</th><th class="num">GMV asociado</th><th class="num">Ticket</th><th style="width:20%">Volumen</th></tr></thead>
          <tbody>${coupons.length ? coupons.slice(0, 25).map((c) => `<tr><td><code>${W.esc(c.code)}</code></td>
              <td class="num">${W.fmtNum(c.orders)}</td><td class="num">${W.fmtMoney(c.gmv)}</td>
              <td class="num">${W.fmtMoney(W.ticket(c.gmv, c.orders))}</td>
              <td><div class="barcell"><span class="bartrack"><span class="barfill" style="width:${(c.gmv / (coupons[0].gmv || 1)) * 100}%"></span></span></div></td></tr>`).join('')
            : '<tr><td colspan="5" class="muted">Sin cupones para este filtro.</td></tr>'}</tbody>
        </table>
      </div>

      <div class="card">
        <div class="card-h">
          <div><h3>Estados de pedido</h3><p>${W.fmtDayLong(range.from)} → ${W.fmtDayLong(range.to)} · todos los pedidos del canal, incluidos los que no cuentan</p></div>
          <button class="btn" data-export="statuses">${W.icon('download', 14)}CSV</button>
        </div>
        <div class="strip">
          <div><span>${W.fmtPct(canc.rate)}</span><em>tasa de cancelación</em></div>
          <div><span>${W.fmtNumC(canc.cancelledOrders)}</span><em>pedidos cancelados</em></div>
          <div><span>${W.fmtMoneyC(canc.cancelledGmv)}</span><em>monto no facturado</em></div>
        </div>
        <table class="tbl">
          <thead><tr><th>Estado</th><th>Cuenta</th><th class="num">Pedidos</th><th class="num">Monto</th><th style="width:18%">% pedidos</th></tr></thead>
          <tbody>${statusRows.length ? statusRows.map((r) => `<tr><td><code>${W.esc(r.status)}</code></td>
              <td>${r.counts ? '<span class="pill ok">Sí</span>' : r.cancelled ? '<span class="pill no">No · cancelado</span>' : '<span class="pill n">No</span>'}</td>
              <td class="num">${W.fmtNum(r.orders)}</td><td class="num">${W.fmtMoney(r.gmv)}</td>
              <td><div class="barcell"><span class="bartrack"><span class="barfill" style="width:${(r.orders / (canc.totalOrders || 1)) * 100}%;background:${r.counts ? 'var(--pos)' : r.cancelled ? 'var(--neg)' : 'var(--ink-4)'}"></span></span><b>${W.fmtPct(r.orders / (canc.totalOrders || 1))}</b></div></td></tr>`).join('')
            : '<tr><td colspan="5" class="muted">Sin datos</td></tr>'}</tbody>
        </table>
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

    wire(ctx, geo, geoAgg, storesPanel);
  };

  function wire(ctx, geo, geoAgg, storesPanel) {
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

    document.querySelectorAll('[data-metric]').forEach((b) =>
      b.addEventListener('click', () => { mapMetric = b.dataset.metric; W.render(); }));

    // Clic en el mapa o en la tabla de ranking: abre / cierra la provincia.
    document.querySelectorAll('[data-prov]').forEach((elp) =>
      elp.addEventListener('click', () => {
        const code = elp.dataset.prov;
        selectedProv = selectedProv === code ? null : code;
        W.render();
      }));
    document.getElementById('clear-prov')?.addEventListener('click', () => { selectedProv = null; W.render(); });

    document.getElementById('xlsx-stores')?.addEventListener('click', () => {
      if (!storesPanel) return;
      const M = W.AR_MAP;
      const provName = (c) => M.provinces[c]?.name || '';
      // Hoja 1: las tiendas del filtro actual. Hoja 2: siempre todas, para no
      // obligar a exportar provincia por provincia.
      const sheetRows = (rows) => [
        ['Tienda', 'Código', 'Provincia', 'Pedidos', 'GMV', 'Ticket promedio'],
        ...rows.map((r) => [r.name, r.code, provName(r.prov), r.orders, Math.round(r.gmv), Math.round(W.ticket(r.gmv, r.orders))]),
      ];
      const todas = Object.entries(geoAgg.stores)
        .map(([code, v]) => ({ code, name: geo.stores?.[code]?.name || code, prov: geo.stores?.[code]?.prov || null, ...v }))
        .sort((a, b) => b.gmv - a.gmv);
      const provincias = [
        ['Provincia', 'Pedidos', 'GMV'],
        ...Object.entries(geoAgg.prov).map(([c, v]) => [provName(c), v.orders, Math.round(v.gmv)]).sort((a, b) => b[2] - a[2]),
      ];

      const sheets = [];
      if (selectedProv) sheets.push({ name: provName(selectedProv).slice(0, 31) || 'Provincia', rows: sheetRows(storesPanel.rows) });
      sheets.push({ name: 'Todas las tiendas', rows: sheetRows(todas) }, { name: 'Provincias', rows: provincias });

      W.downloadXLSX(`webdash-tiendas-${ctx.range.from}_${ctx.range.to}-${ctx.bucket}.xlsx`, sheets);
      W.toast(`Exportadas ${W.fmtNum(todas.length)} tiendas.`, 'good');
    });
  }
})();

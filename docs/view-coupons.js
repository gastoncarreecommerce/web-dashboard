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

  const COUPONS_TOP = 10;
  const COUPONS_ALL_CAP = 300;
  let couponQuery = '';
  let showAllCoupons = false;
  let openCoupon = null; // código del cupón con el detalle de pedidos abierto
  let couponDetail = null; // { loading, rows, months } del cupón abierto

  /**
   * Pedidos que usaron un cupón puntual, buscando en el índice liviano de
   * pedidos por mes (order-index/<mes>.json). Ese archivo solo existe con
   * campo `cp` en pedidos procesados DESPUÉS de este cambio — pedidos viejos
   * no tienen forma de asociarse a su cupón sin volver a pedirle el pedido
   * completo a VTEX, así que el detalle de esos meses queda vacío a propósito
   * (en vez de mostrar un resultado parcial que parezca completo).
   */
  async function loadCouponOrders(code, months, emailMap) {
    const perMonth = await Promise.all(months.map((m) => W.load(`order-index/${m}`).catch(() => [])));
    return perMonth.flat()
      .filter((o) => o.cp?.includes(code))
      .map((o) => ({ ...o, email: (o.h && emailMap?.get(o.h)?.email) || '', dni: (o.h && emailMap?.get(o.h)?.dni) || '' }));
  }

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

    const allCoupons = Object.entries(cur.coupons).map(([code, v]) => ({ code, ...v })).sort((a, b) => b.gmv - a.gmv);
    const prevCoupons = Object.entries(prev.coupons).map(([code, v]) => ({ code, ...v }));
    const prevByCode = Object.fromEntries(prevCoupons.map((c) => [c.code, c]));
    const totalCouponGmv = allCoupons.reduce((s, c) => s + c.gmv, 0);
    const totalCouponOrders = allCoupons.reduce((s, c) => s + c.orders, 0);

    const filteredCoupons = couponQuery
      ? allCoupons.filter((c) => c.code.toLowerCase().includes(couponQuery.toLowerCase()))
      : allCoupons;
    const coupons = (couponQuery || showAllCoupons) ? filteredCoupons.slice(0, COUPONS_ALL_CAP) : filteredCoupons.slice(0, COUPONS_TOP);

    // Meses que toca el rango — el índice de pedidos por cupón está partido
    // por mes, igual que los productos.
    const months = [...new Set((daily.days || [])
      .filter((d) => d.date >= range.from && d.date <= range.to)
      .map((d) => d.date.slice(0, 7)))];

    let detailPanel = null;
    if (openCoupon) {
      const emailMap = await W.loadEmailMap();
      const rows = await loadCouponOrders(openCoupon, months, emailMap);
      detailPanel = { rows, hasEmails: !!emailMap };
    }

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
      rows: allCoupons.map((c) => [c.code, c.orders, Math.round(c.gmv), Math.round(W.ticket(c.gmv, c.orders)), c.gmv / (totalCouponGmv || 1)]),
    };

    const kpi = ({ icon, label, value, sub, color }) => `<div class="kpi">
      <div class="kpi-t"><span class="kpi-ic" style="background:${color}38;color:${color}">${W.icon(icon, 18)}</span></div>
      <div class="kpi-v">${value}</div>
      <div class="kpi-l">${W.esc(label)}</div>
      ${sub ? `<div class="kpi-s">${sub}</div>` : ''}
    </div>`;

    el.innerHTML = `
      <div class="kpis">
        ${kpi({ icon: 'tag', label: 'Cupones distintos usados', value: W.fmtNum(allCoupons.length), color: '#2a78d6', sub: scopeTxt })}
        ${kpi({ icon: 'ticket', label: 'Pedidos con cupón (líneas)', value: W.fmtNumC(totalCouponOrders), color: '#eb6834',
          sub: `${W.fmtMoneyC(totalCouponGmv)} de GMV asociado` })}
        ${hasClientData ? kpi({ icon: 'percent', label: '% de pedidos con cupón', value: W.fmtPct(lifetimeOrders ? lifetimeCouponOrders / lifetimeOrders : 0),
          color: '#1baf7a', sub: 'histórico de toda la base' }) : ''}
        ${hasClientData ? kpi({ icon: 'shield', label: 'Clientes que nunca usaron cupón', value: W.fmtNumC(neverUsed),
          color: '#4a3aa7', sub: `${W.fmtPct(neverUsed + everUsed ? neverUsed / (neverUsed + everUsed) : 0)} de la base` }) : ''}
      </div>

      <div class="card">
        <div class="card-h">
          <div><h3>${showAllCoupons || couponQuery ? 'Cupones' : `Top ${COUPONS_TOP} cupones`}</h3><p>${scopeTxt} ${catalogWarn}
            <span class="scope" ${W.chart.tip('Un pedido puede traer más de un cupón a la vez (VTEX los guarda separados por coma) — cada cupón se cuenta acá individualmente, así que la suma de pedidos puede superar el total de pedidos del período.')}>${W.icon('info', 11)} un pedido puede sumar a varios cupones</span></p></div>
          <div class="card-a">
            <input class="inp inp-search" id="coupon-search" type="search" placeholder="Buscar cupón…" value="${W.esc(couponQuery)}" />
            ${!couponQuery ? `<button class="btn" id="coupons-toggle-all">${showAllCoupons ? 'Ver top 10' : 'Ver todos'}</button>` : ''}
            <button class="btn" data-export="coupons">${W.icon('download', 14)}XLSX (todos)</button>
          </div>
        </div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>#</th><th>Cupón</th><th class="num">Pedidos</th><th class="num">GMV</th><th class="num">Ticket</th><th class="num">vs. período anterior</th><th style="width:16%">% del GMV con cupón</th><th></th></tr></thead>
          <tbody>${coupons.length ? coupons.map((c, i) => {
            const p = prevByCode[c.code];
            const dOrders = p ? W.delta(c.orders, p.orders) : undefined;
            const open = openCoupon === c.code;
            return `<tr class="${open ? 'on' : ''}">
              <td class="muted">${i + 1}</td>
              <td><code>${W.esc(c.code)}</code></td>
              <td class="num">${W.fmtNum(c.orders)}</td>
              <td class="num">${W.fmtMoney(c.gmv)}</td>
              <td class="num">${W.fmtMoney(W.ticket(c.gmv, c.orders))}</td>
              <td class="num">${dOrders !== undefined ? W.deltaBadge(dOrders) : '<span class="muted">—</span>'}</td>
              <td><div class="barcell"><span class="bartrack"><span class="barfill" style="width:${(c.gmv / (totalCouponGmv || 1)) * 100}%"></span></span><b>${W.fmtPct(c.gmv / (totalCouponGmv || 1))}</b></div></td>
              <td><button class="btn-s" data-coupon-detail="${W.esc(c.code)}">${open ? 'Cerrar' : 'Ver detalle'}</button></td>
            </tr>`;
          }).join('') : `<tr><td colspan="8" class="muted">${couponQuery ? 'Ningún cupón coincide con la búsqueda' : 'Sin cupones en este rango'}</td></tr>`}</tbody>
        </table></div>
        ${!couponQuery && !showAllCoupons && allCoupons.length > COUPONS_TOP ? `<p class="muted" style="font-size:.75rem;padding-top:.6rem">Mostrando ${COUPONS_TOP} de ${W.fmtNum(allCoupons.length)} — "Ver todos" o el XLSX traen el resto.</p>` : ''}
      </div>

      ${openCoupon ? `<div class="card" id="coupon-detail">
        <div class="card-h">
          <div><h3>Pedidos con el cupón ${W.esc(openCoupon)}</h3>
            <p>${W.fmtNum(detailPanel.rows.length)} pedidos encontrados en ${scopeTxt}
              ${detailPanel.hasEmails ? '' : `<span class="scope" ${W.chart.tip('Los mails viven en el repositorio privado. Si no aparecen, todavía no se configuró /api/audience-emails.')}>${W.icon('warn', 11)} sin mails</span>`}</p>
          </div>
          <button class="btn" id="close-coupon-detail">${W.icon('close', 14)}Cerrar</button>
        </div>
        <p class="muted" style="font-size:.75rem;margin-bottom:.6rem">El pipeline no guarda el nombre del cliente (solo hash, mail y DNI, por diseño) — acá va número de pedido, fecha, mail y DNI. Los pedidos de antes de este cambio no tienen el cupón asociado guardado y no van a aparecer.</p>
        <div class="tbl-wrap"><table class="tbl dense">
          <thead><tr><th>Pedido</th><th>Fecha</th><th>Mail</th><th>DNI</th><th class="num">GMV</th></tr></thead>
          <tbody>${detailPanel.rows.length ? detailPanel.rows.map((o) => `<tr>
              <td class="muted">${W.esc(o.id)}</td>
              <td class="muted">${new Date(o.t).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', dateStyle: 'short', timeStyle: 'short' })}</td>
              <td>${o.email ? W.esc(o.email) : '<span class="muted">sin mail</span>'}</td>
              <td>${o.dni ? W.esc(o.dni) : '<span class="muted">—</span>'}</td>
              <td class="num">${W.fmtMoney(o.g)}</td>
            </tr>`).join('') : '<tr><td colspan="5" class="muted">Sin pedidos con este cupón en el rango (o son de antes de que se empezara a guardar el detalle).</td></tr>'}</tbody>
        </table></div>
      </div>` : ''}

      ${!hasClientData ? `<div class="card"><div class="card-h"><div><h3>Clientes y cupones</h3>
        <p>Todavía no hay perfiles de cliente para cruzar con cupones — corré el backfill para habilitar esta parte.</p></div></div></div>` : ''}`;

    wire();
  };

  function wire() {
    const $ = (s) => document.querySelector(s);
    const search = $('#coupon-search');
    if (search) {
      search.addEventListener('input', (e) => {
        couponQuery = e.target.value;
        const pos = e.target.selectionStart;
        W.render().then(() => {
          const s2 = document.getElementById('coupon-search');
          if (s2) { s2.focus(); s2.setSelectionRange(pos, pos); }
        });
      });
    }
    $('#coupons-toggle-all')?.addEventListener('click', () => { showAllCoupons = !showAllCoupons; W.render(); });
    document.querySelectorAll('[data-coupon-detail]').forEach((b) =>
      b.addEventListener('click', () => {
        const code = b.dataset.couponDetail;
        openCoupon = openCoupon === code ? null : code;
        W.render().then(() => {
          if (openCoupon) document.getElementById('coupon-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      }));
    $('#close-coupon-detail')?.addEventListener('click', () => { openCoupon = null; W.render(); });
  }
})();

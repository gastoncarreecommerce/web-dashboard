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
  let storeQuery = '';
  let selectedProv = null;  // provincia abierta en el mapa
  let selectedStore = null; // { code, name } de la tienda con el detalle de pedidos abierto
  let mapMetric = 'gmv';   // 'gmv' | 'orders'
  let catLevel = 'n3';     // 'n1' (departamento) | 'n2' (rubro) | 'n3' (detalle)
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
   * Imagen del producto por EAN, vía OpenFoodFacts (base pública y gratuita
   * de productos de supermercado, sin API key). El sku que guarda VTEX suele
   * ser el EAN/código de barras de góndola — si no tiene forma de EAN
   * (8/12/13/14 dígitos) ni vale la pena intentarlo. Best-effort: cualquier
   * falla (sin red, producto no está en la base, timeout) cae a null y se
   * muestra un placeholder — nunca rompe el panel de productos.
   * Cacheado en memoria: no se repite la búsqueda en cada re-render.
   */
  const productImgCache = new Map();
  async function resolveProductImg(sku) {
    if (productImgCache.has(sku)) return productImgCache.get(sku);
    if (!/^\d{8}(\d{4,6})?$/.test(String(sku || ''))) { productImgCache.set(sku, null); return null; }
    let url = null;
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${sku}.json?fields=image_front_small_url`, { signal: ctrl.signal });
      clearTimeout(to);
      if (res.ok) {
        const data = await res.json();
        url = data?.product?.image_front_small_url || null;
      }
    } catch { /* sin red, timeout, o CORS — se sigue sin imagen */ }
    productImgCache.set(sku, url);
    return url;
  }

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
        <div class="tbl-wrap"><table class="tbl dense">
          <thead><tr><th>Provincia</th><th class="num">Pedidos</th><th class="num">GMV</th></tr></thead>
          <tbody>${ranked.length ? ranked.map((r) => `<tr class="provrow${selectedProv === r.code ? ' on' : ''}" data-prov="${r.code}">
              <td>${W.esc(r.name)}</td><td class="num">${W.fmtNum(r.orders)}</td><td class="num">${W.fmtMoneyC(r.gmv)}</td></tr>`).join('')
            : '<tr><td colspan="3" class="muted">Sin datos geográficos en este rango</td></tr>'}</tbody>
        </table></div>
      </div>
    </div>`;
  }

  // Devuelve solo el CONTENIDO (tabla + nota), sin tarjeta propia: se monta
  // dentro de la tarjeta única de geografía, con breadcrumb, para que abrir
  // una provincia o una tienda no vaya apilando tarjetas nuevas más abajo.
  // Top 10 por default (el XLSX trae todas) — buscar por nombre destraba el
  // resto sin tener que bajar el archivo solo para clickear una tienda chica.
  const STORES_TOP = 10;
  function renderStores(geo, agg, provCode) {
    const M = W.AR_MAP;
    const rows = Object.entries(agg.stores)
      .map(([code, v]) => ({ code, name: geo.stores?.[code]?.name || code, prov: geo.stores?.[code]?.prov || null, ...v }))
      .filter((r) => !provCode || r.prov === provCode)
      .sort((a, b) => b.gmv - a.gmv);
    const shown = storeQuery
      ? rows.filter((r) => r.name.toLowerCase().includes(storeQuery.toLowerCase()))
      : rows.slice(0, STORES_TOP);

    return { rows, html: `
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>#</th><th>Tienda</th><th>Provincia</th><th class="num">Pedidos</th><th class="num">GMV</th><th class="num">Ticket</th><th style="width:18%">Participación</th></tr></thead>
        <tbody>${shown.length ? shown.map((r) => {
          const i = rows.indexOf(r);
          const share = rows[0].gmv ? r.gmv / rows[0].gmv : 0;
          const on = selectedStore?.code === r.code;
          return `<tr class="storerow${on ? ' on' : ''}" data-store="${r.code}" data-store-name="${W.esc(r.name)}"><td class="muted">${i + 1}</td><td>${W.esc(r.name)}</td>
            <td class="muted">${W.esc(M.provinces[r.prov]?.name || '—')}</td>
            <td class="num">${W.fmtNum(r.orders)}</td><td class="num">${W.fmtMoney(r.gmv)}</td>
            <td class="num">${W.fmtMoney(W.ticket(r.gmv, r.orders))}</td>
            <td><div class="barcell"><span class="bartrack"><span class="barfill" style="width:${share * 100}%"></span></span></div></td></tr>`;
        }).join('') : `<tr><td colspan="7" class="muted">${storeQuery ? 'Ninguna tienda coincide con la búsqueda' : 'Sin tiendas en este rango'}</td></tr>`}</tbody>
      </table></div>
      ${!storeQuery && rows.length > STORES_TOP ? `<p class="muted" style="font-size:.75rem;padding-top:.6rem">Mostrando ${STORES_TOP} de ${W.fmtNum(rows.length)} — buscá por nombre o exportá el XLSX para verlas todas.</p>` : ''}` };
  }

  /**
   * Pedidos de una tienda en el rango elegido. Se guardan particionados por
   * tienda y mes (docs/data/web/orders/<código>/<mes>.json) para que abrir
   * el detalle de UNA tienda no baje los pedidos de las otras 180 — un mes
   * que la tienda no operó simplemente no tiene archivo (404 = sin pedidos).
   */
  async function loadStoreOrders(storeCode, months) {
    const perMonth = await Promise.all(
      months.map((m) => W.load(`orders/${storeCode}/${m}`).catch(() => []))
    );
    return perMonth.flat();
  }

  // Techo de filas que se pintan en la tabla: una tienda grande en un rango
  // largo puede tener varios miles de pedidos, y armar esa cantidad de <tr>
  // con el detalle de productos de cada uno es lo que trababa el navegador
  // al abrir el panel. Se muestran los más recientes y el XLSX trae todos.
  const STORE_ORDERS_MAX_ROWS = 300;

  function renderStoreOrders(store, orders, range, emailMap) {
    // o.t es el creationDate crudo de VTEX, en UTC: para un pedido de las
    // 00:30 UTC, cortar el string a lo bruto da un día que en AR todavía es
    // "ayer". W.arDateOf() hace la misma conversión que ya usa el resto del
    // pipeline para agrupar por día.
    const inRange = orders.filter((o) => {
      const day = W.arDateOf(o.t);
      return day >= range.from && day <= range.to;
    });
    const totalGmv = inRange.reduce((s, o) => s + o.g, 0);
    const sorted = [...inRange].sort((a, b) => (a.t < b.t ? 1 : a.t > b.t ? -1 : 0));
    const shown = sorted.slice(0, STORE_ORDERS_MAX_ROWS);

    return { rows: sorted, count: inRange.length, gmv: totalGmv, emailMap, html: `
      <div class="tbl-wrap"><table class="tbl dense">
        <thead><tr><th>Pedido</th><th>Fecha</th><th>Mail</th><th>Productos</th><th class="num">GMV</th></tr></thead>
        <tbody>${shown.length ? shown.map((o) => {
          const email = o.h && emailMap?.get(o.h)?.email;
          const ITEMS_PREVIEW = 4;
          const full = o.it.map((it) => `${it.n} ×${it.q}`).join(', ');
          const preview = o.it.slice(0, ITEMS_PREVIEW).map((it) => `${W.esc(it.n)} ×${it.q}`).join(', ');
          const rest = o.it.length - ITEMS_PREVIEW;
          const items = rest > 0
            ? `${preview} <span class="muted" ${W.chart.tip(`<strong>${W.fmtNum(o.it.length)} productos</strong><span class="tip-row">${W.esc(full)}</span>`)}>+${rest} más</span>`
            : preview;
          return `<tr>
            <td class="muted">${W.esc(o.id)}</td>
            <td class="muted">${new Date(o.t).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', dateStyle: 'short', timeStyle: 'short' })}</td>
            <td>${email ? W.esc(email) : '<span class="muted">sin mail</span>'}</td>
            <td class="muted item-cell">${items}</td>
            <td class="num">${W.fmtMoney(o.g)}</td>
          </tr>`;
        }).join('') : '<tr><td colspan="5" class="muted">Sin pedidos de esta tienda en el rango elegido.</td></tr>'}</tbody>
      </table></div>
      ${inRange.length > STORE_ORDERS_MAX_ROWS ? `<p class="muted" style="font-size:.75rem;padding-top:.6rem">Mostrando los ${W.fmtNum(STORE_ORDERS_MAX_ROWS)} más recientes de ${W.fmtNum(inRange.length)} — el XLSX trae todos.</p>` : ''}` };
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
    const topProductImgs = await Promise.all(filtered.slice(0, 10).map((p) => resolveProductImg(p.sku)));

    const categories = Object.entries(cur[CAT_LEVEL[catLevel].key] || {}).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.gmv - a.gmv);
    const payments = Object.entries(cur[PAY_LEVEL[payLevel].key] || {}).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.gmv - a.gmv);
    const hasPayDetail = Object.keys(cur.paymentBrands || {}).length > 0;
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

    // Detalle de pedidos de la tienda elegida. Se resuelve ACÁ (no en el
    // render) porque viewAnalytics ya es async y así el HTML sale completo
    // en una sola pasada, sin parpadeo de "cargando" en medio de la tarjeta.
    let storeOrdersPanel = null;
    if (selectedStore) {
      const [orders, emailMap] = await Promise.all([
        loadStoreOrders(selectedStore.code, months),
        W.loadEmailMap(),
      ]);
      storeOrdersPanel = renderStoreOrders(selectedStore, orders, range, emailMap);
      storeOrdersPanel.emailMap = emailMap;
    }

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
          <button class="btn" data-export="segments">${W.icon('download', 14)}XLSX</button>
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
      <div class="card" id="geo-detail">
        <div class="card-h">
          <div>
            <div class="crumb">
              <button class="crumb-item${!selectedProv ? ' current' : ''}" data-crumb="root">Todas las tiendas</button>
              ${selectedProv ? `<span class="crumb-sep">${W.icon('chevronR', 12)}</span>
                <button class="crumb-item${!selectedStore ? ' current' : ''}" data-crumb="prov">${W.esc(W.AR_MAP.provinces[selectedProv]?.name || selectedProv)}</button>` : ''}
              ${selectedStore ? `<span class="crumb-sep">${W.icon('chevronR', 12)}</span>
                <span class="crumb-item current">${W.esc(selectedStore.name)}</span>` : ''}
            </div>
            <p>${selectedStore
              ? `${W.fmtDayLong(range.from)} → ${W.fmtDayLong(range.to)} · ${W.fmtNum(storeOrdersPanel.count)} pedidos · ${W.fmtMoney(storeOrdersPanel.gmv)}
                 ${storeOrdersPanel.emailMap ? '' : `<span class="scope" ${W.chart.tip('Los mails viven en el repositorio privado. Si no aparecen, todavía no se configuró /api/audience-emails.')}>${W.icon('warn', 11)} sin mails</span>`}`
              : `${W.fmtNum(storesPanel.rows.length)} tiendas · ordenadas por GMV · hacé clic en una fila para ver sus pedidos`}</p>
          </div>
          <div class="card-a">
            ${!selectedStore ? `<input class="inp inp-search" id="store-search" type="search" placeholder="Buscar tienda…" value="${W.esc(storeQuery)}" />` : ''}
            ${selectedStore
              ? `<button class="btn-p" id="xlsx-store-orders">${W.icon('download', 14)}Exportar XLSX</button>`
              : `<button class="btn-p" id="xlsx-stores">${W.icon('download', 14)}Exportar XLSX (todas)</button>`}
          </div>
        </div>
        ${selectedStore ? storeOrdersPanel.html : storesPanel.html}
      </div>`
      : `<div class="card"><div class="card-h"><div><h3>Ventas por provincia</h3>
          <p>Provincia y tienda se empezaron a capturar después del backfill. Al reprocesar el historial aparece el mapa acá.</p></div></div></div>`}

      <div class="card">
        <div class="card-h">
          <div><h3>Top 10 productos más vendidos</h3><p>${scopeTxt}
            <span class="scope" ${W.chart.tip('El ranking se agrega por mes: el rango se redondea a los meses que toca. Para el día exacto está el detalle crudo en data/daily.')}>por mes</span></p></div>
          <div class="card-a">
            <input class="inp inp-search" id="prod-search" type="search" placeholder="Buscar producto…" value="${W.esc(productQuery)}" />
            <button class="btn" data-export="products">${W.icon('download', 14)}XLSX (todos)</button>
          </div>
        </div>
        ${filtered.length ? W.chart.barsH({ items: filtered.slice(0, 10).map((p, i) => ({ label: p.name, sub: p.dept, value: p.gmv, img: topProductImgs[i] })), valueFmt: W.fmtMoneyC, color: 'var(--s1)' })
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
              <button class="btn" data-export="categories">${W.icon('download', 14)}XLSX</button>
            </div>
          </div>
          ${categories.length ? W.chart.barsH({
            items: categories.slice(0, 12).map((c, i) => ({ label: c.name, value: c.gmv, sub: `${W.fmtNum(c.units)} unidades`, color: W.SERIES[i % W.SERIES.length] })),
            valueFmt: W.fmtMoneyC,
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
            </div>
          </div>
          ${payments.length ? W.chart.donut({
            items: payments.slice(0, 8).map((p, i) => ({ label: p.name, value: p.gmv, color: W.SERIES[i % W.SERIES.length] })),
            centerValue: W.fmtNumC(payments.reduce((s, p) => s + p.orders, 0)), centerLabel: 'pedidos',
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

    wire(ctx, geo, geoAgg, storesPanel, storeOrdersPanel, months);

    // La tarjeta de geografía cambia de contenido (provincia → tiendas →
    // pedidos) más abajo en la página: sin este scroll, elegir una provincia
    // o una tienda no se notaba y parecía que el clic no hizo nada. Solo
    // scrollea en la transición de "cerrado" a "abierto" de cada nivel, no
    // en cada re-render (si no, cada clic — incluso cambiar de fecha — tira
    // la página para abajo de nuevo).
    const drillKey = hasGeo ? `${selectedProv || ''}|${selectedStore?.code || ''}` : '';
    if (drillKey && drillKey !== lastDrillKey) {
      requestAnimationFrame(() => {
        document.getElementById('geo-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
    lastDrillKey = drillKey;
  };

  // Última combinación provincia|tienda que ya generó un scroll, para no
  // repetirlo en cada re-render (p.ej. al cambiar el rango de fechas).
  let lastDrillKey = '';

  function wire(ctx, geo, geoAgg, storesPanel, storeOrdersPanel, months) {
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

    const storeSearch = document.getElementById('store-search');
    if (storeSearch) {
      storeSearch.addEventListener('input', (e) => {
        storeQuery = e.target.value;
        const pos = e.target.selectionStart;
        W.render().then(() => {
          const s2 = document.getElementById('store-search');
          if (s2) { s2.focus(); s2.setSelectionRange(pos, pos); }
        });
      });
    }

    document.querySelectorAll('[data-metric]').forEach((b) =>
      b.addEventListener('click', () => { mapMetric = b.dataset.metric; W.render(); }));

    document.querySelectorAll('[data-catlevel]').forEach((b) =>
      b.addEventListener('click', () => { catLevel = b.dataset.catlevel; W.render(); }));

    document.querySelectorAll('[data-paylevel]').forEach((b) =>
      b.addEventListener('click', () => { payLevel = b.dataset.paylevel; W.render(); }));

    // Clic en el mapa o en la tabla de ranking: abre / cierra la provincia.
    document.querySelectorAll('[data-prov]').forEach((elp) =>
      elp.addEventListener('click', () => {
        const code = elp.dataset.prov;
        selectedProv = selectedProv === code ? null : code;
        // Cambiar de provincia deja atrás la tienda que estuviera abierta —
        // si no, la tarjeta de pedidos seguía apuntando a una tienda que ya
        // no pertenece a la provincia recién elegida.
        selectedStore = null;
        storeQuery = '';
        W.render();
      }));
    // Clic en una fila de tienda: abre / cierra el detalle de sus pedidos.
    document.querySelectorAll('[data-store]').forEach((elr) =>
      elr.addEventListener('click', () => {
        const code = elr.dataset.store;
        selectedStore = selectedStore?.code === code ? null : { code, name: elr.dataset.storeName };
        W.render();
      }));

    // Breadcrumb de la tarjeta de geografía: "Todas las tiendas" vuelve al
    // principio, el nombre de la provincia vuelve un nivel (a las tiendas).
    document.querySelectorAll('[data-crumb]').forEach((b) =>
      b.addEventListener('click', () => {
        if (b.dataset.crumb === 'root') { selectedProv = null; storeQuery = ''; }
        selectedStore = null;
        W.render();
      }));

    document.getElementById('xlsx-store-orders')?.addEventListener('click', () => {
      if (!storeOrdersPanel) return;
      const emailMap = storeOrdersPanel.emailMap;
      const rows = storeOrdersPanel.rows.map((o) => [
        o.id,
        new Date(o.t).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }),
        (o.h && emailMap?.get(o.h)?.email) || '',
        o.it.map((it) => `${it.n} x${it.q}`).join(' | '),
        Math.round(o.g),
      ]);
      W.downloadXLSX(`webdash-pedidos-${selectedStore.code}-${ctx.range.from}_${ctx.range.to}.xlsx`, [
        { name: 'Pedidos', rows: [['Pedido', 'Fecha', 'Mail', 'Productos', 'GMV'], ...rows] },
      ]);
      W.toast(`Exportados ${W.fmtNum(rows.length)} pedidos.`, 'good');
    });

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

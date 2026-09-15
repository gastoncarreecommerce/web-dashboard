/* global window, document */
/**
 * Vista "Tiendas": mapa de Argentina + ranking de tiendas + detalle de
 * pedidos por tienda. Antes vivía adentro de Analítica, compitiendo por
 * espacio con todo lo demás — el mapa quedaba gigante en una pantalla ya
 * llena, obligando a scrollear de más para ver el resto. Separado acá queda
 * más chico, más rápido de entender, y con su propio flujo de drill-down
 * (provincia → tienda → pedidos) sin saltos de scroll forzados: el detalle
 * se abre DENTRO de la misma tarjeta en vez de en una tarjeta aparte.
 */
(function () {
  const W = (window.W = window.W || {});

  let selectedProv = null;  // provincia abierta en el mapa
  let selectedStore = null; // { code, name } de la tienda con el detalle de pedidos abierto
  let storeQuery = '';
  let metric = 'gmv'; // 'gmv' | 'orders' — controla el color del mapa Y el orden del ranking

  const SEG_ALL = 'all';
  const segsOf = (bucket) => (bucket === SEG_ALL ? W.SEGMENTS : [bucket]);

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

  function renderMap(agg) {
    const M = W.AR_MAP;
    if (!M) return '<div class="chart-empty">No se pudo cargar el mapa.</div>';

    const vals = Object.values(agg.prov).map((v) => v[metric]);
    const max = Math.max(1, ...vals);
    const fmt = W.metricFmt(metric);

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
      .sort((a, b) => b[metric] - a[metric]);
    const shown = storeQuery
      ? rows.filter((r) => r.name.toLowerCase().includes(storeQuery.toLowerCase()))
      : rows.slice(0, STORES_TOP);

    return { rows, html: `
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>#</th><th>Tienda</th><th>Provincia</th><th class="num">Pedidos</th><th class="num">GMV</th><th class="num">Ticket</th><th style="width:18%">Participación</th></tr></thead>
        <tbody>${shown.length ? shown.map((r) => {
          const i = rows.indexOf(r);
          const share = rows[0][metric] ? r[metric] / rows[0][metric] : 0;
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
   * Pedidos de una tienda en el rango elegido, particionados por tienda Y MES
   * (orders/<código>/<año>-<mes>.json, con el mes como única clave adentro).
   *
   * Antes esto era por semestre y se pedía el semestre entero para mostrar,
   * por ejemplo, una semana: hasta 57 MB para leer unos pocos días. Por mes
   * se piden solo los meses que toca el rango, y un mes cerrado no vuelve a
   * cambiar nunca, así que /api/archive lo deja cacheado en el browser.
   *
   * No todos los meses tienen archivo (una tienda sin pedidos ese mes no
   * genera ninguno): el 404 se trata como "sin datos", no como error.
   */
  async function loadStoreOrders(storeCode, months) {
    const perMonth = await Promise.all(
      months.map((m) => W.load(`orders/${storeCode}/${m}`).catch(() => ({})))
    );
    const byMonth = Object.assign({}, ...perMonth);
    return months.flatMap((m) => byMonth[m] || []);
  }

  // Techo de filas que se pintan en la tabla: una tienda grande en un rango
  // largo puede tener varios miles de pedidos, y armar esa cantidad de <tr>
  // con el detalle de productos de cada uno es lo que trababa el navegador
  // al abrir el panel. Se muestran los más recientes y el XLSX trae todos.
  const STORE_ORDERS_MAX_ROWS = 300;

  function renderStoreOrders(orders, range, emailMap) {
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

  // Última combinación provincia|tienda que ya generó un scroll, para no
  // repetirlo en cada re-render (p.ej. al cambiar el rango de fechas).
  let lastDrillKey = '';

  W.viewTiendas = async function (ctx) {
    const { range, bucket, el } = ctx;
    const daily = await W.load('daily-summary');
    const geo = await W.load('geo').catch(() => null);

    if (!daily.days.length) {
      el.innerHTML = `<div class="empty"><h2>Todavía no hay datos</h2><p>Corré el backfill inicial (ver README).</p></div>`;
      return;
    }

    const scopeTxt = `${W.fmtDayLong(range.from)} → ${W.fmtDayLong(range.to)} · ${bucket === SEG_ALL ? 'todos los segmentos' : W.SEGMENT_LABEL[bucket]}`;
    const months = [...new Set((daily.days || [])
      .filter((d) => d.date >= range.from && d.date <= range.to)
      .map((d) => d.date.slice(0, 7)))];

    const geoAgg = geo ? sumGeo(geo, range, bucket) : null;
    const hasGeo = geoAgg && Object.keys(geoAgg.prov).length > 0;

    if (!hasGeo) {
      el.innerHTML = `<div class="card"><div class="card-h"><div><h3>Tiendas</h3>
        <p>Provincia y tienda se empezaron a capturar después del backfill. Al reprocesar el historial aparece el mapa acá.</p></div></div></div>`;
      return;
    }

    const storesPanel = renderStores(geo, geoAgg, selectedProv);

    // Detalle de pedidos de la tienda elegida. Se resuelve ACÁ (no en el
    // render) porque viewTiendas ya es async y así el HTML sale completo en
    // una sola pasada, sin parpadeo de "cargando" en medio de la tarjeta.
    let storeOrdersPanel = null;
    if (selectedStore) {
      const [orders, emailMap] = await Promise.all([
        loadStoreOrders(selectedStore.code, months),
        W.loadEmailMap(),
      ]);
      storeOrdersPanel = renderStoreOrders(orders, range, emailMap);
      storeOrdersPanel.emailMap = emailMap;
    }

    el.innerHTML = `
      <div class="card">
        <div class="card-h">
          <div><h3>Ventas por provincia</h3><p>${scopeTxt} · hacé clic en una provincia para ver sus tiendas</p></div>
          <div class="card-a">${W.metricToggle(metric, 'metric')}</div>
        </div>
        ${renderMap(geoAgg)}
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
              : `${W.fmtNum(storesPanel.rows.length)} tiendas · ordenadas por ${W.METRIC_LABEL[metric].toLowerCase()} · hacé clic en una fila para ver sus pedidos`}</p>
          </div>
          <div class="card-a">
            ${!selectedStore ? `<input class="inp inp-search" id="store-search" type="search" placeholder="Buscar tienda…" value="${W.esc(storeQuery)}" />` : ''}
            ${selectedStore
              ? `<button class="btn-p" id="xlsx-store-orders">${W.icon('download', 14)}Exportar XLSX</button>`
              : `<button class="btn-p" id="xlsx-stores">${W.icon('download', 14)}Exportar XLSX (todas)</button>`}
          </div>
        </div>
        ${selectedStore ? storeOrdersPanel.html : storesPanel.html}
      </div>`;

    wire(ctx, geo, geoAgg, storesPanel, storeOrdersPanel);

    // La tarjeta de geografía cambia de contenido (provincia → tiendas →
    // pedidos): sin este scroll, elegir una provincia o una tienda no se
    // notaba. Solo scrollea en la transición de "cerrado" a "abierto" de
    // cada nivel, no en cada re-render.
    const drillKey = `${selectedProv || ''}|${selectedStore?.code || ''}`;
    if (drillKey && drillKey !== lastDrillKey) {
      requestAnimationFrame(() => {
        document.getElementById('geo-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
    lastDrillKey = drillKey;
  };

  function wire(ctx, geo, geoAgg, storesPanel, storeOrdersPanel) {
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
      b.addEventListener('click', () => { metric = b.dataset.metric; W.render(); }));

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

    // Breadcrumb: "Todas las tiendas" vuelve al principio, el nombre de la
    // provincia vuelve un nivel (a las tiendas).
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
        .sort((a, b) => b[metric] - a[metric]);
      const provincias = [
        ['Provincia', 'Pedidos', 'GMV'],
        ...Object.entries(geoAgg.prov).map(([c, v]) => [provName(c), v.orders, Math.round(v.gmv)]).sort((a, b) => b[metric === 'orders' ? 1 : 2] - a[metric === 'orders' ? 1 : 2]),
      ];

      const sheets = [];
      if (selectedProv) sheets.push({ name: provName(selectedProv).slice(0, 31) || 'Provincia', rows: sheetRows(storesPanel.rows) });
      sheets.push({ name: 'Todas las tiendas', rows: sheetRows(todas) }, { name: 'Provincias', rows: provincias });

      W.downloadXLSX(`webdash-tiendas-${ctx.range.from}_${ctx.range.to}-${ctx.bucket}.xlsx`, sheets);
      W.toast(`Exportadas ${W.fmtNum(todas.length)} tiendas.`, 'good');
    });
  }
})();

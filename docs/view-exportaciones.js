/* global window, document */
/**
 * Herramienta "Exportaciones": un .xlsx a medida.
 *
 * Se elige el período, las hojas, las columnas de cada hoja de detalle y los
 * filtros; se pueden guardar como plantilla. Además de las hojas del export
 * del período (Resumen, Por día, Categorías, Cupones…), suma las de detalle:
 *
 *   Pedidos            uno por fila, con UTM, pago, cuotas, envío, descuento,
 *                      cupones y promociones (lo que exista para ese pedido).
 *   Ítems              uno por PRODUCTO de cada pedido: EAN, SKU, marca,
 *                      precio de lista y de venta, descuento, qué promociones
 *                      le aplicaron y con qué cupón.
 *   Promociones        cada promoción: cupón, pedidos, unidades, descuento.
 *   Cupón × EAN        qué productos movió cada cupón y cuánto descontó.
 *   EAN                resumen por producto con su participación en promos.
 *
 * El detalle por producto sale de order-items/<día>.json (data-raw, a demanda
 * vía /api/archive) y existe desde que el pipeline empezó a guardarlo. Los
 * días anteriores se pueden completar con el workflow de backfill. Los de App
 * vienen en el mismo archivo marcados c:'app' (desde fines de sept. 2026).
 */
(function () {
  const W = (window.W = window.W || {});
  const E = () => W.XLSX_ESTILO;
  const MAX_ITEM_ROWS = 300000;

  const SUMMARY_SHEETS = [
    ['Resumen', 'KPIs del período y comparación con el anterior'],
    ['Por día', 'serie diaria de pedidos, GMV y ticket'],
    ['Segmentos', 'food, non-food, marketplace, quick commerce'],
    ['Canales', 'App vs. Web'],
    ['Categorías N1', 'departamentos'],
    ['Categorías N2', 'rubros'],
    ['Productos', 'ranking de SKUs del mes'],
    ['Marketing', 'pedidos por fuente (UTM)'],
    ['Cupones', 'usos y GMV por cupón'],
    ['Medios de pago', 'medio, marca y cuotas'],
    ['Por hora', 'curva del día'],
  ];
  const DETAIL_SHEETS = [
    ['pedidos', 'Pedidos', 'uno por fila, con las columnas que elijas'],
    ['items', 'Ítems', 'uno por producto de cada pedido: EAN, precios, promociones y cupones'],
    ['promos', 'Promociones', 'cada promoción con su cupón, unidades y descuento'],
    ['cupean', 'Cupón × EAN', 'qué productos movió cada cupón'],
    ['ean', 'EAN', 'resumen por producto y cuánto se vendió con promoción'],
  ];

  // ── Columnas ─────────────────────────────────────────────────────────────
  const money = 'moneda', int = 'entero', pct = 'pct1', code = 'ean';
  const promoNames = (o, ids) => (ids || []).map((id) => (o.pm || []).find((p) => p[0] === id)?.[1] || id);
  const promoCoupons = (o, ids) => [...new Set((ids || []).map((id) => (o.pm || []).find((p) => p[0] === id)?.[2]).filter(Boolean))];
  const pays = (o) => o.py || [];
  // Monto que descontó la promoción k sobre el ítem. Los días nuevos traen el
  // desglose (pd); en los viejos solo se sabe cuando el ítem tuvo UNA sola
  // promoción. Con varias y sin desglose se devuelve null: no se reparte a ojo.
  const promoAmount = (i, k) => (Array.isArray(i.pd) ? i.pd[k] ?? null : (i.pr || []).length === 1 ? (i.d ?? 0) : null);
  const promoBreakdown = (o, i) => (i.pr || []).map((id, k) => {
    const name = (o.pm || []).find((p) => p[0] === id)?.[1] || id;
    const a = promoAmount(i, k);
    return a == null ? name : `${name}: $${Math.round(a).toLocaleString('es-AR')}`;
  }).join(' · ');
  const ORDER_COLS = [
    ['id', 'Order ID', (o) => o.id, 22, code, true],
    ['fecha', 'Fecha y hora', (o) => W.arDateTimeOf(o.t), 19, null, true],
    ['canal', 'Canal', (o) => o._canal, 8, null, true],
    ['estado', 'Estado', (o) => o.st || '', 18, null, true],
    ['total', 'Total', (o) => o.g ?? null, 13, money, true],
    ['segmento', 'Segmento', (o) => W.SEGMENT_LABEL[o.sg] || o.sg || '', 14, null, true],
    ['tiendaCod', 'Código de tienda', (o) => o.s || '', 12, null, true],
    ['tienda', 'Tienda', (o, c) => c.tiendas?.[o.s]?.name || '', 28, null, true],
    ['provincia', 'Provincia', (o) => o.pv || '', 10, null, false],
    ['unidades', 'Unidades', (o) => o._u ?? null, 10, int, true],
    ['productos', 'Productos distintos', (o) => o._np ?? null, 10, int, false],
    ['descuento', 'Descuento', (o) => o.ds ?? null, 12, money, true],
    ['envio', 'Envío', (o) => o.sh ?? null, 11, money, false],
    ['cupones', 'Cupones', (o) => (Array.isArray(o.cp) ? o.cp.join(' · ') : o.cp || ''), 20, null, true],
    ['promos', 'Promociones', (o) => (o.pm || []).map((p) => p[1]).join(' · '), 40, null, true],
    ['utmSource', 'UTM source', (o) => o.u?.[0] || '', 16, null, true],
    ['utmMedium', 'UTM medium', (o) => o.u?.[1] || '', 14, null, false],
    ['utmCampaign', 'UTM campaign', (o) => o.u?.[2] || '', 22, null, false],
    ['pago', 'Medio de pago', (o) => [...new Set(pays(o).map((p) => p[0]))].join(' · '), 16, null, true],
    ['tarjeta', 'Marca de tarjeta', (o) => [...new Set(pays(o).map((p) => p[1]))].join(' · '), 16, null, false],
    ['cuotas', 'Cuotas', (o) => (pays(o).length ? Math.max(...pays(o).map((p) => p[2] || 1)) : null), 8, int, false],
    ['email', 'Email', (o, c) => c.emails?.get?.(o.h)?.email || '', 30, null, false],
    ['dni', 'DNI', (o, c) => c.emails?.get?.(o.h)?.dni || '', 12, null, false],
    ['cliente', 'ID de cliente', (o) => o.h || '', 18, code, false],
  ];
  const ITEM_COLS = [
    ['id', 'Order ID', (o) => o.id, 22, code, true],
    ['fecha', 'Fecha y hora', (o) => W.arDateTimeOf(o.t), 19, null, true],
    ['canal', 'Canal', (o) => o._canal, 8, null, true],
    ['estado', 'Estado del pedido', (o) => o.st || '', 16, null, false],
    ['tiendaCod', 'Código de tienda', (o) => o.s || '', 12, null, true],
    ['tienda', 'Tienda', (o, c) => c.tiendas?.[o.s]?.name || '', 26, null, false],
    ['segmento', 'Segmento', (o) => W.SEGMENT_LABEL[o.sg] || o.sg || '', 14, null, false],
    ['ean', 'EAN', (o, c, i) => i.e || '', 16, code, true],
    ['sku', 'SKU (RefId)', (o, c, i) => i.r || '', 14, code, true],
    ['skuId', 'SKU ID', (o, c, i) => i.k || '', 10, code, false],
    ['producto', 'Producto', (o, c, i) => i.n || '', 44, null, true],
    ['marca', 'Marca', (o, c, i) => i.b || '', 18, null, true],
    ['cantidad', 'Cantidad', (o, c, i) => i.q ?? null, 9, int, true],
    ['lista', 'Precio de lista (unit.)', (o, c, i) => i.lp ?? null, 13, money, true],
    ['venta', 'Precio de venta (unit.)', (o, c, i) => i.up ?? null, 13, money, true],
    ['totalLinea', 'Total de la línea', (o, c, i) => i.g ?? null, 13, money, true],
    ['descuento', 'Descuento de la línea', (o, c, i) => i.d ?? (i.lp != null ? 0 : null), 13, money, true],
    ['pctDesc', '% de descuento', (o, c, i) => (i.lp && i.q ? (i.d || 0) / (i.lp * i.q) : null), 10, pct, true],
    ['promos', 'Promociones aplicadas', (o, c, i) => promoNames(o, i.pr).join(' · '), 40, null, true],
    ['promoMonto', 'Descuento de cada promoción', (o, c, i) => promoBreakdown(o, i), 48, null, true],
    ['envioItem', 'Descuento de envío (prorrateado)', (o, c, i) => i.ds ?? null, 13, money, false],
    ['cuponItem', 'Cupón que aplicó', (o, c, i) => promoCoupons(o, i.pr).join(' · '), 18, null, true],
    ['cuponesPedido', 'Cupones del pedido', (o) => (Array.isArray(o.cp) ? o.cp.join(' · ') : o.cp || ''), 18, null, false],
    ['utmSource', 'UTM source', (o) => o.u?.[0] || '', 16, null, false],
    ['pago', 'Medio de pago', (o) => [...new Set(pays(o).map((p) => p[0]))].join(' · '), 16, null, false],
  ];

  // ── Estado (con plantillas guardadas en el navegador) ────────────────────
  const iso = (d) => d.toISOString().slice(0, 10);
  const yesterday = () => W.arDateOf(new Date(Date.now() - 864e5).toISOString());
  function defaults() {
    const to = yesterday();
    const from = iso(new Date(new Date(`${to}T12:00:00Z`).getTime() - 6 * 864e5));
    return {
      from, to, bucket: 'all',
      sheets: { Resumen: true, 'Por día': true, pedidos: true, items: true, promos: true, cupean: true },
      orderCols: ORDER_COLS.filter((c) => c[5]).map((c) => c[0]),
      itemCols: ITEM_COLS.filter((c) => c[5]).map((c) => c[0]),
      f: { sinCancelados: true, tiendas: '', cupon: '', promo: '', eans: '', soloConPromo: false },
    };
  }
  let S = Object.assign(defaults(), W.store.get('exportCfg', {}));
  let running = null; // { msg, pct }
  let lastReport = null;
  const save = () => W.store.set('exportCfg', S);

  // ── Datos ────────────────────────────────────────────────────────────────
  function daysOf(from, to) {
    const out = [];
    for (let t = new Date(`${from}T12:00:00Z`).getTime(), end = new Date(`${to}T12:00:00Z`).getTime(); t <= end; t += 864e5) out.push(iso(new Date(t)));
    return out;
  }
  const monthsOf = (from, to) => [...new Set(daysOf(from, to).map((d) => d.slice(0, 7)))];

  async function mapLimit(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
    }));
    return out;
  }

  function passes(o, f, eanSet) {
    if (f.sinCancelados && /cancel/i.test(o.st || '')) return false;
    if (f.tiendas) { const set = f.tiendas.split(/[\s,;]+/).filter(Boolean); if (set.length && !set.includes(String(o.s))) return false; }
    if (f.cupon) { const q = f.cupon.toLowerCase(); const cps = Array.isArray(o.cp) ? o.cp : o.cp ? [o.cp] : []; if (!cps.some((c) => c.toLowerCase().includes(q))) return false; }
    if (f.promo) { const q = f.promo.toLowerCase(); if (!(o.pm || []).some((p) => String(p[1]).toLowerCase().includes(q))) return false; }
    if (eanSet && !(o.it || []).some((i) => eanSet.has(i.e) || eanSet.has(i.r))) return false;
    return true;
  }

  function itemPasses(i, f, eanSet) {
    if (eanSet && !(eanSet.has(i.e) || eanSet.has(i.r))) return false;
    if (f.soloConPromo && !(i.pr || []).length) return false;
    return true;
  }

  function detailSheet(name, title, note, cols, rows) {
    const head = cols.map((c) => c[1]);
    const last = String.fromCharCode(64 + Math.min(26, cols.length));
    return {
      name,
      rows: [[title], [note], [], head, ...rows],
      filaEncabezado: 4,
      columnasFijas: Math.min(2, cols.length),
      widths: cols.map((c) => c[3]),
      merges: [`A1:${last}1`, `A2:${last}2`],
      estiloDe: (f, c) => {
        if (f === 1) return E().titulo;
        if (f === 2) return E().nota;
        if (f === 4) return E().encabezado;
        if (f < 4) return null;
        const st = cols[c]?.[4];
        return st ? E()[st] : null;
      },
    };
  }

  async function generate() {
    const f = S.f;
    const range = { from: S.from, to: S.to };
    if (!range.from || !range.to || range.from > range.to) { W.toast('Revisá las fechas del período.', 'bad'); return; }
    const days = daysOf(range.from, range.to);
    const wantItems = ['items', 'promos', 'cupean', 'ean'].some((k) => S.sheets[k]);
    const wantOrders = !!S.sheets.pedidos;
    if (wantItems && days.length > 62) { W.toast('El detalle por producto se exporta de a 62 días como máximo. Achicá el período.', 'bad'); return; }
    const eanSet = f.eans.trim() ? new Set(f.eans.split(/[\s,;]+/).filter(Boolean)) : null;
    const canal = W.channel === 'app' ? 'App' : W.channel === 'web' ? 'Web' : 'App + Web';
    const cab = `${W.fmtDayLong(range.from)} – ${W.fmtDayLong(range.to)} · ${canal}`;
    const report = { missingDays: [], orders: 0, items: 0, cut: false };
    running = { msg: 'Preparando…', pct: 0 };
    W.render();
    const step = (msg, p) => { running = { msg, pct: p }; const m = document.getElementById('ex-msg'); const b = document.getElementById('ex-bar'); if (m) m.textContent = msg; if (b) b.style.width = `${Math.round(p * 100)}%`; };

    try {
      const hojas = [];
      // 1) Hojas resumen del período (las mismas del botón Exportar).
      const wantSummary = SUMMARY_SHEETS.filter(([n]) => S.sheets[n]).map(([n]) => n);
      if (wantSummary.length) {
        step('Armando las hojas de resumen…', 0.05);
        const daily = await W.load('daily-summary');
        const acc = W.sumRange(daily, S.bucket, range);
        const prevRange = W.previousRange ? W.previousRange(range) : null;
        const prev = prevRange ? W.sumRange(daily, S.bucket, prevRange) : null;
        const { productos, meses } = wantSummary.includes('Productos') ? await W.exportParts.productosDelRango(range, S.bucket) : {};
        const all = W.exportParts.libro({ acc, prev, range, bucket: S.bucket, canal, productos, meses });
        const keep = new Set(wantSummary);
        if (keep.has('Medios de pago')) { keep.add('Marcas de tarjeta'); keep.add('Cuotas'); }
        hojas.push(...all.filter((h) => keep.has(h.name)));
      }

      const ctx = { tiendas: null, emails: null };
      const needEmails = wantOrders && S.orderCols.some((k) => k === 'email' || k === 'dni');
      [ctx.tiendas, ctx.emails] = await Promise.all([
        W.load('geo').then((g) => g?.stores || null).catch(() => null),
        needEmails && W.loadEmailMap ? W.loadEmailMap().catch(() => null) : null,
      ]);

      const inRange = (o) => { const d = W.arDateOf(o.t); return d && d >= range.from && d <= range.to; };
      const segOk = (o) => S.bucket === 'all' || o.sg === S.bucket;

      // 2) Detalle por pedido/producto de Web (order-items por día).
      // Cada día pesa ~12 MB: se procesa apenas llega y se descarta, sin
      // guardarlo en la caché de W.loadRaw. Así un mes no junta cientos de MB
      // en el navegador. De cada pedido queda solo la versión sin ítems (para
      // la hoja Pedidos) y de cada ítem la fila y los acumulados.
      const detail = new Map(); // orderId -> pedido sin ítems (+ _u unidades, _np productos, _pass filtro)
      const itemCols = ITEM_COLS.filter((c) => S.itemCols.includes(c[0]));
      const itemRows = [];
      const promoAgg = new Map(), cupEan = new Map(), eanAgg = new Map();
      const processItems = wantItems;
      const consume = (o) => {
        o._canal = o.c === 'app' ? 'App' : 'Web';
        // El archivo del día trae los dos canales: se respeta el selector de arriba.
        if ((W.channel === 'app' && o._canal !== 'App') || (W.channel === 'web' && o._canal !== 'Web')) return;
        const ok = inRange(o) && segOk(o);
        const pass = ok && passes(o, f, eanSet);
        if (processItems && pass) {
          for (const i of o.it || []) {
            if (!itemPasses(i, f, eanSet)) continue;
            report.items += 1;
            if (S.sheets.items) {
              if (itemRows.length < MAX_ITEM_ROWS) itemRows.push(itemCols.map((c) => c[2](o, ctx, i)));
              else report.cut = true;
            }
            const key = i.e || i.r || i.n;
            const ea = eanAgg.get(key) || { e: i.e || '', r: i.r || '', n: i.n, b: i.b || '', q: 0, g: 0, d: 0, qp: 0, orders: new Set(), promos: new Map() };
            ea.q += i.q || 0; ea.g += i.g || 0; ea.d += i.d || 0; ea.orders.add(o.id);
            if ((i.pr || []).length) ea.qp += i.q || 0;
            (i.pr || []).forEach((id, k) => {
              const p = (o.pm || []).find((x) => x[0] === id) || [id, id, null];
              const amt = promoAmount(i, k);
              ea.promos.set(p[1], (ea.promos.get(p[1]) || 0) + (i.q || 0));
              const pa = promoAgg.get(id) || { name: p[1], coupons: new Set(), orders: new Set(), items: 0, q: 0, d: 0, g: 0, sin: 0 };
              if (p[2]) pa.coupons.add(p[2]);
              pa.orders.add(o.id); pa.items += 1; pa.q += i.q || 0; pa.g += i.g || 0;
              if (amt == null) pa.sin += 1; else pa.d += amt;
              promoAgg.set(id, pa);
              if (p[2]) {
                const ck = `${p[2]}|${key}`;
                const ce = cupEan.get(ck) || { c: p[2], e: i.e || '', r: i.r || '', n: i.n, q: 0, d: 0, g: 0, sin: 0, orders: new Set() };
                ce.q += i.q || 0; ce.g += i.g || 0; ce.orders.add(o.id);
                if (amt == null) ce.sin += 1; else ce.d += amt;
                cupEan.set(ck, ce);
              }
            });
            eanAgg.set(key, ea);
          }
        }
        if (wantOrders && ok) {
          const { it, ...slim } = o;
          slim._u = (it || []).reduce((a, i) => a + (i.q || 0), 0);
          slim._np = (it || []).length;
          slim._pass = pass;
          detail.set(`${o._canal}:${o.id}`, slim);
        }
      };
      let daysWithDetail = 0;
      if (wantItems || wantOrders) {
        let done = 0;
        await mapLimit(days, 2, async (d) => {
          let file = null;
          try {
            const r = await fetch(`api/archive?path=${encodeURIComponent(`order-items/${d}.json`)}`, { cache: 'default' });
            if (r.ok) file = await r.json();
          } catch { /* día sin detalle */ }
          if (!file?.orders) report.missingDays.push(d);
          else { daysWithDetail += 1; for (const o of file.orders) consume(o); }
          file = null;
          done += 1;
          step(`Leyendo el detalle por producto… ${done} de ${days.length} días`, 0.1 + 0.6 * (done / days.length));
        });
        report.missingDays.sort();
      }

      // 3) Pedidos: el índice (todos, incluso App y días viejos) + el detalle.
      if (wantOrders) {
        step('Armando los pedidos…', 0.75);
        const fuentes = [];
        if (W.channel !== 'app') fuentes.push(['Web', 'order-index']);
        if (W.channel !== 'web') fuentes.push(['App', 'app/order-index']);
        const listas = await Promise.all(fuentes.flatMap(([c, pref]) => monthsOf(range.from, range.to)
          .map((m) => W.load(`${pref}/${m}`).catch(() => []).then((l) => (l || []).map((o) => ({ ...o, _canal: c }))))));
        const byId = new Map();
        for (const o of listas.flat()) if (inRange(o) && segOk(o)) byId.set(`${o._canal}:${o.id}`, o);
        for (const [k, o] of detail) byId.set(k, { ...(byId.get(k) || {}), ...o });
        const cols = ORDER_COLS.filter((c) => S.orderCols.includes(c[0]));
        const rows = [...byId.values()].filter((o) => ('_pass' in o ? o._pass : passes(o, f, eanSet))).sort((a, b) => (a.t < b.t ? 1 : -1))
          .map((o) => cols.map((c) => c[2](o, ctx)));
        report.orders = rows.length;
        hojas.push(detailSheet('Pedidos', `Pedidos, uno por fila — ${cab} · ${rows.length.toLocaleString('es-AR')} pedidos`,
          'UTM, pago, cuotas, envío, descuento y promociones existen desde que se empezó a guardar el detalle (Web desde el 1/9/2026, App desde fines de septiembre de 2026).'
          + (cols.some((c) => c[0] === 'email' || c[0] === 'dni') ? ' Email y DNI son datos personales.' : ''), cols, rows));
      }

      // 4) Ítems y sus derivados.
      // Sin un solo día con detalle, las hojas por producto saldrían vacías:
      // se omiten y se explica en pantalla cómo generarlo.
      report.noDetail = wantItems && (daysWithDetail === 0 || report.items === 0 && W.channel === 'app');
      if (wantItems && !report.noDetail) {
        step('Armando el detalle por producto…', 0.85);
        const cols = itemCols;
        const appNote = W.channel === 'web' ? ' Solo pedidos Web.' : ' App tiene detalle por producto desde fines de septiembre de 2026 (antes, solo Web).';
        const nota = report.missingDays.length
          ? `Sin detalle por producto para ${report.missingDays.length} de ${days.length} días (${report.missingDays.slice(0, 6).join(', ')}${report.missingDays.length > 6 ? '…' : ''}): se completan con el backfill (force tildado).${appNote}`
          : appNote.trim();
        if (S.sheets.items) {
          hojas.push(detailSheet('Ítems', `Ítems de pedidos, uno por producto — ${cab} · ${itemRows.length.toLocaleString('es-AR')} filas`
            + (report.cut ? ` (cortado en ${MAX_ITEM_ROWS.toLocaleString('es-AR')}: usá filtros)` : ''), nota, cols, itemRows));
        }
        if (S.sheets.promos) {
          const pc = [['p', 'Promoción', 0, 40], ['c', 'Cupón', 0, 18], ['o', 'Pedidos', 0, 10, int], ['i', 'Ítems', 0, 10, int], ['q', 'Unidades', 0, 10, int], ['d', 'Descuento de la promoción', 0, 15, money], ['g', 'GMV de esos ítems', 0, 16, money], ['s', 'Ítems sin desglose', 0, 11, int]];
          const rows = [...promoAgg.values()].sort((a, b) => b.d - a.d)
            .map((p) => [p.name, [...p.coupons].join(' · '), p.orders.size, p.items, p.q, p.d, p.g, p.sin || null]);
          const sinDesglose = rows.some((r) => r[7]);
          hojas.push(detailSheet('Promociones', `Promociones aplicadas — ${cab}`, `${nota} Descuento = lo que descontó ESA promoción (sin el envío).`
            + (sinDesglose ? ' "Ítems sin desglose": ítems de días anteriores al desglose por promoción que tuvieron varias promociones a la vez; su descuento no se reparte a ojo, así que no está sumado (se completa con el backfill).' : ''), pc, rows));
        }
        if (S.sheets.cupean) {
          const cc = [['c', 'Cupón', 0, 18], ['e', 'EAN', 0, 16, code], ['r', 'SKU', 0, 14, code], ['n', 'Producto', 0, 44], ['o', 'Pedidos', 0, 10, int], ['q', 'Unidades', 0, 10, int], ['d', 'Descuento del cupón', 0, 14, money], ['g', 'GMV', 0, 14, money], ['s', 'Ítems sin desglose', 0, 11, int]];
          const rows = [...cupEan.values()].sort((a, b) => a.c.localeCompare(b.c) || b.q - a.q)
            .map((x) => [x.c, x.e, x.r, x.n, x.orders.size, x.q, x.d, x.g, x.sin || null]);
          hojas.push(detailSheet('Cupón × EAN', `Qué productos movió cada cupón — ${cab}`, `${nota} Solo cupones que dispararon una promoción sobre el producto.`, cc, rows));
        }
        if (S.sheets.ean) {
          const ec = [['e', 'EAN', 0, 16, code], ['r', 'SKU', 0, 14, code], ['n', 'Producto', 0, 44], ['b', 'Marca', 0, 18], ['o', 'Pedidos', 0, 10, int], ['q', 'Unidades', 0, 10, int], ['g', 'GMV', 0, 14, money], ['d', 'Descuento', 0, 14, money], ['p', '% unidades con promo', 0, 12, pct], ['t', 'Promociones principales', 0, 44]];
          const rows = [...eanAgg.values()].sort((a, b) => b.q - a.q)
            .map((x) => [x.e, x.r, x.n, x.b, x.orders.size, x.q, x.g, x.d, x.q ? x.qp / x.q : null,
              [...x.promos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n).join(' · ')]);
          hojas.push(detailSheet('EAN', `Resumen por producto — ${cab}`, nota, ec, rows));
        }
      }

      if (!hojas.length) {
        lastReport = report.noDetail ? { ...report, sheets: [], at: new Date() } : lastReport;
        W.toast(report.noDetail ? 'No hay detalle por producto para ese período: no se generó el archivo.' : 'Elegí al menos una hoja.', 'bad');
        running = null; W.render(); return;
      }
      step('Generando el Excel…', 0.95);
      await new Promise((r) => setTimeout(r, 30));
      await W.downloadXLSX(`webdash-export-${range.from}_a_${range.to}.xlsx`, hojas);
      lastReport = { ...report, sheets: hojas.map((h) => h.name), at: new Date() };
      W.toast(`Listo: ${hojas.length} hojas.`, 'good');
    } catch (e) {
      console.error(e);
      W.toast(`No se pudo generar: ${e.message}`, 'bad');
    }
    running = null;
    W.render();
  }

  // ── Vista ────────────────────────────────────────────────────────────────
  function colPicker(id, cols, sel) {
    return `<div class="ex-cols">${cols.map((c) => `<label class="ex-col${sel.includes(c[0]) ? ' on' : ''}"><input type="checkbox" data-${id}="${c[0]}" ${sel.includes(c[0]) ? 'checked' : ''}/>${W.esc(c[1])}</label>`).join('')}</div>
      <div class="ex-colsa"><button class="btn-s" data-allcols="${id}">Todas</button><button class="btn-s" data-defcols="${id}">Recomendadas</button></div>`;
  }

  W.viewExportaciones = async function (ctx) {
    const { el } = ctx;
    const tpls = W.store.get('exportTemplates', []);
    const canal = W.channel === 'app' ? 'App' : W.channel === 'web' ? 'Web' : 'App + Web';
    const days = daysOf(S.from, S.to).length;
    const chips = [['Ayer', 1], ['7 días', 7], ['30 días', 30], ['Mes actual', 'm'], ['Mes anterior', 'pm']];

    el.innerHTML = `
      <div class="card ct-intro">
        <div class="ct-ic">${W.icon('download', 20)}</div>
        <div><h3>Exportaciones a medida</h3>
          <p>Elegí el período, qué hojas querés, qué columnas lleva cada una y los filtros. Incluye el detalle por producto de cada pedido:
            EAN, precio de lista y de venta, descuento, qué promoción le aplicó y con qué cupón. Guardá la combinación como plantilla para repetirla.</p></div>
      </div>

      <div class="ex-grid">
        <div>
          <div class="card">
            <div class="card-h"><div><h3>1. Período y alcance</h3><p>canal: <b>${canal}</b> (se cambia arriba) · ${W.fmtNum(days)} día${days === 1 ? '' : 's'}</p></div></div>
            <div class="ex-row">
              <label class="au-f"><span>Desde</span><input class="inp" type="date" id="ex-from" value="${S.from}"/></label>
              <label class="au-f"><span>Hasta</span><input class="inp" type="date" id="ex-to" value="${S.to}"/></label>
              <label class="au-f"><span>Segmento</span><select class="inp" id="ex-seg">
                <option value="all">Todos</option>${W.SEGMENTS.map((s) => `<option value="${s}"${S.bucket === s ? ' selected' : ''}>${W.esc(W.SEGMENT_LABEL[s])}</option>`).join('')}</select></label>
            </div>
            <div class="sx-filters">${chips.map(([l, v]) => `<button class="chip-sm" data-quick="${v}">${l}</button>`).join('')}</div>
          </div>

          <div class="card">
            <div class="card-h"><div><h3>2. Hojas</h3><p>tildá las que quieras en el archivo</p></div></div>
            <h4 class="sx-h4" style="margin-top:0">Detalle (lo nuevo)</h4>
            <div class="ex-sheets">${DETAIL_SHEETS.map(([k, n, d]) => `<label class="ex-sheet${S.sheets[k] ? ' on' : ''}"><input type="checkbox" data-sheet="${k}" ${S.sheets[k] ? 'checked' : ''}/><b>${n}</b><em>${d}</em></label>`).join('')}</div>
            <h4 class="sx-h4">Resumen del período</h4>
            <div class="ex-sheets small">${SUMMARY_SHEETS.map(([n, d]) => `<label class="ex-sheet${S.sheets[n] ? ' on' : ''}"><input type="checkbox" data-sheet="${W.esc(n)}" ${S.sheets[n] ? 'checked' : ''}/><b>${n}</b><em>${d}</em></label>`).join('')}</div>
          </div>

          ${S.sheets.pedidos ? `<div class="card"><div class="card-h"><div><h3>Columnas de "Pedidos"</h3><p>${S.orderCols.length} elegidas</p></div></div>${colPicker('oc', ORDER_COLS, S.orderCols)}</div>` : ''}
          ${S.sheets.items ? `<div class="card"><div class="card-h"><div><h3>Columnas de "Ítems"</h3><p>${S.itemCols.length} elegidas</p></div></div>${colPicker('ic', ITEM_COLS, S.itemCols)}</div>` : ''}
        </div>

        <aside>
          <div class="card stick">
            <h3 class="ex-h3">3. Filtros</h3>
            <label class="ex-chk"><input type="checkbox" id="ex-nocancel" ${S.f.sinCancelados ? 'checked' : ''}/>Sacar pedidos cancelados</label>
            <label class="ex-chk"><input type="checkbox" id="ex-onlypromo" ${S.f.soloConPromo ? 'checked' : ''}/>Solo productos con promoción (Ítems)</label>
            <label class="au-f"><span>Cupón contiene</span><input class="inp" id="ex-cupon" value="${W.esc(S.f.cupon)}" placeholder="ej. LECHE"/></label>
            <label class="au-f"><span>Promoción contiene</span><input class="inp" id="ex-promo" value="${W.esc(S.f.promo)}" placeholder="ej. 2x1"/></label>
            <label class="au-f"><span>Tiendas (códigos)</span><input class="inp" id="ex-tiendas" value="${W.esc(S.f.tiendas)}" placeholder="ej. 0009, 0123"/></label>
            <label class="au-f"><span>EANs o SKUs</span><textarea class="inp ex-ta" id="ex-eans" placeholder="uno por renglón o separados por coma">${W.esc(S.f.eans)}</textarea></label>

            <button class="btn-p blk au-cta" id="ex-go" ${running ? 'disabled' : ''}>${W.icon('download', 15)}Generar Excel</button>
            ${running ? `<div class="ct-progress"><span class="au-share"><i id="ex-bar" style="width:${Math.round(running.pct * 100)}%"></i></span><p id="ex-msg" class="muted">${W.esc(running.msg)}</p></div>` : ''}
            ${lastReport ? `<div class="ex-rep">${W.icon(lastReport.sheets.length ? 'check' : 'alert', 14)}<div><b>${lastReport.sheets.length ? 'Último archivo:' : 'No se generó el archivo.'}</b> ${lastReport.sheets.length ? `${lastReport.sheets.length} hojas` : ''}${lastReport.orders ? ` · ${W.fmtNum(lastReport.orders)} pedidos` : ''}${lastReport.items ? ` · ${W.fmtNum(lastReport.items)} ítems` : ''}
              ${lastReport.noDetail ? `<br><span class="au-warn"><b>Ningún día del período tiene detalle por producto todavía</b>, así que no se incluyeron Ítems, Promociones, Cupón × EAN ni EAN.
                Se genera solo desde ahora con la corrida diaria; para días anteriores hay que correr el workflow <b>WebDash backfill</b> en GitHub Actions con <b>force</b> tildado.</span>`
      : lastReport.missingDays.length ? `<br><span class="au-warn">Sin detalle por producto: ${lastReport.missingDays.length} día(s). Se completan con el backfill (con force tildado).</span>` : ''}${lastReport.cut ? '<br><span class="au-warn">Los ítems se cortaron: usá filtros o un período más corto.</span>' : ''}</div></div>` : ''}

            <div class="saved">
              <h4>Plantillas</h4>
              <div class="saved-r"><input class="inp" id="ex-tplname" placeholder="Nombre (ej. Cupones semanal)"/><button class="btn-s" id="ex-tplsave" title="Guardar">${W.icon('save', 14)}</button></div>
              ${tpls.length ? `<ul class="saved-l">${tpls.map((t, i) => `<li><button class="saved-go" data-tpl="${i}">${W.esc(t.name)}</button><button class="saved-x" data-tplx="${i}">${W.icon('close', 13)}</button></li>`).join('')}</ul>`
    : '<p class="muted" style="font-size:.75rem;margin-top:.4rem">Guardá la combinación actual para usarla de nuevo.</p>'}
              <p class="sx-foot">La plantilla guarda hojas, columnas y filtros; el período se elige cada vez.</p>
            </div>
          </div>
        </aside>
      </div>`;

    const $ = (s) => el.querySelector(s);
    const rerender = () => { save(); W.render(); };
    $('#ex-from').addEventListener('change', (e) => { S.from = e.target.value; rerender(); });
    $('#ex-to').addEventListener('change', (e) => { S.to = e.target.value; rerender(); });
    $('#ex-seg').addEventListener('change', (e) => { S.bucket = e.target.value; save(); });
    el.querySelectorAll('[data-quick]').forEach((b) => b.addEventListener('click', () => {
      const v = b.dataset.quick, y = yesterday();
      const yd = new Date(`${y}T12:00:00Z`);
      if (v === 'm') { S.from = `${y.slice(0, 7)}-01`; S.to = y; }
      else if (v === 'pm') { const d = new Date(Date.UTC(yd.getUTCFullYear(), yd.getUTCMonth(), 0)); S.to = iso(d); S.from = `${S.to.slice(0, 7)}-01`; }
      else { S.to = y; S.from = iso(new Date(yd.getTime() - (Number(v) - 1) * 864e5)); }
      rerender();
    }));
    el.querySelectorAll('[data-sheet]').forEach((c) => c.addEventListener('change', () => { S.sheets[c.dataset.sheet] = c.checked; rerender(); }));
    const toggleCol = (key, list) => (c) => c.addEventListener('change', () => {
      S[list] = c.checked ? [...new Set([...S[list], c.dataset[key]])] : S[list].filter((x) => x !== c.dataset[key]);
      save(); c.closest('.ex-col').classList.toggle('on', c.checked);
    });
    el.querySelectorAll('[data-oc]').forEach(toggleCol('oc', 'orderCols'));
    el.querySelectorAll('[data-ic]').forEach(toggleCol('ic', 'itemCols'));
    el.querySelectorAll('[data-allcols]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.allcols === 'oc') S.orderCols = ORDER_COLS.map((c) => c[0]); else S.itemCols = ITEM_COLS.map((c) => c[0]);
      rerender();
    }));
    el.querySelectorAll('[data-defcols]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.defcols === 'oc') S.orderCols = ORDER_COLS.filter((c) => c[5]).map((c) => c[0]); else S.itemCols = ITEM_COLS.filter((c) => c[5]).map((c) => c[0]);
      rerender();
    }));
    const bindF = (id, k, ev = 'input', get = (e) => e.target.value) => $(id).addEventListener(ev, (e) => { S.f[k] = get(e); save(); });
    bindF('#ex-nocancel', 'sinCancelados', 'change', (e) => e.target.checked);
    bindF('#ex-onlypromo', 'soloConPromo', 'change', (e) => e.target.checked);
    bindF('#ex-cupon', 'cupon'); bindF('#ex-promo', 'promo'); bindF('#ex-tiendas', 'tiendas'); bindF('#ex-eans', 'eans');
    $('#ex-go').addEventListener('click', generate);
    $('#ex-tplsave').addEventListener('click', () => {
      const name = $('#ex-tplname').value.trim();
      if (!name) { W.toast('Poné un nombre para la plantilla.', 'bad'); return; }
      const list = W.store.get('exportTemplates', []).filter((t) => t.name !== name);
      list.push({ name, sheets: S.sheets, orderCols: S.orderCols, itemCols: S.itemCols, f: S.f, bucket: S.bucket });
      W.store.set('exportTemplates', list);
      W.toast(`Plantilla "${name}" guardada.`, 'good');
      W.render();
    });
    el.querySelectorAll('[data-tpl]').forEach((b) => b.addEventListener('click', () => {
      const t = W.store.get('exportTemplates', [])[+b.dataset.tpl];
      if (!t) return;
      S = { ...S, sheets: { ...t.sheets }, orderCols: [...t.orderCols], itemCols: [...t.itemCols], f: { ...t.f }, bucket: t.bucket || 'all' };
      W.toast(`Plantilla "${t.name}" cargada.`, 'good');
      rerender();
    }));
    el.querySelectorAll('[data-tplx]').forEach((b) => b.addEventListener('click', () => {
      const list = W.store.get('exportTemplates', []);
      list.splice(+b.dataset.tplx, 1);
      W.store.set('exportTemplates', list);
      W.render();
    }));
  };
})();

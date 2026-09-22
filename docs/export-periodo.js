/* global window, document */
/**
 * Exportar el período: un .xlsx con todo lo que el dashboard sabe del rango
 * elegido, en vez de una tabla por vez.
 *
 * Antes cada vista tenía su propio botón de descarga y bajaba SU tabla. Para
 * armar un informe había que entrar a seis pantallas, bajar seis archivos y
 * pegarlos a mano — y cada uno con su propio corte, así que no cerraban entre
 * sí. Esto baja un solo archivo, con el mismo rango, canal y segmento que se
 * está viendo, y todas las hojas consistentes entre ellas.
 *
 * Qué trae, una hoja por pregunta:
 *   Resumen         los KPIs del período y su comparación con el anterior
 *   Por día         la serie diaria, que es la que se pega en cualquier informe
 *   Segmentos       food / non-food / marketplace / quick commerce
 *   Canales         App vs. Web, total y por segmento
 *   Categorías      nivel 1 y nivel 2
 *   Productos       el ranking de SKUs con su mix App/Web
 *   Marketing       de dónde vino cada pedido
 *   Cupones         uso y descuento
 *   Medios de pago  medio, marca y cuotas
 *   Por hora        la curva del día
 *
 * Los números van como números y los porcentajes como fracción, así Excel los
 * suma y promedia (ver docs/xlsx.js).
 */
(function () {
  const W = (window.W = window.W || {});

  const E = () => W.XLSX_ESTILO;

  /** Filas ordenadas de un diccionario {nombre: {gmv, orders, ...}}. */
  function ranking(dic, campos = ['gmv', 'orders']) {
    return Object.entries(dic || {})
      .map(([nombre, v]) => [nombre, ...campos.map((c) => (typeof v === 'number' ? v : v?.[c] ?? null))])
      .sort((a, b) => (b[1] || 0) - (a[1] || 0));
  }

  /** Una hoja con título arriba, encabezado y filas. */
  function hoja(name, titulo, encabezado, filas, opts = {}) {
    const rows = [[titulo], [], encabezado, ...filas];
    return {
      name,
      rows,
      filaEncabezado: 3,
      columnasFijas: opts.columnasFijas ?? 1,
      widths: opts.widths,
      merges: [`A1:${opts.ultimaCol || 'F'}1`],
      estiloDe: (f, c) => {
        if (f === 1) return E().titulo;
        if (f === 3) return E().encabezado;
        if (f < 4) return null;
        // Las filas de datos arrancan en la 4: titulo, vacia, encabezado, datos.
        return opts.estilo ? opts.estilo(f - 4, c) : null;
      },
    };
  }

  /**
   * El libro entero. Recibe lo ya calculado por la vista para no recalcular
   * nada distinto de lo que se ve en pantalla: si el Excel y el dashboard no
   * dan lo mismo, el Excel no sirve.
   */
  function libro({ acc, prev, range, bucket, canal, productos, meses }) {
    const hojas = [];
    const pct = (a, b) => (b ? a / b - 1 : null);
    const seg = bucket === 'all' ? 'todos los segmentos' : bucket;
    const cab = `${W.fmtDayLong(range.from)} – ${W.fmtDayLong(range.to)} · ${canal} · ${seg}`;

    // ── Resumen ─────────────────────────────────────────────────────────────
    const ticket = acc.orders ? acc.gmv / acc.orders : 0;
    const ticketPrev = prev && prev.orders ? prev.gmv / prev.orders : 0;
    const kpis = [
      ['GMV', acc.gmv, prev?.gmv ?? null, pct(acc.gmv, prev?.gmv)],
      ['Pedidos', acc.orders, prev?.orders ?? null, pct(acc.orders, prev?.orders)],
      ['Ticket promedio', ticket, ticketPrev || null, pct(ticket, ticketPrev)],
      ['Unidades', acc.units, prev?.units ?? null, pct(acc.units, prev?.units)],
      ['Unidades por pedido', acc.orders ? acc.units / acc.orders : 0,
        prev?.orders ? prev.units / prev.orders : null, null],
      ['Clientes activos', acc.activeCustomers, prev?.activeCustomers ?? null,
        pct(acc.activeCustomers, prev?.activeCustomers)],
      ['Clientes nuevos', acc.newCustomers, prev?.newCustomers ?? null,
        pct(acc.newCustomers, prev?.newCustomers)],
      ['Descuentos', acc.discount, prev?.discount ?? null, pct(acc.discount, prev?.discount)],
    ];
    hojas.push(hoja('Resumen', `Resumen del período — ${cab}`,
      ['Métrica', 'Período', 'Período anterior', 'Variación'], kpis, {
        widths: [26, 18, 20, 14], ultimaCol: 'D',
        estilo: (i, c) => {
          if (c === 0) return null;
          const esPlata = [0, 1, 2, 3, 7].includes(i);
          if (c === 3) {
            const v = kpis[i][3];
            return v == null ? E().delta : v < 0 ? E().deltaMala : E().deltaBuena;
          }
          return esPlata ? E().moneda : E().entero;
        },
      }));

    // ── Por día ─────────────────────────────────────────────────────────────
    const dias = (acc.series || []).map((d) => [
      d.date, d.orders || 0, d.gmv || 0, d.units || 0,
      d.orders ? d.gmv / d.orders : null,
    ]);
    hojas.push(hoja('Por día', `Serie diaria — ${cab}`,
      ['Fecha', 'Pedidos', 'GMV', 'Unidades', 'Ticket promedio'], dias, {
        widths: [14, 12, 18, 12, 18], ultimaCol: 'E',
        estilo: (i, c) => (c === 0 ? null : c === 2 || c === 4 ? E().moneda : E().entero),
      }));

    // ── Segmentos ───────────────────────────────────────────────────────────
    const segs = W.SEGMENTS.map((s) => {
      const v = acc.bySegment[s] || {};
      const ch = acc.byChannelSeg?.[s] || {};
      return [W.SEGMENT_LABEL[s] || s, v.orders || 0, v.gmv || 0, v.units || 0,
        acc.gmv ? (v.gmv || 0) / acc.gmv : null,
        ch.app?.orders ?? null, ch.web?.orders ?? null];
    });
    hojas.push(hoja('Segmentos', `Por segmento — ${cab}`,
      ['Segmento', 'Pedidos', 'GMV', 'Unidades', '% del GMV', 'Pedidos App', 'Pedidos Web'], segs, {
        widths: [20, 12, 18, 12, 12, 14, 14], ultimaCol: 'G',
        estilo: (i, c) => (c === 0 ? null : c === 2 ? E().moneda : c === 4 ? E().pct1 : E().entero),
      }));

    // ── Canales ─────────────────────────────────────────────────────────────
    const chs = Object.entries(acc.byChannel || {});
    if (chs.length) {
      const totOrders = chs.reduce((t, [, v]) => t + (v.orders || 0), 0);
      hojas.push(hoja('Canales', `App vs. Web — ${cab}`,
        ['Canal', 'Pedidos', 'GMV', 'Unidades', '% de pedidos', 'Ticket promedio'],
        chs.map(([k, v]) => [k === 'app' ? 'App' : 'Web', v.orders || 0, v.gmv || 0, v.units || 0,
          totOrders ? (v.orders || 0) / totOrders : null,
          v.orders ? v.gmv / v.orders : null]), {
          widths: [14, 12, 18, 12, 14, 18], ultimaCol: 'F',
          estilo: (i, c) => (c === 0 ? null : c === 2 || c === 5 ? E().moneda : c === 4 ? E().pct1 : E().entero),
        }));
    }

    // ── Categorías ──────────────────────────────────────────────────────────
    for (const [clave, nombre] of [['categoriesN1', 'Categorías N1'], ['categoriesN2', 'Categorías N2']]) {
      const filas = ranking(acc[clave]);
      if (!filas.length) continue;
      hojas.push(hoja(nombre, `${nombre} — ${cab}`, ['Categoría', 'GMV', 'Pedidos'], filas, {
        widths: [44, 18, 12], ultimaCol: 'C',
        estilo: (i, c) => (c === 0 ? null : c === 1 ? E().moneda : E().entero),
      }));
    }

    // ── Productos ───────────────────────────────────────────────────────────
    if (productos && productos.length) {
      hojas.push(hoja('Productos', `Ranking de productos — ${cab}`
        + (meses ? ` · el ranking se guarda por mes: ${meses}` : ''),
      ['SKU', 'Producto', 'Departamento', 'Unidades', 'GMV', 'Pedidos', 'Unidades App', 'Unidades Web', '% App'],
      productos.map((r) => [r.sku, r.name, r.dept, r.qty, r.gmv, r.orders,
        r.app?.qty ?? 0, r.web?.qty ?? 0,
        r.qty ? (r.app?.qty || 0) / r.qty : null]), {
        widths: [16, 46, 26, 12, 18, 12, 14, 14, 10], ultimaCol: 'I', columnasFijas: 2,
        estilo: (i, c) => (c === 0 ? E().ean : c === 4 ? E().moneda : c === 8 ? E().pct1
          : c >= 3 ? E().entero : null),
      }));
    }

    // ── Marketing, cupones, pagos ───────────────────────────────────────────
    const extras = [
      ['Marketing', acc.marketing, ['Fuente', 'GMV', 'Pedidos'], 34],
      ['Cupones', acc.coupons, ['Cupón', 'GMV', 'Usos'], 26],
      ['Medios de pago', acc.payments, ['Medio', 'GMV', 'Pedidos'], 26],
      ['Marcas de tarjeta', acc.paymentBrands, ['Marca', 'GMV', 'Pedidos'], 26],
      ['Cuotas', acc.installments, ['Cuotas', 'GMV', 'Pedidos'], 14],
    ];
    for (const [nombre, dic, encabezado, ancho] of extras) {
      const filas = ranking(dic);
      if (!filas.length) continue;
      hojas.push(hoja(nombre, `${nombre} — ${cab}`, encabezado, filas, {
        widths: [ancho, 18, 12], ultimaCol: 'C',
        estilo: (i, c) => (c === 0 ? null : c === 1 ? E().moneda : E().entero),
      }));
    }

    // ── Por hora ────────────────────────────────────────────────────────────
    const totalHora = (acc.hourly || []).reduce((t, v) => t + v, 0);
    if (totalHora) {
      hojas.push(hoja('Por hora', `Pedidos por hora (AR) — ${cab}`,
        ['Hora', 'Pedidos', '% del total'],
        acc.hourly.map((v, h) => [`${String(h).padStart(2, '0')}:00`, v, totalHora ? v / totalHora : null]), {
          widths: [10, 12, 14], ultimaCol: 'C',
          estilo: (i, c) => (c === 1 ? E().entero : c === 2 ? E().pct1 : null),
        }));
    }

    return hojas;
  }

  /**
   * Una fila por PEDIDO, que es lo que pedía el informe: no un agregado, la
   * lista cruda para filtrar y tabular en Excel.
   *
   * De dónde sale: docs/data/web/order-index/<mes>.json, un archivo por mes con
   * todos los pedidos sin sus items. No viaja en el deploy (son ~12 MB por mes)
   * — lo trae api/archive desde la rama del histórico, a pedido.
   *
   * QUÉ NO TIENE, y hay que decirlo porque el informe de la app sí los trae:
   *
   *  · UTM (source / medium / campaign). La atribución se guarda agregada por
   *    fuente, no por pedido.
   *  · Productos y unidades del pedido. El índice es "sin items" a propósito:
   *    guardarlos multiplicaría el archivo por el tamaño del carrito.
   *  · El estado viene vacío en los pedidos anteriores a que se empezara a
   *    guardar. No es un hueco de esta exportación: no está en el dato.
   *
   * Los tres se pueden sumar, pero es un cambio en el pipeline y solo aplicaría
   * de ahí en adelante.
   */
  async function hojaPedidos(range, bucket, tiendas, emails) {
    const meses = [];
    let m = range.from.slice(0, 7);
    const fin = range.to.slice(0, 7);
    while (m <= fin) {
      meses.push(m);
      const [y, mm] = m.split('-').map(Number);
      m = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`;
    }

    const listas = await Promise.all(meses.map((ym) => W.load(`order-index/${ym}`).catch(() => [])));
    const segs = bucket === 'all' ? null : new Set([bucket]);
    const filas = [];
    for (const lista of listas) {
      for (const o of (lista || [])) {
        const fecha = String(o.t || '').slice(0, 10);
        if (fecha < range.from || fecha > range.to) continue;
        if (segs && !segs.has(o.sg)) continue;
        filas.push([
          o.id,
          // Fecha y hora como texto ISO recortado: comparable y ordenable sin
          // depender de la configuración regional de quien lo abre.
          String(o.t || '').replace('T', ' ').slice(0, 19),
          o.st || '',
          o.g ?? null,
          W.SEGMENT_LABEL[o.sg] || o.sg || '',
          o.s || '',
          tiendas?.[o.s]?.name || '',
          o.cp || '',
          emails?.get?.(o.h) || o.h || '',
        ]);
      }
    }
    filas.sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0));  // del más nuevo al más viejo
    return filas;
  }

  /**
   * Arma y baja el archivo. Se le pasa el contexto del dashboard tal como está
   * en pantalla.
   */
  W.exportarPeriodo = async function ({ range, bucket }) {
    const canal = W.channel === 'app' ? 'App' : W.channel === 'web' ? 'Web' : 'App + Web';
    const daily = await W.load('daily-summary');
    const acc = W.sumRange(daily, bucket, range);
    const prevRange = W.previousRange ? W.previousRange(range) : null;
    const prev = prevRange ? W.sumRange(daily, bucket, prevRange) : null;

    // Los productos salen de su propio archivo, cortado por mes: se toman los
    // meses que toca el rango y se avisa en la hoja.
    let productos = null; let meses = null;
    try {
      const file = await W.load('products');
      const ms = [];
      let m = range.from.slice(0, 7);
      const fin = range.to.slice(0, 7);
      while (m <= fin) {
        ms.push(m);
        const [y, mm] = m.split('-').map(Number);
        m = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`;
      }
      meses = ms.filter((x) => (file.months || []).includes(x)).join(', ');
      const porSku = new Map();
      const segs = bucket === 'all' ? W.SEGMENTS : [bucket];
      for (const s of segs) {
        for (const ym of ms) {
          for (const it of (file.segments?.[s]?.[ym] || [])) {
            const k = String(it.sku || it.name);
            const e = porSku.get(k) || { sku: it.sku, name: it.name, dept: it.dept || '',
              qty: 0, gmv: 0, orders: 0, app: { qty: 0 }, web: { qty: 0 } };
            e.qty += it.qty || 0; e.gmv += it.gmv || 0; e.orders += it.orders || 0;
            e.app.qty += it.byChannel?.app?.qty || 0;
            e.web.qty += it.byChannel?.web?.qty || 0;
            porSku.set(k, e);
          }
        }
      }
      productos = [...porSku.values()].sort((a, b) => b.qty - a.qty).slice(0, 500);
    } catch { /* sin ranking de productos, el resto del archivo sirve igual */ }

    const hojas = libro({ acc, prev, range, bucket, canal, productos, meses });

    // ── Pedidos, uno por fila ───────────────────────────────────────────────
    // Va al final porque es la más pesada: si falla (el archivo del histórico
    // no está configurado), el resto del libro sirve igual.
    try {
      const [geo, emails] = await Promise.all([
        W.load('geo').catch(() => null),
        W.loadEmailMap ? W.loadEmailMap().catch(() => null) : null,
      ]);
      const filas = await hojaPedidos(range, bucket, geo?.stores, emails);
      if (filas.length) {
        const E2 = W.XLSX_ESTILO;
        hojas.splice(2, 0, {
          name: 'Pedidos',
          rows: [
            [`Pedidos, uno por fila — ${W.fmtDayLong(range.from)} a ${W.fmtDayLong(range.to)} · ${canal}`
              + ` · ${filas.length.toLocaleString('es-AR')} pedidos`],
            ['Sin UTM ni cantidad de productos: no se guardan por pedido.'
              + ' El estado viene vacío en los pedidos más viejos.'
              + (emails ? ' La columna Cliente trae el email: es información personal.' : '')],
            [],
            ['Order ID', 'Fecha', 'Estado', 'Total', 'Segmento', 'Código de tienda',
              'Tienda', 'Cupón', 'Cliente'],
            ...filas,
          ],
          filaEncabezado: 4,
          columnasFijas: 2,
          widths: [22, 20, 20, 14, 16, 16, 30, 20, 34],
          merges: ['A1:I1', 'A2:I2'],
          estiloDe: (f, c) => {
            if (f === 1) return E2.titulo;
            if (f === 2) return E2.nota;
            if (f === 4) return E2.encabezado;
            if (f < 4) return null;
            return c === 3 ? E2.moneda : null;
          },
        });
      }
    } catch { /* sin el histórico, el resto del libro va igual */ }
    const nombre = `webdash-${W.channel}-${range.from}_a_${range.to}.xlsx`;
    W.downloadXLSX(nombre, hojas);
    return hojas.length;
  };
})();

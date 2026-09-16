/* global window, document */
/**
 * Vista "Resumen mensual": el acumulado mes a mes, desde que hay datos.
 *
 * Es la contraparte del "Resumen Mensual" de AppDash, pero del ecommerce
 * completo: cada mes muestra el total y como se reparte entre App y Web, en vez
 * de un solo canal.
 *
 * POR QUE NO USA EL RANGO DE FECHAS DE ARRIBA. Un resumen mensual que se recorta
 * al rango elegido deja de ser un resumen: la pregunta que responde es "como
 * venimos mes contra mes", y para eso hacen falta TODOS los meses. El selector
 * de rango se esconde, igual que en Buscador y Audiencias. El filtro de canal y
 * el de segmento SI aplican, porque no cambian el eje del tiempo.
 *
 * EL MES EN CURSO. El ultimo mes casi nunca esta cerrado, asi que compararlo
 * contra el anterior a secas dice "-60%" cuando en realidad van 16 de 30 dias.
 * Se marca como parcial y la comparacion del ultimo mes se hace contra el mismo
 * tramo del mes anterior (los primeros N dias), no contra su total.
 */
(function () {
  const W = (window.W = window.W || {});

  let metrica = W.store.get('mensualMetrica', 'orders');   // 'orders' | 'gmv'

  W.viewMensual = async function (ctx) {
    const { bucket, el } = ctx;
    const daily = await W.load('daily-summary');
    const dias = daily.days || [];
    if (!dias.length) {
      el.innerHTML = `<div class="empty"><h2>Todavía no hay datos</h2><p>Corré el backfill inicial (ver README).</p></div>`;
      return;
    }

    const segs = bucket === 'all' ? W.SEGMENTS : [bucket];
    const hoy = W.arToday();
    const mesActual = hoy.slice(0, 7);

    // ── Agregado por mes ───────────────────────────────────────────────────
    const meses = new Map();
    for (const d of dias) {
      const ym = d.date.slice(0, 7);
      let m = meses.get(ym);
      if (!m) {
        m = {
          ym, orders: 0, gmv: 0, units: 0, ecommOrders: 0, conUtm: 0, sinUtm: 0,
          porSeg: Object.fromEntries(W.SEGMENTS.map((s) => [s, { orders: 0, gmv: 0 }])),
          porCanal: {}, dias: 0, ultimoDia: d.date,
        };
        meses.set(ym, m);
      }
      m.dias += 1;
      if (d.date > m.ultimoDia) m.ultimoDia = d.date;
      m.ecommOrders += d.totalEcommOrders || 0;
      m.conUtm += d.conUtm || 0;
      m.sinUtm += d.sinUtm || 0;
      for (const sg of segs) {
        const v = d.segments?.[sg];
        if (!v) continue;
        m.orders += v.orders || 0; m.gmv += v.gmv || 0; m.units += v.units || 0;
        m.porSeg[sg].orders += v.orders || 0; m.porSeg[sg].gmv += v.gmv || 0;
        for (const [ch, cv] of Object.entries(v.byChannel || {})) {
          const t = (m.porCanal[ch] = m.porCanal[ch] || { orders: 0, gmv: 0, units: 0 });
          t.orders += cv.orders || 0; t.gmv += cv.gmv || 0; t.units += cv.units || 0;
        }
        // Atribución: si el dataset la trae por segmento (marketing), se usa esa;
        // conUtm/sinUtm del día solo existe en el canal app.
        for (const [fuente, mv] of Object.entries(v.marketing || {})) {
          if (fuente === 'sin_atribucion' || !fuente) m.sinUtmSeg = (m.sinUtmSeg || 0) + (mv.orders || 0);
          m.totUtmSeg = (m.totUtmSeg || 0) + (mv.orders || 0);
        }
      }
    }

    const lista = [...meses.values()].sort((a, b) => (a.ym < b.ym ? -1 : 1));
    const hayCanal = lista.some((m) => Object.keys(m.porCanal).length > 1);

    // DESDE QUE MES HAY DATO DE CADA CANAL. Web arranca en enero y app en mayo,
    // asi que los meses anteriores mostraban "0 app · 0% app" — y eso no es que
    // la app no vendio, es que el dato no existe. Un cero ahi es una mentira, y
    // en el grafico dibujaria una linea pegada al piso que se lee como "la app
    // arranco en mayo desde cero".
    const desde = {};
    for (const ch of W.CHANNELS) {
      const m = lista.find((x) => (x.porCanal[ch]?.orders || 0) > 0);
      desde[ch] = m ? m.ym : null;
    }
    /** ¿Ese canal tiene dato ese mes? Si no, va null, no 0. */
    const cubre = (ch, ym) => !!desde[ch] && ym >= desde[ch];
    const sinCobertura = hayCanal
      ? lista.filter((m) => W.CHANNELS.some((ch) => !cubre(ch, m.ym)))
      : [];
    const fmt = metrica === 'gmv' ? W.fmtMoneyC : W.fmtNumC;
    const fmtL = metrica === 'gmv' ? W.fmtMoney : W.fmtNum;

    // ── El mes en curso, comparado contra el mismo tramo del anterior ──────
    const ultimo = lista[lista.length - 1];
    const parcial = ultimo.ym === mesActual;
    const diasCorridos = parcial ? Number(ultimo.ultimoDia.slice(8, 10)) : null;
    let mismoTramoAnterior = null;
    if (parcial && lista.length > 1) {
      const anteriorYm = lista[lista.length - 2].ym;
      let acc = 0;
      for (const d of dias) {
        if (d.date.slice(0, 7) !== anteriorYm) continue;
        if (Number(d.date.slice(8, 10)) > diasCorridos) continue;
        for (const sg of segs) acc += d.segments?.[sg]?.[metrica === 'gmv' ? 'gmv' : 'orders'] || 0;
      }
      mismoTramoAnterior = acc;
    }

    const labels = lista.map((m) => `${m.ym}-01`);   // el eje lo formatea fmtMonth

    // ── Series ─────────────────────────────────────────────────────────────
    const serieTotal = [{
      name: metrica === 'gmv' ? 'GMV' : 'Pedidos',
      color: metrica === 'gmv' ? '#eb6834' : '#2a78d6',
      values: lista.map((m) => m[metrica]),
    }];

    const seriePart = hayCanal ? W.CHANNELS.map((ch) => ({
      name: W.CHANNEL_LABEL[ch],
      color: W.CHANNEL_COLOR[ch],
      values: lista.map((m) => {
        // Sin cobertura de los DOS canales, el reparto no significa nada: con
        // app en cero por falta de dato, web daria 100% y no es cierto.
        if (W.CHANNELS.some((c) => !cubre(c, m.ym))) return null;
        const t = W.CHANNELS.reduce((a, c) => a + (m.porCanal[c]?.[metrica] || 0), 0);
        return t ? ((m.porCanal[ch]?.[metrica] || 0) / t) * 100 : 0;
      }),
    })) : null;

    const serieSeg = W.SEGMENTS.map((sg) => ({
      name: W.SEGMENT_LABEL[sg],
      color: W.SEGMENT_COLOR[sg],
      values: lista.map((m) => m.porSeg[sg][metrica]),
    }));

    // ── Tarjetas del último mes ────────────────────────────────────────────
    const prevMes = lista.length > 1 ? lista[lista.length - 2] : null;
    const dMes = parcial
      ? (mismoTramoAnterior ? W.delta(ultimo[metrica], mismoTramoAnterior) : null)
      : (prevMes ? W.delta(ultimo[metrica], prevMes[metrica]) : null);

    const kc = ({ color, icon, label, value, sub, delta, chip }) => `<div class="kc" style="--kc:${color}">
      <div class="kc-top"><span class="kc-ic">${W.icon(icon, 15)}</span>
        ${chip ? `<span class="kc-share">${W.esc(chip)}</span>` : ''}</div>
      <div class="kc-v">${value}</div><div class="kc-l">${W.esc(label)}</div>
      ${sub ? `<div class="kc-s">${sub}</div>` : ''}
      ${delta != null ? `<div class="kc-d">${W.deltaBadge(delta)}<em>${parcial ? 'mismo tramo del mes anterior' : 'vs. mes anterior'}</em></div>` : ''}
    </div>`;

    const chApp = ultimo.porCanal.app || { orders: 0, gmv: 0 };
    const chWeb = ultimo.porCanal.web || { orders: 0, gmv: 0 };

    const tarjetas = [
      kc({
        color: '#2a78d6', icon: 'orders', label: `${W.fmtMonthLong(ultimo.ym)}`,
        value: fmt(ultimo[metrica]), delta: dMes,
        chip: parcial ? `${diasCorridos} días` : 'cerrado',
        sub: hayCanal ? `App <b>${fmt(chApp[metrica])}</b> · Web <b>${fmt(chWeb[metrica])}</b>` : '',
      }),
      kc({
        color: '#eb6834', icon: 'ticket', label: 'Ticket del mes',
        value: W.fmtMoney(W.ticket(ultimo.gmv, ultimo.orders)),
        delta: prevMes && !parcial ? W.delta(W.ticket(ultimo.gmv, ultimo.orders), W.ticket(prevMes.gmv, prevMes.orders)) : null,
        sub: 'GMV ÷ pedidos',
      }),
      ...(ultimo.ecommOrders ? [kc({
        color: '#4a3aa7', icon: 'globe', label: 'Participación sobre el ecommerce',
        value: W.fmtPct(ultimo.orders / ultimo.ecommOrders, 1),
        sub: `${W.fmtNumC(ultimo.orders)} de ${W.fmtNumC(ultimo.ecommOrders)} pedidos que reporta VTEX`,
      })] : []),
      ...(ultimo.totUtmSeg ? [kc({
        color: '#e34948', icon: 'warn', label: 'Sin atribución',
        value: W.fmtPct((ultimo.sinUtmSeg || 0) / ultimo.totUtmSeg, 1),
        sub: `${W.fmtNumC(ultimo.sinUtmSeg || 0)} pedidos llegaron sin utm_source`,
      })] : []),
    ];

    // ── La tabla: es la vista de tabla de los tres gráficos ────────────────
    const fila = (m, i) => {
      const prev = i > 0 ? lista[i - 1] : null;
      const esParcial = m.ym === mesActual;
      const tot = W.CHANNELS.reduce((a, c) => a + (m.porCanal[c]?.[metrica] || 0), 0);
      return `<tr class="${esParcial ? 'is-parcial' : ''}">
        <td class="mes-n">${W.esc(W.fmtMonthLong(m.ym))}
          ${esParcial ? `<span class="mes-chip">${m.dias} de ${new Date(Number(m.ym.slice(0, 4)), Number(m.ym.slice(5, 7)), 0).getDate()} días</span>` : ''}</td>
        <td class="num strong">${fmt(m[metrica])}</td>
        ${hayCanal ? W.CHANNELS.map((ch) => `<td class="num${cubre(ch, m.ym) ? '' : ' dim'}">${
          cubre(ch, m.ym) ? fmt(m.porCanal[ch]?.[metrica] || 0)
            : `<span ${W.chart.tip(`<strong>Sin dato</strong><span class="tip-row">El canal ${W.esc(W.CHANNEL_LABEL[ch])} tiene datos desde ${W.esc(W.fmtMonthLong(desde[ch]))}.</span>`)}>s/d</span>`}</td>`).join('')
        + `<td class="chm-mix">${W.CHANNELS.every((ch) => cubre(ch, m.ym))
          ? W.splitBar(m.porCanal.app?.[metrica], m.porCanal.web?.[metrica], { alto: 5 })
            + `<span class="chm-mixl">${W.fmtPct(tot ? (m.porCanal.app?.[metrica] || 0) / tot : 0, 0)} app</span>`
          : '<span class="dim" style="font-size:.7rem">sin los dos canales</span>'}</td>` : ''}
        ${W.SEGMENTS.map((sg) => `<td class="num dim">${fmt(m.porSeg[sg][metrica])}</td>`).join('')}
        <td class="num">${W.fmtMoney(W.ticket(m.gmv, m.orders))}</td>
        <td class="num">${m.ecommOrders ? W.fmtPct(m.orders / m.ecommOrders, 1) : '—'}</td>
        <td class="num">${prev && !esParcial ? W.deltaBadge(W.delta(m[metrica], prev[metrica])) : '<span class="dim">—</span>'}</td>
      </tr>`;
    };

    const leyendaCanal = hayCanal
      ? `<div class="chleg"><span><i style="background:${W.CHANNEL_COLOR.app}"></i>App</span><span><i style="background:${W.CHANNEL_COLOR.web}"></i>Web</span></div>`
      : '';

    const toggle = `<div class="seg-ctl">
      <button data-mensual="orders" class="${metrica === 'orders' ? 'on' : ''}">Pedidos</button>
      <button data-mensual="gmv" class="${metrica === 'gmv' ? 'on' : ''}">GMV</button>
    </div>`;

    const card = (t, s, cont, extra = '') => `<div class="card">
      <div class="card-h"><div><h3>${t}</h3><p>${s}</p></div>${extra}</div>${cont}</div>`;

    el.innerHTML = `
      ${parcial ? `<div class="chalert warn"><span class="chalert-ic">${W.icon('info', 16)}</span>
        <div><strong>${W.esc(W.fmtMonthLong(ultimo.ym))} está en curso</strong>
        <span>Van ${diasCorridos} días. La variación de ese mes se compara contra los primeros ${diasCorridos} días del mes anterior, no contra su total cerrado — comparar un mes a medias contra uno completo daría una caída que no pasó.</span></div>
      </div>` : ''}

      ${sinCobertura.length ? `<div class="chalert warn"><span class="chalert-ic">${W.icon('info', 16)}</span>
        <div><strong>Los dos canales no arrancan el mismo mes</strong>
        <span>${W.CHANNELS.filter((ch) => desde[ch]).map((ch) => `${W.CHANNEL_LABEL[ch]} tiene datos desde <b>${W.esc(W.fmtMonthLong(desde[ch]))}</b>`).join(' y ')}.
        Los ${sinCobertura.length} ${sinCobertura.length === 1 ? 'mes' : 'meses'} anteriores figuran como <b>s/d</b> en la columna del canal que falta, y la línea de participación arranca recién donde están los dos: un cero ahí se leería como que ese canal no vendió.</span></div>
      </div>` : ''}

      <div class="kgrid k4">${tarjetas.join('')}</div>

      <div class="cgrid">
        ${card(`${metrica === 'gmv' ? 'GMV' : 'Pedidos'} por mes`,
          `desde ${W.esc(W.fmtMonthLong(lista[0].ym))} · ${segs.length === 1 ? W.esc(W.SEGMENT_LABEL[segs[0]]) : 'todos los segmentos'}`,
          W.chart.line({ labels, series: serieTotal, height: 210, yFmt: fmt, id: 'men-tot',
            xFmt: (d) => W.fmtMonth(d.slice(0, 7)), tipTitle: (d) => W.fmtMonthLong(d.slice(0, 7)) }),
          toggle)}
        ${seriePart ? card('Participación App vs. Web por mes', '% del total de cada mes',
          W.chart.line({ labels, series: seriePart, height: 210, yFmt: (v) => `${Math.round(v)}%`, id: 'men-part',
            xFmt: (d) => W.fmtMonth(d.slice(0, 7)), tipTitle: (d) => W.fmtMonthLong(d.slice(0, 7)) }))
        : card('Participación sobre el ecommerce', '% de los pedidos que reporta VTEX',
          W.chart.line({ labels, series: [{ name: 'Participación', color: '#4a3aa7',
            values: lista.map((m) => (m.ecommOrders ? (m.orders / m.ecommOrders) * 100 : 0)) }],
            height: 210, yFmt: (v) => `${Math.round(v)}%`, id: 'men-ecom',
            xFmt: (d) => W.fmtMonth(d.slice(0, 7)), tipTitle: (d) => W.fmtMonthLong(d.slice(0, 7)) }))}
      </div>

      ${card('Tendencia por segmento', `${metrica === 'gmv' ? 'GMV' : 'pedidos'} de cada segmento, mes a mes`,
        W.chart.line({ labels, series: serieSeg, height: 230, yFmt: fmt, id: 'men-seg',
          xFmt: (d) => W.fmtMonth(d.slice(0, 7)), tipTitle: (d) => W.fmtMonthLong(d.slice(0, 7)) }))}

      <div class="card">
        <div class="card-h">
          <div><h3>Mes por mes</h3><p>los mismos números de los gráficos, para leer exacto</p></div>
          <div class="prod-tools">${leyendaCanal}
            <button class="btn" data-export="mensual">${W.icon('download', 14)}XLSX</button></div>
        </div>
        <div class="tbl-wrap">
          <table class="tbl mens">
            <thead><tr>
              <th>Mes</th><th class="num">${metrica === 'gmv' ? 'GMV' : 'Pedidos'}</th>
              ${hayCanal ? '<th class="num">App</th><th class="num">Web</th><th>Mix</th>' : ''}
              ${W.SEGMENTS.map((sg) => `<th class="num">${W.esc(W.SEGMENT_LABEL[sg])}</th>`).join('')}
              <th class="num">Ticket</th><th class="num">Part. ecomm</th><th class="num">vs. mes ant.</th>
            </tr></thead>
            <tbody>${lista.slice().reverse().map((m, i) => fila(m, lista.length - 1 - i)).join('')}</tbody>
          </table>
        </div>
      </div>`;

    document.querySelectorAll('[data-mensual]').forEach((b) => b.addEventListener('click', () => {
      metrica = b.dataset.mensual; W.store.set('mensualMetrica', metrica); W.render();
    }));

    ctx.exports.mensual = {
      filename: `mensual_${lista[0].ym}_${ultimo.ym}.csv`,
      headers: ['mes', 'pedidos', 'gmv', 'unidades', 'ticket', 'pedidos_app', 'pedidos_web',
        ...W.SEGMENTS.map((s) => `pedidos_${s}`), 'part_ecommerce', 'dias_con_datos'],
      rows: lista.map((m) => [
        m.ym, m.orders, Math.round(m.gmv), Math.round(m.units), Math.round(W.ticket(m.gmv, m.orders)),
        m.porCanal.app?.orders || 0, m.porCanal.web?.orders || 0,
        ...W.SEGMENTS.map((s) => m.porSeg[s].orders),
        m.ecommOrders ? Number((m.orders / m.ecommOrders).toFixed(4)) : '', m.dias,
      ]),
    };
  };
}());

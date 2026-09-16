/* global window, document */
/**
 * Vista "Dashboard": la pantalla que responde "¿cómo venimos?" de un vistazo.
 *
 * Tres decisiones que definen esta vista:
 *
 * 1. JERARQUÍA. Antes había 12 tiles del mismo tamaño y el mismo blanco: nada
 *    decía qué mirar primero. Ahora hay UN número protagonista (el GMV), una
 *    fila de métricas primarias, los 4 segmentos con su color y su
 *    participación, y las métricas de apoyo en una tira recesiva.
 *
 * 2. UN DÍA EN CURSO NO SE COMPARA CONTRA UN DÍA CERRADO. Mirando "Hoy" al
 *    mediodía, comparar contra el total del martes pasado daba -74% en TODAS
 *    las métricas: no es una caída, es que el día va por la mitad. Donde hay
 *    dato hora a hora (pedidos) se compara a la misma hora, que es exacto;
 *    donde no lo hay (plata, clientes) no se inventa un porcentaje: se marca
 *    "día en curso" y se muestra en cuánto cerró el día de referencia.
 *
 * 3. PARA UN SOLO DÍA, LA EVOLUCIÓN ES POR HORA. Un gráfico diario con un
 *    solo punto no es un gráfico; la curva acumulada de hoy contra la del
 *    mismo día de la semana pasada dice en dos segundos si vamos adelante o
 *    atrás, y las dos curvas son datos reales (no proyecciones).
 */
(function () {
  const W = (window.W = window.W || {});

  // Pestañas internas: los KPIs de arriba quedan siempre visibles y el resto
  // se reparte, para no apilar cinco tarjetas grandes una abajo de la otra.

  // Color por métrica, tomado de la paleta de series ya validada
  // (--s1..--s8). El hero no está acá: usa el degradé de marca, que es
  // superficie, no color de dato.
  const MC = {
    orders: '#2a78d6',  // s1
    ticket: '#eb6834',  // s2
    units: '#4a3aa7',   // s7
    clients: '#e87ba4', // s5
    fresh: '#eda100',   // s4
    discount: '#008300',// s6
  };
  const REF_GRAY = '#898781'; // serie de referencia (día anterior): de-énfasis

  // ── Piezas de UI ─────────────────────────────────────────────────────────
  /** El único número protagonista de la vista (uno solo, por diseño). */

  /** Métrica primaria: valor grande, color pleno de la métrica como acento. */

  /** Un segmento con SU color, su volumen y cuánto pesa del total. */

  /**
   * LA TARJETA. Una sola, para todo: KPIs, segmentos y metricas de apoyo.
   *
   * Antes habia cuatro lenguajes en la misma pantalla —un hero con degradé del
   * ancho de tres tarjetas, los `tile`, los `segc` y los `mitem`— cada uno con
   * su tipografia, su padding y su forma. Cuatro familias no se leen como un
   * sistema: se leen como cuatro pantallas pegadas.
   *
   *   [ic]           99.1%   icono en cuadrado tintado · chip de share
   *   6,5 K                  el numero
   *   Food                   etiqueta
   *   $526,3 M · incl. QC    sub, recesivo
   *   ↓ 4.3% vs ant.         delta
   *   ▬▬▬▬▬▬▬▬               barra de participacion, 3px
   */
  function kc({ color, icon, label, value, sub, delta, chip, share, note, tip, split }) {
    return `<div class="kc" style="--kc:${color}"${tip ? ` ${W.chart.tip(tip)}` : ''}>
      <div class="kc-top">
        <span class="kc-ic">${W.icon(icon, 15)}</span>
        ${share != null ? `<span class="kc-share">${W.fmtPct(share, 1)}</span>`
          : chip ? `<span class="kc-share">${W.esc(chip)}</span>` : ''}
      </div>
      <div class="kc-v">${value}</div>
      <div class="kc-l">${W.esc(label)}</div>
      ${sub ? `<div class="kc-s">${sub}</div>` : ''}
      ${delta !== undefined && delta !== null
        ? `<div class="kc-d">${W.deltaBadge(delta)}<em>vs. ant.</em></div>`
        : note ? `<div class="kc-d"><em>${note}</em></div>` : ''}
      ${split || ''}
      ${share != null ? `<div class="kc-bar"><div class="kc-track">
        <div class="kc-fill" style="width:${Math.min(100, share * 100)}%"></div></div></div>` : ''}
    </div>`;
  }

  /** Métrica de apoyo: chica, gris, para consultar — no compite con el hero. */

  // ── Datos por hora ───────────────────────────────────────────────────────
  /**
   * Las 24 horas de un día, respetando el segmento elegido. En schema 2 el
   * horario vive por segmento; los días viejos lo traen a nivel día. Se
   * soportan los dos porque el historial tiene de las dos clases.
   */
  function dayHourly(day, bucket) {
    if (!day) return null;
    if (bucket !== 'all') return day.segments?.[bucket]?.hourly || null;
    const perSeg = W.SEGMENTS.some((s) => day.segments?.[s]?.hourly);
    if (perSeg) {
      const out = new Array(24).fill(0);
      for (const s of W.SEGMENTS) (day.segments[s]?.hourly || []).forEach((n, h) => { out[h] += n; });
      return out;
    }
    return day.hourly || null;
  }

  const sumTo = (arr, upto) => (arr || []).slice(0, upto).reduce((a, b) => a + b, 0);

  /** Acumulado hora a hora. `upto` corta la serie (el día en curso no llega
   * a las 23: dibujarlo plano hasta el final parecería que se cayó a cero). */
  function cumulative(arr, upto) {
    let acc = 0;
    return (arr || []).map((n, h) => {
      if (upto != null && h >= upto) return null;
      acc += n;
      return acc;
    });
  }

  /** Observaciones automáticas: qué mirar / qué mejorar, sin tener que leer los gráficos. */
  function buildInsights(cur, prev, range, daily, catalog, bucket) {
    const out = [];
    const dTicket = W.delta(W.ticket(cur.gmv, cur.orders), W.ticket(prev.gmv, prev.orders));
    const dOrders = W.delta(cur.orders, prev.orders);
    const dGmv = W.delta(cur.gmv, prev.gmv);

    if (dOrders != null && dGmv != null) {
      if (dGmv > 0.02 && dOrders <= 0.005) {
        out.push({ kind: 'warn', title: 'El GMV sube por precio, no por demanda',
          text: `GMV ${W.fmtPct(dGmv)} vs. pedidos ${W.fmtPct(dOrders)}. El crecimiento viene del ticket, no de más clientes comprando: si el ticket se estanca, el GMV se frena.` });
      } else if (dOrders > 0.02 && dTicket != null && dTicket < -0.02) {
        out.push({ kind: 'warn', title: 'Más pedidos pero ticket en baja',
          text: `Pedidos ${W.fmtPct(dOrders)} con ticket ${W.fmtPct(dTicket)}. Suele indicar mix hacia canastas chicas o descuento agresivo — revisá cupones y Quick Commerce.` });
      } else if (dGmv > 0.02 && dOrders > 0.02) {
        out.push({ kind: 'good', title: 'Crecimiento sano', text: `Pedidos ${W.fmtPct(dOrders)} y GMV ${W.fmtPct(dGmv)} crecen juntos: el volumen manda, no el precio.` });
      } else if (dGmv < -0.03) {
        out.push({ kind: 'bad', title: 'Caída de GMV', text: `GMV ${W.fmtPct(dGmv)} vs. el período de comparación. Mirá el mix por segmento y el detalle de fuentes de marketing para aislar de dónde viene.` });
      }
    }

    // Tendencia intra-período: pendiente de la regresión sobre pedidos diarios.
    if (cur.series.length >= 7) {
      const vals = cur.series.map((s) => s.orders);
      const reg = W.linreg(vals);
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const perDayPct = avg ? reg.slope / avg : 0;
      if (Math.abs(perDayPct) > 0.004) {
        out.push({
          kind: perDayPct > 0 ? 'good' : 'warn',
          title: perDayPct > 0 ? 'Tendencia en alza dentro del período' : 'Tendencia en baja dentro del período',
          text: `Los pedidos se mueven ${W.fmtPct(perDayPct)} por día en promedio (≈ ${W.fmtPct(perDayPct * 30)} proyectado a 30 días si se sostiene).`,
        });
      }
    }

    // Dependencia de descuento.
    if (cur.discount > 0 && cur.gmv > 0) {
      const ratio = cur.discount / (cur.gmv + cur.discount);
      if (ratio > 0.15) {
        out.push({ kind: 'warn', title: 'Alta dependencia de descuento',
          text: `Los descuentos representan ${W.fmtPct(ratio)} del valor bruto. Por encima del 15% conviene revisar qué cupones están comprando volumen que ya ibas a tener.` });
      }
    }

    // Concentración de segmento — solo tiene sentido mirando el canal completo
    // (si el usuario filtró por un segmento, su share es 100% por definición).
    const segEntries = W.SEGMENTS.map((s) => [s, cur.bySegment[s].gmv]).sort((a, b) => b[1] - a[1]);
    if (bucket === 'all' && segEntries[0] && cur.gmv > 0) {
      const share = segEntries[0][1] / cur.gmv;
      if (share > 0.8) {
        out.push({ kind: 'info', title: `Concentración en ${W.SEGMENT_LABEL[segEntries[0][0]]}`,
          text: `${W.fmtPct(share)} del GMV sale de un solo segmento. Los otros tres son la palanca de crecimiento con menor competencia interna.` });
      }
    }

    // Mejor y peor día de la semana.
    if (catalog?.dayOfWeek?.length === 7) {
      const withData = catalog.dayOfWeek.map((d, i) => ({ ...d, i })).filter((d) => d.days > 0);
      if (withData.length >= 5) {
        const best = withData.reduce((a, b) => (b.avgOrders > a.avgOrders ? b : a));
        const worst = withData.reduce((a, b) => (b.avgOrders < a.avgOrders ? b : a));
        if (best.avgOrders > 0) {
          out.push({ kind: 'info', title: `${W.DOW_LABELS[best.i]} es tu mejor día`,
            text: `Promedia ${W.fmtNum(best.avgOrders)} pedidos vs. ${W.fmtNum(worst.avgOrders)} de ${W.DOW_LABELS[worst.i]} (${W.fmtPct(best.avgOrders / (worst.avgOrders || 1) - 1)} más). Concentrar envíos de campaña ahí rinde más.` });
        }
      }
    }

    // Adquisición.
    if (cur.newCustomers > 0 && cur.activeCustomers > 0) {
      const newShare = cur.newCustomers / cur.activeCustomers;
      out.push({
        kind: newShare < 0.15 ? 'warn' : 'info',
        title: newShare < 0.15 ? 'Poca adquisición nueva' : 'Mix de adquisición',
        text: `${W.fmtPct(newShare)} de los clientes activos del período compraron por primera vez. ${newShare < 0.15 ? 'El negocio se apoya casi todo en la base existente: sano para margen, frágil para crecer.' : 'Base renovándose a buen ritmo.'}`,
      });
    }

    // Segmento con mejor y peor variación de GMV — solo tiene sentido mirando
    // el canal completo, para no comparar un segmento contra sí mismo.
    if (bucket === 'all') {
      const segDeltas = W.SEGMENTS
        .map((s) => ({ s, d: W.delta(cur.bySegment[s].gmv, prev.bySegment[s]?.gmv || 0) }))
        .filter((x) => x.d != null && prev.bySegment[x.s]?.gmv > 0);
      if (segDeltas.length >= 2) {
        const best = segDeltas.reduce((a, b) => (b.d > a.d ? b : a));
        if (best.d > 0.05) {
          out.push({ kind: 'good', title: `${W.SEGMENT_LABEL[best.s]} es el que más crece`,
            text: `GMV ${W.fmtPct(best.d)} vs. el período de comparación — la palanca más fuerte del canal ahora mismo.` });
        }
        const worst = segDeltas.reduce((a, b) => (b.d < a.d ? b : a));
        if (worst.d < -0.1 && worst.s !== best.s) {
          out.push({ kind: 'warn', title: `${W.SEGMENT_LABEL[worst.s]} viene en baja`,
            text: `GMV ${W.fmtPct(worst.d)} vs. el período de comparación. Vale la pena revisar qué cambió ahí.` });
        }
      }
    }

    // Categoría dominante del período — sencillo pero de un vistazo dice qué
    // mueve la aguja del surtido.
    const catEntries = Object.entries(cur.categories || {}).sort((a, b) => b[1].gmv - a[1].gmv);
    if (catEntries.length && cur.gmv > 0) {
      const [topName, topV] = catEntries[0];
      const share = topV.gmv / cur.gmv;
      if (share > 0.08) {
        out.push({ kind: 'info', title: `${topName} lidera el surtido`,
          text: `${W.fmtPct(share)} del GMV del período — ${W.fmtMoneyC(topV.gmv)} en ${W.fmtNum(topV.orders)} líneas de pedido.` });
      }
    }

    return out;
  }

  W.viewDashboard = async function (ctx) {
    const { range, bucket, compare, el } = ctx;
    const daily = await W.load('daily-summary');
    const catalog = await W.load('catalog').catch(() => null);

    if (!daily.days.length) {
      el.innerHTML = `<div class="empty"><h2>Todavía no hay datos</h2>
        <p>Corré el backfill inicial para poblar el historial (ver README).</p></div>`;
      return;
    }

    const cur = W.sumRange(daily, bucket, range);
    const prevRange = W.previousRange(range);
    const prev = W.sumRange(daily, bucket, prevRange);
    const cmp = W.compareText(range);

    // ── ¿Es un día en curso? ───────────────────────────────────────────────
    // Todo lo que sigue depende de esto: un día a mitad de camino no se
    // compara contra un día cerrado.
    const arToday = W.arToday();
    const isSingleDay = range.from === range.to;
    const isToday = isSingleDay && range.from === arToday;
    const hoursElapsed = isToday ? Math.min(24, W.arHour() + 1) : 24;

    const cmpDayDate = prevRange.from;
    const cmpDay = daily.days.find((d) => d.date === cmpDayDate) || null;
    // La curva de referencia sirve para cualquier día suelto (hoy o "ayer"),
    // no solo para hoy.
    const cmpHourly = isSingleDay ? dayHourly(cmpDay, bucket) : null;
    const cmpHasHours = !!cmpHourly && cmpHourly.some((n) => n > 0);
    // Base exacta para comparar pedidos: el mismo día de la semana pasada,
    // contado SOLO hasta la hora que ya transcurrió hoy.
    const cmpOrdersToHour = isToday && cmpHasHours ? sumTo(cmpHourly, hoursElapsed) : null;
    const cmpName = W.fmtDayWeek(cmpDayDate);

    const showDelta = compare;
    // Dos clases de métrica se comportan distinto en un día a medio terminar:
    //   · ACUMULADAS (GMV, pedidos, clientes, descuentos): medio día contra un
    //     día entero no se puede comparar → d() devuelve null y la UI pone el
    //     chip "día en curso" en vez de un porcentaje inventado.
    //   · PROMEDIOS (ticket, unidades por pedido): son razones, no sumas, así
    //     que sí se pueden comparar contra el promedio del día de referencia
    //     — se compara y se aclara en el subtítulo que la base es el día
    //     completo (puede haber sesgo de mix horario, pero es un dato real y
    //     mucho más útil que no mostrar nada).
    const d = (a, b) => (showDelta && !isToday ? W.delta(a, b) : null);
    const dRatio = (a, b) => (showDelta ? W.delta(a, b) : null);
    const partialChip = isToday ? 'día en curso' : null;

    const labels = cur.series.map((s) => s.date);
    const orders = cur.series.map((s) => s.orders);

    // ── Proyección de cierre de mes ──────────────────────────────────────────
    const lastDay = daily.days[daily.days.length - 1].date;
    const monthStart = lastDay.slice(0, 8) + '01';
    const mtd = W.sumRange(daily, bucket, { from: monthStart, to: lastDay });
    const dim = new Date(Number(lastDay.slice(0, 4)), Number(lastDay.slice(5, 7)), 0).getDate();
    const elapsed = Number(lastDay.slice(8, 10));
    const paceGmv = elapsed ? (mtd.gmv / elapsed) * dim : 0;
    const paceOrders = elapsed ? (mtd.orders / elapsed) * dim : 0;

    // Mes anterior completo, para comparar la proyección contra algo real.
    const prevMonthEnd = W.addDays(monthStart, -1);
    const prevMonthStart = prevMonthEnd.slice(0, 8) + '01';
    const prevMonth = W.sumRange(daily, bucket, { from: prevMonthStart, to: prevMonthEnd });

    const scopeTxt = bucket === 'all' ? 'todos los segmentos' : W.SEGMENT_LABEL[bucket];
    const rangeTxt = isToday ? 'hoy' : isSingleDay ? W.fmtDayWeek(range.from) : W.rangeText(range);

    // ── Hero: el GMV ────────────────────────────────────────────────────────
    const cmpDayTotals = cmpDay ? W.sumRange(daily, bucket, { from: cmpDayDate, to: cmpDayDate }) : null;
    // ── Métricas primarias ─────────────────────────────────────────────────
    const ordersDelta = isToday
      ? (showDelta && cmpOrdersToHour != null ? W.delta(cur.orders, cmpOrdersToHour) : null)
      : d(cur.orders, prev.orders);
    const ordersSub = isToday
      ? (cmpOrdersToHour != null
        ? `${W.esc(cmpName)} a esta hora: <b>${W.fmtNumC(cmpOrdersToHour)}</b>`
        : `sin dato horario de ${W.esc(cmpName)} para comparar`)
      : (showDelta ? `período anterior: <b>${W.fmtNumC(prev.orders)}</b>` : '');

    const curTicket = W.ticket(cur.gmv, cur.orders);
    const curUpo = W.unitsPerOrder(cur.units, cur.orders);
    const cmpTicket = cmpDayTotals ? W.ticket(cmpDayTotals.gmv, cmpDayTotals.orders) : null;
    const cmpUpo = cmpDayTotals ? W.unitsPerOrder(cmpDayTotals.units, cmpDayTotals.orders) : null;

    // ── El mix App/Web de cada total ───────────────────────────────────────
    // Solo cuando el filtro esta en "App + Web": con un solo canal no hay mix
    // que mostrar y una barra de un solo color seria ruido.
    const mostrarSplit = W.hasSplit(cur.byChannel);
    const chApp = cur.byChannel?.app || { orders: 0, gmv: 0, units: 0 };
    const chWeb = cur.byChannel?.web || { orders: 0, gmv: 0, units: 0 };



    // ── Métricas de apoyo ──────────────────────────────────────────────────
    // `has` lo declara el dataset: la fusion de canales lo calcula como la
    // interseccion, asi que si un canal no mide algo, queda en false y se avisa.
    const soloWeb = daily.has ? daily.has.discount === false : false;
    const canc = W.cancellations(cur.statusStats);
    const cancPrev = showDelta && !isToday ? W.cancellations(prev.statusStats) : null;

    // ── Evolución ──────────────────────────────────────────────────────────
    // Un solo día: curva acumulada hora a hora, hoy contra el mismo día de la
    // semana pasada. Las dos series son pedidos reales por hora.
    const hourLabels = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
    const curHourly = cur.hourly || [];
    const hasCurHours = curHourly.some((n) => n > 0);
    const hourChart = () => {
      if (!hasCurHours) {
        return '<div class="chart-empty">Todavía no hay pedidos con hora registrada en este día.</div>';
      }
      // La serie de referencia va PRIMERO: se dibuja abajo y la curva del día
      // elegido queda encima. Al revés (como estaba) el gris tapaba al azul
      // justo cuando las dos curvas van parejas, que es el caso interesante.
      const series = [];
      if (cmpHasHours) {
        series.push({ name: cmpName, color: REF_GRAY, values: cumulative(cmpHourly, null) });
      }
      series.push({
        name: isToday ? 'Hoy' : W.fmtDayWeek(range.from), color: MC.orders, fill: true,
        values: cumulative(curHourly, isToday ? hoursElapsed : null),
      });
      return W.chart.line({
        labels: hourLabels, series, height: 260, yFmt: W.fmtNumC,
        xFmt: (h) => `${h}h`, tipTitle: (h) => `${h}:00`,
        id: 'hour-line',
      });
    };


    // ── Mix por segmento en el tiempo ───────────────────────────────────────
    const mixSeries = W.SEGMENTS.map((s) => ({
      name: W.SEGMENT_LABEL[s],
      color: W.SEGMENT_COLOR[s],
      values: cur.series.map((row) => {
        const day = daily.days.find((dd) => dd.date === row.date);
        return day?.segments?.[s]?.gmv || 0;
      }),
    }));

    // ── Series de los gráficos nuevos ───────────────────────────────────────
    // Cada una sale de daily.days, que es la fuente que ya tiene todo por día:
    // no hace falta un dataset aparte.
    const diaDe = (fecha) => daily.days.find((dd) => dd.date === fecha);

    // Pedidos por día y por segmento. Cuatro series: dentro del tope seguro de
    // la paleta, y con leyenda, que es obligatoria a partir de dos.
    const pedidosPorSeg = W.SEGMENTS.map((sg) => ({
      name: W.SEGMENT_LABEL[sg],
      color: W.SEGMENT_COLOR[sg],
      values: cur.series.map((row) => diaDe(row.date)?.segments?.[sg]?.orders || 0),
    }));

    // Sin atribución por día, en % — es EL kpi que mira AppDash. Sale de
    // marketing.sin_atribucion, que es el nombre que le pone el agregador.
    const sinAtrib = cur.series.map((row) => {
      const d = diaDe(row.date);
      if (!d) return 0;
      let sin = 0, tot = 0;
      for (const sg of (bucket === 'all' ? W.SEGMENTS : [bucket])) {
        const mk = d.segments?.[sg]?.marketing || {};
        for (const [fuente, v] of Object.entries(mk)) {
          tot += v.orders || 0;
          if (fuente === 'sin_atribucion' || fuente === 'Sin atribución' || !fuente) sin += v.orders || 0;
        }
      }
      return tot ? (sin / tot) * 100 : 0;
    });
    const haySinAtrib = sinAtrib.some((v) => v > 0);

    // Participación de cada canal sobre el total del día, en %.
    const partPorDia = ['app', 'web'].map((ch) => ({
      name: W.CHANNEL_LABEL[ch],
      color: W.CHANNEL_COLOR[ch],
      values: cur.series.map((row) => {
        const d = diaDe(row.date);
        if (!d) return 0;
        let mio = 0, tot = 0;
        for (const sg of (bucket === 'all' ? W.SEGMENTS : [bucket])) {
          const bc = d.segments?.[sg]?.byChannel || {};
          for (const [k, v] of Object.entries(bc)) { tot += v.orders || 0; if (k === ch) mio += v.orders || 0; }
        }
        return tot ? (mio / tot) * 100 : 0;
      }),
    }));
    const hayCanalPorDia = partPorDia.some((sr) => sr.values.some((v) => v > 0));

    // Ticket por día.
    const ticketPorDia = cur.series.map((row) => W.ticket(row.gmv, row.orders));

    // Actual contra período anterior, día a día, alineados por posición: es la
    // comparación que pide "vamos mejor o peor que el período pasado".
    const prevSerie = W.sumRange(daily, bucket, prevRange).series.map((r) => r.orders);

    // ── Heatmap día de semana × hora ────────────────────────────────────────
    // A propósito NO usa el rango elegido arriba: con rangos cortos podía
    // tocar un solo martes (o ninguno) y la fila quedaba vacía sin estarlo.
    const hmFrom = W.addDays(arToday, -90);
    const dowHour = Array.from({ length: 7 }, () => new Array(24).fill(0));
    let hasHourly = false;
    for (const day of daily.days) {
      if (day.date < hmFrom || day.date >= arToday) continue;
      const hrs = dayHourly(day, bucket);
      if (!hrs) continue;
      hasHourly = true;
      const dow = new Date(`${day.date}T12:00:00Z`).getUTCDay();
      hrs.forEach((n, h) => (dowHour[dow][h] += n));
    }

    ctx.exports.daily = {
      filename: `webdash-diario-${bucket}-${range.from}_${range.to}.csv`,
      headers: ['fecha', 'pedidos', 'gmv', 'unidades', 'ticket'],
      rows: cur.series.map((s) => [s.date, s.orders, Math.round(s.gmv), Math.round(s.units), Math.round(W.ticket(s.gmv, s.orders))]),
    };

    // Las observaciones automáticas se apoyan en variaciones período contra
    // período: en un día en curso comparan medio día contra un día entero y
    // dicen "caída de GMV -73%", que es falso. Se omiten ahí.
    const insights = showDelta && !isToday ? buildInsights(cur, prev, range, daily, catalog, bucket) : [];

    // ── LA GRILLA DE TARJETAS ───────────────────────────────────────────────
    // Una sola familia, todas del mismo tamaño. El GMV ya no es un hero con
    // degradé del ancho de tres: es la primera tarjeta, y manda por estar
    // primera, no por ser cuatro veces más grande.
    const kcs = [
      kc({
        color: MC.ticket, icon: 'money', label: 'GMV', value: W.fmtMoneyC(cur.gmv),
        delta: showDelta && !isToday ? W.delta(cur.gmv, prev.gmv) : null,
        chip: isToday ? partialChip : null,
        sub: showDelta && !isToday ? `antes ${W.fmtMoneyC(prev.gmv)}` : '',
        tip: `<strong>GMV</strong><span class="tip-row">${W.fmtMoney(cur.gmv)}</span>${
          mostrarSplit ? W.splitTip(chApp.gmv, chWeb.gmv, W.fmtMoney) : ''}`,
      }),
      kc({
        color: MC.orders, icon: 'orders', label: 'Pedidos', value: W.fmtNumC(cur.orders),
        delta: ordersDelta, chip: isToday && ordersDelta == null ? partialChip : null,
        sub: ordersSub,
        split: mostrarSplit
          ? W.splitBar(chApp.orders, chWeb.orders, { alto: 3 })
            + `<div class="kc-s">${W.splitLabel(chApp.orders, chWeb.orders)}</div>`
          : '',
        tip: `<strong>Pedidos</strong><span class="tip-row">${W.fmtNum(cur.orders)} en el período</span>${
          mostrarSplit ? W.splitTip(chApp.orders, chWeb.orders) : ''}`,
      }),
      kc({
        color: MC.ticket, icon: 'ticket', label: 'Ticket promedio', value: W.fmtMoney(curTicket),
        delta: isToday ? dRatio(curTicket, cmpTicket) : d(curTicket, W.ticket(prev.gmv, prev.orders)),
        sub: 'GMV ÷ pedidos',
      }),
      kc({
        color: MC.units, icon: 'box', label: 'Unidades por pedido', value: W.fmtDec(curUpo, 1),
        delta: isToday ? dRatio(curUpo, cmpUpo) : d(curUpo, W.unitsPerOrder(prev.units, prev.orders)),
        sub: `${W.fmtNumC(cur.units)} unidades en total`,
      }),
    ];

    const segmentos = bucket === 'all' ? W.SEGMENTS.map((sg) => {
        const c = cur.bySegment[sg], pv = prev.bySegment[sg] || { gmv: 0, orders: 0 };
        const bc = cur.byChannelSeg?.[sg];
        return kc({
          color: W.SEGMENT_COLOR[sg], icon: W.SEGMENT_ICON_NAME[sg],
          label: W.SEGMENT_LABEL[sg], value: W.fmtNumC(c.orders),
          share: cur.orders ? c.orders / cur.orders : 0,
          delta: d(c.orders, pv.orders),
          sub: W.fmtMoneyC(c.gmv),
          split: W.hasSplit(bc)
            ? `<div class="kc-s">${W.splitLabel(bc.app?.orders, bc.web?.orders)}</div>` : '',
          tip: `<strong>${W.esc(W.SEGMENT_LABEL[sg])}</strong>
            <span class="tip-row">${W.fmtNum(c.orders)} pedidos · ${W.fmtMoney(c.gmv)}</span>
            <span class="tip-row">${W.fmtPct(cur.orders ? c.orders / cur.orders : 0)} de los pedidos del período</span>${
            W.hasSplit(bc) ? W.splitTip(bc.app?.orders, bc.web?.orders) : ''}`,
        });
      }) : [];

    const apoyo = bucket === 'all' ? [
      kc({
        color: MC.clients, icon: 'users', label: 'Clientes activos', value: W.fmtNumC(cur.activeCustomers),
        delta: d(cur.activeCustomers, prev.activeCustomers),
        sub: isSingleDay ? 'compraron en el día' : 'suma de activos por día',
      }),
      kc({
        color: MC.fresh, icon: 'sparkles', label: 'Clientes nuevos', value: W.fmtNumC(cur.newCustomers),
        delta: d(cur.newCustomers, prev.newCustomers),
        sub: cur.activeCustomers ? `${W.fmtPct(cur.newCustomers / cur.activeCustomers)} de los activos` : '',
      }),
      kc({
        color: MC.discount, icon: 'tag', label: 'Descuentos', value: W.fmtMoneyC(cur.discount),
        delta: soloWeb ? null : d(cur.discount, prev.discount),
        chip: soloWeb ? (W.channel === 'app' ? 'sin dato' : 'solo Web') : null,
        sub: soloWeb ? 'App no informa descuentos'
          : (cur.gmv ? `${W.fmtPct(cur.discount / (cur.gmv + cur.discount))} del valor bruto` : ''),
      }),
      ...(canc.totalOrders ? [kc({
        color: canc.rate > 0.05 ? '#d03b3b' : '#898781', icon: 'ban',
        label: 'Cancelaciones', value: W.fmtPct(canc.rate),
        delta: cancPrev ? W.delta(canc.rate, cancPrev.rate) : null,
        sub: `${W.fmtNumC(canc.cancelledOrders)} pedidos · ${W.fmtMoneyC(canc.cancelledGmv)}`,
      })] : []),
      ...(mostrarSplit && cur.orders ? [kc({
        color: W.CHANNEL_COLOR.app, icon: 'bolt', label: 'Participación App',
        value: W.fmtPct(chApp.orders / cur.orders, 1),
        share: chApp.orders / cur.orders,
        sub: `${W.fmtNumC(chApp.orders)} de ${W.fmtNumC(cur.orders)} pedidos`,
      })] : []),
    ] : [];

    // ── LOS GRÁFICOS ────────────────────────────────────────────────────────
    // Todos visibles, en dos columnas. Antes estaban detrás de dos pestañas, y
    // una pestaña esconde la mitad de la pantalla a cambio de nada.
    const cardChart = (titulo, sub, contenido, extra = '') => `<div class="card">
      <div class="card-h"><div><h3>${titulo}</h3><p>${sub}</p></div>${extra}</div>
      ${contenido}
    </div>`;

    const graficoPrincipal = isSingleDay ? hourChart() : W.chart.line({
      labels, series: pedidosPorSeg, height: 250, yFmt: W.fmtNumC, id: 'ped-seg',
    });

    const donutItems = W.SEGMENTS
      .map((sg) => ({ label: W.SEGMENT_LABEL[sg], value: cur.bySegment[sg].orders, color: W.SEGMENT_COLOR[sg] }))
      .filter((it) => it.value > 0);

    el.innerHTML = `
      <div class="kgrid k4">${kcs.join('')}</div>
      ${segmentos.length ? `<div class="kgrid k4">${segmentos.join('')}</div>` : ''}
      ${apoyo.length ? `<div class="kgrid">${apoyo.join('')}</div>` : ''}

      <div class="cgrid side">
        ${cardChart(
          isSingleDay ? 'Pedidos acumulados por hora' : 'Pedidos por día',
          isSingleDay
            ? `${W.esc(rangeTxt)} · ${W.esc(scopeTxt)}${cmpHasHours ? ` · contra ${W.esc(cmpName)}, hora por hora` : ''}`
            : `por segmento de negocio · ${W.esc(scopeTxt)}`,
          graficoPrincipal,
          `<button class="btn" data-export="daily">${W.icon('download', 14)}XLSX</button>`)}
        ${cardChart('Distribución', `${W.esc(rangeTxt)} · pedidos por segmento`,
          donutItems.length
            ? W.chart.donut({ items: donutItems, size: 168, valueFmt: W.fmtNumC,
                centerLabel: 'pedidos', centerValue: W.fmtNumC(cur.orders) })
            : '<div class="chart-empty">Sin datos en el período.</div>')}
      </div>

      ${!isSingleDay ? `<div class="cgrid">
        ${haySinAtrib ? cardChart('Sin atribución por día', 'pedidos que llegan sin utm_source',
          W.chart.line({ labels, series: [{ name: 'Sin atribución', color: '#e34948', values: sinAtrib }],
            height: 200, yFmt: (v) => `${Math.round(v)}%`, id: 'sin-utm' }))
        : ''}
        ${hayCanalPorDia ? cardChart('Participación App vs. Web', '% de los pedidos de cada día',
          W.chart.line({ labels, series: partPorDia, height: 200, yFmt: (v) => `${Math.round(v)}%`, id: 'part-ch' }))
        : ''}
      </div>

      <div class="cgrid">
        ${cardChart('Ticket promedio por día', 'evolución del AOV',
          W.chart.line({ labels, series: [{ name: 'Ticket', color: MC.ticket, values: ticketPorDia }],
            height: 200, yFmt: W.fmtMoneyC, id: 'ticket-dia' }))}
        ${cardChart('Pedidos: actual vs. período anterior', `misma cantidad de días · ${W.esc(W.rangeText(prevRange))}`,
          W.chart.line({ labels,
            series: [
              { name: 'Período anterior', color: REF_GRAY, values: prevSerie },
              { name: 'Período actual', color: MC.orders, values: cur.series.map((r) => r.orders) },
            ], height: 200, yFmt: W.fmtNumC, id: 'vs-prev' }))}
      </div>

      <div class="cgrid">
        ${cardChart('Proyección de cierre de mes', `al ritmo de los primeros ${elapsed} de ${dim} días`,
          `<div class="proj">
            <div class="proj-main">
              <span class="proj-v">${W.fmtMoneyC(paceGmv)}</span>
              <span class="proj-l">GMV proyectado · ${W.fmtNumC(paceOrders)} pedidos</span>
              ${prevMonth.gmv > 0 ? `<span class="proj-c">${W.deltaBadge(W.delta(paceGmv, prevMonth.gmv))} vs. mes anterior cerrado (${W.fmtMoneyC(prevMonth.gmv)})</span>` : ''}
            </div>
            <div class="proj-bar">
              <div class="proj-f" style="width:${Math.min(100, (elapsed / dim) * 100)}%"></div>
              <span class="proj-bl">${W.fmtMoneyC(mtd.gmv)} acumulado · ${Math.round((elapsed / dim) * 100)}% del mes transcurrido</span>
            </div>
          </div>`)}
        ${cardChart('Mix de GMV por segmento', 'participación diaria',
          W.chart.stackedBars({ labels, series: mixSeries, height: 200, pct: true, yFmt: W.fmtMoneyC }))}
      </div>` : ''}

      ${hasHourly ? cardChart('Horarios pico',
        `pedidos por día de la semana y hora (AR) · ${W.esc(scopeTxt)}
         <span class="scope" ${W.chart.tip('Usa siempre los últimos 90 días completos, sin importar el rango elegido arriba: con rangos cortos podía tocarte un solo martes y la fila parecía vacía sin estarlo. Hoy queda afuera por ser un día a medio terminar.')}>${W.icon('info', 11)} últimos 90 días, sin hoy</span>`,
        W.chart.heatmap({
          rows: W.DOW_LABELS,
          cols: Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0')),
          matrix: dowHour, fmt: W.fmtNumC, showValues: false, legend: true,
          tipFmt: (r, c, v) => `<strong>${r} ${c}:00</strong><span class="tip-row"><b>${W.fmtNum(v)}</b> pedidos</span>`,
        })) : ''}

      ${insights.length ? `<div>
        <div class="sec-h"><h3>Qué está pasando</h3><span>lectura automática del período vs. el anterior</span></div>
        <div class="ins-g">${insights
          .map((i) => `<div class="ins ${i.kind}">${W.icon(i.kind === 'good' ? 'trend' : i.kind === 'bad' ? 'trendDown' : i.kind === 'warn' ? 'warn' : 'info', 16)}<div><h4>${W.esc(i.title)}</h4><p>${W.esc(i.text)}</p></div></div>`)
          .join('')}</div></div>` : ''}`;

  };
})();

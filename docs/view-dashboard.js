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
  let dashTab = 'evolucion'; // 'evolucion' | 'detalle'

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
  function hero({ label, value, exact, delta, deltaNote, chip, sub, spark, pace }) {
    return `<div class="hero">
      <div class="hero-t">
        <span class="hero-l">${W.esc(label)}</span>
        ${delta !== undefined && delta !== null ? W.deltaBadge(delta) : ''}
        ${chip ? `<span class="hero-chip">${chip}</span>` : ''}
      </div>
      <div class="hero-v"${exact ? ` ${W.chart.tip(exact)}` : ''}>${value}</div>
      ${deltaNote ? `<div class="hero-s">${deltaNote}</div>` : ''}
      ${sub ? `<div class="hero-s">${sub}</div>` : ''}
      ${pace ? `<div class="pace">
        <div class="pace-track"><div class="pace-fill" style="width:${pace.pct}%"></div></div>
        <span class="pace-l">${pace.label}</span>
      </div>` : ''}
      ${spark ? `<div class="hero-spark">${spark}</div>` : ''}
    </div>`;
  }

  /** Métrica primaria: valor grande, color pleno de la métrica como acento. */
  function tile({ rail, icon, label, value, sub, delta, chip, spark, tip }) {
    return `<div class="tile" style="--rail:${rail}"${tip ? ` ${W.chart.tip(tip)}` : ''}>
      <div class="tile-t">
        <span class="tile-ic">${W.icon(icon, 16)}</span>
        ${delta !== undefined && delta !== null ? W.deltaBadge(delta) : chip ? `<span class="delta flat">${chip}</span>` : ''}
      </div>
      <div class="tile-v">${value}</div>
      <div class="tile-l">${W.esc(label)}</div>
      ${sub ? `<div class="tile-s">${sub}</div>` : ''}
      ${spark ? `<div class="tile-spark">${spark}</div>` : ''}
    </div>`;
  }

  /** Un segmento con SU color, su volumen y cuánto pesa del total. */
  function segCard({ seg, orders, gmv, share, delta }) {
    const color = W.SEGMENT_COLOR[seg];
    return `<div class="segc" style="--rail:${color};--track:${color}22"
      ${W.chart.tip(`<strong>${W.esc(W.SEGMENT_LABEL[seg])}</strong><span class="tip-row">${W.fmtNum(orders)} pedidos</span><span class="tip-row">${W.fmtMoney(gmv)}</span><span class="tip-row">${W.fmtPct(share)} de los pedidos del período</span>`)}>
      <div class="segc-t">${W.icon(W.SEGMENT_ICON_NAME[seg], 13)}${W.esc(W.SEGMENT_LABEL[seg])}</div>
      <div class="segc-row">
        <span class="segc-v">${W.fmtNumC(orders)}</span>
        ${delta !== undefined && delta !== null ? W.deltaBadge(delta) : ''}
      </div>
      <div class="segc-s">${W.fmtMoneyC(gmv)} · ${W.fmtPct(share)} de los pedidos</div>
      <div class="segc-bar"><div class="segc-fill" style="width:${Math.min(100, share * 100)}%"></div></div>
    </div>`;
  }

  /** Métrica de apoyo: chica, gris, para consultar — no compite con el hero. */
  function mitem({ rail, label, value, sub, delta, tip }) {
    return `<div class="mitem"${tip ? ` ${W.chart.tip(tip)}` : ''}>
      <div class="mitem-l"><span class="mitem-dot" style="background:${rail}"></span>${W.esc(label)}</div>
      <div class="mitem-v">${value}${delta !== undefined && delta !== null ? W.deltaBadge(delta) : ''}</div>
      ${sub ? `<div class="mitem-s">${sub}</div>` : ''}
    </div>`;
  }

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
    const gmvs = cur.series.map((s) => s.gmv);

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
    const heroSpark = gmvs.length > 1 ? W.chart.sparkline(gmvs, 'rgba(255,255,255,.9)', 240, 46) : '';
    const cmpDayTotals = cmpDay ? W.sumRange(daily, bucket, { from: cmpDayDate, to: cmpDayDate }) : null;
    const heroBlock = hero({
      label: `GMV · ${rangeTxt}`,
      value: W.fmtMoneyC(cur.gmv),
      exact: `<strong>GMV exacto</strong><span class="tip-row">${W.fmtMoney(cur.gmv)}</span>`,
      delta: showDelta && !isToday ? W.delta(cur.gmv, prev.gmv) : null,
      chip: isToday ? partialChip : null,
      // Sin repetir las fechas del período de comparación: ya están arriba,
      // al lado del check de "Comparar".
      deltaNote: showDelta && !isToday ? `período anterior: <b>${W.fmtMoneyC(prev.gmv)}</b>` : '',
      sub: isToday && cmpDayTotals
        ? `${W.esc(cmpName)} cerró en <b>${W.fmtMoneyC(cmpDayTotals.gmv)}</b>`
        : `${W.fmtNumC(cur.orders)} pedidos · ticket ${W.fmtMoney(W.ticket(cur.gmv, cur.orders))}`,
      pace: isToday ? {
        pct: (hoursElapsed / 24) * 100,
        label: `${hoursElapsed} de 24 horas del día transcurridas`,
      } : null,
      spark: isToday ? '' : heroSpark,
    });

    // ── Métricas primarias ─────────────────────────────────────────────────
    const ordersDelta = isToday
      ? (showDelta && cmpOrdersToHour != null ? W.delta(cur.orders, cmpOrdersToHour) : null)
      : d(cur.orders, prev.orders);
    const ordersSub = isToday
      ? (cmpOrdersToHour != null
        ? `${W.esc(cmpName)} a esta hora: <b>${W.fmtNumC(cmpOrdersToHour)}</b>`
        : `sin dato horario de ${W.esc(cmpName)} para comparar`)
      : (showDelta ? `período anterior: <b>${W.fmtNumC(prev.orders)}</b>` : '');

    // Sparklines de las métricas de razón: se calculan día por día del rango.
    const ticketSeries = cur.series.map((s) => W.ticket(s.gmv, s.orders));
    const upoSeries = cur.series.map((s) => W.unitsPerOrder(s.units, s.orders));
    const curTicket = W.ticket(cur.gmv, cur.orders);
    const curUpo = W.unitsPerOrder(cur.units, cur.orders);
    const cmpTicket = cmpDayTotals ? W.ticket(cmpDayTotals.gmv, cmpDayTotals.orders) : null;
    const cmpUpo = cmpDayTotals ? W.unitsPerOrder(cmpDayTotals.units, cmpDayTotals.orders) : null;

    const tiles = [
      tile({
        rail: MC.orders, icon: 'orders', label: 'Pedidos', value: W.fmtNumC(cur.orders),
        delta: ordersDelta, chip: isToday && ordersDelta == null ? partialChip : null,
        sub: ordersSub,
        spark: orders.length > 1 ? W.chart.sparkline(orders, MC.orders) : '',
        tip: `<strong>Pedidos</strong><span class="tip-row">${W.fmtNum(cur.orders)} en el período</span>${
          isToday && cmpOrdersToHour != null ? `<span class="tip-row">Comparado contra ${W.esc(cmpName)} hasta las ${String(hoursElapsed - 1).padStart(2, '0')}:59, no contra su total del día</span>` : ''}`,
      }),
      tile({
        rail: MC.ticket, icon: 'ticket', label: 'Ticket promedio', value: W.fmtMoney(curTicket),
        delta: isToday ? dRatio(curTicket, cmpTicket) : d(curTicket, W.ticket(prev.gmv, prev.orders)),
        sub: isToday && cmpTicket
          ? `${W.esc(cmpName)}, día completo: <b>${W.fmtMoney(cmpTicket)}</b>`
          : 'GMV ÷ pedidos',
        spark: ticketSeries.length > 1 ? W.chart.sparkline(ticketSeries, MC.ticket) : '',
        tip: `<strong>Ticket promedio</strong><span class="tip-row">GMV dividido la cantidad de pedidos</span>${
          isToday ? '<span class="tip-row">Es un promedio, no un acumulado: se puede comparar contra el día de referencia aunque hoy no haya terminado.</span>' : ''}`,
      }),
      tile({
        rail: MC.units, icon: 'box', label: 'Unidades por pedido', value: W.fmtDec(curUpo, 1),
        delta: isToday ? dRatio(curUpo, cmpUpo) : d(curUpo, W.unitsPerOrder(prev.units, prev.orders)),
        sub: isToday && cmpUpo
          ? `${W.esc(cmpName)}, día completo: <b>${W.fmtDec(cmpUpo, 1)}</b>`
          : `${W.fmtNumC(cur.units)} unidades en total`,
        spark: upoSeries.length > 1 ? W.chart.sparkline(upoSeries, MC.units) : '',
        tip: '<strong>Tamaño de canasta</strong><span class="tip-row">Unidades totales dividido la cantidad de pedidos</span>',
      }),
    ];

    // ── Segmentos ──────────────────────────────────────────────────────────
    const segCards = bucket === 'all'
      ? W.SEGMENTS.map((s) => {
          const c = cur.bySegment[s], p = prev.bySegment[s] || { gmv: 0, orders: 0 };
          return segCard({
            seg: s, orders: c.orders, gmv: c.gmv,
            share: cur.orders ? c.orders / cur.orders : 0,
            delta: d(c.orders, p.orders),
          });
        })
      : [];

    // ── Métricas de apoyo ──────────────────────────────────────────────────
    const canc = W.cancellations(cur.statusStats);
    const cancPrev = showDelta && !isToday ? W.cancellations(prev.statusStats) : null;
    const support = bucket === 'all' ? [
      mitem({
        rail: MC.clients, label: 'Clientes activos', value: W.fmtNumC(cur.activeCustomers),
        delta: d(cur.activeCustomers, prev.activeCustomers),
        sub: isSingleDay ? 'compraron en el día' : 'suma de activos por día',
        tip: '<strong>Clientes activos</strong><span class="tip-row">Se suman los activos de cada día del rango: un cliente que compró dos días cuenta dos veces.</span>',
      }),
      mitem({
        rail: MC.fresh, label: 'Clientes nuevos', value: W.fmtNumC(cur.newCustomers),
        delta: d(cur.newCustomers, prev.newCustomers),
        sub: cur.activeCustomers ? `${W.fmtPct(cur.newCustomers / cur.activeCustomers)} de los activos` : '',
        tip: isToday
          ? '<strong>Clientes nuevos</strong><span class="tip-row">En el día en curso este número lo completa la corrida del pipeline: el dato en vivo no cruza contra todo el historial de clientes.</span>'
          : '<strong>Clientes nuevos</strong><span class="tip-row">Primera compra registrada dentro del período.</span>',
      }),
      mitem({
        rail: MC.discount, label: 'Descuentos', value: W.fmtMoneyC(cur.discount),
        delta: d(cur.discount, prev.discount),
        sub: cur.gmv ? `${W.fmtPct(cur.discount / (cur.gmv + cur.discount))} del valor bruto` : '',
        tip: '<strong>Descuentos</strong><span class="tip-row">Total descontado (cupones y promociones) sobre el valor bruto del período.</span>',
      }),
      ...(canc.totalOrders ? [mitem({
        rail: canc.rate > 0.05 ? 'var(--neg)' : 'var(--ink-4)',
        label: 'Cancelaciones', value: W.fmtPct(canc.rate),
        delta: cancPrev ? W.delta(canc.rate, cancPrev.rate) : null,
        sub: `${W.fmtNumC(canc.cancelledOrders)} pedidos · ${W.fmtMoneyC(canc.cancelledGmv)}`,
        tip: `<strong>Cancelaciones</strong><span class="tip-row">${W.fmtNum(canc.cancelledOrders)} de ${W.fmtNum(canc.totalOrders)} pedidos del período</span><span class="tip-row">No se cuentan en GMV ni en pedidos</span>`,
      })] : []),
    ] : [];

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

    const dayChart = () => {
      const reg = W.linreg(orders); // una sola vez, no por punto
      return W.chart.line({
        labels,
        series: [
          { name: 'Pedidos', color: MC.orders, values: orders, fill: true },
          { name: 'Media móvil 7d', color: MC.ticket, values: W.movingAvg(orders, 7) },
          { name: 'Tendencia', color: REF_GRAY, values: orders.map((_, i) => Math.max(0, reg.at(i))), dashed: true },
        ],
        height: 260,
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

    const evolucionTab = `
      <div class="card">
        <div class="card-h">
          <div><h3>${isSingleDay ? 'Pedidos acumulados por hora' : 'Pedidos por día'}</h3>
            <p>${isSingleDay
              ? `${W.esc(rangeTxt)} · ${W.esc(scopeTxt)}${cmpHasHours ? ` · contra ${W.esc(cmpName)}, hora por hora` : ''}`
              : `${W.fmtDayLong(range.from)} → ${W.fmtDayLong(range.to)} · ${W.esc(scopeTxt)}`}</p></div>
          <button class="btn" data-export="daily">${W.icon('download', 14)}XLSX</button>
        </div>
        ${isSingleDay ? hourChart() : dayChart()}
      </div>

      ${insights.length ? `<div>
        <div class="sec-h"><h3>Qué está pasando</h3><span>lectura automática del período vs. el anterior</span></div>
        <div class="ins-g">${insights
          .map((i) => `<div class="ins ${i.kind}">${W.icon(i.kind === 'good' ? 'trend' : i.kind === 'bad' ? 'trendDown' : i.kind === 'warn' ? 'warn' : 'info', 16)}<div><h4>${W.esc(i.title)}</h4><p>${W.esc(i.text)}</p></div></div>`)
          .join('')}</div></div>` : ''}`;

    const detalleTab = `
      <div class="g2">
        <div class="card">
          <div class="card-h"><div><h3>Proyección de cierre de mes</h3><p>al ritmo de los primeros ${elapsed} de ${dim} días</p></div></div>
          <div class="proj">
            <div class="proj-main">
              <span class="proj-v">${W.fmtMoneyC(paceGmv)}</span>
              <span class="proj-l">GMV proyectado · ${W.fmtNumC(paceOrders)} pedidos</span>
              ${prevMonth.gmv > 0 ? `<span class="proj-c">${W.deltaBadge(W.delta(paceGmv, prevMonth.gmv))} vs. mes anterior cerrado (${W.fmtMoneyC(prevMonth.gmv)})</span>` : ''}
            </div>
            <div class="proj-bar">
              <div class="proj-f" style="width:${Math.min(100, (elapsed / dim) * 100)}%"></div>
              <span class="proj-bl">${W.fmtMoneyC(mtd.gmv)} acumulado · ${Math.round((elapsed / dim) * 100)}% del mes transcurrido</span>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-h"><div><h3>Mix de GMV por segmento</h3><p>participación diaria</p></div></div>
          ${W.chart.stackedBars({ labels, series: mixSeries, height: 200, pct: true, yFmt: W.fmtMoneyC })}
        </div>
      </div>

      ${hasHourly ? `<div class="card">
        <div class="card-h"><div><h3>Horarios pico</h3><p>pedidos por día de la semana y hora (AR) · ${W.esc(scopeTxt)} — dónde conviene disparar campañas
          <span class="scope" ${W.chart.tip('Usa siempre los últimos 90 días completos, sin importar el rango elegido arriba: con rangos cortos podía tocarte un solo martes (o ninguno, si era justo hoy) y la fila de "martes" parecía vacía sin estarlo. Hoy queda afuera por ser un día a medio terminar.')}>${W.icon('info', 11)} últimos 90 días, sin hoy</span></p></div></div>
        ${W.chart.heatmap({
          rows: W.DOW_LABELS,
          cols: Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0')),
          matrix: dowHour,
          fmt: W.fmtNumC,
          showValues: false,
          legend: true,
          tipFmt: (r, c, v) => `<strong>${r} ${c}:00</strong><span class="tip-row"><b>${W.fmtNum(v)}</b> pedidos</span>`,
        })}
      </div>` : ''}`;

    el.innerHTML = `
      <div class="dash-hero">${heroBlock}${tiles.join('')}</div>

      ${segCards.length ? `<div class="sec-h"><h3>Por segmento</h3><span>${W.esc(rangeTxt)} · participación sobre los pedidos del período</span></div>
        <div class="segs">${segCards.join('')}</div>` : ''}

      ${support.length ? `<div class="mstrip">${support.join('')}</div>` : ''}

      <div class="seg-ctl" style="margin-bottom:.9rem;width:max-content">
        <button data-dashtab="evolucion" class="${dashTab === 'evolucion' ? 'on' : ''}">Evolución</button>
        <button data-dashtab="detalle" class="${dashTab === 'detalle' ? 'on' : ''}">Proyección y mix</button>
      </div>

      ${dashTab === 'evolucion' ? evolucionTab : detalleTab}`;

    document.querySelectorAll('[data-dashtab]').forEach((b) =>
      b.addEventListener('click', () => { dashTab = b.dataset.dashtab; W.render(); }));
  };
})();

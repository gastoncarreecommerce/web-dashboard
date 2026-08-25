/* global window, document */
/** Vista "Dashboard": resumen ejecutivo del canal web con proyección e insights. */
(function () {
  const W = (window.W = window.W || {});

  function kpi({ icon, label, value, sub, delta, spark, color, tip }) {
    return `<div class="kpi"${tip ? ` ${W.chart.tip(tip)}` : ''}>
      <div class="kpi-t">
        <span class="kpi-ic" style="background:${color}14;color:${color}">${W.icon(icon, 16)}</span>
        ${delta !== undefined ? W.deltaBadge(delta) : ''}
      </div>
      <div class="kpi-v">${value}</div>
      <div class="kpi-l">${W.esc(label)}</div>
      ${sub ? `<div class="kpi-s">${sub}</div>` : ''}
      ${spark ? `<div class="kpi-spark">${spark}</div>` : ''}
    </div>`;
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
        out.push({ kind: 'bad', title: 'Caída de GMV', text: `GMV ${W.fmtPct(dGmv)} vs. el período anterior. Mirá el mix por segmento y el detalle de fuentes de marketing para aislar de dónde viene.` });
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
    const showDelta = compare ? undefined : null;

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

    const cmp = compare ? prev : null;
    const d = (a, b) => (cmp ? W.delta(a, b) : undefined);

    const color = bucket === 'all' ? '#2a78d6' : W.SEGMENT_COLOR[bucket];
    const icon = bucket === 'all' ? 'globe' : W.SEGMENT_ICON_NAME[bucket];

    const tiles = [
      kpi({ icon, label: 'Pedidos', value: W.fmtNumC(cur.orders), delta: d(cur.orders, prev.orders), color,
        spark: W.chart.sparkline(orders, color), tip: `<strong>Pedidos</strong><span class="tip-row">${W.fmtNum(cur.orders)} en el período</span>` }),
      kpi({ icon: 'money', label: 'GMV', value: W.fmtMoneyC(cur.gmv), delta: d(cur.gmv, prev.gmv), color: '#1baf7a',
        spark: W.chart.sparkline(gmvs, '#1baf7a'), tip: `<strong>GMV</strong><span class="tip-row">${W.fmtMoney(cur.gmv)}</span>` }),
      kpi({ icon: 'ticket', label: 'Ticket promedio', value: W.fmtMoney(W.ticket(cur.gmv, cur.orders)),
        delta: d(W.ticket(cur.gmv, cur.orders), W.ticket(prev.gmv, prev.orders)), color: '#eb6834', sub: 'GMV / pedidos' }),
      kpi({ icon: 'box', label: 'Unidades por pedido', value: W.fmtDec(W.unitsPerOrder(cur.units, cur.orders), 1),
        delta: d(W.unitsPerOrder(cur.units, cur.orders), W.unitsPerOrder(prev.units, prev.orders)), color: '#4a3aa7', sub: 'tamaño de canasta' }),
    ];

    if (bucket === 'all') {
      tiles.push(
        kpi({ icon: 'users', label: 'Clientes activos', value: W.fmtNumC(cur.activeCustomers),
          delta: d(cur.activeCustomers, prev.activeCustomers), color: '#e87ba4', sub: 'suma de activos por día' }),
        kpi({ icon: 'sparkles', label: 'Clientes nuevos', value: W.fmtNumC(cur.newCustomers),
          delta: d(cur.newCustomers, prev.newCustomers), color: '#eda100',
          spark: W.chart.sparkline(cur.series.map((s) => s.newCustomers), '#eda100'),
          sub: cur.activeCustomers ? `${W.fmtPct(cur.newCustomers / cur.activeCustomers)} de los activos` : '' }),
        kpi({ icon: 'tag', label: 'Descuentos', value: W.fmtMoneyC(cur.discount), delta: d(cur.discount, prev.discount),
          color: '#e34948', sub: cur.gmv ? `${W.fmtPct(cur.discount / (cur.gmv + cur.discount))} del valor bruto` : '' })
      );

      // Las cancelaciones NO entran en las métricas de negocio, pero se miden
      // igual: salen del listado de VTEX, sin costo extra de llamadas.
      const canc = W.cancellations(cur.statusStats);
      const cancPrev = cmp ? W.cancellations(prev.statusStats) : null;
      if (canc.totalOrders) {
        tiles.push(kpi({
          icon: 'ban', label: 'Cancelaciones', value: W.fmtPct(canc.rate),
          delta: cmp ? W.delta(canc.rate, cancPrev.rate) : undefined,
          color: '#e34948',
          sub: `${W.fmtNumC(canc.cancelledOrders)} pedidos · ${W.fmtMoneyC(canc.cancelledGmv)} no facturados`,
          tip: `<strong>Cancelaciones</strong><span class="tip-row">${W.fmtNum(canc.cancelledOrders)} de ${W.fmtNum(canc.totalOrders)} pedidos del período</span><span class="tip-row">No se cuentan en GMV ni pedidos</span>`,
        }));
      }
    }

    // ── Serie principal: pedidos + media móvil + proyección ─────────────────
    const ma = W.movingAvg(orders, 7);
    const reg = W.linreg(orders);
    const trend = orders.map((_, i) => Math.max(0, reg.at(i)));

    const mainSeries = [
      { name: 'Pedidos', color, values: orders, fill: true },
      { name: 'Media móvil 7d', color: '#eb6834', values: ma },
      { name: 'Tendencia', color: '#898781', values: trend, dashed: true },
    ];

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
    const dowHour = Array.from({ length: 7 }, () => new Array(24).fill(0));
    let hasHourly = false;
    for (const day of daily.days) {
      if (day.date < range.from || day.date > range.to || !day.hourly) continue;
      hasHourly = true;
      const dow = new Date(`${day.date}T12:00:00Z`).getUTCDay();
      day.hourly.forEach((n, h) => (dowHour[dow][h] += n));
    }

    // ── Fuentes de marketing ────────────────────────────────────────────────
    const mkRows = Object.entries(cur.marketing).sort((a, b) => b[1].gmv - a[1].gmv);
    const mkTotal = mkRows.reduce((s, [, v]) => s + v.gmv, 0);
    ctx.exports.marketing = {
      filename: `webdash-marketing-${range.from}_${range.to}.csv`,
      headers: ['fuente', 'pedidos', 'gmv', 'ticket', 'share_gmv'],
      rows: mkRows.map(([k, v]) => [k, v.orders, Math.round(v.gmv), Math.round(W.ticket(v.gmv, v.orders)), (v.gmv / (mkTotal || 1)).toFixed(4)]),
    };
    ctx.exports.daily = {
      filename: `webdash-diario-${bucket}-${range.from}_${range.to}.csv`,
      headers: ['fecha', 'pedidos', 'gmv', 'unidades', 'ticket'],
      rows: cur.series.map((s) => [s.date, s.orders, Math.round(s.gmv), Math.round(s.units), Math.round(W.ticket(s.gmv, s.orders))]),
    };

    const insights = compare ? buildInsights(cur, prev, range, daily, catalog, bucket) : [];

    el.innerHTML = `
      <div class="kpis">${tiles.join('')}</div>

      ${insights.length ? `<div>
        <div class="ins-h"><h3>Qué está pasando</h3><span>lectura automática del período vs. el anterior</span></div>
        <div class="ins-g">${insights
          .map((i) => `<div class="ins ${i.kind}">${W.icon(i.kind === 'good' ? 'trend' : i.kind === 'bad' ? 'trendDown' : i.kind === 'warn' ? 'warn' : 'info', 16)}<div><h4>${W.esc(i.title)}</h4><p>${W.esc(i.text)}</p></div></div>`)
          .join('')}</div></div>` : ''}

      <div class="card">
        <div class="card-h">
          <div><h3>Pedidos por día</h3><p>${W.fmtDayLong(range.from)} → ${W.fmtDayLong(range.to)} · ${bucket === 'all' ? 'todos los segmentos' : W.SEGMENT_LABEL[bucket]}</p></div>
          <button class="btn" data-export="daily">${W.icon("download",14)}CSV</button>
        </div>
        ${W.chart.line({ labels, series: mainSeries, height: 260 })}
      </div>

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

      ${hasHourly && bucket === 'all' ? `<div class="card">
        <div class="card-h"><div><h3>Cuándo compran</h3><p>pedidos por día de la semana y hora (AR) — dónde conviene disparar campañas</p></div></div>
        ${W.chart.heatmap({
          rows: W.DOW_LABELS,
          cols: Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0')),
          matrix: dowHour,
          fmt: W.fmtNumC,
          tipFmt: (r, c, v) => `<strong>${r} ${c}:00</strong><span class="tip-row"><b>${W.fmtNum(v)}</b> pedidos</span>`,
        })}
      </div>` : ''}

      <div class="card">
        <div class="card-h">
          <div><h3>Fuentes de marketing</h3><p>atribución por utmSource de VTEX</p></div>
          <button class="btn" data-export="marketing">${W.icon("download",14)}CSV</button>
        </div>
        <table class="tbl">
          <thead><tr><th>Fuente</th><th class="num">Pedidos</th><th class="num">GMV</th><th class="num">Ticket</th><th style="width:26%">% GMV</th></tr></thead>
          <tbody>${mkRows.length ? mkRows.map(([k, v]) => `<tr>
              <td>${W.esc(k)}</td>
              <td class="num">${W.fmtNum(v.orders)}</td>
              <td class="num">${W.fmtMoney(v.gmv)}</td>
              <td class="num">${W.fmtMoney(W.ticket(v.gmv, v.orders))}</td>
              <td><div class="barcell"><span class="bartrack"><span class="barfill" style="width:${(v.gmv / (mkTotal || 1)) * 100}%"></span></span><b>${W.fmtPct(v.gmv / (mkTotal || 1))}</b></div></td>
            </tr>`).join('') : '<tr><td colspan="5" class="muted">Sin datos en este rango</td></tr>'}</tbody>
        </table>
      </div>`;
  };
})();

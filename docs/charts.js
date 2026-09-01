/* global window, document */
/**
 * Gráficos en SVG inline, sin librerías externas.
 *
 * Todas las funciones devuelven un string de HTML. Los elementos con
 * `data-tip` muestran un tooltip flotante manejado por el listener delegado
 * de abajo (se registra una sola vez para toda la página).
 */
(function () {
  const W = (window.W = window.W || {});
  const C = (W.chart = {});

  const AXIS = 'var(--ink-3)';
  const GRID = 'var(--grid)';

  // ── Tooltip global delegado ───────────────────────────────────────────────
  let tipEl = null;
  function ensureTip() {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'chart-tip';
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }
  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest?.('[data-tip]');
    if (!t) return;
    const el = ensureTip();
    el.innerHTML = t.getAttribute('data-tip');
    el.classList.add('show');
  });
  document.addEventListener('mousemove', (e) => {
    if (!tipEl || !tipEl.classList.contains('show')) return;
    const pad = 14;
    const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    let x = e.clientX + pad, y = e.clientY + pad;
    if (x + w > window.innerWidth - 8) x = e.clientX - w - pad;
    if (y + h > window.innerHeight - 8) y = e.clientY - h - pad;
    tipEl.style.left = `${x}px`;
    tipEl.style.top = `${y}px`;
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target.closest?.('[data-tip]') && tipEl) tipEl.classList.remove('show');
  });

  const attr = (s) => String(s).replace(/"/g, '&quot;');
  C.tip = (html) => `data-tip="${attr(html)}"`;

  function niceMax(v) {
    if (v <= 0) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / mag;
    const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return step * mag;
  }
  C.niceMax = niceMax;

  // ── Rampa secuencial (azul, de palette.md) ────────────────────────────────
  const RAMP = ['#eef5fe', '#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
  C.rampColor = function (t) {
    if (!isFinite(t)) return RAMP[0];
    const x = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
    return RAMP[Math.round(x)];
  };

  /**
   * Gráfico de líneas con grilla, etiquetas y crosshair al pasar el mouse.
   * series: [{ name, color, values: number[], dashed?: bool }]
   */
  C.line = function ({ labels, series, height = 240, yFmt = W.fmtNumC, id = 'line' }) {
    if (!labels.length) return '<div class="chart-empty">Sin datos en este rango.</div>';
    if (labels.length < 2) return '<div class="chart-empty">Seleccioná un rango de más de un día para ver la evolución.</div>';

    const w = 900, h = height, padL = 52, padR = 14, padT = 12, padB = 30;
    const maxV = niceMax(Math.max(1, ...series.flatMap((s) => s.values.filter((v) => v != null))));
    const x = (i) => padL + (i * (w - padL - padR)) / (labels.length - 1);
    const y = (v) => padT + (h - padT - padB) * (1 - v / maxV);

    const grid = [0, 0.25, 0.5, 0.75, 1]
      .map((f) => {
        const gy = padT + (h - padT - padB) * (1 - f);
        return `<line x1="${padL}" x2="${w - padR}" y1="${gy}" y2="${gy}" stroke="${GRID}" stroke-width="1"/>
                <text x="${padL - 8}" y="${gy + 3.5}" text-anchor="end" fill="${AXIS}" font-size="10">${yFmt(maxV * f)}</text>`;
      })
      .join('');

    const step = Math.max(1, Math.ceil(labels.length / 8));
    const xLabels = labels
      .map((l, i) => (i % step === 0 || i === labels.length - 1
        ? `<text x="${x(i)}" y="${h - 9}" text-anchor="middle" fill="${AXIS}" font-size="10">${W.fmtDay(l)}</text>` : ''))
      .join('');

    const paths = series
      .map((s) => {
        const pts = s.values.map((v, i) => (v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean).join(' ');
        const area = s.fill
          ? `<polygon points="${padL},${y(0)} ${pts} ${x(s.values.length - 1)},${y(0)}" fill="${s.color}" opacity="0.08"/>`
          : '';
        return `${area}<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2"
                  stroke-linejoin="round" stroke-linecap="round"${s.dashed ? ' stroke-dasharray="5 4"' : ''}/>`;
      })
      .join('');

    // Bandas invisibles: capturan el hover de toda la columna, no solo del punto.
    const bandW = (w - padL - padR) / Math.max(1, labels.length - 1);
    const bands = labels
      .map((l, i) => {
        const rows = series
          .filter((s) => s.values[i] != null)
          .map((s) => `<span class="tip-row"><i style="background:${s.color}"></i>${W.esc(s.name)} <b>${s.tipFmt ? s.tipFmt(s.values[i]) : yFmt(s.values[i])}</b></span>`)
          .join('');
        const dots = series
          .filter((s) => s.values[i] != null)
          .map((s) => `<circle cx="${x(i)}" cy="${y(s.values[i])}" r="3.5" fill="${s.color}" stroke="var(--surface)" stroke-width="1.5"/>`)
          .join('');
        return `<g class="lc-band">
            <rect x="${x(i) - bandW / 2}" y="${padT}" width="${bandW}" height="${h - padT - padB}" fill="transparent"
              ${C.tip(`<strong>${W.fmtDayLong(l)}</strong>${rows}`)}/>
            <g class="lc-hover"><line x1="${x(i)}" x2="${x(i)}" y1="${padT}" y2="${h - padB}" stroke="${AXIS}" stroke-width="1" stroke-dasharray="3 3"/>${dots}</g>
          </g>`;
      })
      .join('');

    const legend = series.length > 1
      ? `<div class="legend">${series
          .map((s) => `<span class="lg"><i style="background:${s.color}${s.dashed ? ';opacity:.55' : ''}"></i>${W.esc(s.name)}</span>`)
          .join('')}</div>`
      : '';

    return `${legend}<svg class="chart" id="${id}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img">
      ${grid}${paths}${xLabels}${bands}</svg>`;
  };

  /** Barras verticales apiladas (mix por segmento a lo largo del tiempo). */
  C.stackedBars = function ({ labels, series, height = 240, yFmt = W.fmtNumC, pct = false }) {
    if (!labels.length) return '<div class="chart-empty">Sin datos en este rango.</div>';
    const w = 900, h = height, padL = 52, padR = 14, padT = 12, padB = 30;
    const totals = labels.map((_, i) => series.reduce((s, ser) => s + (ser.values[i] || 0), 0));
    const maxV = pct ? 1 : niceMax(Math.max(1, ...totals));
    const innerW = w - padL - padR;
    const bw = Math.max(1, (innerW / labels.length) * 0.72);
    const x = (i) => padL + (i + 0.5) * (innerW / labels.length);
    const y = (v) => padT + (h - padT - padB) * (1 - v / maxV);

    const grid = [0, 0.5, 1]
      .map((f) => {
        const gy = padT + (h - padT - padB) * (1 - f);
        return `<line x1="${padL}" x2="${w - padR}" y1="${gy}" y2="${gy}" stroke="${GRID}"/>
                <text x="${padL - 8}" y="${gy + 3.5}" text-anchor="end" fill="${AXIS}" font-size="10">${pct ? `${Math.round(f * 100)}%` : yFmt(maxV * f)}</text>`;
      })
      .join('');

    const bars = labels
      .map((l, i) => {
        const total = totals[i] || 1;
        let acc = 0;
        const rows = series
          .map((s) => `<span class="tip-row"><i style="background:${s.color}"></i>${W.esc(s.name)} <b>${yFmt(s.values[i] || 0)}</b> (${W.fmtPct((s.values[i] || 0) / total)})</span>`)
          .join('');
        const segs = series
          .map((s) => {
            const v = pct ? (s.values[i] || 0) / total : s.values[i] || 0;
            if (v <= 0) return '';
            const yTop = y(acc + v), hh = Math.max(0, y(acc) - y(acc + v) - 2);
            acc += v;
            return `<rect x="${x(i) - bw / 2}" y="${yTop}" width="${bw}" height="${hh}" fill="${s.color}" rx="2"/>`;
          })
          .join('');
        return `<g ${C.tip(`<strong>${W.fmtDayLong(l)}</strong>${rows}`)}>
            <rect x="${x(i) - (innerW / labels.length) / 2}" y="${padT}" width="${innerW / labels.length}" height="${h - padT - padB}" fill="transparent"/>
            ${segs}</g>`;
      })
      .join('');

    const step = Math.max(1, Math.ceil(labels.length / 8));
    const xLabels = labels
      .map((l, i) => (i % step === 0 || i === labels.length - 1
        ? `<text x="${x(i)}" y="${h - 9}" text-anchor="middle" fill="${AXIS}" font-size="10">${W.fmtDay(l)}</text>` : ''))
      .join('');

    const legend = `<div class="legend">${series.map((s) => `<span class="lg"><i style="background:${s.color}"></i>${W.esc(s.name)}</span>`).join('')}</div>`;
    return `${legend}<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img">${grid}${bars}${xLabels}</svg>`;
  };

  /** Barras horizontales (pareto de productos, categorías, cupones…). */
  // r.img (opcional, URL ya resuelta) agrega una miniatura antes del label —
  // hoy solo lo usa el ranking de productos de Analítica.
  C.barsH = function ({ items, valueFmt = W.fmtMoneyC, color = 'var(--s1)', maxRows = 20, showRank = true }) {
    const rows = items.slice(0, maxRows);
    if (!rows.length) return '<div class="chart-empty">Sin datos en este rango.</div>';
    const max = Math.max(...rows.map((r) => r.value), 1);
    return `<div class="barsh">${rows
      .map((r, i) => `
        <div class="barsh-row${r.img !== undefined ? ' has-img' : ''}" ${C.tip(`<strong>${W.esc(r.label)}</strong><span class="tip-row">${W.esc(r.sub || '')} <b>${valueFmt(r.value)}</b></span>`)}>
          ${showRank ? `<span class="barsh-rank">${i + 1}</span>` : ''}
          ${r.img !== undefined ? (r.img ? `<img class="barsh-img" src="${r.img}" alt="" loading="lazy" />` : `<span class="barsh-img barsh-img-ph">${W.icon('box', 14)}</span>`) : ''}
          <span class="barsh-label">${W.esc(r.label)}</span>
          <span class="barsh-track"><span class="barsh-fill" style="width:${(r.value / max) * 100}%;background:${r.color || color}"></span></span>
          <span class="barsh-value">${valueFmt(r.value)}</span>
        </div>`)
      .join('')}</div>`;
  };

  /**
   * Heatmap genérico (cohortes, hora × día de semana, grilla RFM).
   * matrix[r][c] = número | null. `fmt` formatea el valor de la celda.
   */
  // showValues=false da el estilo "mapa de calor" limpio (solo color, el
  // número sale en el tooltip) — mejor para matrices grandes tipo hora × día
  // de semana (168 celdas), donde un número en cada celda es puro ruido
  // visual. Las cohortes (pocas celdas, cada una importa) siguen mostrando
  // el valor adentro por default.
  C.heatmap = function ({ rows, cols, matrix, fmt = W.fmtNum, tipFmt, rowSub, cellPct = false, showValues = true, legend = false }) {
    if (!rows.length || !cols.length) return '<div class="chart-empty">Sin datos suficientes.</div>';
    let max = 0;
    for (const r of matrix) for (const v of r) if (v != null && v > max) max = v;

    const head = `<tr><th class="hm-corner"></th>${cols.map((c) => `<th>${W.esc(c)}</th>`).join('')}</tr>`;
    const body = rows
      .map((rLabel, ri) => {
        const cells = cols
          .map((cLabel, ci) => {
            const v = matrix[ri]?.[ci];
            if (v == null) return '<td class="hm-null"></td>';
            // En una matriz de cohortes la columna 0 puede estar vacía (la cohorte
            // nace más tarde): el denominador es el primer valor real de la fila,
            // que es el tamaño de la cohorte en su mes de nacimiento.
            const base = cellPct ? (matrix[ri].find((x) => x != null) || 1) : max;
            const t = base ? v / base : 0;
            const bg = C.rampColor(t);
            const dark = t > 0.55;
            const tip = tipFmt ? tipFmt(rLabel, cLabel, v, t) : `<strong>${W.esc(rLabel)} → ${W.esc(cLabel)}</strong><span class="tip-row">${fmt(v)}</span>`;
            const label = cellPct ? W.fmtPct(t, 0) : fmt(v);
            return `<td class="hm-cell" style="background:${bg};color:${dark ? '#fff' : 'var(--ink)'}" ${C.tip(tip)}>${showValues ? label : ''}</td>`;
          })
          .join('');
        return `<tr><th class="hm-row">${W.esc(rLabel)}${rowSub ? `<span>${W.esc(rowSub[ri] || '')}</span>` : ''}</th>${cells}</tr>`;
      })
      .join('');

    return `<div class="hm-wrap"><table class="heatmap${showValues ? '' : ' hm-clean'}"><thead>${head}</thead><tbody>${body}</tbody></table></div>
      ${legend ? `<div class="maplegend hm-legend"><span>Menos</span><i style="background:linear-gradient(90deg, ${C.rampColor(.1)}, ${C.rampColor(1)})"></i><span>Más (máx ${fmt(max)})</span></div>` : ''}`;
  };

  /** Donut para participación (medios de pago, mix de segmentos). */
  C.donut = function ({ items, size = 190, valueFmt = W.fmtMoneyC, centerLabel, centerValue }) {
    const total = items.reduce((s, i) => s + i.value, 0);
    if (!total) return '<div class="chart-empty">Sin datos en este rango.</div>';
    const r = size / 2, ir = r * 0.62;
    let angle = -Math.PI / 2;
    const arcs = items
      .map((it) => {
        const frac = it.value / total;
        const a0 = angle, a1 = angle + frac * Math.PI * 2;
        angle = a1;
        const large = a1 - a0 > Math.PI ? 1 : 0;
        const p = (rad, ang) => `${(r + rad * Math.cos(ang)).toFixed(2)},${(r + rad * Math.sin(ang)).toFixed(2)}`;
        // Un círculo completo no se puede dibujar con un solo arco: se cierra el anillo.
        if (frac >= 0.9999) {
          return `<circle cx="${r}" cy="${r}" r="${(r + ir) / 2}" fill="none" stroke="${it.color}" stroke-width="${r - ir}"
                    ${C.tip(`<strong>${W.esc(it.label)}</strong><span class="tip-row"><b>${valueFmt(it.value)}</b> (100%)</span>`)}/>`;
        }
        return `<path d="M ${p(r, a0)} A ${r} ${r} 0 ${large} 1 ${p(r, a1)} L ${p(ir, a1)} A ${ir} ${ir} 0 ${large} 0 ${p(ir, a0)} Z"
                  fill="${it.color}" stroke="var(--surface)" stroke-width="2"
                  ${C.tip(`<strong>${W.esc(it.label)}</strong><span class="tip-row"><b>${valueFmt(it.value)}</b> (${W.fmtPct(frac)})</span>`)}/>`;
      })
      .join('');

    return `<div class="donut-wrap">
      <svg class="donut" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img">
        ${arcs}
        ${centerValue ? `<text x="${r}" y="${r - 2}" text-anchor="middle" font-size="19" font-weight="700" fill="var(--ink)">${W.esc(centerValue)}</text>` : ''}
        ${centerLabel ? `<text x="${r}" y="${r + 16}" text-anchor="middle" font-size="10.5" fill="var(--ink-3)">${W.esc(centerLabel)}</text>` : ''}
      </svg>
      <div class="donut-legend">${items
        .map((i) => `<div class="dl"><i style="background:${i.color}"></i><span>${W.esc(i.label)}</span><b>${W.fmtPct(i.value / total)}</b></div>`)
        .join('')}</div>
    </div>`;
  };

  /** Sparkline para las tiles de KPI. */
  C.sparkline = function (values, color = 'var(--s1)', w = 110, h = 30) {
    if (!values || values.length < 2) return '';
    const max = Math.max(...values), min = Math.min(...values);
    const span = max - min || 1;
    const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - ((v - min) / span) * (h - 4) - 2).toFixed(1)}`).join(' ');
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <polygon points="0,${h} ${pts} ${w},${h}" fill="${color}" opacity="0.10"/>
      <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>`;
  };

  /** Embudo (pedidos → clientes → recompradores). */
  C.funnel = function ({ steps }) {
    const max = Math.max(...steps.map((s) => s.value), 1);
    return `<div class="funnel">${steps
      .map((s, i) => {
        const prev = i > 0 ? steps[i - 1].value : null;
        const conv = prev ? s.value / prev : null;
        return `<div class="funnel-step" ${C.tip(`<strong>${W.esc(s.label)}</strong><span class="tip-row"><b>${W.fmtNum(s.value)}</b></span>`)}>
          <div class="funnel-bar" style="width:${(s.value / max) * 100}%;background:${s.color || W.SERIES[i % W.SERIES.length]}"></div>
          <div class="funnel-meta"><span>${W.esc(s.label)}</span><b>${W.fmtNum(s.value)}</b>
            ${conv != null ? `<em>${W.fmtPct(conv)} del paso anterior</em>` : ''}</div>
        </div>`;
      })
      .join('')}</div>`;
  };
})();

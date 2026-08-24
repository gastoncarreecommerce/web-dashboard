(function () {
  const CHANNEL = 'web';
  const SEGMENTS = ['food', 'non-food', 'marketplace', 'quickcommerce'];
  const SEGMENT_ICON = { food: '🥦', 'non-food': '🏠', marketplace: '🛒', quickcommerce: '⚡' };
  const SEGMENT_SLOT = { food: '--slot-food', 'non-food': '--slot-nonfood', marketplace: '--slot-marketplace', quickcommerce: '--slot-quick' };
  const SEGMENT_SLOT_SOFT = { food: '--slot-food-soft', 'non-food': '--slot-nonfood-soft', marketplace: '--slot-marketplace-soft', quickcommerce: '--slot-quick-soft' };

  const content = document.getElementById('content');
  const rangeLabelEl = document.getElementById('range-label');
  const compareLabelEl = document.getElementById('compare-label');
  const compareToggle = document.getElementById('compare-toggle');
  const dateFromEl = document.getElementById('date-from');
  const dateToEl = document.getElementById('date-to');
  const presetBtns = document.querySelectorAll('.preset');
  const tabBtns = document.querySelectorAll('.tab');

  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  const fmtMoney = (n) => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n || 0);
  const fmtMoneyCompact = (n) => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
  const fmtNumCompact = (n) => new Intl.NumberFormat('es-AR', { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
  const fmtPct = (n) => `${((n || 0) * 100).toFixed(1)}%`;
  const fmtNum = (n, d = 1) => (n || 0).toFixed(d);
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDateShort = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });

  let dailySummary = null; // { detailWindowStartDate, days: [{date, segments:{...}}] }
  let fullHistoryMetrics = {}; // bucket -> metrics.json (repurchase/frequency, no rango)
  let activeTab = 'food';
  let activePreset = 'month';
  let compareOn = true;

  async function loadJson(path) {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) throw new Error(`No se pudo cargar ${path} (${res.status})`);
    return res.json();
  }

  function lastAvailableDate() {
    const days = dailySummary?.days || [];
    return days.length ? days[days.length - 1].date : null;
  }

  function addDays(dateStr, n) {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function daysBetween(fromStr, toStr) {
    return Math.round((new Date(`${toStr}T00:00:00Z`) - new Date(`${fromStr}T00:00:00Z`)) / 86400000) + 1;
  }

  function presetRange(preset) {
    const last = lastAvailableDate();
    if (!last) return null;
    if (preset === 'yesterday') return { from: last, to: last };
    if (preset === '7d') return { from: addDays(last, -6), to: last };
    if (preset === '30d') return { from: addDays(last, -29), to: last };
    if (preset === 'month') return { from: last.slice(0, 8) + '01', to: last };
    if (preset === 'all') return { from: dailySummary.detailWindowStartDate, to: last };
    return null;
  }

  function previousRange(range) {
    const n = daysBetween(range.from, range.to);
    return { from: addDays(range.from, -n), to: addDays(range.from, -1) };
  }

  function sumRange(bucket, range) {
    const acc = { gmv: 0, orders: 0, units: 0, marketing: {}, series: [] };
    for (const day of dailySummary.days) {
      if (day.date < range.from || day.date > range.to) continue;
      const seg = day.segments[bucket] || { gmv: 0, orders: 0, units: 0, marketing: {} };
      acc.gmv += seg.gmv;
      acc.orders += seg.orders;
      acc.units += seg.units || 0;
      for (const [name, v] of Object.entries(seg.marketing || {})) {
        acc.marketing[name] = acc.marketing[name] || { gmv: 0, orders: 0 };
        acc.marketing[name].gmv += v.gmv;
        acc.marketing[name].orders += v.orders;
      }
      acc.series.push({ date: day.date, gmv: seg.gmv, orders: seg.orders });
    }
    return acc;
  }

  function totalAllSegments(range) {
    let gmv = 0;
    for (const day of dailySummary.days) {
      if (day.date < range.from || day.date > range.to) continue;
      for (const s of SEGMENTS) gmv += (day.segments[s]?.gmv || 0);
    }
    return gmv;
  }

  function deltaBadge(current, previous) {
    if (previous === 0 && current === 0) return '<span class="kpi-delta flat">=</span>';
    if (previous === 0) return '<span class="kpi-delta up">nuevo</span>';
    const pct = ((current - previous) / previous) * 100;
    const cls = pct > 0.5 ? 'up' : pct < -0.5 ? 'down' : 'flat';
    const arrow = pct > 0.5 ? '↑' : pct < -0.5 ? '↓' : '→';
    return `<span class="kpi-delta ${cls}">${arrow} ${Math.abs(pct).toFixed(1)}%</span>`;
  }

  function renderChart(series) {
    const w = 720, h = 200, padL = 36, padR = 8, padT = 10, padB = 24;
    if (!series.length) return '<div class="empty">Sin datos para este rango.</div>';
    if (series.length < 2) return '<div class="empty">Seleccioná un rango de más de un día para ver la evolución.</div>';
    const maxOrders = Math.max(1, ...series.map((s) => s.orders));
    const xStep = series.length > 1 ? (w - padL - padR) / (series.length - 1) : 0;
    const x = (i) => padL + i * xStep;
    const y = (v) => padT + (h - padT - padB) * (1 - v / maxOrders);

    const points = series.map((s, i) => `${x(i)},${y(s.orders)}`).join(' ');
    const areaPoints = `${padL},${y(0)} ${points} ${x(series.length - 1)},${y(0)}`;

    const gridLines = [0, 0.5, 1]
      .map((f) => {
        const gy = padT + (h - padT - padB) * (1 - f);
        return `<line class="chart-gridline" x1="${padL}" x2="${w - padR}" y1="${gy}" y2="${gy}" />
                <text class="chart-axis-label" x="${padL - 6}" y="${gy + 3}" text-anchor="end">${Math.round(maxOrders * f)}</text>`;
      })
      .join('');

    const step = Math.max(1, Math.ceil(series.length / 7));
    const xLabels = series
      .map((s, i) => (i % step === 0 || i === series.length - 1 ? `<text class="chart-axis-label" x="${x(i)}" y="${h - 6}" text-anchor="middle">${fmtDateShort(s.date)}</text>` : ''))
      .join('');

    const dots = series
      .map((s, i) => `<circle class="chart-dot" data-i="${i}" cx="${x(i)}" cy="${y(s.orders)}" r="3" opacity="0" />`)
      .join('');

    return `
      <div class="chart-wrap">
        <svg class="chart-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" id="chart-svg">
          ${gridLines}
          <polygon class="chart-area" points="${areaPoints}"></polygon>
          <polyline class="chart-line" points="${points}"></polyline>
          ${xLabels}
          <g id="chart-dots">${dots}</g>
          <line id="chart-hover-line" class="chart-hover-line" x1="0" x2="0" y1="${padT}" y2="${h - padB}" style="display:none" />
        </svg>
        <div class="chart-tooltip" id="chart-tooltip"></div>
      </div>`;
  }

  function wireChartHover(series) {
    const svg = document.getElementById('chart-svg');
    const tooltip = document.getElementById('chart-tooltip');
    const hoverLine = document.getElementById('chart-hover-line');
    const dots = [...document.querySelectorAll('#chart-dots circle')];
    if (!svg || series.length < 2) return;
    const padL = 36, padR = 8, w = 720;
    const xStep = series.length > 1 ? (w - padL - padR) / (series.length - 1) : 0;

    svg.addEventListener('mousemove', (ev) => {
      const rect = svg.getBoundingClientRect();
      const scaleX = w / rect.width;
      const svgX = (ev.clientX - rect.left) * scaleX;
      let i = Math.round((svgX - padL) / (xStep || 1));
      i = Math.max(0, Math.min(series.length - 1, i));
      const cx = padL + i * xStep;
      hoverLine.setAttribute('x1', cx);
      hoverLine.setAttribute('x2', cx);
      hoverLine.style.display = 'block';
      dots.forEach((d, di) => (d.style.opacity = di === i ? '1' : '0'));

      const s = series[i];
      tooltip.innerHTML = `<strong>${fmtDateShort(s.date)}</strong><br/>${fmtNum(s.orders, 0)} pedidos · ${fmtMoney(s.gmv)}`;
      tooltip.style.opacity = '1';
      const wrapRect = svg.parentElement.getBoundingClientRect();
      const left = (cx / w) * wrapRect.width;
      tooltip.style.left = `${Math.min(wrapRect.width - 140, Math.max(0, left + 10))}px`;
      tooltip.style.top = '4px';
    });
    svg.addEventListener('mouseleave', () => {
      tooltip.style.opacity = '0';
      hoverLine.style.display = 'none';
      dots.forEach((d) => (d.style.opacity = '0'));
    });
  }

  function segmentRows(marketing) {
    const entries = Object.entries(marketing || {}).sort((a, b) => b[1].gmv - a[1].gmv);
    const totalGmv = entries.reduce((s, [, v]) => s + v.gmv, 0);
    if (!entries.length) return '<tr><td colspan="4">Sin datos en este rango</td></tr>';
    return entries
      .map(([seg, v]) => {
        const share = totalGmv > 0 ? v.gmv / totalGmv : 0;
        return `
        <tr>
          <td>${escapeHtml(seg)}</td>
          <td>${fmtMoney(v.gmv)}</td>
          <td>${fmtNum(v.orders, 0)}</td>
          <td>
            <div class="share-cell">
              <div class="share-bar-track"><div class="share-bar-fill" style="width:${(share * 100).toFixed(1)}%"></div></div>
              <span class="share-pct">${fmtPct(share)}</span>
            </div>
          </td>
        </tr>`;
      })
      .join('');
  }

  function render() {
    const range = activePreset === 'custom' ? { from: dateFromEl.value, to: dateToEl.value } : presetRange(activePreset);
    if (!range || !range.from || !range.to) {
      content.innerHTML = '<div class="empty">Todavía no hay días procesados. Corré el backfill inicial (ver README).</div>';
      return;
    }
    dateFromEl.value = range.from;
    dateToEl.value = range.to;
    rangeLabelEl.textContent = range.from === range.to ? fmtDateShort(range.from) : `${fmtDateShort(range.from)} → ${fmtDateShort(range.to)}`;

    const cur = sumRange(activeTab, range);
    const prevRange = previousRange(range);
    const prev = compareOn ? sumRange(activeTab, prevRange) : null;
    compareLabelEl.textContent = compareOn ? `vs. ${fmtDateShort(prevRange.from)} → ${fmtDateShort(prevRange.to)}` : '';

    const curTicket = cur.orders ? cur.gmv / cur.orders : 0;
    const prevTicket = prev && prev.orders ? prev.gmv / prev.orders : 0;
    const curTotalAll = totalAllSegments(range);
    const curShare = curTotalAll > 0 ? cur.gmv / curTotalAll : 0;
    const prevTotalAll = prev ? totalAllSegments(prevRange) : 0;
    const prevShare = prev && prevTotalAll > 0 ? prev.gmv / prevTotalAll : 0;

    const hist = fullHistoryMetrics[activeTab];
    const slot = css(SEGMENT_SLOT[activeTab]);
    const slotSoft = css(SEGMENT_SLOT_SOFT[activeTab]);
    const icon = SEGMENT_ICON[activeTab];

    const tile = (iconGlyph, label, value, sub, deltaHtml, accentColor) => `
      <div class="kpi-card">
        <div class="kpi-top">
          <div class="kpi-icon" style="background:${slotSoft}">${iconGlyph}</div>
          ${deltaHtml || ''}
        </div>
        <div class="kpi-value">${value}</div>
        <div class="kpi-label">${label}</div>
        ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
        <div class="kpi-accent"><div class="kpi-accent-fill" style="width:100%;background:${accentColor || slot}"></div></div>
      </div>`;

    const kpis = [
      tile(icon, 'Pedidos', fmtNumCompact(cur.orders), null, prev ? deltaBadge(cur.orders, prev.orders) : ''),
      tile('💰', 'GMV', `<span title="${fmtMoney(cur.gmv)}">${fmtMoneyCompact(cur.gmv)}</span>`, null, prev ? deltaBadge(cur.gmv, prev.gmv) : ''),
      tile('🧾', 'Ticket promedio', fmtMoney(curTicket), 'GMV / pedidos', prev ? deltaBadge(curTicket, prevTicket) : ''),
      tile('📊', 'Participación', fmtPct(curShare), '% del GMV web total (4 segmentos)', prev ? deltaBadge(curShare, prevShare) : ''),
      tile('🔁', 'Repurchase rate', hist ? fmtPct(hist.repurchaseRate) : '—', `histórico desde ${hist?.detailWindowStartDate || '—'}`, ''),
      tile('📈', 'Frecuencia de compra', hist ? fmtNum(hist.purchaseFrequency, 2) : '—', 'pedidos / cliente · histórico', ''),
    ].join('');

    if (cur.orders === 0 && cur.gmv === 0) {
      content.innerHTML = `
        <div class="kpi-grid">${kpis}</div>
        <div class="empty">No hay pedidos de este segmento en el rango seleccionado.</div>`;
      return;
    }

    content.innerHTML = `
      <div class="kpi-grid">${kpis}</div>

      <div class="panel">
        <div class="panel-title">Pedidos por día</div>
        <div class="panel-sub">${range.from === range.to ? fmtDateShort(range.from) : `${fmtDateShort(range.from)} → ${fmtDateShort(range.to)}`} · ${activeTab}</div>
        ${renderChart(cur.series)}
      </div>

      <div class="section-title">Participación por fuente de marketing</div>
      <div class="seg-table">
        <table>
          <thead><tr><th>Fuente</th><th>GMV</th><th>Pedidos</th><th>% GMV</th></tr></thead>
          <tbody>${segmentRows(cur.marketing)}</tbody>
        </table>
      </div>
    `;
    wireChartHover(cur.series);
  }

  async function loadFullHistoryMetrics(bucket) {
    if (fullHistoryMetrics[bucket]) return;
    try {
      fullHistoryMetrics[bucket] = await loadJson(`data/${CHANNEL}/${bucket}/metrics.json`);
    } catch (e) {
      fullHistoryMetrics[bucket] = null;
    }
  }

  async function selectTab(bucket) {
    activeTab = bucket;
    tabBtns.forEach((t) => {
      const isActive = t.dataset.bucket === bucket;
      t.classList.toggle('active', isActive);
      t.setAttribute('aria-selected', String(isActive));
    });
    await loadFullHistoryMetrics(bucket);
    render();
  }

  function selectPreset(preset) {
    activePreset = preset;
    presetBtns.forEach((b) => b.classList.toggle('active', b.dataset.preset === preset));
    render();
  }

  presetBtns.forEach((b) => b.addEventListener('click', () => selectPreset(b.dataset.preset)));
  tabBtns.forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.bucket)));
  compareToggle.addEventListener('change', () => {
    compareOn = compareToggle.checked;
    render();
  });
  [dateFromEl, dateToEl].forEach((el) =>
    el.addEventListener('change', () => {
      activePreset = 'custom';
      presetBtns.forEach((b) => b.classList.remove('active'));
      render();
    })
  );

  async function main() {
    content.innerHTML = '<div class="loading">Cargando métricas...</div>';
    try {
      dailySummary = await loadJson(`data/${CHANNEL}/daily-summary.json`);
    } catch (e) {
      content.innerHTML = `<div class="error">No se pudo cargar el historial (¿corrió ya el backfill?). ${escapeHtml(e.message)}</div>`;
      return;
    }
    compareOn = compareToggle.checked;
    selectPreset('month');
    await selectTab('food');
  }

  main();
})();

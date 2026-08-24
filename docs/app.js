(function () {
  const CHANNEL = 'web';
  const content = document.getElementById('content');
  const runInfoEl = document.getElementById('run-info');
  const tabs = document.querySelectorAll('.tab');

  const fmtMoney = (n) =>
    new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n || 0);
  // Notación compacta para los números grandes de las tiles (evita que un GMV de
  // 9+ dígitos se corte contra el borde de la card); el valor exacto va en el title.
  const fmtMoneyCompact = (n) =>
    new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
  const fmtNumCompact = (n) => new Intl.NumberFormat('es-AR', { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
  const fmtPct = (n) => `${((n || 0) * 100).toFixed(1)}%`;
  const fmtNum = (n, d = 1) => (n || 0).toFixed(d);
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function loadJson(path) {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) throw new Error(`No se pudo cargar ${path} (${res.status})`);
    return res.json();
  }

  function segmentRows(segmentParticipation) {
    const entries = Object.entries(segmentParticipation || {}).sort((a, b) => b[1].gmv - a[1].gmv);
    if (!entries.length) return '<tr><td colspan="4">Sin datos todavía</td></tr>';
    return entries
      .map(([seg, v]) => {
        const pct = Math.max(0, Math.min(1, v.gmvShare || 0));
        return `
        <tr>
          <td>${escapeHtml(seg)}</td>
          <td>${fmtMoney(v.gmv)}</td>
          <td>${fmtNum(v.orders, 0)}</td>
          <td>
            <div class="share-cell">
              <div class="share-bar-track"><div class="share-bar-fill" style="width:${(pct * 100).toFixed(1)}%"></div></div>
              <span class="share-pct">${fmtPct(v.gmvShare)}</span>
            </div>
          </td>
        </tr>`;
      })
      .join('');
  }

  function renderMetrics(m) {
    if (!m.orders) {
      content.innerHTML = `
        <div class="empty">
          Todavía no hay pedidos procesados en esta pestaña${m.daysAggregated ? ` (${m.daysAggregated} días agregados)` : ''}.
          Corré el backfill inicial (ver README) para completar el historial desde ${m.detailWindowStartDate || '—'}.
        </div>`;
      return;
    }

    content.innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">GMV</div>
          <div class="kpi-value" title="${fmtMoney(m.gmv)}">${fmtMoneyCompact(m.gmv)}</div>
          <div class="kpi-sub">desde ${m.detailWindowStartDate} · ${m.daysAggregated} días</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Pedidos</div>
          <div class="kpi-value" title="${fmtNum(m.orders, 0)}">${fmtNumCompact(m.orders)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Basket size promedio</div>
          <div class="kpi-value">${fmtMoney(m.averageBasketSize)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Repurchase rate</div>
          <div class="kpi-value">${fmtPct(m.repurchaseRate)}</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Frecuencia de compra</div>
          <div class="kpi-value">${fmtNum(m.purchaseFrequency, 2)}</div>
          <div class="kpi-sub">pedidos / cliente</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Proyección mensual (GMV)</div>
          <div class="kpi-value" title="${fmtMoney(m.monthlyProjection?.projectedGmv)}">${fmtMoneyCompact(m.monthlyProjection?.projectedGmv)}</div>
          <div class="kpi-sub">día ${m.monthlyProjection?.daysElapsed} de ${m.monthlyProjection?.daysInMonth}</div>
        </div>
      </div>

      <div class="section-title">Participación por segmento</div>
      <div class="seg-table">
        <table>
          <thead><tr><th>Segmento</th><th>GMV</th><th>Pedidos</th><th>% GMV</th></tr></thead>
          <tbody>${segmentRows(m.segmentParticipation)}</tbody>
        </table>
      </div>
    `;
  }

  async function loadBucket(bucket) {
    content.innerHTML = '<div class="loading">Cargando métricas...</div>';
    try {
      const m = await loadJson(`data/${CHANNEL}/${bucket}/metrics.json`);
      renderMetrics(m);
      runInfoEl.textContent = `Actualizado: ${new Date(m.generatedAt).toLocaleString('es-AR')}`;
    } catch (err) {
      content.innerHTML = `<div class="error">No se pudieron cargar los datos todavía (¿corrió ya el pipeline?). ${escapeHtml(err.message)}</div>`;
      runInfoEl.textContent = '';
    }
  }

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      loadBucket(tab.dataset.bucket);
    });
  });

  loadBucket('food');
})();

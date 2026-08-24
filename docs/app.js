(function () {
  const CHANNEL = 'web';
  const content = document.getElementById('content');
  const runInfoEl = document.getElementById('run-info');
  const tabs = document.querySelectorAll('.tab');

  const fmtMoney = (n) =>
    new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n || 0);
  const fmtPct = (n) => `${((n || 0) * 100).toFixed(1)}%`;
  const fmtNum = (n, d = 1) => (n || 0).toFixed(d);

  async function loadJson(path) {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) throw new Error(`No se pudo cargar ${path} (${res.status})`);
    return res.json();
  }

  function renderMetrics(m) {
    const segRows = Object.entries(m.segmentParticipation || {})
      .sort((a, b) => b[1].gmv - a[1].gmv)
      .map(
        ([seg, v]) => `
        <tr>
          <td>${seg}</td>
          <td>${fmtMoney(v.gmv)}</td>
          <td>${fmtNum(v.orders, 1)}</td>
          <td>${fmtPct(v.gmvShare)}</td>
        </tr>`
      )
      .join('');

    content.innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">GMV</div>
          <div class="kpi-value">${fmtMoney(m.gmv)}</div>
          <div class="kpi-sub">desde ${m.detailWindowStartDate} (${m.daysAggregated} días)</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Pedidos</div>
          <div class="kpi-value">${fmtNum(m.orders, 0)}</div>
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
          <div class="kpi-value">${fmtMoney(m.monthlyProjection?.projectedGmv)}</div>
          <div class="kpi-sub">día ${m.monthlyProjection?.daysElapsed} de ${m.monthlyProjection?.daysInMonth}</div>
        </div>
      </div>

      <div class="section-title">Participación por segmento</div>
      <table>
        <thead><tr><th>Segmento</th><th>GMV</th><th>Pedidos</th><th>% GMV</th></tr></thead>
        <tbody>${segRows || '<tr><td colspan="4">Sin datos</td></tr>'}</tbody>
      </table>
    `;
  }

  async function loadBucket(bucket) {
    content.innerHTML = '<div class="loading">Cargando métricas...</div>';
    try {
      const m = await loadJson(`data/${CHANNEL}/${bucket}/metrics.json`);
      renderMetrics(m);
      runInfoEl.textContent = `Actualizado: ${new Date(m.generatedAt).toLocaleString('es-AR')}`;
    } catch (err) {
      content.innerHTML = `<div class="error">No se pudieron cargar los datos todavía (¿corrió ya el pipeline?). ${err.message}</div>`;
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

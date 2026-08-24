/* global window, document */
/** Shell + router de WebDash: estado global (vista, rango, segmento) y render. */
(function () {
  const W = (window.W = window.W || {});

  const state = {
    view: W.store.get('view', 'dashboard'),
    preset: W.store.get('preset', 'month'),
    range: null,
    bucket: W.store.get('bucket', 'all'),
    compare: W.store.get('compare', true),
  };

  const el = {
    content: () => document.getElementById('content'),
    rangeLabel: () => document.getElementById('range-label'),
    compareLabel: () => document.getElementById('compare-label'),
    from: () => document.getElementById('date-from'),
    to: () => document.getElementById('date-to'),
    metaBar: () => document.getElementById('meta-bar'),
  };

  let days = [];
  let startDate = null;
  let exportsBag = {};

  function resolveRange() {
    if (state.preset === 'custom' && el.from()?.value && el.to()?.value) {
      const from = el.from().value, to = el.to().value;
      return from <= to ? { from, to } : { from: to, to: from };
    }
    return W.presetRange(state.preset, days, startDate);
  }

  function syncChrome() {
    document.querySelectorAll('.nav-item').forEach((n) => {
      const active = n.dataset.view === state.view;
      n.classList.toggle('active', active);
      n.setAttribute('aria-current', active ? 'page' : 'false');
    });
    document.querySelectorAll('.preset').forEach((b) => b.classList.toggle('active', b.dataset.preset === state.preset));
    document.querySelectorAll('.seg-pill').forEach((b) => b.classList.toggle('active', b.dataset.bucket === state.bucket));

    // El selector de segmento y la comparación solo aplican al Dashboard; sin
    // ellos la subbarra queda vacía, así que se oculta entera.
    const isDash = state.view === 'dashboard';
    document.querySelector('.subbar').style.display = isDash ? '' : 'none';
    // Audiencias mira toda la base histórica, no un rango: se ocultan los filtros de fecha.
    document.getElementById('date-controls').style.display = state.view === 'audiences' ? 'none' : '';

    const titles = { dashboard: 'Dashboard', analytics: 'Analítica', audiences: 'Audiencias' };
    document.getElementById('view-title').textContent = titles[state.view];

    if (state.range) {
      el.rangeLabel().textContent = state.range.from === state.range.to
        ? W.fmtDayLong(state.range.from)
        : `${W.fmtDayLong(state.range.from)} → ${W.fmtDayLong(state.range.to)}`;
      if (el.from()) el.from().value = state.range.from;
      if (el.to()) el.to().value = state.range.to;
      const pr = W.previousRange(state.range);
      el.compareLabel().textContent = state.compare ? `vs. ${W.fmtDay(pr.from)} → ${W.fmtDay(pr.to)}` : '';
    }
    el.rangeLabel().style.display = state.view === 'audiences' ? 'none' : '';
  }

  W.render = async function () {
    state.range = resolveRange();
    syncChrome();
    exportsBag = {};
    const ctx = { range: state.range, bucket: state.bucket, compare: state.compare, el: el.content(), exports: exportsBag };

    try {
      if (state.view === 'dashboard') await W.viewDashboard(ctx);
      else if (state.view === 'analytics') await W.viewAnalytics(ctx);
      else await W.viewAudiences(ctx);
    } catch (e) {
      el.content().innerHTML = `<div class="empty-state error"><h2>Algo falló al renderizar</h2><p>${W.esc(e.message)}</p></div>`;
      console.error(e);
    }
  };

  // Botones de exportación: delegado, porque las vistas se re-renderizan enteras.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-export]');
    if (!btn) return;
    const spec = exportsBag[btn.dataset.export];
    if (!spec) { W.toast('No hay datos para exportar todavía.', 'bad'); return; }
    W.downloadCSV(spec.filename, spec.headers, spec.rows);
    W.toast(`Exportadas ${W.fmtNum(spec.rows.length)} filas.`, 'good');
  });

  async function main() {
    let meta = null;
    try {
      const daily = await W.load('daily-summary');
      days = daily.days.map((d) => d.date);
      startDate = daily.detailWindowStartDate;
      meta = await W.load('_meta/run-info').catch(() => null);
    } catch (e) {
      el.content().innerHTML = `<div class="empty-state error"><h2>No se pudieron cargar los datos</h2>
        <p>${W.esc(e.message)}</p><p class="muted">¿Ya corrió el pipeline? Ver README.</p></div>`;
      return;
    }

    if (meta) {
      const bits = [`Actualizado ${new Date(meta.generatedAt).toLocaleString('es-AR')}`];
      if (meta.uniqueCustomers) bits.push(`${W.fmtNumC(meta.uniqueCustomers)} clientes únicos`);
      if (meta.daysAggregated) bits.push(`${meta.daysAggregated} días`);
      el.metaBar().innerHTML = bits.map((b) => `<span>${W.esc(b)}</span>`).join('');
      if (meta.warning) {
        el.metaBar().innerHTML += `<span class="meta-warn" ${W.chart.tip(W.esc(meta.warning))}>⚠ ${W.esc(meta.warning.slice(0, 70))}${meta.warning.length > 70 ? '…' : ''}</span>`;
      }
    }

    document.querySelectorAll('.nav-item').forEach((n) =>
      n.addEventListener('click', (ev) => {
        ev.preventDefault();
        state.view = n.dataset.view;
        W.store.set('view', state.view);
        W.render();
      })
    );
    document.querySelectorAll('.preset').forEach((b) =>
      b.addEventListener('click', () => {
        state.preset = b.dataset.preset;
        W.store.set('preset', state.preset);
        W.render();
      })
    );
    document.querySelectorAll('.seg-pill').forEach((b) =>
      b.addEventListener('click', () => {
        state.bucket = b.dataset.bucket;
        W.store.set('bucket', state.bucket);
        W.render();
      })
    );
    [el.from(), el.to()].forEach((i) =>
      i.addEventListener('change', () => {
        state.preset = 'custom';
        W.store.set('preset', 'custom');
        W.render();
      })
    );
    document.getElementById('logout')?.addEventListener('click', async () => {
      try { await fetch('/api/logout', { method: 'POST' }); } catch { /* sin backend en local */ }
      location.href = '/login.html';
    });

    const ct = document.getElementById('compare-toggle');
    ct.checked = state.compare;
    ct.addEventListener('change', () => {
      state.compare = ct.checked;
      W.store.set('compare', state.compare);
      W.render();
    });

    W.render();
  }

  main();
})();

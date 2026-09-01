/* global window, document */
/** Shell + router: estado global (vista, rango, segmento) y render. */
(function () {
  const W = (window.W = window.W || {});

  const state = {
    view: W.store.get('view', 'dashboard'),
    preset: W.store.get('preset', 'month'),
    range: null,
    bucket: W.store.get('bucket', 'all'),
    compare: W.store.get('compare', true),
  };

  const $ = (id) => document.getElementById(id);
  let days = [];
  let startDate = null;
  let exportsBag = {};
  let meta = null;

  // El punto de "en vivo" solo se prende si hoy tiene datos Y son recientes:
  // el pipeline en vivo corre cada 30 min, así que más de 90 sin actualizar
  // significa que se cortó, no que "hoy" dejó de existir.
  function liveFresh() {
    if (!meta?.generatedAt || !days.includes(W.arToday())) return false;
    return Date.now() - new Date(meta.generatedAt).getTime() < 90 * 60 * 1000;
  }

  const NAV_ICON = { dashboard: 'dashboard', analytics: 'analytics', coupons: 'tag', marketing: 'megaphone', audiences: 'audience' };
  const TITLES = { dashboard: 'Dashboard', analytics: 'Analítica', coupons: 'Cupones', marketing: 'Marketing', audiences: 'Audiencias' };

  function paintChrome() {
    document.querySelectorAll('.nav-item').forEach((n) => {
      n.querySelector('.ni').innerHTML = W.icon(NAV_ICON[n.dataset.view], 18);
      const on = n.dataset.view === state.view;
      n.classList.toggle('active', on);
      n.setAttribute('aria-current', on ? 'page' : 'false');
    });
    $('logout').innerHTML = `${W.icon('logout', 15)}<span>Cerrar sesión</span>`;

    $('segbar').innerHTML = [
      { k: 'all', label: 'Todos', icon: 'globe' },
      ...W.SEGMENTS.map((s) => ({ k: s, label: W.SEGMENT_LABEL[s], icon: W.SEGMENT_ICON_NAME[s] })),
    ]
      .map((s) => `<button class="chip${s.k === state.bucket ? ' on' : ''}" data-bucket="${s.k}">${W.icon(s.icon, 14)}${W.esc(s.label)}</button>`)
      .join('');
    document.querySelectorAll('[data-bucket]').forEach((b) =>
      b.addEventListener('click', () => {
        state.bucket = b.dataset.bucket;
        W.store.set('bucket', state.bucket);
        W.render();
      })
    );
  }

  const FALLBACK_PRESET = 'month';

  /**
   * Nunca devuelve null mientras haya días cargados. El caso que rompía: el
   * navegador recuerda preset='custom' de una sesión anterior, pero al recargar
   * los inputs de fecha arrancan vacíos — presetRange('custom') devolvía null y
   * la vista explotaba al leer range.from. Ahora eso cae al preset por defecto.
   */
  function resolveRange() {
    if (state.preset === 'custom') {
      const from = $('date-from')?.value, to = $('date-to')?.value;
      if (from && to) return from <= to ? { from, to } : { from: to, to: from };
      state.preset = FALLBACK_PRESET; // custom sin fechas: no es un estado válido
      W.store.set('preset', state.preset);
    }

    const r = W.presetRange(state.preset, days, startDate);
    if (r) return r;

    // Preset desconocido (por ejemplo guardado por una versión anterior).
    state.preset = FALLBACK_PRESET;
    W.store.set('preset', state.preset);
    return W.presetRange(FALLBACK_PRESET, days, startDate)
      || (days.length ? { from: days[0], to: days[days.length - 1] } : null);
  }

  function sync() {
    paintChrome();
    document.querySelectorAll('#presets button').forEach((b) => b.classList.toggle('on', b.dataset.preset === state.preset));
    $('view-title').textContent = TITLES[state.view];
    $('preset-today').classList.toggle('is-live', liveFresh());

    // Dashboard, Analítica, Cupones y Marketing se filtran por segmento;
    // Audiencias mira la base completa, así que ahí la fila no aplica.
    const hasSeg = ['dashboard', 'analytics', 'coupons', 'marketing'].includes(state.view);
    $('row2').style.display = hasSeg ? '' : 'none';
    $('cmp-wrap').style.display = state.view === 'dashboard' ? '' : 'none';
    // Audiencias mira toda la base histórica, no un rango.
    $('date-controls').style.display = state.view === 'audiences' ? 'none' : '';
    $('range-label').style.display = state.view === 'audiences' ? 'none' : '';

    if (state.range) {
      const isToday = state.preset === 'today' && state.range.from === W.arToday();
      $('range-label').textContent = isToday
        // Nunca "en vivo": el pipeline actualiza cada ~30 min, no en tiempo
        // real — decir "en vivo" y mostrar datos con 30 min de atraso es lo
        // que generaba la confusión. Se muestra la hora real de la última
        // actualización, sin prometer algo que no es.
        ? `Hoy ${liveFresh() ? '· actualizado ' + W.timeAgo(meta.generatedAt) : '· todavía sin datos de hoy'}`
        : state.range.from === state.range.to
          ? W.fmtDayLong(state.range.from)
          : `${W.fmtDayLong(state.range.from)} → ${W.fmtDayLong(state.range.to)}`;
      $('date-from').value = state.range.from;
      $('date-to').value = state.range.to;
      const pr = W.previousRange(state.range);
      $('cmp-label').textContent = state.compare ? `vs. ${W.fmtDay(pr.from)} – ${W.fmtDay(pr.to)}` : '';
    }
  }

  W.render = async function () {
    state.range = resolveRange();
    sync();

    // Sin rango no hay nada que calcular: se muestra el estado vacío en vez de
    // dejar que cada vista falle leyendo range.from.
    if (!state.range && state.view !== 'audiences') {
      $('content').innerHTML = `<div class="empty"><h2>Todavía no hay datos</h2>
        <p>Corré el backfill inicial para poblar el historial (ver README).</p></div>`;
      return;
    }

    exportsBag = {};
    const ctx = { range: state.range, bucket: state.bucket, compare: state.compare, el: $('content'), exports: exportsBag };
    try {
      if (state.view === 'dashboard') await W.viewDashboard(ctx);
      else if (state.view === 'analytics') await W.viewAnalytics(ctx);
      else if (state.view === 'coupons') await W.viewCoupons(ctx);
      else if (state.view === 'marketing') await W.viewMarketing(ctx);
      else await W.viewAudiences(ctx);
    } catch (e) {
      $('content').innerHTML = `<div class="empty err"><h2>Algo falló al renderizar</h2><p>${W.esc(e.message)}</p></div>`;
      console.error(e);
    }
  };

  // Exportaciones: delegado, porque las vistas se re-renderizan enteras.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-export]');
    if (!btn) return;
    const spec = exportsBag[btn.dataset.export];
    if (!spec) { W.toast('No hay datos para exportar todavía.', 'bad'); return; }
    W.downloadXLSX(spec.filename.replace(/\.csv$/, '.xlsx'), [{ name: 'Datos', rows: [spec.headers, ...spec.rows] }]);
    W.toast(`Exportadas ${W.fmtNum(spec.rows.length)} filas.`, 'good');
  });

  async function main() {
    try {
      const daily = await W.load('daily-summary');
      days = daily.days.map((d) => d.date);
      startDate = daily.detailWindowStartDate;
      meta = await W.load('_meta/run-info').catch(() => null);
    } catch (e) {
      $('content').innerHTML = `<div class="empty err"><h2>No se pudieron cargar los datos</h2>
        <p>${W.esc(e.message)}</p><p class="muted">¿Ya corrió el pipeline? Ver README.</p></div>`;
      paintChrome();
      return;
    }

    // El footer es lo único siempre visible sin scroll extra: solo va acá lo
    // que le sirve a quien mira el negocio (cuándo se actualizó, cuánta base
    // hay) — nada de detalles de infraestructura o del pipeline interno.
    if (meta) {
      const bits = [`Actualizado ${new Date(meta.generatedAt).toLocaleString('es-AR')}`];
      if (meta.uniqueCustomers) bits.push(`${W.fmtNumC(meta.uniqueCustomers)} clientes`);
      if (meta.daysAggregated) bits.push(`${meta.daysAggregated} días de historial`);
      $('meta').innerHTML = bits.map((b) => `<span>${W.esc(b)}</span>`).join('');
    }

    document.querySelectorAll('.nav-item').forEach((n) =>
      n.addEventListener('click', (ev) => {
        ev.preventDefault();
        state.view = n.dataset.view;
        W.store.set('view', state.view);
        W.render();
      })
    );
    document.querySelectorAll('#presets button').forEach((b) =>
      b.addEventListener('click', () => {
        state.preset = b.dataset.preset;
        W.store.set('preset', state.preset);
        W.render();
      })
    );
    [$('date-from'), $('date-to')].forEach((i) =>
      i.addEventListener('change', () => {
        state.preset = 'custom';
        W.store.set('preset', 'custom');
        W.render();
      })
    );
    const cmp = $('cmp');
    cmp.checked = state.compare;
    cmp.addEventListener('change', () => {
      state.compare = cmp.checked;
      W.store.set('compare', state.compare);
      W.render();
    });
    $('logout').addEventListener('click', async () => {
      try { await fetch('/api/logout', { method: 'POST' }); } catch { /* sin backend en local */ }
      location.href = '/login.html';
    });

    W.render();
  }

  main();
})();

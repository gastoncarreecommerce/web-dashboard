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

  // ── "Hoy en vivo" ──────────────────────────────────────────────────────
  // Sondea /api/today-live cada 15s mientras "hoy" esté dentro del rango
  // elegido, sin importar la vista — el endpoint devuelve el día completo en
  // el mismo formato que daily-summary.json, así que alcanza con pisar esa
  // entrada en el objeto cacheado por W.load: todas las vistas (Dashboard,
  // Analítica, Marketing, Cupones) lo leen del mismo cache y quedan al día
  // sin ningún cambio propio. Solo el Dashboard se re-renderiza solo en cada
  // poll (es la pantalla sin inputs de texto); en las demás el dato queda
  // fresco para la próxima vez que el usuario interactúe y dispare un render.
  const LIVE_VIEWS = ['dashboard', 'analytics', 'marketing', 'coupons'];
  let liveTimer = null;
  let liveQueriedAt = null;

  function stopLive() {
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  }

  async function pollLiveToday() {
    try {
      const res = await fetch('/api/today-live', { cache: 'no-store' });
      if (!res.ok) return; // sin storage configurado (404) o error transitorio: se reintenta el próximo tick
      const live = await res.json();
      const daily = await W.load('daily-summary');
      const entry = {
        date: live.date, segments: live.segments, hourly: null,
        discount: live.discount || 0, newCustomers: live.newCustomers || 0,
        activeCustomers: live.activeCustomers || 0, statusStats: live.statusStats || {},
      };
      const idx = daily.days.findIndex((d) => d.date === live.date);
      if (idx >= 0) daily.days[idx] = entry;
      else { daily.days.push(entry); daily.days.sort((a, b) => a.date.localeCompare(b.date)); }
      if (!days.includes(live.date)) { days.push(live.date); days.sort(); }
      liveQueriedAt = live.queriedAt;
      if (state.view === 'dashboard') W.render();
    } catch { /* red intermitente: se reintenta en el próximo tick, sin romper la pantalla */ }
  }

  function startLive() {
    if (liveTimer) return;
    pollLiveToday();
    liveTimer = setInterval(pollLiveToday, 15000);
  }

  /**
   * En qué estado está el día de hoy. Son TRES estados distintos y antes se
   * mezclaban dos: con datos guardados pero de hace más de 90 minutos, el
   * cartel decía "todavía sin datos de hoy" aunque la pantalla estuviera
   * mostrando, justo al lado, los 1,7 K pedidos de hoy. No es lo mismo "no
   * hay datos" que "hay datos y son de hace un rato".
   *   none   → hoy no existe en la serie: no hay NADA que mostrar.
   *   live   → el sondeo a /api/today-live respondió hace segundos.
   *   stored → hay datos de hoy, guardados por el pipeline, con su hora real.
   */
  function todayState() {
    if (!days.includes(W.arToday())) return { kind: 'none', at: null };
    if (liveQueriedAt && Date.now() - new Date(liveQueriedAt).getTime() < 45000) return { kind: 'live', at: liveQueriedAt };
    return { kind: 'stored', at: meta?.generatedAt || null };
  }

  const NAV_ICON = { dashboard: 'dashboard', analytics: 'analytics', tiendas: 'store', coupons: 'tag', marketing: 'megaphone', buscador: 'search', audiences: 'audience' };
  const TITLES = { dashboard: 'Dashboard', analytics: 'Analítica', tiendas: 'Tiendas', coupons: 'Cupones', marketing: 'Marketing', buscador: 'Buscador', audiences: 'Audiencias' };

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
    // El punto verde significa UNA cosa: el sondeo en vivo está respondiendo
    // ahora. Datos guardados de hace 80 minutos no son "en vivo" — eso se
    // dice con la hora real al lado, no con un punto que promete tiempo real.
    const today = todayState();
    $('preset-today').classList.toggle('is-live', today.kind === 'live');

    // Dashboard, Analítica, Tiendas, Cupones y Marketing se filtran por
    // segmento; Audiencias mira la base completa y Buscador mira GA4 (no
    // pedidos de VTEX), así que en esas dos la fila no aplica.
    const hasSeg = ['dashboard', 'analytics', 'tiendas', 'coupons', 'marketing'].includes(state.view);
    $('row2').style.display = hasSeg ? '' : 'none';
    $('cmp-wrap').style.display = state.view === 'dashboard' ? '' : 'none';
    // Audiencias mira toda la base histórica y Buscador tiene su propia
    // ventana fija (GA4, últimos 30 días) — ninguna usa el selector de rango.
    const noRange = state.view === 'audiences' || state.view === 'buscador';
    $('date-controls').style.display = noRange ? 'none' : '';
    $('range-label').style.display = noRange ? 'none' : '';

    if (state.range) {
      const isToday = state.range.from === state.range.to && state.range.from === W.arToday();
      $('range-label').textContent = isToday
        ? (today.kind === 'none' ? 'Hoy · todavía sin datos'
          : today.kind === 'live' ? `Hoy · en vivo, ${W.timeAgo(today.at)}`
          : today.at ? `Hoy · actualizado ${W.timeAgo(today.at)}` : 'Hoy')
        : state.range.from === state.range.to
          ? W.fmtDayWeek(state.range.from)
          : `${W.rangeText(state.range)} · ${W.daysBetween(state.range.from, state.range.to)} días`;
      $('date-from').value = state.range.from;
      $('date-to').value = state.range.to;
      const cmp = W.compareText(state.range);
      const cmpLabel = $('cmp-label');
      cmpLabel.textContent = state.compare ? cmp.text : '';
      if (state.compare) cmpLabel.setAttribute('data-tip', cmp.tip);
      else cmpLabel.removeAttribute('data-tip');
    }
  }

  W.render = async function () {
    state.range = resolveRange();
    sync();

    // Sin rango no hay nada que calcular: se muestra el estado vacío en vez de
    // dejar que cada vista falle leyendo range.from.
    if (!state.range && state.view !== 'audiences' && state.view !== 'buscador') {
      $('content').innerHTML = `<div class="empty"><h2>Todavía no hay datos</h2>
        <p>Corré el backfill inicial para poblar el historial (ver README).</p></div>`;
      return;
    }

    exportsBag = {};
    const ctx = { range: state.range, bucket: state.bucket, compare: state.compare, el: $('content'), exports: exportsBag };

    const todayInRange = state.range && W.arToday() >= state.range.from && W.arToday() <= state.range.to;
    if (todayInRange && LIVE_VIEWS.includes(state.view)) startLive();
    else stopLive();

    try {
      if (state.view === 'dashboard') await W.viewDashboard(ctx);
      else if (state.view === 'analytics') await W.viewAnalytics(ctx);
      else if (state.view === 'tiendas') await W.viewTiendas(ctx);
      else if (state.view === 'coupons') await W.viewCoupons(ctx);
      else if (state.view === 'marketing') await W.viewMarketing(ctx);
      else if (state.view === 'buscador') await W.viewBuscador(ctx);
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

    // Le pide a VTEX el día de hoy AHORA, en vez de esperar la corrida
    // automática de cada 30 min. El pedido en sí es rápido, pero traer los
    // pedidos + guardarlos tarda unos minutos de verdad — así que en vez de
    // tirar un mensaje único y dejar al usuario adivinando si ya está,
    // el botón se queda "actualizando" y consulta solo, cada 15s, si ya
    // apareció información más nueva. Cuando aparece, recarga la pantalla
    // sola. Nada de esto se cuenta: para quien lo usa es solo "actualizar".
    const refreshBtn = $('refresh-today');
    if (refreshBtn) {
      const icon = refreshBtn.querySelector('.ri');
      const label = refreshBtn.querySelector('.rl');
      icon.innerHTML = W.icon('refresh', 14);
      let busy = false;

      const setBusy = (on, text) => {
        busy = on;
        refreshBtn.disabled = on;
        refreshBtn.classList.toggle('is-busy', on);
        if (label) label.textContent = text;
      };

      async function fetchFreshMeta() {
        try {
          const res = await fetch(`data/${W.CHANNEL}/_meta/run-info.json?t=${Date.now()}`, { cache: 'no-store' });
          return res.ok ? await res.json() : null;
        } catch {
          return null;
        }
      }

      // Traer los pedidos de hoy + guardarlos es un proceso de varios pasos
      // (pedirle a VTEX, procesar, guardar) que de punta a punta puede tardar
      // bastante más de lo que parece a simple vista — 6 minutos de espera se
      // quedaban cortos y el botón parecía "colgado" sin explicación. Ahora
      // espera hasta 12 minutos y de paso muestra hace cuánto está esperando,
      // para que quede claro que sigue trabajando y no que se rompió.
      const POLL_MAX_MS = 12 * 60 * 1000;
      const POLL_STEP_MS = 15000;
      function pollUntilFresh(baselineAt) {
        const start = Date.now();
        const tick = async () => {
          if (!busy) return; // se canceló (no debería pasar, pero por las dudas)
          const fresh = await fetchFreshMeta();
          if (fresh?.generatedAt && fresh.generatedAt !== baselineAt) {
            W.toast('Listo, ya está la información actualizada.', 'good');
            location.reload();
            return;
          }
          const elapsedMin = Math.floor((Date.now() - start) / 60000);
          if (Date.now() - start > POLL_MAX_MS) {
            setBusy(false, 'Actualizar');
            W.toast('Todavía no llegó — probá de nuevo en unos minutos.', 'bad');
            return;
          }
          setBusy(true, elapsedMin > 0 ? `Actualizando… (${elapsedMin} min)` : 'Actualizando…');
          setTimeout(tick, POLL_STEP_MS);
        };
        setTimeout(tick, POLL_STEP_MS);
      }

      refreshBtn.addEventListener('click', async () => {
        if (busy) { W.toast('Ya se está actualizando, esperá un toque.', 'bad'); return; }
        setBusy(true, 'Actualizando…');
        try {
          const res = await fetch('/api/refresh-today', { method: 'POST' });
          if (!res.ok) {
            setBusy(false, 'Actualizar');
            W.toast('No se pudo pedir la actualización. Probá de nuevo en un rato.', 'bad');
            return;
          }
          W.toast('Pidiendo la información de hoy — puede tardar unos minutos.', 'good');
          pollUntilFresh(meta?.generatedAt || null);
        } catch {
          setBusy(false, 'Actualizar');
          W.toast('No se pudo conectar. Probá de nuevo en un rato.', 'bad');
        }
      });
    }

    // Aviso de "primera versión": una sola vez por sesión de navegador (no en
    // cada cambio de pestaña dentro del dashboard, que sería machacante), para
    // que nadie confunda un número que todavía hay que afinar con un dato ya
    // cerrado.
    if (!sessionStorage.getItem('webdash_v1_notice_seen')) {
      sessionStorage.setItem('webdash_v1_notice_seen', '1');
      const back = document.createElement('div');
      back.className = 'modal-back';
      back.innerHTML = `
        <div class="modal-card">
          <div class="modal-hero">
            <span class="mi">${W.icon('sparkles', 20)}</span>
            <div><h3>Esta es la primera versión</h3><p>Todavía estamos afinando el dashboard</p></div>
          </div>
          <div class="modal-body">
            <p>Acordate de <b>comparar los datos con tu información real</b>. Estamos en la etapa de corregir datos y funcionalidades, así que puede haber cosas para ajustar.</p>
            <button class="btn-p" id="notice-ok">Entendido</button>
          </div>
        </div>`;
      document.body.appendChild(back);
      const close = () => back.remove();
      back.querySelector('#notice-ok').addEventListener('click', close);
      back.addEventListener('click', (e) => { if (e.target === back) close(); });
    }

    W.render();
  }

  main();
})();

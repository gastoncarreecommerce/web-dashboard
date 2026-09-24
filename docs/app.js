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
  let avisoCobertura = null;
  // Si el primer sondeo del vivo ya termino en esta sesion (bien o mal).
  let primerSondeoHecho = false;
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
  // TODA vista que muestre numeros de un rango que incluya hoy tiene que
  // sondear el vivo. Cuando se agregaron canales/mensual/productos/tiendas no
  // se las sumo acá, asi que en "App vs. Web" el sondeo de 15s no arrancaba
  // nunca: la pantalla mostraba el ultimo snapshot committeado y el cartel
  // decia "actualizado hace 4 h" al lado de los numeros de hoy.
  const LIVE_VIEWS = ['dashboard', 'canales', 'mensual', 'productos', 'analytics', 'tiendas', 'marketing', 'coupons'];
  let liveTimer = null;
  let liveQueriedAt = null;

  function stopLive() {
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  }

  // Si el vivo no está configurado, el sondeo fallaba en silencio: el
  // dashboard mostraba los datos committeados y nadie se enteraba de que el
  // vivo de 15s no estaba andando ni de qué le faltaba. Se avisa una sola vez
  // (no en cada tick, que serían 4 mensajes por minuto).
  let liveWarned = false;
  async function warnLiveUnavailable(res) {
    if (liveWarned) return;
    liveWarned = true;
    let detalle = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.faltan?.length) detalle = `faltan env vars en Vercel: ${body.faltan.join(', ')}`;
      else if (body?.error) detalle = body.error;
    } catch { /* respuesta sin JSON: alcanza con el status */ }
    console.warn(`[WebDash] "Hoy en vivo" (15s) no está disponible — ${detalle}. `
      + 'Se están usando los datos guardados del pipeline.');
    // Esto tiene que verse en pantalla, no solo en la consola. Con el vivo
    // caido los numeros de hoy son del ultimo snapshot y el cartel de arriba
    // dice "actualizado hace 4 h" sin explicar nada: parece un bug de los
    // datos cuando en realidad es el endpoint que no responde.
    W.toast(`Los números de hoy no están en vivo: ${detalle}. Se muestran los últimos datos guardados.`, 'bad');
  }

  async function pollLiveToday() {
    try {
      const res = await fetch('/api/today-live', { cache: 'no-store' });
      if (!res.ok) {
        // El primer sondeo TERMINO, aunque haya sido mal: hay que salir del
        // esqueleto igual, o la pantalla se queda cargando para siempre cuando
        // el endpoint no responde.
        primerSondeoHecho = true;
        warnLiveUnavailable(res);
        if (LIVE_VIEWS.includes(state.view)) W.render();
        return;
      }
      const live = await res.json();

      // El vivo ahora trae los DOS canales del mismo escaneo de VTEX
      // (`live.canales.web` / `live.canales.app`), asi que cada uno se empalma
      // en el dataset de SU canal. Antes el endpoint descartaba los pedidos de
      // app y aca solo se escribia web: por eso hoy App daba 0 mientras VTEX
      // tenia cientos de pedidos de app. Nunca se escribe en el dataset del
      // canal activo, y App + Web se recalcula invalidando la union.
      const canales = live.canales || { web: live };
      for (const [canal, d] of Object.entries(canales)) {
        if (!d) continue;
        const ds = canal === 'web'
          ? await W.loadRaw('daily-summary')
          : await W.loadChannel(canal, 'daily-summary');
        if (!ds?.days) continue;
        const entry = {
          date: live.date, segments: d.segments, hourly: null,
          discount: d.discount || 0, newCustomers: 0,
          activeCustomers: d.activeCustomers || 0,
          // statusStats sale del listado del dia SIN filtrar por canal, asi
          // que es del ecommerce entero: va solo en web para no contarlo dos
          // veces cuando se suman los canales.
          statusStats: canal === 'web' ? (live.statusStats || {}) : {},
          totalEcommOrders: canal === 'web' ? (live.totalEcommOrders || 0) : 0,
        };
        const idx = ds.days.findIndex((x) => x.date === live.date);
        if (idx >= 0) ds.days[idx] = entry;
        else { ds.days.push(entry); ds.days.sort((x, y) => x.date.localeCompare(y.date)); }
      }
      W.invalidateMerged();
      if (!days.includes(live.date)) { days.push(live.date); days.sort(); }
      liveQueriedAt = live.queriedAt;
      primerSondeoHecho = true;
      if (LIVE_VIEWS.includes(state.view)) W.render();
    } catch {
      // Red intermitente: se reintenta en el proximo tick, sin romper la
      // pantalla. Pero se sale del esqueleto: mejor los ultimos datos guardados
      // que un esqueleto eterno.
      primerSondeoHecho = true;
      if (LIVE_VIEWS.includes(state.view)) W.render();
    }
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

  // Sin entrada para canales y productos, W.icon(undefined) caia en un icono
  // generico y esos dos items del nav mostraban un circulito sin sentido.
  const NAV_ICON = {
    dashboard: 'dashboard', canales: 'layers', mensual: 'calendar', productos: 'box',
    analytics: 'analytics', tiendas: 'store',
    marketing: 'megaphone', coupons: 'tag', buscador: 'search', audiences: 'audience',
  };
  const TITLES = { dashboard: 'Resumen', canales: 'App vs. Web', mensual: 'Resumen mensual', productos: 'Productos', analytics: 'Analítica', tiendas: 'Tiendas', coupons: 'Cupones', marketing: 'Marketing', buscador: 'Buscador', audiences: 'Audiencias' };

  function paintChrome() {
    document.querySelectorAll('.nav-item').forEach((n) => {
      n.querySelector('.ni').innerHTML = W.icon(NAV_ICON[n.dataset.view], 18);
      const on = n.dataset.view === state.view;
      n.classList.toggle('active', on);
      n.setAttribute('aria-current', on ? 'page' : 'false');
    });
    $('logout').innerHTML = `${W.icon('logout', 15)}<span>Cerrar sesión</span>`;

    // El canal se pinta siempre que la vista mire pedidos: es el corte mas
    // grueso del dashboard, arriba incluso del segmento.
    const CH = [
      ['total', 'App + Web'],
      ['app', 'App'],
      ['web', 'Web'],
    ];
    $('chanbar').innerHTML = CH.map(([k, label]) =>
      `<button data-chan="${k}" class="${W.channel === k ? 'on' : ''}">${label}</button>`).join('');

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
    const hasSeg = ['dashboard', 'mensual', 'productos', 'analytics', 'tiendas', 'coupons', 'marketing'].includes(state.view);
    // "App + Web" cruza los cuatro segmentos contra los dos canales: filtrar por
    // un segmento la dejaria sin su razon de ser, asi que ahi la fila de chips
    // no aplica. El comparador contra el periodo anterior si, porque toda la
    // vista muestra variaciones.
    const showRow2 = hasSeg || state.view === 'canales';
    $('row2').style.display = showRow2 ? '' : 'none';
    $('segbar').style.display = hasSeg ? '' : 'none';
    // La vista "App + Web" muestra los dos canales lado a lado por definicion,
    // asi que ahi el filtro de canal no tiene sentido.
    $('chanbar').style.display = (showRow2 && state.view !== 'canales') ? '' : 'none';
    $('cmp-wrap').style.display = (state.view === 'dashboard' || state.view === 'canales') ? '' : 'none';
    // Audiencias mira toda la base histórica y Buscador tiene su propia
    // ventana fija (GA4, últimos 30 días) — ninguna usa el selector de rango.
    // El resumen mensual muestra TODOS los meses: recortarlo al rango elegido lo
    // dejaria de ser un resumen. El canal y el segmento si aplican.
    const noRange = state.view === 'audiences' || state.view === 'buscador' || state.view === 'mensual';
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

  /**
   * El pie: cuando se actualizo el dato y cuanto historial hay.
   *
   * daysAggregated y uniqueCustomers de run-info son de LA ULTIMA CORRIDA del
   * pipeline, no del dataset. Con un incremental de un dia el pie decia
   * "173 clientes · 1 días de historial", que se lee como que el dashboard tiene
   * un dia de datos cuando tiene nueve meses. El historial sale del dataset que
   * se esta mirando, y se repinta en cada render porque cambia con el canal.
   */
  function pintarPie() {
    if (!meta?.generatedAt) return;
    const bits = [`Actualizado ${new Date(meta.generatedAt).toLocaleString('es-AR')}`];
    if (days.length) {
      bits.push(`${W.fmtNum(days.length)} días de historial`);
      bits.push(`${W.fmtDayShort(days[0])} → ${W.fmtDayShort(days[days.length - 1])}`);
    }
    // Cobertura parcial del canal activo. Es el caso mas enganoso de los dos:
    // los numeros que se pintan son reales, pero incompletos, y la comparacion
    // contra el periodo anterior compara un rango al que le faltan dias contra
    // uno entero — o sea que inventa una caida.
    if (avisoCobertura) {
      const c = avisoCobertura;
      const faltan = c.diasPedidos - c.enRango;
      if (faltan > 0) {
        bits.push(`⚠ faltan ${faltan} de ${c.diasPedidos} días en este canal`
          + ` (llega hasta ${W.fmtDayShort(c.ultimo)}): los totales están incompletos`
          + ` y la comparación contra el período anterior no es válida`);
      } else if (c.ultimoParcial) {
        bits.push(`⚠ ${W.fmtDayShort(c.ultimo)} está incompleto: la última corrida fue`
          + ` ese mismo día, así que capturó solo hasta esa hora.`
          + ` La caída contra el período anterior es del corte, no de las ventas`);
      }
    }
    $('meta').innerHTML = bits.map((b) => `<span>${W.esc(b)}</span>`).join('');
  }

  W.render = async function () {
    // Los dias disponibles dependen del canal: app arranca en mayo y web en
    // enero. Sin refrescarlos, al filtrar por App los presets de fecha seguian
    // ofreciendo el rango de web y el pie mostraba su historial.
    try {
      const ds = await W.load('daily-summary');
      const nuevos = (ds.days || []).map((d) => d.date);
      if (nuevos.length) {
        days = nuevos;
        startDate = ds.detailWindowStartDate || startDate;
      }
    } catch { /* la vista se encarga de avisar si el dataset no carga */ }

    state.range = resolveRange();
    sync();
    pintarPie();

    // Sin rango no hay nada que calcular: se muestra el estado vacío en vez de
    // dejar que cada vista falle leyendo range.from.
    if (!state.range && !['audiences', 'buscador', 'mensual'].includes(state.view)) {
      $('content').innerHTML = `<div class="empty"><h2>Todavía no hay datos</h2>
        <p>Corré el backfill inicial para poblar el historial (ver README).</p></div>`;
      return;
    }

    // ── El canal activo, llega hasta donde llega ──────────────────────────
    // Antes, con el canal App y el rango "Ayer", el dashboard mostraba GMV $0,
    // 0 pedidos y un "↓100,0% vs. ant." en rojo en cada KPI: anunciaba que la
    // App se habia caido del todo. Lo que pasaba es que el agregado de App se
    // genera a mano y estaba cortado seis dias antes, asi que ese dia no existe
    // en el dataset. "0" y "no tengo el dato" son cosas distintas.
    //
    // Va en el shell y no en cada vista a proposito: el problema es el mismo en
    // todas, y un numero inventado en Analitica engana igual que en el Resumen.
    const VISTAS_CON_RANGO = !['audiences', 'buscador', 'mensual'].includes(state.view);
    if (VISTAS_CON_RANGO && state.range) {
      let cob = null;
      try { cob = W.coberturaCanal(await W.load('daily-summary'), state.range); } catch { /* sin dataset, cada vista avisa */ }
      if (cob && cob.enRango === 0 && cob.ultimo) {
        const canal = W.channel === 'app' ? 'App' : W.channel === 'web' ? 'Web' : 'App + Web';
        $('content').innerHTML = `<div class="empty">
          <h2>No hay datos de ${W.esc(canal)} para este período</h2>
          <p>Los datos de <b>${W.esc(canal)}</b> llegan hasta el
            <b>${W.esc(W.fmtDayLong(cob.ultimo))}</b>${cob.generatedAt
    ? ` (última actualización ${W.esc(W.timeAgo(cob.generatedAt))})` : ''},
            y el rango elegido ${cob.porDelante ? 'es posterior a eso' : 'no lo toca'}.</p>
          <p>No es que no hubo ventas: <b>ese día no está cargado</b>. Se muestra esto en vez de
            un 0 con una caída del 100%, que es lo que decía antes.</p>
          ${W.channel !== 'web' ? '<p class="muted">El canal <b>Web</b> sí está al día: se actualiza solo cada 30 minutos.</p>' : ''}
        </div>`;
        $('meta').innerHTML = '';
        return;
      }
      // Cobertura parcial: se pintan los numeros, pero se avisa que faltan dias
      // —y sobre todo que la comparacion contra el periodo anterior no vale,
      // porque compara un rango incompleto contra uno completo.
      avisoCobertura = (cob && cob.enRango > 0
        && (cob.enRango < cob.diasPedidos || cob.ultimoParcial)) ? cob : null;
      // pintarPie() ya corrio mas arriba, antes de saber la cobertura: se
      // repinta para que el aviso entre.
      if (avisoCobertura) pintarPie();
    } else avisoCobertura = null;

    exportsBag = {};
    const ctx = { range: state.range, bucket: state.bucket, compare: state.compare, el: $('content'), exports: exportsBag };

    const todayInRange = state.range && W.arToday() >= state.range.from && W.arToday() <= state.range.to;
    if (todayInRange && LIVE_VIEWS.includes(state.view)) startLive();
    else stopLive();

    // ── Esqueleto mientras se traen los numeros de hoy ─────────────────────
    // Al elegir "Hoy" la vista se pintaba con lo ultimo guardado —que puede ser
    // de hace horas— y un segundo despues los numeros saltaban a los reales.
    // Ese salto se lee como si los datos hubieran cambiado, cuando lo que
    // cambio fue que llegaron. El esqueleto dice "esto todavia no esta", que es
    // la verdad, en vez de mostrar un numero viejo como si fuera el de ahora.
    //
    // Solo la PRIMERA vez: despues, los refrescos de cada 15 segundos actualizan
    // en su lugar sin parpadear, porque ahi si hay un numero real que mostrar.
    if (todayInRange && LIVE_VIEWS.includes(state.view) && !primerSondeoHecho) {
      $('content').innerHTML = W.esqueleto(state.view);
      return;
    }

    try {
      if (state.view === 'dashboard') await W.viewDashboard(ctx);
      else if (state.view === 'canales') await W.viewCanales(ctx);
      else if (state.view === 'productos') await W.viewProductos(ctx);
      else if (state.view === 'mensual') await W.viewMensual(ctx);
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
    const ch = e.target.closest('[data-chan]');
    if (ch) {
      if (ch.dataset.chan !== W.channel) { W.setChannel(ch.dataset.chan); W.render(); }
      return;
    }
    const btn = e.target.closest('[data-export]');
    if (!btn) return;
    const spec = exportsBag[btn.dataset.export];
    if (!spec) { W.toast('No hay datos para exportar todavía.', 'bad'); return; }
    W.downloadXLSX(spec.filename.replace(/\.csv$/, '.xlsx'), [{ name: 'Datos', rows: [spec.headers, ...spec.rows] }]);
    W.toast(`Exportadas ${W.fmtNum(spec.rows.length)} filas.`, 'good');
  });

  /**
   * Empalma recent.json sobre daily-summary.
   *
   * daily-summary.json se regenera una sola vez por día (pesa 20 MB, no se
   * puede commitear cada media hora), así que por sí solo deja "Hoy" con
   * hasta 24 horas de atraso. recent.json son los últimos dos días en el
   * mismo formato, ~120 KB, y lo commitea el workflow de cada 30 min.
   *
   * Orden de frescura, de menos a más: daily-summary (1×día) → recent.json
   * (cada 30 min) → /api/today-live (cada 15s). Cada uno pisa al anterior, y
   * los de arriba son opcionales: si recent.json no está, o si el vivo no
   * tiene Redis configurado, el dashboard sigue funcionando con lo que haya
   * en vez de quedarse esperando.
   */
  /**
   * Empalma recent.json sobre el dataset de WEB — su canal de origen — y tira la
   * fusion para que se rearme. Antes se aplicaba al dataset del canal ACTIVO, y
   * eso mezclaba los canales: con el filtro en App, el dia de web se metia
   * dentro del dataset de app y App vs Web mostraba el mismo numero en los dos
   * lados.
   *
   * Y no reemplaza a ciegas: recent.json se supone mas fresco que
   * daily-summary, pero cuando el pipeline lo deja atras (paso: traia el 15/09
   * con 175 pedidos cuando el diario tenia 2.242) pisarlo DEGRADA el dato. Solo
   * entra si su generatedAt es igual o posterior.
   */
  async function spliceRecent(recent) {
    if (!recent?.days?.length) return null;
    const web = await W.loadRaw('daily-summary');
    const pedidosDe = (d) => Object.values(d?.segments || {}).reduce((t, sg) => t + (sg.orders || 0), 0);
    let entraron = 0;

    for (const day of recent.days) {
      const idx = web.days.findIndex((d) => d.date === day.date);
      if (idx < 0) { web.days.push(day); entraron += 1; continue; }

      // NO REEMPLAZAR POR MENOS. recent.json se supone mas fresco, y por
      // generatedAt lo es, pero puede venir INCOMPLETO: el pipeline corre
      // incrementales y uno de un dia escribio el 15/09 con 175 pedidos cuando
      // el diario ya tenia 2.242. Los pedidos de un dia no desaparecen, asi que
      // un conteo menor significa "esta corrida vio menos", no "hubo menos".
      const nuevos = pedidosDe(day), viejos = pedidosDe(web.days[idx]);
      if (nuevos < viejos) {
        console.warn(`[EcommDash] recent.json trae ${day.date} con ${nuevos} pedidos y el diario ya tiene ${viejos}: se descarta por incompleto.`);
        continue;
      }
      web.days[idx] = day;
      entraron += 1;
    }
    if (!entraron) return null;
    web.days.sort((a, b) => a.date.localeCompare(b.date));
    W.invalidateMerged();
    return recent.generatedAt || null;
  }

  async function main() {
    try {
      meta = await W.load('_meta/run-info').catch(() => null);

      const recentAt = await spliceRecent(await W.load('recent').catch(() => null));
      // La hora que se muestra en "actualizado hace X" tiene que ser la del
      // dato más fresco que realmente se está viendo, no la del agregado
      // diario.
      if (recentAt && (!meta?.generatedAt || recentAt > meta.generatedAt)) {
        meta = { ...(meta || {}), generatedAt: recentAt };
      }

      // Despues del empalme, y del canal que este elegido: W.render() los vuelve
      // a refrescar en cada cambio de canal, esto es solo el arranque.
      const inicial = await W.load('daily-summary');
      days = (inicial.days || []).map((d) => d.date);
      startDate = inicial.detailWindowStartDate || null;
    } catch (e) {
      $('content').innerHTML = `<div class="empty err"><h2>No se pudieron cargar los datos</h2>
        <p>${W.esc(e.message)}</p><p class="muted">¿Ya corrió el pipeline? Ver README.</p></div>`;
      paintChrome();
      return;
    }

    // El footer es lo único siempre visible sin scroll extra: solo va acá lo
    // que le sirve a quien mira el negocio (cuándo se actualizó, cuánta base
    // hay) — nada de detalles de infraestructura o del pipeline interno.
    if (meta) pintarPie();

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
    // ── Exportar el período ────────────────────────────────────────────────
    // Un solo archivo con todo lo del rango que se está viendo, en vez de una
    // tabla por vista. Respeta el canal y el segmento activos: el Excel tiene
    // que dar lo mismo que la pantalla, o no sirve.
    const expBtn = $('export-periodo');
    if (expBtn) {
      const ico = expBtn.querySelector('.ri');
      const lbl = expBtn.querySelector('.rl');
      ico.innerHTML = W.icon('download', 14);
      let bajando = false;
      expBtn.addEventListener('click', async () => {
        if (bajando) return;
        if (!state.range) { W.toast('Elegí un período para exportar.', 'bad'); return; }
        bajando = true; expBtn.disabled = true; lbl.textContent = 'Armando…';
        try {
          const n = await W.exportarPeriodo({ range: state.range, bucket: state.bucket });
          W.toast(`Listo: ${n} hojas con todo el período.`, 'ok');
        } catch (e) {
          W.toast(`No se pudo exportar: ${e.message}`, 'bad');
        } finally {
          bajando = false; expBtn.disabled = false; lbl.textContent = 'Exportar';
        }
      });
    }

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

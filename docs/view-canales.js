/* global window, document */
/**
 * Vista "Canales": App y Web en la misma pantalla.
 *
 * Hasta ahora cada canal tenia su propio dashboard —AppDash para from=app,
 * WebDash para el resto— y no habia forma de mirar el ecommerce completo ni de
 * comparar los dos sin abrir dos pestañas y sumar a mano.
 *
 * Tres bloques, de lo general a lo particular:
 *
 *   1. KPIs del ecommerce completo, cada uno partido en App / Web.
 *   2. Una tarjeta por canal, con su total y sus cuatro segmentos.
 *   3. La matriz segmento x canal, que es donde se ve el cruce completo.
 *
 * Dos cosas que esta vista se toma en serio, porque sin ellas la comparacion
 * miente:
 *
 *   - FRESCURA. Los dos pipelines corren por separado y no terminan juntos. Si
 *     web viene atrasado, un dia va a mostrar app entero contra web a medias,
 *     que parece una caida de web y no lo es. Se avisa arriba, siempre.
 *   - COBERTURA. Web tiene historia desde enero y app desde mayo. Un rango que
 *     empiece antes de mayo no es "app vendio cero": es que el dato no existe.
 *
 * Sobre que mide cada canal: casi todo es comparable. App tiene unidades,
 * productos, cupones, estados, horario, fuentes y clientes unicos — todo eso
 * vive en los -rows.json del repo privado, que es de donde los saca el
 * agregador. Solo tres cosas son genuinamente de Web: medio de pago, cuotas y
 * categoria de producto (App no trae catalogo), mas provincia/tienda.
 */
(function () {
  const W = (window.W = window.W || {});

  let metric = 'orders';   // 'orders' | 'gmv' — el cruce se mira de las dos formas
  let foco = 'total';      // 'total' | 'app' | 'web'

  const CH_RAIL = { app: W.CHANNEL_COLOR?.app || '#4a3aa7', web: W.CHANNEL_COLOR?.web || '#2a78d6' };

  function tile({ rail, icon, label, value, sub, delta, chip, tip }) {
    return `<div class="tile" style="--rail:${rail}"${tip ? ` ${W.chart.tip(tip)}` : ''}>
      <div class="tile-t">
        <span class="tile-ic">${W.icon(icon, 16)}</span>
        ${delta !== undefined && delta !== null ? W.deltaBadge(delta)
          : chip ? `<span class="delta flat">${chip}</span>` : ''}
      </div>
      <div class="tile-v">${value}</div>
      <div class="tile-l">${W.esc(label)}</div>
      ${sub ? `<div class="tile-s">${sub}</div>` : ''}
    </div>`;
  }

  /** Barra de una sola linea partida en App/Web, para ver el mix de un tiron. */
  function splitBar(appVal, webVal) {
    const t = appVal + webVal;
    if (!t) return '';
    const p = (appVal / t) * 100;
    return `<div class="chsplit">
      <div class="chsplit-a" style="width:${p}%"></div>
      <div class="chsplit-w" style="width:${100 - p}%"></div>
    </div>`;
  }

  function segRow(seg, celdas, totalSeg, granTotal, fmt) {
    const a = celdas[seg].app[metric] || 0;
    const w = celdas[seg].web[metric] || 0;
    const t = totalSeg[metric] || 0;
    const share = granTotal ? t / granTotal : 0;
    const mixApp = t ? a / t : 0;
    return `<tr>
      <td class="chm-seg">
        <span class="chm-dot" style="background:${W.SEGMENT_COLOR[seg]}"></span>
        ${W.icon(W.SEGMENT_ICON_NAME[seg], 13)} ${W.esc(W.SEGMENT_LABEL[seg])}
      </td>
      <td class="num">${fmt(a)}</td>
      <td class="num">${fmt(w)}</td>
      <td class="num strong">${fmt(t)}</td>
      <td class="chm-mix">${splitBar(a, w)}<span class="chm-mixl">${W.fmtPct(mixApp, 0)} app</span></td>
      <td class="num dim">${W.fmtPct(share, 1)}</td>
    </tr>`;
  }

  W.viewCanales = async function (ctx) {
    const { range, compare, el } = ctx;

    let channels;
    try {
      channels = await W.loadChannels();
    } catch (e) {
      el.innerHTML = `<div class="empty err"><h2>No se pudieron cargar los dos canales</h2>
        <p>${W.esc(e.message)}</p>
        <p class="dim">El canal App se genera con <code>node scripts/build-app-summary.mjs</code>
        desde el repo <code>vtex-utm-audit</code>.</p></div>`;
      return;
    }

    const m = W.channelMatrix(channels, range);
    const prevRange = W.previousRange(range);
    const mPrev = compare ? W.channelMatrix(channels, prevRange) : null;
    const d = (cur, prev) => (mPrev && prev ? W.delta(cur, prev) : null);

    const fmt = metric === 'orders' ? W.fmtNum : W.fmtMoneyC;
    const rangeTxt = W.rangeText(range);

    // ── Avisos de cobertura y frescura ─────────────────────────────────────
    const avisos = [];
    for (const ch of W.CHANNELS) {
      const info = channels[ch];
      const falta = info.missing(range);
      if (falta.before || falta.after) {
        const partes = [];
        if (falta.before) partes.push(`${falta.before} día${falta.before === 1 ? '' : 's'} antes de ${W.fmtDayShort(info.first)}`);
        if (falta.after) partes.push(`${falta.after} día${falta.after === 1 ? '' : 's'} después de ${W.fmtDayShort(info.last)}`);
        avisos.push({
          tono: 'warn',
          t: `${W.CHANNEL_LABEL[ch]} no tiene datos para todo el rango`,
          s: `Faltan ${partes.join(' y ')}. Los totales del período incluyen esos días solo para el otro canal, así que la comparación entre canales queda sesgada.`,
        });
      }
    }
    // Frescura: si un canal se genero mucho antes que el otro, el ultimo dia
    // del rango puede estar completo en uno y a medias en el otro.
    const gen = {};
    for (const ch of W.CHANNELS) gen[ch] = channels[ch].freshAt ? new Date(channels[ch].freshAt).getTime() : null;
    if (gen.app && gen.web) {
      const horas = Math.abs(gen.app - gen.web) / 3600000;
      if (horas >= 3) {
        const atrasado = gen.app < gen.web ? 'app' : 'web';
        avisos.push({
          tono: 'warn',
          t: `Los dos canales no están igual de actualizados`,
          s: `Los datos de ${W.CHANNEL_LABEL[atrasado]} se trajeron ${Math.round(horas)} h antes que los de ${W.CHANNEL_LABEL[atrasado === 'app' ? 'web' : 'app']}
              (app: ${W.timeAgo(channels.app.freshAt)}, web: ${W.timeAgo(channels.web.freshAt)}).
              Los días más recientes del rango pueden estar completos en un canal y a medias en el otro.`,
        });
      }
    }

    // ── KPIs del ecommerce completo ────────────────────────────────────────
    const app = m.porCanal.app, web = m.porCanal.web;
    // `baseOrders` ya viene saneado: es el total de VTEX salvo que ese total
    // este por debajo de app+web (snapshots de horas distintas), caso en que
    // es app+web. Sin eso salian participaciones que sumaban 112,8%.
    const base = m.baseOrders || 0;
    const partApp = base ? app.orders / base : 0;
    const partWeb = base ? web.orders / base : 0;
    const cobertura = base ? m.total.orders / base : 0;
    const basePrev = mPrev?.baseOrders || 0;

    // Cuando la referencia de VTEX quedo atras, no se dice "X% del ecommerce":
    // no lo sabemos todavia.
    const refTxt = m.ecommDesfasado
      ? 'la referencia de VTEX está más atrasada que los canales'
      : `${W.fmtPct(cobertura, 1)} del ecommerce`;
    const subPart = m.ecommDesfasado
      ? 'sobre App + Web (referencia de VTEX atrasada)'
      : `sobre ${W.fmtNumC(base)} pedidos del ecommerce`;

    if (m.ecommDesfasado) {
      avisos.push({
        tono: 'warn',
        t: 'El total del ecommerce que reporta VTEX está atrasado',
        s: `Dice ${W.fmtNum(m.ecommOrders)} pedidos, menos que los ${W.fmtNum(m.total.orders)} que ya tenemos contados entre los dos canales,
            así que es un dato más viejo (se escribe junto con el agregado de App, no con el de Web).
            Las participaciones se calculan sobre App + Web hasta que se actualice, y por eso suman 100%.`,
      });
    }

    // avisoHtml se arma DESPUES de los KPIs porque el chequeo de la
    // referencia de VTEX (arriba) puede agregar un aviso.
    const avisoHtml = avisos.length
      ? `<div class="chalerts">${avisos.map((a) => `<div class="chalert ${a.tono}">
          <span class="chalert-ic">${W.icon('warn', 16)}</span>
          <div><strong>${W.esc(a.t)}</strong><span>${a.s}</span></div>
        </div>`).join('')}</div>`
      : '';

    const tiles = [
      tile({
        rail: '#2a78d6', icon: 'orders', label: 'Pedidos App + Web', value: W.fmtNumC(m.total.orders),
        delta: d(m.total.orders, mPrev?.total.orders),
        sub: `App <b>${W.fmtNumC(app.orders)}</b> · Web <b>${W.fmtNumC(web.orders)}</b> · ${refTxt}`,
        tip: `<strong>Pedidos de los dos canales</strong>
          <span class="tip-row">${W.fmtNum(m.total.orders)} en el período</span>
          <span class="tip-row">App ${W.fmtNum(app.orders)} · Web ${W.fmtNum(web.orders)}</span>
          <span class="tip-row">${m.ecommDesfasado
            ? `VTEX reporta ${W.fmtNum(m.ecommOrders)} pedidos, pero ese número está más atrasado que los canales, así que todavía no se puede decir qué porcentaje del ecommerce explican.`
            : `Los dos juntos explican el ${W.fmtPct(cobertura, 1)} de los ${W.fmtNum(m.ecommOrders)} pedidos que reporta VTEX. El resto no cae en ninguno de los dos canales.`}</span>`,
      }),
      tile({
        rail: '#eb6834', icon: 'money', label: 'GMV App + Web', value: W.fmtMoneyC(m.total.gmv),
        delta: d(m.total.gmv, mPrev?.total.gmv),
        sub: `App <b>${W.fmtMoneyC(app.gmv)}</b> · Web <b>${W.fmtMoneyC(web.gmv)}</b>`,
      }),
      tile({
        rail: CH_RAIL.app, icon: 'bolt', label: 'Participación App', value: W.fmtPct(partApp, 1),
        delta: basePrev ? W.delta(partApp, mPrev.porCanal.app.orders / basePrev) : null,
        sub: subPart,
        tip: `<strong>Participación de App</strong>
          <span class="tip-row">${W.fmtNum(app.orders)} de ${W.fmtNum(base)} pedidos</span>
          <span class="tip-row">El denominador es el total que reporta VTEX, no App+Web: así la cuenta no se infla hasta el 100% a la fuerza.</span>`,
      }),
      tile({
        rail: CH_RAIL.web, icon: 'store', label: 'Participación Web', value: W.fmtPct(partWeb, 1),
        delta: basePrev ? W.delta(partWeb, mPrev.porCanal.web.orders / basePrev) : null,
        sub: subPart,
      }),
    ];

    // ── Una tarjeta por canal, con sus segmentos ───────────────────────────
    const canalCards = W.CHANNELS.map((ch) => {
      const c = m.porCanal[ch];
      const prev = mPrev ? mPrev.porCanal[ch] : null;
      const ticket = W.ticket(c.gmv, c.orders);
      const segs = W.SEGMENTS.map((s) => {
        const v = c.bySegment[s] || { orders: 0, gmv: 0 };
        const share = c.orders ? v.orders / c.orders : 0;
        return `<div class="chseg">
          <div class="chseg-t"><span class="chm-dot" style="background:${W.SEGMENT_COLOR[s]}"></span>${W.esc(W.SEGMENT_LABEL[s])}</div>
          <div class="chseg-v">${W.fmtNumC(v.orders)}</div>
          <div class="chseg-s">${W.fmtMoneyC(v.gmv)} · ${W.fmtPct(share, 0)}</div>
          <div class="chseg-bar"><div class="chseg-fill" style="width:${Math.min(100, share * 100)}%;background:${W.SEGMENT_COLOR[s]}"></div></div>
        </div>`;
      }).join('');

      return `<div class="card chcard" style="--rail:${CH_RAIL[ch]}">
        <div class="chcard-h">
          <div class="chcard-ti">
            <span class="chcard-ic" style="background:${CH_RAIL[ch]}1a;color:${CH_RAIL[ch]}">${W.icon(W.CHANNEL_ICON[ch], 15)}</span>
            <div>
              <strong>${W.esc(W.CHANNEL_LABEL[ch])}</strong>
              <em>${W.esc(W.CHANNEL_DESC[ch])}</em>
            </div>
          </div>
          ${prev ? W.deltaBadge(W.delta(c.orders, prev.orders)) : ''}
        </div>
        <div class="chcard-kpis">
          <div><span class="chk-v">${W.fmtNumC(c.orders)}</span><span class="chk-l">pedidos</span></div>
          <div><span class="chk-v">${W.fmtMoneyC(c.gmv)}</span><span class="chk-l">GMV</span></div>
          <div><span class="chk-v">${W.fmtMoney(ticket)}</span><span class="chk-l">ticket</span></div>
        </div>
        <div class="chsegs">${segs}</div>
      </div>`;
    }).join('');

    // ── La matriz ──────────────────────────────────────────────────────────
    const granTotal = m.total[metric] || 0;
    const filas = W.SEGMENTS.map((s) => segRow(s, m.celdas, m.porSegmento[s], granTotal, fmt)).join('');
    const totApp = m.porCanal.app[metric] || 0;
    const totWeb = m.porCanal.web[metric] || 0;

    const matriz = `<div class="card">
      <div class="card-h">
        <h3>Segmentos × canal</h3>
        ${W.metricToggle(metric, 'chmetric')}
      </div>
      <div class="tbl-wrap">
        <table class="tbl chm">
          <thead><tr>
            <th>Segmento</th>
            <th class="num"><span class="chm-th" style="--c:${CH_RAIL.app}">App</span></th>
            <th class="num"><span class="chm-th" style="--c:${CH_RAIL.web}">Web</span></th>
            <th class="num">Total</th>
            <th>Mix App / Web</th>
            <th class="num">% del total</th>
          </tr></thead>
          <tbody>${filas}</tbody>
          <tfoot><tr>
            <td class="chm-seg strong">Todos los segmentos</td>
            <td class="num strong">${fmt(totApp)}</td>
            <td class="num strong">${fmt(totWeb)}</td>
            <td class="num strong">${fmt(granTotal)}</td>
            <td class="chm-mix">${splitBar(totApp, totWeb)}<span class="chm-mixl">${W.fmtPct(granTotal ? totApp / granTotal : 0, 0)} app</span></td>
            <td class="num dim">100%</td>
          </tr></tfoot>
        </table>
      </div>
      <div class="card-f dim">${W.esc(rangeTxt)} · ${W.METRIC_LABEL[metric]} por segmento y canal.
        El mix dice qué porción de cada segmento viene de la app.</div>
    </div>`;

    el.innerHTML = `${avisoHtml}
      <div class="dash-hero">${tiles.join('')}</div>
      <div class="sec-h"><h3>Cada canal por separado</h3><span>${W.esc(rangeTxt)} · total del canal y sus cuatro segmentos</span></div>
      <div class="g2 chcards">${canalCards}</div>
      <div class="sec-h"><h3>El cruce completo</h3><span>los cuatro segmentos contra los dos canales</span></div>
      ${matriz}`;

    document.querySelectorAll('[data-chmetric]').forEach((b) =>
      b.addEventListener('click', () => { metric = b.dataset.chmetric; W.render(); }));

    ctx.exports.canales = {
      filename: `canales_${range.from}_${range.to}.csv`,
      headers: ['Segmento', 'Canal', 'Pedidos', 'GMV'],
      rows: W.SEGMENTS.flatMap((s) => W.CHANNELS.map((ch) => [
        W.SEGMENT_LABEL[s], W.CHANNEL_LABEL[ch], m.celdas[s][ch].orders, Math.round(m.celdas[s][ch].gmv),
      ])),
    };
  };
}());

/* global window, document, FileReader */
/**
 * Vista "Audiencias": constructor de segmentaciones accionables.
 *
 * El índice público identifica a cada cliente con un hash (no lleva datos
 * personales). Los emails viven en un repositorio PRIVADO y llegan por
 * /api/audience-emails, que guarda el token del lado del servidor: el
 * navegador nunca lo ve. Con eso, la exportación primaria es la lista de mails
 * — el CSV de hashes queda como salida secundaria para cruces técnicos.
 */
(function () {
  const W = (window.W = window.W || {});

  let idx = null;      // audience-index.json
  let D = null;        // columnas derivadas (recencia, churn, ciclo de vida)
  let emailMap = null; // hash -> email, solo en memoria de esta pestaña
  let emailSource = '';
  let emailTried = false;
  let rules = W.store.get('audienceRules', [{ field: 'ciclo', op: 'es', value: 'churn' }]);

  // ── Campos disponibles en el constructor ──────────────────────────────────
  const FIELDS = {
    ciclo:        { label: 'Ciclo de vida', type: 'lifecycle', ops: ['es', 'no es'] },
    segDominante: { label: 'Segmento dominante', type: 'segment', ops: ['es', 'no es'] },
    catDominante: { label: 'Categoría dominante', type: 'category', ops: ['es', 'no es'] },
    comproEnCat:  { label: 'Compró en la categoría', type: 'category', ops: ['sí', 'no'] },
    medioPago:    { label: 'Medio de pago habitual', type: 'payment', ops: ['es', 'no es'] },
    pedidos:      { label: 'Cantidad de pedidos', type: 'number', ops: ['≥', '≤', '='] },
    gasto:        { label: 'Gasto total (ARS)', type: 'number', ops: ['≥', '≤'] },
    ticket:       { label: 'Ticket promedio (ARS)', type: 'number', ops: ['≥', '≤'] },
    recencia:     { label: 'Días desde la última compra', type: 'number', ops: ['≥', '≤'] },
    antiguedad:   { label: 'Días desde la primera compra', type: 'number', ops: ['≥', '≤'] },
    intervalo:    { label: 'Días promedio entre compras', type: 'number', ops: ['≥', '≤'] },
    churnRatio:   { label: 'Ratio de abandono (recencia ÷ intervalo)', type: 'number', ops: ['≥', '≤'] },
    cuponPct:     { label: '% de pedidos con cupón', type: 'number', ops: ['≥', '≤'] },
    cuponPedidos: { label: 'Pedidos con cupón', type: 'number', ops: ['≥', '≤', '='] },
  };

  // ── Presets, agrupados por intención de campaña ───────────────────────────
  const PRESETS = [
    { group: 'Ciclo de vida', items: [
      { name: 'Campeones', icon: 'star', rules: [{ field: 'ciclo', op: 'es', value: 'campeon' }] },
      { name: 'Nuevos sin recompra', icon: 'sparkles', rules: [{ field: 'ciclo', op: 'es', value: 'nuevo' }] },
      { name: 'En riesgo', icon: 'alert', rules: [{ field: 'ciclo', op: 'es', value: 'riesgo' }] },
      { name: 'Churners', icon: 'trendDown', rules: [{ field: 'ciclo', op: 'es', value: 'churn' }] },
      { name: 'Anti-churn (fieles)', icon: 'heart', rules: [{ field: 'ciclo', op: 'es', value: 'activo' }, { field: 'pedidos', op: '≥', value: 4 }] },
      { name: 'Perdidos', icon: 'sleep', rules: [{ field: 'ciclo', op: 'es', value: 'perdido' }] },
    ]},
    { group: 'Cupones', needs: 'coupon', items: [
      { name: 'Cupón-dependientes', icon: 'tag', rules: [{ field: 'cuponPct', op: '≥', value: 70 }, { field: 'pedidos', op: '≥', value: 2 }] },
      { name: 'Nunca usó cupón', icon: 'shield', rules: [{ field: 'cuponPedidos', op: '=', value: 0 }, { field: 'pedidos', op: '≥', value: 2 }] },
      { name: 'Churn recuperable con cupón', icon: 'refresh', rules: [{ field: 'ciclo', op: 'es', value: 'churn' }, { field: 'cuponPct', op: '≥', value: 40 }] },
      { name: 'Fieles a precio lleno', icon: 'heart', rules: [{ field: 'cuponPedidos', op: '=', value: 0 }, { field: 'pedidos', op: '≥', value: 5 }] },
    ]},
    { group: 'Valor', items: [
      { name: 'Alto valor en fuga', icon: 'money', rules: [{ field: 'gasto', op: '≥', value: 500000 }, { field: 'churnRatio', op: '≥', value: 2 }] },
      { name: 'Ticket alto', icon: 'ticket', rules: [{ field: 'ticket', op: '≥', value: 200000 }] },
      { name: 'Alta frecuencia', icon: 'refresh', rules: [{ field: 'pedidos', op: '≥', value: 10 }] },
      { name: 'Compró una sola vez', icon: 'box', rules: [{ field: 'pedidos', op: '=', value: 1 }] },
    ]},
  ];

  // ── Derivadas: se calculan una vez al cargar el índice ────────────────────
  function derive() {
    const n = idx.count;
    const lastIdx = idx.days.length - 1;
    const recency = new Int32Array(n);
    const churn = new Float32Array(n);
    const life = new Array(n);
    const couponPct = new Float32Array(n);

    let sumG = 0;
    for (let i = 0; i < n; i++) sumG += idx.g[i];
    const avgG = n ? sumG / n : 0;

    for (let i = 0; i < n; i++) {
      const r = lastIdx - idx.l[i];
      recency[i] = r;
      const ip = idx.ip ? idx.ip[i] : 0;
      churn[i] = W.churnRatio(r, ip);
      life[i] = W.lifecycleOf(idx.o[i], r, ip, idx.g[i], avgG);
      couponPct[i] = idx.o[i] ? ((idx.cp ? idx.cp[i] : 0) / idx.o[i]) * 100 : 0;
    }
    return { recency, churn, life, couponPct, avgG, lastIdx };
  }

  /** Aplica todas las reglas (AND) y devuelve los índices que matchean. */
  function evaluate() {
    const n = idx.count;
    const out = [];
    const compiled = rules
      .map((r) => {
        const f = FIELDS[r.field];
        if (!f) return null;
        if (f.type === 'category') return { ...r, ci: idx.categories.indexOf(r.value) };
        if (f.type === 'segment') return { ...r, si: idx.segments.indexOf(r.value) };
        if (f.type === 'payment') return { ...r, pi: (idx.payments || []).indexOf(r.value) };
        if (f.type === 'lifecycle') return { ...r };
        return { ...r, num: Number(r.value) || 0 };
      })
      .filter(Boolean);

    const cmp = (v, op, t) => (op === '≥' ? v >= t : op === '≤' ? v <= t : v === t);

    for (let i = 0; i < n; i++) {
      let ok = true;
      for (const r of compiled) {
        switch (r.field) {
          case 'ciclo': ok = r.op === 'es' ? D.life[i] === r.value : D.life[i] !== r.value; break;
          case 'segDominante': ok = r.op === 'es' ? idx.sd[i] === r.si : idx.sd[i] !== r.si; break;
          case 'catDominante': ok = r.op === 'es' ? idx.cd[i] === r.ci : idx.cd[i] !== r.ci; break;
          case 'medioPago': ok = r.op === 'es' ? idx.pd?.[i] === r.pi : idx.pd?.[i] !== r.pi; break;
          case 'comproEnCat': { const has = idx.cs[i].includes(r.ci); ok = r.op === 'sí' ? has : !has; break; }
          case 'pedidos': ok = cmp(idx.o[i], r.op, r.num); break;
          case 'gasto': ok = cmp(idx.g[i], r.op, r.num); break;
          case 'ticket': ok = cmp(idx.o[i] ? idx.g[i] / idx.o[i] : 0, r.op, r.num); break;
          case 'recencia': ok = cmp(D.recency[i], r.op, r.num); break;
          case 'antiguedad': ok = cmp(D.lastIdx - idx.f[i], r.op, r.num); break;
          case 'intervalo': ok = cmp(idx.ip ? idx.ip[i] : 0, r.op, r.num); break;
          case 'churnRatio': ok = cmp(D.churn[i], r.op, r.num); break;
          case 'cuponPct': ok = cmp(D.couponPct[i], r.op, r.num); break;
          case 'cuponPedidos': ok = cmp(idx.cp ? idx.cp[i] : 0, r.op, r.num); break;
          default: ok = true;
        }
        if (!ok) break;
      }
      if (ok) out.push(i);
    }
    return out;
  }

  function summarize(m) {
    let orders = 0, gmv = 0, rec = 0, coup = 0;
    const bySeg = {}, byCat = {}, byLife = {};
    for (const i of m) {
      orders += idx.o[i];
      gmv += idx.g[i];
      rec += D.recency[i];
      coup += idx.cp ? idx.cp[i] : 0;
      const s = idx.segments[idx.sd[i]] || 'sin_dato';
      bySeg[s] = (bySeg[s] || 0) + 1;
      const c = idx.categories[idx.cd[i]] || 'Sin categoría';
      byCat[c] = (byCat[c] || 0) + 1;
      byLife[D.life[i]] = (byLife[D.life[i]] || 0) + 1;
    }
    return {
      customers: m.length, orders, gmv, bySeg, byCat, byLife,
      avgRecency: m.length ? rec / m.length : 0,
      couponRate: orders ? coup / orders : 0,
    };
  }

  // ── Emails desde el repo privado ──────────────────────────────────────────
  function parseHashEmailCsv(text) {
    const lines = String(text).split(/\r?\n/);
    const map = new Map();
    const start = (lines[0] || '').toLowerCase().includes('hash') ? 1 : 0;
    for (let i = start; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const c = lines[i].indexOf(',');
      if (c < 0) continue;
      const h = lines[i].slice(0, c).trim();
      const e = lines[i].slice(c + 1).trim().replace(/^"|"$/g, '');
      if (h && e) map.set(h, e);
    }
    return map.size ? map : null;
  }

  async function loadEmails() {
    if (emailTried) return;
    emailTried = true;
    try {
      const res = await fetch('/api/audience-emails', { cache: 'no-store' });
      if (!res.ok) return;
      const map = parseHashEmailCsv(await res.text());
      if (map) { emailMap = map; emailSource = 'repositorio privado'; }
    } catch { /* sin backend (local): queda el modo manual */ }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function ruleRow(r, i) {
    const f = FIELDS[r.field];
    const av = availability();
    const fieldOpts = Object.entries(FIELDS)
      .filter(([k]) => (av.coupon || !k.startsWith('cupon')) && (av.payment || k !== 'medioPago'))
      .map(([k, v]) => `<option value="${k}"${k === r.field ? ' selected' : ''}>${W.esc(v.label)}</option>`).join('');
    const opOpts = f.ops.map((o) => `<option${o === r.op ? ' selected' : ''}>${o}</option>`).join('');

    let val;
    if (f.type === 'lifecycle') {
      val = `<select class="rule-v" data-i="${i}">${W.LIFECYCLE_ORDER
        .map((k) => `<option value="${k}"${k === r.value ? ' selected' : ''}>${W.esc(W.LIFECYCLE[k].label)}</option>`).join('')}</select>`;
    } else if (f.type === 'segment') {
      val = `<select class="rule-v" data-i="${i}">${idx.segments
        .map((s) => `<option value="${W.esc(s)}"${s === r.value ? ' selected' : ''}>${W.esc(W.SEGMENT_LABEL[s] || s)}</option>`).join('')}</select>`;
    } else if (f.type === 'payment') {
      val = `<select class="rule-v" data-i="${i}">${(idx.payments || [])
        .map((p) => `<option value="${W.esc(p)}"${p === r.value ? ' selected' : ''}>${W.esc(p)}</option>`).join('')}</select>`;
    } else if (f.type === 'category') {
      val = `<select class="rule-v" data-i="${i}">${idx.categories
        .map((c) => `<option value="${W.esc(c)}"${c === r.value ? ' selected' : ''}>${W.esc(c)}</option>`).join('')}</select>`;
    } else {
      val = `<input class="rule-v" data-i="${i}" type="number" value="${W.esc(r.value)}" />`;
    }

    return `<div class="rule">
      <span class="rule-j">${i === 0 ? 'DONDE' : 'Y'}</span>
      <select class="rule-f" data-i="${i}">${fieldOpts}</select>
      <select class="rule-o" data-i="${i}">${opOpts}</select>
      ${val}
      <button class="rule-x" data-i="${i}" title="Quitar condición">${W.icon('close', 14)}</button>
    </div>`;
  }

  /** Qué datos por-cliente están disponibles en el índice actual. */
  function availability() {
    return {
      coupon: idx.hasCouponData !== false && (idx.cp || []).some((v) => v > 0),
      payment: idx.hasPaymentData !== false && (idx.payments || []).length > 0,
    };
  }

  W.viewAudiences = async function (ctx) {
    const { el } = ctx;
    if (!idx) {
      el.innerHTML = '<div class="loading">Cargando perfiles de clientes…</div>';
      try {
        idx = await W.load('audience-index');
      } catch {
        el.innerHTML = `<div class="empty"><h2>Todavía no hay perfiles</h2>
          <p>Corré el backfill y el agregador para generar <code>audience-index.json</code>.</p></div>`;
        return;
      }
      if (!idx.count) {
        el.innerHTML = `<div class="empty"><h2>Todavía no hay clientes</h2><p>Corré el backfill inicial (ver README).</p></div>`;
        idx = null;
        return;
      }
      D = derive();
    }
    await loadEmails();

    const avail = availability();
    const matches = evaluate();
    const sum = summarize(matches);
    const share = idx.count ? sum.customers / idx.count : 0;

    // Distribución de ciclo de vida de TODA la base (tarjetas clickeables)
    const lifeAll = {};
    for (let i = 0; i < idx.count; i++) lifeAll[D.life[i]] = (lifeAll[D.life[i]] || 0) + 1;

    ctx.exports.audienceData = {
      filename: `webdash-audiencia-datos-${new Date().toISOString().slice(0, 10)}.csv`,
      headers: ['hash', 'ciclo_de_vida', 'pedidos', 'gasto_total', 'ticket_promedio', 'primera_compra',
        'ultima_compra', 'dias_sin_comprar', 'intervalo_promedio_dias', 'ratio_abandono',
        'pedidos_con_cupon', 'pct_con_cupon', 'segmento_dominante', 'categoria_dominante', 'medio_pago'],
      rows: matches.map((i) => [
        idx.h[i], W.LIFECYCLE[D.life[i]].label, idx.o[i], idx.g[i],
        Math.round(idx.o[i] ? idx.g[i] / idx.o[i] : 0),
        idx.days[idx.f[i]], idx.days[idx.l[i]], D.recency[i],
        idx.ip ? idx.ip[i] : 0, D.churn[i].toFixed(2),
        idx.cp ? idx.cp[i] : 0, D.couponPct[i].toFixed(1),
        W.SEGMENT_LABEL[idx.segments[idx.sd[i]]] || '', idx.categories[idx.cd[i]] || '',
        (idx.payments || [])[idx.pd?.[i]] || '',
      ]),
    };

    const topCats = Object.entries(sum.byCat).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const saved = W.store.get('savedAudiences', []);
    let withMail = 0;
    if (emailMap) for (const i of matches) if (emailMap.has(idx.h[i])) withMail++;

    el.innerHTML = `
      <div class="card">
        <div class="card-h">
          <div><h3>Ciclo de vida de la base</h3>
          <p>${W.fmtNumC(idx.count)} clientes · clasificados comparando cuánto hace que no compran contra su propio ritmo habitual — hacé clic para filtrar</p></div>
        </div>
        <div class="lifes">${W.LIFECYCLE_ORDER.map((k) => {
          const L = W.LIFECYCLE[k], n = lifeAll[k] || 0;
          return `<button class="life" data-life="${k}">
            <div class="life-t" style="color:${L.color}">${W.icon(L.icon, 14)}${W.esc(L.label)}</div>
            <div class="life-n">${W.fmtNumC(n)}</div>
            <div class="life-p">${W.fmtPct(idx.count ? n / idx.count : 0)} de la base</div>
            <div class="life-d">${W.esc(L.desc)}</div>
          </button>`;
        }).join('')}</div>
      </div>

      <div class="aud">
        <div>
          <div class="card">
            <div class="card-h">
              <div><h3>Constructor de audiencias</h3><p>combiná condiciones y exportá la lista de mails para la campaña</p></div>
            </div>

            ${PRESETS.map((g, gi) => {
              const off = g.needs && !avail[g.needs];
              return `<div class="pre-group"><label>${W.esc(g.group)}${off
                ? ` <span class="scope" ${W.chart.tip('El dato de cupón por cliente se empezó a guardar después del backfill inicial. Se completa solo con las corridas diarias del pipeline, o de una con un backfill del período que quieras analizar.')}>sin datos todavía</span>`
                : ''}</label>
              <div class="pre-row">${g.items.map((p, pi) =>
                `<button class="pre" data-g="${gi}" data-p="${pi}"${off ? ' disabled' : ''}>${W.icon(p.icon, 14)}${W.esc(p.name)}</button>`).join('')}</div></div>`;
            }).join('')}

            <div class="rules">${rules.map(ruleRow).join('')}</div>
            <div class="rules-a">
              <button class="btn-s" id="add-rule">${W.icon('plus', 14)}Agregar condición</button>
              <button class="btn" id="clear-rules">Limpiar</button>
            </div>
          </div>

          <div class="g2">
            <div class="card">
              <div class="card-h"><div><h3>Composición</h3><p>por segmento dominante</p></div></div>
              ${W.chart.donut({
                items: Object.entries(sum.bySeg).sort((a, b) => b[1] - a[1])
                  .map(([s, v]) => ({ label: W.SEGMENT_LABEL[s] || s, value: v, color: W.SEGMENT_COLOR[s] || '#8b93a5' })),
                valueFmt: W.fmtNum, centerValue: W.fmtNumC(sum.customers), centerLabel: 'clientes',
              })}
            </div>
            <div class="card">
              <div class="card-h"><div><h3>Qué compran</h3><p>categoría principal de cada cliente</p></div></div>
              ${W.chart.barsH({ items: topCats.map(([c, v]) => ({ label: c, value: v })), valueFmt: W.fmtNum, color: 'var(--s3)', maxRows: 10 })}
            </div>
          </div>
        </div>

        <aside class="aud-side">
          <div class="card stick">
            <div class="aud-n">
              <b>${W.fmtNum(sum.customers)}</b>
              <span>clientes en la audiencia</span>
              <em>${W.fmtPct(share)} de ${W.fmtNumC(idx.count)}</em>
            </div>
            <div class="aud-st">
              <div><em>Pedidos</em><b>${W.fmtNumC(sum.orders)}</b></div>
              <div><em>GMV histórico</em><b>${W.fmtMoneyC(sum.gmv)}</b></div>
              <div><em>Ticket promedio</em><b>${W.fmtMoney(W.ticket(sum.gmv, sum.orders))}</b></div>
              <div><em>Pedidos por cliente</em><b>${W.fmtDec(sum.customers ? sum.orders / sum.customers : 0, 1)}</b></div>
              <div><em>Días sin comprar</em><b>${W.fmtNum(sum.avgRecency)}</b></div>
              ${avail.coupon ? `<div><em>Pedidos con cupón</em><b>${W.fmtPct(sum.couponRate)}</b></div>` : ''}
            </div>

            <div class="mail-box">
              <h4>${W.icon('mail', 15)}Lista de mails</h4>
              ${emailMap
                ? `<div class="mail-ok">${W.icon('check', 15)}<div><strong>${W.fmtNum(withMail)}</strong> de ${W.fmtNum(sum.customers)} con mail
                     <span class="mail-src">origen: ${W.esc(emailSource)}</span></div></div>`
                : `<p class="mail-no">Los mails no se guardan en este repo: los publica el pipeline en un repositorio
                     <strong>privado</strong> y se leen por <code>/api/audience-emails</code>. Si todavía no corrió,
                     podés cargar el CSV a mano — el cruce ocurre en tu navegador.</p>`}

              <button class="btn-p blk" id="exp-mails" ${emailMap && withMail ? '' : 'disabled'}>
                ${W.icon('download', 15)}Exportar ${emailMap && withMail ? W.fmtNum(withMail) + ' mails' : 'lista de mails'}
              </button>
              <button class="btn blk" data-export="audienceData" ${sum.customers ? '' : 'disabled'}>
                ${W.icon('layers', 15)}Exportar datos (sin mails)
              </button>

              <label class="drop" id="drop">
                <input type="file" id="mail-file" accept=".csv,text/csv" hidden />
                ${emailMap ? 'Reemplazar por un CSV propio' : 'Arrastrá el CSV acá'}<br/><small>o hacé clic para elegirlo</small>
              </label>
            </div>

            <div class="saved">
              <h4>Audiencias guardadas</h4>
              <div class="saved-r">
                <input class="inp" id="save-name" type="text" placeholder="Nombre" />
                <button class="btn-s" id="save-aud">${W.icon('save', 14)}</button>
              </div>
              ${saved.length
                ? `<ul class="saved-l">${saved.map((s, i) =>
                    `<li><button class="saved-go" data-i="${i}">${W.esc(s.name)}</button><button class="saved-x" data-i="${i}">${W.icon('close', 13)}</button></li>`).join('')}</ul>`
                : '<p class="muted" style="font-size:.75rem;margin-top:.4rem">Todavía no guardaste ninguna.</p>'}
            </div>
          </div>
        </aside>
      </div>`;

    wire(matches, sum, withMail);
  };

  function persist() { W.store.set('audienceRules', rules); W.render(); }

  function wire(matches, sum, withMail) {
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => [...document.querySelectorAll(s)];

    $$('.life').forEach((b) => b.addEventListener('click', () => {
      rules = [{ field: 'ciclo', op: 'es', value: b.dataset.life }];
      persist();
    }));
    $$('.pre').forEach((b) => b.addEventListener('click', () => {
      rules = JSON.parse(JSON.stringify(PRESETS[+b.dataset.g].items[+b.dataset.p].rules));
      persist();
    }));

    $$('.rule-f').forEach((sel) => sel.addEventListener('change', (e) => {
      const i = +e.target.dataset.i, field = e.target.value, f = FIELDS[field];
      const dflt = {
        lifecycle: 'churn', segment: idx.segments[0], category: idx.categories[0],
        payment: (idx.payments || [])[0] || '', number: 1,
      }[f.type];
      rules[i] = { field, op: f.ops[0], value: dflt };
      persist();
    }));
    $$('.rule-o').forEach((sel) => sel.addEventListener('change', (e) => { rules[+e.target.dataset.i].op = e.target.value; persist(); }));
    $$('.rule-v').forEach((inp) => inp.addEventListener('change', (e) => { rules[+e.target.dataset.i].value = e.target.value; persist(); }));
    $$('.rule-x').forEach((b) => b.addEventListener('click', (e) => { rules.splice(+e.currentTarget.dataset.i, 1); persist(); }));
    $('#add-rule')?.addEventListener('click', () => { rules.push({ field: 'pedidos', op: '≥', value: 2 }); persist(); });
    $('#clear-rules')?.addEventListener('click', () => { rules = []; persist(); });

    // ── Carga manual del CSV (alternativa al repo privado) ──────────────────
    const drop = $('#drop'), input = $('#mail-file');
    const handle = (file) => {
      if (!file) return;
      const rd = new FileReader();
      rd.onload = () => {
        const map = parseHashEmailCsv(rd.result);
        if (!map) { W.toast('No se encontraron pares hash,email en el archivo.', 'bad'); return; }
        emailMap = map;
        emailSource = `archivo ${file.name}`;
        W.toast(`Cargados ${W.fmtNum(map.size)} mails (solo en este navegador).`, 'good');
        W.render();
      };
      rd.readAsText(file);
    };
    input?.addEventListener('change', (e) => handle(e.target.files[0]));
    if (drop) {
      ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
      ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
      drop.addEventListener('drop', (e) => handle(e.dataTransfer.files[0]));
    }

    $('#exp-mails')?.addEventListener('click', () => {
      if (!emailMap) return;
      const rows = [];
      for (const i of matches) {
        const email = emailMap.get(idx.h[i]);
        if (!email) continue;
        rows.push([email, W.LIFECYCLE[D.life[i]].label, idx.o[i], idx.g[i],
          Math.round(idx.o[i] ? idx.g[i] / idx.o[i] : 0), idx.days[idx.l[i]], D.recency[i],
          idx.cp ? idx.cp[i] : 0, W.SEGMENT_LABEL[idx.segments[idx.sd[i]]] || '', idx.categories[idx.cd[i]] || '']);
      }
      if (!rows.length) { W.toast('Ningún cliente de la audiencia tiene mail disponible.', 'bad'); return; }
      W.downloadCSV(`webdash-mailing-${new Date().toISOString().slice(0, 10)}.csv`,
        ['email', 'ciclo_de_vida', 'pedidos', 'gasto_total', 'ticket_promedio', 'ultima_compra',
         'dias_sin_comprar', 'pedidos_con_cupon', 'segmento', 'categoria'], rows);
      W.toast(`Exportados ${W.fmtNum(rows.length)} mails.`, 'good');
    });

    $('#save-aud')?.addEventListener('click', () => {
      const name = ($('#save-name')?.value || '').trim();
      if (!name) { W.toast('Poné un nombre para guardar la audiencia.', 'bad'); return; }
      const list = W.store.get('savedAudiences', []);
      list.push({ name, rules: JSON.parse(JSON.stringify(rules)) });
      W.store.set('savedAudiences', list);
      W.toast(`Audiencia "${name}" guardada.`, 'good');
      W.render();
    });
    $$('.saved-go').forEach((b) => b.addEventListener('click', (e) => {
      rules = JSON.parse(JSON.stringify(W.store.get('savedAudiences', [])[+e.target.dataset.i].rules));
      persist();
    }));
    $$('.saved-x').forEach((b) => b.addEventListener('click', (e) => {
      const list = W.store.get('savedAudiences', []);
      list.splice(+e.currentTarget.dataset.i, 1);
      W.store.set('savedAudiences', list);
      W.render();
    }));
  }
})();

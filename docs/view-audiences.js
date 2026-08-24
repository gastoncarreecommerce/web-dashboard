/* global window, document, FileReader */
/**
 * Vista "Audiencias": constructor de segmentaciones sobre perfiles de cliente.
 *
 * Trabaja siempre con HASHES (audience-index.json no contiene datos personales).
 * Para obtener la lista de mails real, el usuario baja el artifact privado que
 * genera .github/workflows/webdash-audience-export.yml y lo carga acá: el cruce
 * hash -> email pasa entero en el navegador, el archivo nunca se sube.
 */
(function () {
  const W = (window.W = window.W || {});

  const FIELDS = {
    segDominante: { label: 'Segmento dominante', type: 'segment', ops: ['es', 'no es'] },
    catDominante: { label: 'Categoría dominante', type: 'category', ops: ['es', 'no es'] },
    comproEnCat: { label: 'Compró en la categoría', type: 'category', ops: ['sí', 'no'] },
    pedidos: { label: 'Cantidad de pedidos', type: 'number', ops: ['≥', '≤', '='] },
    gasto: { label: 'Gasto total (ARS)', type: 'number', ops: ['≥', '≤'] },
    ticket: { label: 'Ticket promedio (ARS)', type: 'number', ops: ['≥', '≤'] },
    recencia: { label: 'Días desde la última compra', type: 'number', ops: ['≤', '≥'] },
    antiguedad: { label: 'Días desde la primera compra', type: 'number', ops: ['≥', '≤'] },
  };

  let idx = null;          // audience-index.json
  let rules = W.store.get('audienceRules', [{ field: 'pedidos', op: '≥', value: 2 }]);
  let emailMap = null;     // Map hash -> email (solo en memoria, cargado por el usuario)
  let emailFileName = '';
  let lastMatch = null;    // Uint32Array de índices que matchean

  function quantile(sorted, q) {
    if (!sorted.length) return 0;
    const pos = (sorted.length - 1) * q;
    const base = Math.floor(pos);
    return sorted[base + 1] !== undefined ? sorted[base] + (sorted[base + 1] - sorted[base]) * (pos - base) : sorted[base];
  }

  /** Aplica todas las reglas (AND) y devuelve los índices que matchean. */
  function evaluate() {
    const n = idx.count;
    const lastDayIdx = idx.days.length - 1;
    const out = [];
    const catIndexOf = (name) => idx.categories.indexOf(name);
    const segIndexOf = (name) => idx.segments.indexOf(name);

    // Se resuelven los índices de las reglas una sola vez, fuera del loop de N clientes.
    const compiled = rules
      .map((r) => {
        const f = FIELDS[r.field];
        if (!f) return null;
        if (f.type === 'category') return { ...r, ci: catIndexOf(r.value) };
        if (f.type === 'segment') return { ...r, si: segIndexOf(r.value) };
        return { ...r, num: Number(r.value) || 0 };
      })
      .filter(Boolean);

    for (let i = 0; i < n; i++) {
      let ok = true;
      for (const r of compiled) {
        switch (r.field) {
          case 'segDominante': ok = r.op === 'es' ? idx.sd[i] === r.si : idx.sd[i] !== r.si; break;
          case 'catDominante': ok = r.op === 'es' ? idx.cd[i] === r.ci : idx.cd[i] !== r.ci; break;
          case 'comproEnCat': {
            const has = idx.cs[i].includes(r.ci);
            ok = r.op === 'sí' ? has : !has;
            break;
          }
          case 'pedidos': ok = r.op === '≥' ? idx.o[i] >= r.num : r.op === '≤' ? idx.o[i] <= r.num : idx.o[i] === r.num; break;
          case 'gasto': ok = r.op === '≥' ? idx.g[i] >= r.num : idx.g[i] <= r.num; break;
          case 'ticket': {
            const t = idx.o[i] ? idx.g[i] / idx.o[i] : 0;
            ok = r.op === '≥' ? t >= r.num : t <= r.num;
            break;
          }
          case 'recencia': {
            const rec = lastDayIdx - idx.l[i];
            ok = r.op === '≤' ? rec <= r.num : rec >= r.num;
            break;
          }
          case 'antiguedad': {
            const age = lastDayIdx - idx.f[i];
            ok = r.op === '≥' ? age >= r.num : age <= r.num;
            break;
          }
          default: ok = true;
        }
        if (!ok) break;
      }
      if (ok) out.push(i);
    }
    return out;
  }

  function summarize(matches) {
    const lastDayIdx = idx.days.length - 1;
    let orders = 0, gmv = 0, recencySum = 0;
    const bySeg = {}, byCat = {};
    for (const i of matches) {
      orders += idx.o[i];
      gmv += idx.g[i];
      recencySum += lastDayIdx - idx.l[i];
      const s = idx.segments[idx.sd[i]] || 'sin_dato';
      bySeg[s] = (bySeg[s] || 0) + 1;
      const c = idx.categories[idx.cd[i]] || 'Sin categoría';
      byCat[c] = (byCat[c] || 0) + 1;
    }
    return { customers: matches.length, orders, gmv, bySeg, byCat, avgRecency: matches.length ? recencySum / matches.length : 0 };
  }

  /** Grilla RFM 5×5 (recencia × frecuencia) sobre toda la base. */
  function rfmGrid() {
    const lastDayIdx = idx.days.length - 1;
    const rec = [], freq = [];
    for (let i = 0; i < idx.count; i++) { rec.push(lastDayIdx - idx.l[i]); freq.push(idx.o[i]); }
    const rs = [...rec].sort((a, b) => a - b);
    const fs = [...freq].sort((a, b) => a - b);
    const rCuts = [0.2, 0.4, 0.6, 0.8].map((q) => quantile(rs, q));
    const fCuts = [0.2, 0.4, 0.6, 0.8].map((q) => quantile(fs, q));
    const bucket = (v, cuts) => (v <= cuts[0] ? 0 : v <= cuts[1] ? 1 : v <= cuts[2] ? 2 : v <= cuts[3] ? 3 : 4);

    const m = Array.from({ length: 5 }, () => new Array(5).fill(0));
    for (let i = 0; i < idx.count; i++) {
      // Recencia invertida: R=5 (fila 0) es el que compró más recién.
      const r = 4 - bucket(rec[i], rCuts);
      const f = bucket(freq[i], fCuts);
      m[r][f] += 1;
    }
    return { matrix: m, rCuts, fCuts };
  }

  const PRESETS = [
    { name: '🏆 Campeones', desc: 'compran seguido y hace poco', rules: [{ field: 'pedidos', op: '≥', value: 5 }, { field: 'recencia', op: '≤', value: 30 }] },
    { name: '⚠️ En riesgo', desc: 'buenos clientes que no vuelven', rules: [{ field: 'pedidos', op: '≥', value: 4 }, { field: 'recencia', op: '≥', value: 60 }] },
    { name: '💤 Dormidos', desc: 'sin comprar hace más de 90 días', rules: [{ field: 'recencia', op: '≥', value: 90 }] },
    { name: '✨ Nuevos', desc: 'primera compra reciente, aún sin recompra', rules: [{ field: 'antiguedad', op: '≤', value: 30 }, { field: 'pedidos', op: '=', value: 1 }] },
    { name: '💎 Alto valor', desc: 'ticket promedio alto', rules: [{ field: 'ticket', op: '≥', value: 30000 }] },
    { name: '📱 Solo Quick', desc: 'dominan Quick Commerce', rules: [{ field: 'segDominante', op: 'es', value: 'quickcommerce' }] },
  ];

  function ruleRow(r, i) {
    const f = FIELDS[r.field];
    const fieldOpts = Object.entries(FIELDS).map(([k, v]) => `<option value="${k}"${k === r.field ? ' selected' : ''}>${W.esc(v.label)}</option>`).join('');
    const opOpts = f.ops.map((o) => `<option${o === r.op ? ' selected' : ''}>${o}</option>`).join('');
    let valueInput;
    if (f.type === 'segment') {
      valueInput = `<select class="rule-value" data-i="${i}">${idx.segments.map((s) => `<option value="${W.esc(s)}"${s === r.value ? ' selected' : ''}>${W.esc(W.SEGMENT_LABEL[s] || s)}</option>`).join('')}</select>`;
    } else if (f.type === 'category') {
      valueInput = `<select class="rule-value" data-i="${i}">${idx.categories.map((c) => `<option value="${W.esc(c)}"${c === r.value ? ' selected' : ''}>${W.esc(c)}</option>`).join('')}</select>`;
    } else {
      valueInput = `<input class="rule-value" data-i="${i}" type="number" value="${W.esc(r.value)}" />`;
    }
    return `<div class="rule">
      <span class="rule-join">${i === 0 ? 'DONDE' : 'Y'}</span>
      <select class="rule-field" data-i="${i}">${fieldOpts}</select>
      <select class="rule-op" data-i="${i}">${opOpts}</select>
      ${valueInput}
      <button class="rule-del" data-i="${i}" title="Quitar condición">✕</button>
    </div>`;
  }

  W.viewAudiences = async function (ctx) {
    const { el } = ctx;
    el.innerHTML = `<div class="loading">Cargando perfiles de clientes… <span class="muted">(el índice puede pesar varios MB)</span></div>`;

    try {
      idx = await W.load('audience-index');
    } catch (e) {
      el.innerHTML = `<div class="empty-state"><h2>Todavía no hay perfiles</h2>
        <p>Corré el backfill y el agregador para generar <code>audience-index.json</code>.</p></div>`;
      return;
    }
    if (!idx.count) {
      el.innerHTML = `<div class="empty-state"><h2>Todavía no hay clientes</h2><p>Corré el backfill inicial (ver README).</p></div>`;
      return;
    }

    const matches = evaluate();
    lastMatch = matches;
    const sum = summarize(matches);
    const pctBase = idx.count ? sum.customers / idx.count : 0;
    const rfm = rfmGrid();
    const saved = W.store.get('savedAudiences', []);

    ctx.exports.audience = {
      filename: `webdash-audiencia-${new Date().toISOString().slice(0, 10)}.csv`,
      headers: ['hash', 'pedidos', 'gasto_total', 'ticket_promedio', 'primera_compra', 'ultima_compra', 'dias_sin_comprar', 'segmento_dominante', 'categoria_dominante'],
      rows: matches.map((i) => [
        idx.h[i], idx.o[i], idx.g[i], Math.round(idx.o[i] ? idx.g[i] / idx.o[i] : 0),
        idx.days[idx.f[i]], idx.days[idx.l[i]], idx.days.length - 1 - idx.l[i],
        W.SEGMENT_LABEL[idx.segments[idx.sd[i]]] || '', idx.categories[idx.cd[i]] || '',
      ]),
    };

    const topCats = Object.entries(sum.byCat).sort((a, b) => b[1] - a[1]).slice(0, 10);

    el.innerHTML = `
      <div class="builder-layout">
        <div class="builder-main">
          <div class="panel">
            <div class="panel-head">
              <div><h3>Constructor de audiencias</h3><p>combiná condiciones para aislar un grupo de clientes y exportarlo como lista de mailing</p></div>
            </div>

            <div class="presets">${PRESETS.map((p, i) => `<button class="preset-chip" data-preset="${i}" title="${W.esc(p.desc)}">${W.esc(p.name)}</button>`).join('')}</div>

            <div class="rules">${rules.map(ruleRow).join('')}</div>
            <div class="rules-actions">
              <button class="btn-secondary" id="add-rule">+ Agregar condición</button>
              <button class="btn-ghost" id="clear-rules">Limpiar todo</button>
            </div>
          </div>

          <div class="grid-2">
            <div class="panel">
              <div class="panel-head"><div><h3>Composición de la audiencia</h3><p>por segmento dominante</p></div></div>
              ${W.chart.donut({
                items: Object.entries(sum.bySeg).map(([s, v]) => ({ label: W.SEGMENT_LABEL[s] || s, value: v, color: W.SEGMENT_COLOR[s] || '#898781' })),
                valueFmt: W.fmtNum, centerValue: W.fmtNumC(sum.customers), centerLabel: 'clientes',
              })}
            </div>
            <div class="panel">
              <div class="panel-head"><div><h3>Categorías dominantes</h3><p>qué compra principalmente esta audiencia</p></div></div>
              ${W.chart.barsH({ items: topCats.map(([c, v]) => ({ label: c, value: v })), valueFmt: W.fmtNum, color: '#1baf7a', maxRows: 10 })}
            </div>
          </div>

          <div class="panel">
            <div class="panel-head"><div><h3>Matriz RFM de toda la base</h3>
              <p>recencia × frecuencia — arriba a la derecha están tus mejores clientes, abajo a la izquierda los que estás perdiendo</p></div></div>
            ${W.chart.heatmap({
              rows: ['R5 · más reciente', 'R4', 'R3', 'R2', 'R1 · más lejano'],
              cols: ['F1 · menos', 'F2', 'F3', 'F4', 'F5 · más'],
              matrix: rfm.matrix, fmt: W.fmtNumC,
              tipFmt: (r, c, v) => `<strong>${r} / ${c}</strong><span class="tip-row"><b>${W.fmtNum(v)}</b> clientes</span>`,
            })}
          </div>
        </div>

        <aside class="builder-side">
          <div class="panel sticky">
            <div class="audience-count">
              <span class="ac-value">${W.fmtNum(sum.customers)}</span>
              <span class="ac-label">clientes en la audiencia</span>
              <span class="ac-share">${W.fmtPct(pctBase)} de la base (${W.fmtNumC(idx.count)})</span>
            </div>
            <div class="ac-stats">
              <div><em>Pedidos</em><b>${W.fmtNumC(sum.orders)}</b></div>
              <div><em>GMV histórico</em><b>${W.fmtMoneyC(sum.gmv)}</b></div>
              <div><em>Ticket promedio</em><b>${W.fmtMoney(W.ticket(sum.gmv, sum.orders))}</b></div>
              <div><em>Pedidos por cliente</em><b>${W.fmtDec(sum.customers ? sum.orders / sum.customers : 0, 1)}</b></div>
              <div><em>Días sin comprar (prom.)</em><b>${W.fmtNum(sum.avgRecency)}</b></div>
            </div>

            <button class="btn-primary block" data-export="audience" ${sum.customers ? '' : 'disabled'}>⭳ Exportar audiencia (hashes)</button>

            <div class="pii-box">
              <h4>Lista de mails</h4>
              <p>El sitio es público, así que los emails no viven acá. Bajá el artifact privado del workflow
                <code>WebDash export audiencia</code>, cargalo abajo y el cruce ocurre <strong>en tu navegador</strong> — el archivo no se sube a ningún lado.</p>
              <label class="file-drop" id="file-drop">
                <input type="file" id="email-file" accept=".csv,text/csv" hidden />
                ${emailMap
                  ? `<span class="fd-ok">✓ ${W.esc(emailFileName)}<br/><small>${W.fmtNum(emailMap.size)} mails disponibles</small></span>`
                  : '<span class="fd-idle">Arrastrá el CSV acá<br/><small>o hacé clic para elegirlo</small></span>'}
              </label>
              <button class="btn-primary block" id="export-emails" ${emailMap && sum.customers ? '' : 'disabled'}>⭳ Exportar lista de mails</button>
              ${emailMap ? `<p class="muted small" id="match-preview"></p>` : ''}
            </div>

            <div class="saved">
              <h4>Audiencias guardadas</h4>
              <div class="saved-row">
                <input id="save-name" type="text" placeholder="Nombre de la audiencia" />
                <button class="btn-secondary" id="save-audience">Guardar</button>
              </div>
              ${saved.length
                ? `<ul class="saved-list">${saved.map((s, i) => `<li><button class="saved-load" data-i="${i}">${W.esc(s.name)}</button><button class="saved-del" data-i="${i}" title="Borrar">✕</button></li>`).join('')}</ul>`
                : '<p class="muted small">Todavía no guardaste ninguna.</p>'}
            </div>
          </div>
        </aside>
      </div>`;

    wire(ctx, matches, sum);
  };

  function persistAndRender() {
    W.store.set('audienceRules', rules);
    W.render();
  }

  function wire(ctx, matches, sum) {
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => [...document.querySelectorAll(s)];

    $$('.rule-field').forEach((s) => s.addEventListener('change', (e) => {
      const i = +e.target.dataset.i;
      const field = e.target.value;
      const f = FIELDS[field];
      rules[i] = {
        field,
        op: f.ops[0],
        value: f.type === 'segment' ? idx.segments[0] : f.type === 'category' ? idx.categories[0] : 1,
      };
      persistAndRender();
    }));
    $$('.rule-op').forEach((s) => s.addEventListener('change', (e) => { rules[+e.target.dataset.i].op = e.target.value; persistAndRender(); }));
    $$('.rule-value').forEach((s) => s.addEventListener('change', (e) => { rules[+e.target.dataset.i].value = e.target.value; persistAndRender(); }));
    $$('.rule-del').forEach((b) => b.addEventListener('click', (e) => { rules.splice(+e.target.dataset.i, 1); persistAndRender(); }));

    $('#add-rule')?.addEventListener('click', () => { rules.push({ field: 'pedidos', op: '≥', value: 2 }); persistAndRender(); });
    $('#clear-rules')?.addEventListener('click', () => { rules = []; persistAndRender(); });

    $$('.preset-chip').forEach((b) => b.addEventListener('click', (e) => {
      rules = JSON.parse(JSON.stringify(PRESETS[+e.currentTarget.dataset.preset].rules));
      persistAndRender();
    }));

    // ── Carga del archivo privado hash -> email ────────────────────────────
    const drop = $('#file-drop');
    const input = $('#email-file');
    const handleFile = (file) => {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const text = String(reader.result);
          const lines = text.split(/\r?\n/);
          const map = new Map();
          const header = (lines[0] || '').toLowerCase();
          const start = header.includes('hash') ? 1 : 0;
          for (let i = start; i < lines.length; i++) {
            const line = lines[i];
            if (!line.trim()) continue;
            const parts = line.split(',');
            const hash = (parts[0] || '').trim().replace(/^"|"$/g, '');
            const email = (parts[1] || '').trim().replace(/^"|"$/g, '');
            if (hash && email) map.set(hash, email);
          }
          if (!map.size) { W.toast('No se encontraron pares hash,email en el archivo.', 'bad'); return; }
          emailMap = map;
          emailFileName = file.name;
          W.toast(`Cargados ${W.fmtNum(map.size)} mails (solo en memoria de este navegador).`, 'good');
          W.render();
        } catch (err) {
          W.toast('No se pudo leer el archivo: ' + err.message, 'bad');
        }
      };
      reader.readAsText(file);
    };

    input?.addEventListener('change', (e) => handleFile(e.target.files[0]));
    if (drop) {
      ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
      ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
      drop.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));
    }

    if (emailMap) {
      let hit = 0;
      for (const i of matches) if (emailMap.has(idx.h[i])) hit++;
      const prev = document.getElementById('match-preview');
      if (prev) {
        prev.innerHTML = `${W.fmtNum(hit)} de ${W.fmtNum(matches.length)} clientes de la audiencia tienen mail en el archivo cargado${
          hit < matches.length ? ` — los ${W.fmtNum(matches.length - hit)} restantes compraron fuera del rango que exportaste.` : '.'}`;
      }
    }

    $('#export-emails')?.addEventListener('click', () => {
      if (!emailMap) return;
      const rows = [];
      for (const i of matches) {
        const email = emailMap.get(idx.h[i]);
        if (!email) continue;
        rows.push([email, idx.o[i], idx.g[i], Math.round(idx.o[i] ? idx.g[i] / idx.o[i] : 0),
          idx.days[idx.l[i]], W.SEGMENT_LABEL[idx.segments[idx.sd[i]]] || '', idx.categories[idx.cd[i]] || '']);
      }
      if (!rows.length) { W.toast('Ningún cliente de la audiencia tiene mail en el archivo cargado.', 'bad'); return; }
      W.downloadCSV(`webdash-mailing-${new Date().toISOString().slice(0, 10)}.csv`,
        ['email', 'pedidos', 'gasto_total', 'ticket_promedio', 'ultima_compra', 'segmento_dominante', 'categoria_dominante'], rows);
      W.toast(`Exportados ${W.fmtNum(rows.length)} mails.`, 'good');
    });

    // ── Audiencias guardadas ──────────────────────────────────────────────
    $('#save-audience')?.addEventListener('click', () => {
      const name = ($('#save-name')?.value || '').trim();
      if (!name) { W.toast('Poné un nombre para guardar la audiencia.', 'bad'); return; }
      const list = W.store.get('savedAudiences', []);
      list.push({ name, rules: JSON.parse(JSON.stringify(rules)) });
      W.store.set('savedAudiences', list);
      W.toast(`Audiencia "${name}" guardada.`, 'good');
      W.render();
    });
    $$('.saved-load').forEach((b) => b.addEventListener('click', (e) => {
      const list = W.store.get('savedAudiences', []);
      rules = JSON.parse(JSON.stringify(list[+e.target.dataset.i].rules));
      persistAndRender();
    }));
    $$('.saved-del').forEach((b) => b.addEventListener('click', (e) => {
      const list = W.store.get('savedAudiences', []);
      list.splice(+e.target.dataset.i, 1);
      W.store.set('savedAudiences', list);
      W.render();
    }));
  }
})();

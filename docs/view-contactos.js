/* global window, document, FileReader, navigator */
/**
 * Vista "Contactos SFMC": pegar o subir una lista de DNIs y traer de Salesforce
 * Marketing Cloud el mail asociado a cada uno.
 *
 * Todo pasa por /api/sfmc-contacts (las credenciales viven en el servidor).
 * Se manda de a 200 DNIs por pedido para poder mostrar el progreso y no chocar
 * contra el tiempo máximo de una función. Los resultados quedan solo en esta
 * pestaña: no se guardan en ningún lado.
 */
(function () {
  const W = (window.W = window.W || {});
  const CHUNK = 200;
  const MAX_TOTAL = 20000;

  const S = { text: '', running: false, done: 0, total: 0, results: null, notFound: [], invalid: [], error: null, filter: 'todos' };

  // Saca DNIs de cualquier texto: Excel pegado, CSV, separados por coma, con
  // puntos ("12.345.678")… Se queda con números de 6 a 9 dígitos.
  function parseDnis(text) {
    const tokens = String(text || '').split(/[\s,;|\t]+/).map((t) => t.trim()).filter(Boolean);
    const out = [], invalid = [], seen = new Set();
    for (const t of tokens) {
      const d = t.replace(/[.\-]/g, '');
      if (!/^\d+$/.test(d)) { if (/\d/.test(t)) invalid.push(t); continue; }
      const n = d.replace(/^0+/, '');
      if (n.length < 6 || n.length > 9) { invalid.push(t); continue; }
      if (!seen.has(n)) { seen.add(n); out.push(n); }
    }
    return { dnis: out, invalid };
  }

  const STATUS = { Active: ['Activo', 'ok'], Unsubscribed: ['Desuscripto', 'w'], Held: ['Retenido', 'no'], Bounced: ['Rebotado', 'no'], Deleted: ['Borrado', 'n'] };
  const statusPill = (s) => { const x = STATUS[s] || [s || '—', 'n']; return `<span class="pill ${x[1]}">${W.esc(x[0])}</span>`; };

  async function run() {
    const { dnis, invalid } = parseDnis(S.text);
    if (!dnis.length) { W.toast('No encontré DNIs en lo que pegaste.', 'bad'); return; }
    if (dnis.length > MAX_TOTAL) { W.toast(`Son ${W.fmtNum(dnis.length)} DNIs: el máximo por vez es ${W.fmtNum(MAX_TOTAL)}.`, 'bad'); return; }
    Object.assign(S, { running: true, done: 0, total: dnis.length, results: [], notFound: [], invalid, error: null, filter: 'todos' });
    W.render();
    for (let i = 0; i < dnis.length; i += CHUNK) {
      const part = dnis.slice(i, i + CHUNK);
      try {
        const r = await fetch('/api/sfmc-contacts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dnis: part }) });
        const j = await r.json().catch(() => ({}));
        if (r.status === 503) throw new Error(`Falta configurar la conexión con Marketing Cloud en Vercel${j.faltan ? `: ${j.faltan.join(', ')}` : ''}.`);
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        S.results.push(...(j.results || []));
        S.notFound.push(...(j.notFound || []));
        S.invalid.push(...(j.invalid || []));
      } catch (e) {
        S.error = `${e.message} (se procesaron ${W.fmtNum(S.done)} de ${W.fmtNum(S.total)}).`;
        break;
      }
      S.done = Math.min(S.total, i + part.length);
      paintProgress();
    }
    S.running = false;
    W.render();
  }

  function paintProgress() {
    const bar = document.getElementById('ct-bar');
    const txt = document.getElementById('ct-prog');
    if (bar) bar.style.width = `${S.total ? Math.round((S.done / S.total) * 100) : 0}%`;
    if (txt) txt.textContent = `Consultando Marketing Cloud… ${W.fmtNum(S.done)} de ${W.fmtNum(S.total)} DNIs`;
  }

  function exportXlsx() {
    const rows = [['DNI', 'MAIL', 'ESTADO EN SFMC']];
    for (const r of S.results) rows.push([r.dni, r.email, (STATUS[r.status] || [r.status])[0]]);
    const sheets = [{ name: 'Encontrados', rows }];
    if (S.notFound.length) sheets.push({ name: 'Sin mail', rows: [['DNI'], ...S.notFound.map((d) => [d])] });
    if (S.invalid.length) sheets.push({ name: 'No válidos', rows: [['Valor'], ...S.invalid.map((d) => [d])] });
    W.downloadXLSX(`sfmc-dni-mails-${W.arDateOf(new Date().toISOString())}.xlsx`, sheets);
  }

  W.viewContactos = async function (ctx) {
    const { el } = ctx;
    const pre = parseDnis(S.text);
    const dnisFound = new Set(S.results ? S.results.map((r) => r.dni) : []);
    const multi = S.results ? S.results.length - dnisFound.size : 0;
    const shown = !S.results ? [] : S.filter === 'activos' ? S.results.filter((r) => r.status === 'Active')
      : S.filter === 'otros' ? S.results.filter((r) => r.status !== 'Active') : S.results;

    el.innerHTML = `
      <div class="card ct-intro">
        <div class="ct-ic">${W.icon('mail', 20)}</div>
        <div><h3>DNI → mail desde Marketing Cloud</h3>
          <p>Pegá una lista de DNIs (una columna de Excel, separados por coma o por renglón) y te devuelvo el mail que tiene cada uno en Salesforce Marketing Cloud.
            Los resultados quedan solo en esta pestaña; cada consulta queda registrada (quién y cuántos DNIs, nunca los datos).</p></div>
      </div>

      <div class="ct-grid">
        <div class="card">
          <div class="card-h"><div><h3>1. Cargá los DNIs</h3><p>con o sin puntos, hasta ${W.fmtNum(MAX_TOTAL)} por vez</p></div>
            <label class="btn ct-file">${W.icon('download', 14)}Subir CSV o TXT<input type="file" id="ct-file" accept=".csv,.txt,text/csv,text/plain" hidden /></label></div>
          <textarea class="inp ct-ta" id="ct-ta" placeholder="30123456&#10;27.456.789&#10;40111222, 35222333…" ${S.running ? 'disabled' : ''}>${W.esc(S.text)}</textarea>
          <div class="ct-pre" id="ct-pre">${pre.dnis.length ? `<b>${W.fmtNum(pre.dnis.length)}</b> DNIs válidos${pre.invalid.length ? ` · <span class="au-warn">${W.fmtNum(pre.invalid.length)} no parecen DNI</span>` : ''}` : '<span class="muted">Todavía no hay DNIs.</span>'}</div>
          <div class="ct-actions">
            <button class="btn-p" id="ct-go" ${S.running || !pre.dnis.length ? 'disabled' : ''}>${W.icon('search', 14)}Buscar mails</button>
            ${S.text ? `<button class="btn-s" id="ct-clear" ${S.running ? 'disabled' : ''}>${W.icon('close', 12)}Limpiar</button>` : ''}
          </div>
          ${S.running ? `<div class="ct-progress"><span class="au-share"><i id="ct-bar" style="width:${S.total ? Math.round((S.done / S.total) * 100) : 0}%"></i></span><p id="ct-prog" class="muted">Consultando Marketing Cloud… ${W.fmtNum(S.done)} de ${W.fmtNum(S.total)} DNIs</p></div>` : ''}
          ${S.error ? `<div class="ins bad">${W.icon('alert', 16)}<div><p>${W.esc(S.error)}</p></div></div>` : ''}
        </div>

        <div class="card">
          <div class="card-h"><div><h3>2. Resultado</h3><p>${S.results ? `${W.fmtNum(S.total)} DNIs consultados` : 'aparece acá cuando busques'}</p></div>
            ${S.results?.length ? `<div class="card-a"><button class="btn" id="ct-copy">${W.icon('save', 14)}Copiar mails</button><button class="btn-p" id="ct-xlsx">${W.icon('download', 14)}Excel</button></div>` : ''}</div>
          ${S.results ? `
            <div class="sx-mini">
              <div><b>${W.fmtNum(dnisFound.size)}</b><em>DNIs con mail</em></div>
              <div><b>${W.fmtNum(S.notFound.length)}</b><em>sin mail en SFMC</em></div>
              <div><b>${W.fmtNum(S.invalid.length)}</b><em>no válidos</em></div>
              ${multi ? `<div><b>${W.fmtNum(multi)}</b><em>mails extra (DNI con más de uno)</em></div>` : ''}
            </div>
            ${S.results.length ? `<div class="sx-filters" style="margin-bottom:.6rem">${[['todos', 'Todos'], ['activos', 'Solo activos'], ['otros', 'Desuscriptos / rebotados']].map(([k, l]) => `<button class="chip-sm${S.filter === k ? ' on' : ''}" data-ctf="${k}">${l}</button>`).join('')}</div>
            <div class="tbl-wrap ct-res"><table class="tbl dense"><thead><tr><th>DNI</th><th>Mail</th><th>Estado</th></tr></thead>
              <tbody>${shown.slice(0, 500).map((r) => `<tr><td>${W.esc(r.dni)}</td><td>${W.esc(r.email)}</td><td>${statusPill(r.status)}</td></tr>`).join('')}</tbody></table></div>
            ${shown.length > 500 ? `<p class="sx-foot">Se muestran 500 de ${W.fmtNum(shown.length)}: el Excel trae todos.</p>` : ''}` : ''}
            ${S.notFound.length ? `<details class="ct-nf"><summary>${W.fmtNum(S.notFound.length)} DNIs sin mail en Marketing Cloud</summary><p>${S.notFound.slice(0, 300).map(W.esc).join(', ')}${S.notFound.length > 300 ? '…' : ''}</p></details>` : ''}
            <p class="sx-foot">"Sin mail" = no hay un suscriptor con ese DNI como Clave del Suscriptor en Marketing Cloud. Un mail desuscripto o rebotado existe, pero no conviene usarlo para un envío.</p>`
    : '<div class="chart-empty">Cargá DNIs a la izquierda y tocá "Buscar mails".</div>'}
        </div>
      </div>`;

    const ta = el.querySelector('#ct-ta');
    ta?.addEventListener('input', () => {
      S.text = ta.value;
      const p = parseDnis(S.text);
      el.querySelector('#ct-pre').innerHTML = p.dnis.length ? `<b>${W.fmtNum(p.dnis.length)}</b> DNIs válidos${p.invalid.length ? ` · <span class="au-warn">${W.fmtNum(p.invalid.length)} no parecen DNI</span>` : ''}` : '<span class="muted">Todavía no hay DNIs.</span>';
      el.querySelector('#ct-go').disabled = !p.dnis.length;
    });
    el.querySelector('#ct-file')?.addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => { S.text = String(rd.result || ''); W.render(); };
      rd.readAsText(f);
    });
    el.querySelector('#ct-go')?.addEventListener('click', run);
    el.querySelector('#ct-clear')?.addEventListener('click', () => { Object.assign(S, { text: '', results: null, notFound: [], invalid: [], error: null }); W.render(); });
    el.querySelector('#ct-xlsx')?.addEventListener('click', exportXlsx);
    el.querySelector('#ct-copy')?.addEventListener('click', () => {
      const mails = [...new Set(shown.map((r) => r.email))].join('\n');
      navigator.clipboard?.writeText(mails).then(() => W.toast(`Copiados ${W.fmtNum(mails.split('\n').length)} mails.`, 'good'));
    });
    el.querySelectorAll('[data-ctf]').forEach((b) => b.addEventListener('click', () => { S.filter = b.dataset.ctf; W.render(); }));
  };
})();

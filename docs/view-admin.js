/* global window, document */
/**
 * Vista "Accesos" (solo administradores): qué módulos ve cada persona.
 *
 * Cada cambio se guarda al instante en /api/access. A la persona le llega en
 * menos de un minuto (su sesión se renueva cada minuto de uso y trae los
 * módulos habilitados); el servidor también le niega los datos propios de los
 * módulos que no tiene.
 */
(function () {
  const W = (window.W = window.W || {});

  let data = null;   // { modules, users, updatedAt, updatedBy }
  let state = 'idle';
  let errMsg = '';
  let q = '';
  const saving = new Set();

  const initials = (name) => String(name).split(/[\s_]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

  async function load() {
    state = 'loading';
    try {
      const r = await fetch('/api/access', { cache: 'no-store' });
      if (r.status === 503) { state = 'error'; errMsg = 'El almacenamiento compartido (Redis) no está configurado.'; }
      else if (r.status === 403) { state = 'error'; errMsg = 'Solo los administradores pueden ver esta pantalla.'; }
      else if (!r.ok) { state = 'error'; errMsg = `No se pudo cargar (HTTP ${r.status}).`; }
      else { data = await r.json(); state = 'ready'; }
    } catch {
      state = 'error'; errMsg = 'No se pudo conectar con el servidor.';
    }
    W.render();
  }

  async function save(u, views) {
    const prev = u.views;
    u.views = views;
    saving.add(u.username);
    W.render();
    try {
      const r = await fetch('/api/access', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u.username, views }),
      });
      if (!r.ok) throw new Error(String(r.status));
      const out = await r.json();
      u.views = out.views;
      data.updatedAt = out.updatedAt;
      data.updatedBy = out.updatedBy;
    } catch {
      u.views = prev;
      W.toast(`No se pudo guardar el acceso de ${u.name}.`, 'bad');
    }
    saving.delete(u.username);
    W.render();
  }

  W.viewAdmin = async function (ctx) {
    const { el } = ctx;
    if (!W.session?.me?.admin) {
      el.innerHTML = '<div class="empty"><h2>Solo administradores</h2><p>Esta pantalla es para quien administra los accesos.</p></div>';
      return;
    }
    if (state === 'idle') { load(); }
    if (state === 'idle' || state === 'loading') { el.innerHTML = '<div class="loading">Cargando accesos…</div>'; return; }
    if (state === 'error') {
      el.innerHTML = `<div class="empty err"><h2>No se pudieron cargar los accesos</h2><p>${W.esc(errMsg)}</p>
        <button class="btn" id="adm-retry">${W.icon('refresh', 14)}Reintentar</button></div>`;
      document.getElementById('adm-retry').addEventListener('click', () => { state = 'idle'; W.render(); });
      return;
    }

    const M = data.modules;
    // "Todo" = los módulos comunes. Los opcionales (datos personales) nunca
    // entran por "Todo": se tildan a mano.
    const BASE = M.filter((m) => !m.optIn).map((m) => m.k);
    const sees = (u, m) => (u.admin ? true : Array.isArray(u.views) ? u.views.includes(m.k) : !m.optIn);
    const groups = [];
    for (const m of M) {
      const g = groups.find((x) => x.name === m.group);
      if (g) g.mods.push(m); else groups.push({ name: m.group, mods: [m] });
    }
    const users = data.users.filter((u) => !q || `${u.name} ${u.username}`.toLowerCase().includes(q.toLowerCase()));
    const restricted = data.users.filter((u) => !u.admin && Array.isArray(u.views)).length;
    const full = data.users.length - restricted;
    const perModule = Object.fromEntries(M.map((m) => [m.k, data.users.filter((u) => sees(u, m)).length]));

    el.innerHTML = `
      <div class="card adm-h">
        <div>
          <h3>${W.icon('shield', 16)} Accesos por módulo</h3>
          <p>Elegí qué módulos ve cada persona. Se guarda al instante y le llega en menos de un minuto.
            Quien tiene <b>Todo</b> prendido ve el dashboard completo, incluidos los módulos que se agreguen en el futuro.</p>
        </div>
        <div class="adm-sum">
          <div><b>${W.fmtNum(data.users.length)}</b><em>personas</em></div>
          <div><b>${W.fmtNum(full)}</b><em>ven todo</em></div>
          <div><b>${W.fmtNum(restricted)}</b><em>con acceso limitado</em></div>
        </div>
      </div>

      <div class="card">
        <div class="card-h">
          <input class="inp adm-q" id="adm-q" type="search" placeholder="Buscar persona…" value="${W.esc(q)}" />
          <span class="muted adm-upd">${data.updatedAt ? `Último cambio: ${W.esc(data.updatedBy || '')} · ${W.esc(W.arDateTimeOf ? W.arDateTimeOf(data.updatedAt).slice(0, 16) : data.updatedAt)}` : 'Todavía nadie tiene acceso limitado.'}</span>
        </div>
        <div class="tbl-wrap"><table class="tbl adm-t">
          <thead>
            <tr class="adm-g"><th rowspan="2">Persona</th><th rowspan="2" class="c">Todo</th>${groups.map((g) => `<th colspan="${g.mods.length}" class="c">${W.esc(g.name)}</th>`).join('')}</tr>
            <tr>${M.map((m) => `<th class="c adm-m" ${W.chart.tip(`${W.fmtNum(perModule[m.k])} personas lo ven`)}>${W.esc(m.label)}</th>`).join('')}</tr>
          </thead>
          <tbody>${users.length ? users.map((u) => {
            const all = !Array.isArray(u.views) || BASE.every((k) => u.views.includes(k));
            const busy = saving.has(u.username);
            return `<tr class="${busy ? 'adm-busy' : ''}${u.admin ? ' adm-admin' : ''}">
              <td><div class="adm-p"><span class="nav-av adm-av">${W.esc(initials(u.name))}</span>
                <div><b>${W.esc(u.name)}</b><em>${W.esc(u.username)}${u.admin ? ' · administrador' : ''}</em></div></div></td>
              <td class="c"><label class="adm-sw" title="${u.admin ? 'Los administradores ven todo siempre' : 'Ve todo el dashboard'}">
                <input type="checkbox" data-all="${W.esc(u.username)}" ${all ? 'checked' : ''} ${u.admin || busy ? 'disabled' : ''}/><i></i></label></td>
              ${M.map((m) => {
                const on = sees(u, m);
                return `<td class="c"><input class="adm-cb" type="checkbox" data-u="${W.esc(u.username)}" data-m="${m.k}" ${on ? 'checked' : ''} ${u.admin || busy ? 'disabled' : ''} aria-label="${W.esc(`${u.name}: ${m.label}`)}"/></td>`;
              }).join('')}
            </tr>`;
          }).join('') : `<tr><td colspan="${M.length + 2}" class="muted">Nadie coincide con la búsqueda.</td></tr>`}</tbody>
        </table></div>
        <p class="au-foot">Además de esconder el módulo del menú, el servidor le niega los datos propios de ese módulo
          (por ejemplo, la base de audiencias, los mails o el buscador). Los números generales que comparten
          todas las pantallas siguen disponibles para el export del período.</p>
      </div>`;

    const find = (name) => data.users.find((x) => x.username === name);
    const qi = document.getElementById('adm-q');
    qi.addEventListener('input', () => {
      q = qi.value;
      const pos = qi.selectionStart;
      W.render().then(() => { const n = document.getElementById('adm-q'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } });
    });
    document.querySelectorAll('[data-all]').forEach((cb) => cb.addEventListener('change', () => {
      const u = find(cb.dataset.all);
      // Apagar "Todo" arranca desde todo lo que veía, para ir sacando.
      // Prender "Todo" conserva los opcionales que ya tenía; apagarlo arranca
      // desde todo lo que veía, para ir sacando.
      const extra = Array.isArray(u.views) ? u.views.filter((k) => !BASE.includes(k)) : [];
      save(u, cb.checked ? (extra.length ? [...BASE, ...extra] : null) : (Array.isArray(u.views) ? u.views.filter((k) => BASE.includes(k) || extra.includes(k)) : BASE.slice()));
    }));
    document.querySelectorAll('.adm-cb').forEach((cb) => cb.addEventListener('change', () => {
      const u = find(cb.dataset.u);
      const cur = Array.isArray(u.views) ? u.views.slice() : BASE.slice();
      const next = cb.checked ? [...new Set([...cur, cb.dataset.m])] : cur.filter((x) => x !== cb.dataset.m);
      if (!next.length) W.toast(`${u.name} se queda sin ningún módulo: no va a ver nada al entrar.`, 'bad');
      // Si terminó con todos tildados, vuelve a "Todo" (así recibe los módulos nuevos).
      // Solo vuelve a "Todo" si tiene exactamente los comunes y ningún opcional.
      const isBase = next.length === BASE.length && BASE.every((k) => next.includes(k));
      save(u, isBase ? null : next);
    }));
  };
})();

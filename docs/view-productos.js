/* global window, document */
/**
 * Vista "Productos": el ranking del ecommecere completo, App y Web en la misma
 * fila.
 *
 * Es la vista que faltaba. El ranking de productos existia solo dentro de
 * Analitica, del canal web, y sin forma de ver que parte de cada producto se
 * vende por la app — que es justo la pregunta comercial interesante: hay SKUs
 * que en la app pesan el triple que en la web.
 *
 * DECISIONES DE FORMA (vienen del skill de dataviz, no del gusto):
 *
 *  - Barras HORIZONTALES. El nombre de un producto de supermercado tiene 40
 *    caracteres; en columnas verticales las etiquetas se pisan o se rotan, y una
 *    etiqueta rotada no se lee. Horizontal, el nombre va al lado y se lee solo.
 *  - Barra APILADA de dos tramos (App / Web), no dos barras agrupadas: la
 *    pregunta es "cuanto vende este producto y como se reparte", o sea
 *    parte-de-un-total, y para eso la apilada es la forma correcta.
 *  - DOS series, asi que hay leyenda siempre presente. Con dos, el color alcanza
 *    y ademas cada fila lleva el porcentaje de app escrito, que es la etiqueta
 *    directa: la identidad nunca depende solo del color.
 *  - Hueco de 2px del color de la superficie entre los tramos. El hueco separa;
 *    un borde seria tinta que no es dato.
 *  - Grosor tope 24px y punta redondeada de 4px solo en el extremo del dato.
 *  - La tabla no es un agregado: la vista ES una tabla, asi que todo valor se
 *    puede leer sin pasar el mouse. El tooltip agrega, no habilita.
 */
(function () {
  const W = (window.W = window.W || {});

  let metric = W.store.get('prodMetric', 'qty');   // 'qty' | 'gmv' | 'orders'
  let q = '';
  let tope = 25;

  const METRIC = {
    qty: { label: 'Unidades', fmt: W.fmtNum, fmtC: W.fmtNumC },
    gmv: { label: 'GMV', fmt: W.fmtMoney, fmtC: W.fmtMoneyC },
    orders: { label: 'Pedidos', fmt: W.fmtNum, fmtC: W.fmtNumC },
  };
  const CH = { app: '#4a3aa7', web: '#2a78d6' };

  /**
   * El toggle de metrica. W.metricToggle solo hace GMV/Pedidos; acá son tres,
   * porque en productos la unidad natural es la unidad vendida, no el pedido:
   * un pedido con 12 botellas de agua es un pedido y son 12 unidades.
   */
  function toggle() {
    return `<div class="seg-ctl">${Object.entries(METRIC).map(([k, v]) =>
      `<button data-prodmetric="${k}" class="${metric === k ? 'on' : ''}">${W.esc(v.label)}</button>`).join('')}</div>`;
  }

  /** Los meses que toca el rango elegido, que es el corte del dataset. */
  function mesesDe(range) {
    const out = [];
    let m = range.from.slice(0, 7);
    const fin = range.to.slice(0, 7);
    while (m <= fin) {
      out.push(m);
      const [y, mm] = m.split('-').map(Number);
      m = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`;
    }
    return out;
  }

  W.viewProductos = async function (ctx) {
    const { range, bucket, el } = ctx;

    let file;
    try { file = await W.load('products'); }
    catch (e) {
      el.innerHTML = `<div class="empty err"><h2>No se pudo cargar el ranking</h2><p>${W.esc(e.message)}</p></div>`;
      return;
    }

    const M = METRIC[metric];
    const meses = mesesDe(range);
    const segs = bucket === 'all' ? W.SEGMENTS : [bucket];

    // Se suma por SKU sobre los meses y segmentos elegidos. El dataset esta
    // cortado por mes, asi que un rango de dias sueltos dentro de un mes trae
    // el mes completo: se avisa abajo en vez de mostrar un numero que no es del
    // rango pedido.
    const porSku = new Map();
    let mesesSinDato = 0;
    for (const seg of segs) {
      const porMes = file.segments?.[seg];
      if (!porMes) continue;
      for (const ym of meses) {
        const arr = porMes[ym];
        if (!arr) { mesesSinDato++; continue; }
        for (const it of arr) {
          const k = String(it.sku || it.name);
          const e = porSku.get(k) || {
            sku: it.sku, name: it.name, dept: it.dept || '',
            qty: 0, gmv: 0, orders: 0,
            app: { qty: 0, gmv: 0, orders: 0 }, web: { qty: 0, gmv: 0, orders: 0 },
          };
          e.qty += it.qty || 0; e.gmv += it.gmv || 0; e.orders += it.orders || 0;
          if ((it.name || '').length > (e.name || '').length) e.name = it.name;
          if (!e.dept && it.dept) e.dept = it.dept;
          for (const ch of ['app', 'web']) {
            const v = it.byChannel?.[ch];
            if (!v) continue;
            e[ch].qty += v.qty || 0; e[ch].gmv += v.gmv || 0; e[ch].orders += v.orders || 0;
          }
          porSku.set(k, e);
        }
      }
    }

    let filas = [...porSku.values()];
    const total = filas.reduce((t, r) => t + (r[metric] || 0), 0);
    const totalApp = filas.reduce((t, r) => t + (r.app[metric] || 0), 0);
    const totalWeb = filas.reduce((t, r) => t + (r.web[metric] || 0), 0);
    const hayCanal = totalApp > 0 && totalWeb > 0;

    if (q) {
      const needle = q.toLowerCase();
      filas = filas.filter((r) => (r.name || '').toLowerCase().includes(needle)
        || String(r.sku).includes(needle) || (r.dept || '').toLowerCase().includes(needle));
    }
    filas.sort((a, b) => (b[metric] || 0) - (a[metric] || 0));
    const visibles = filas.slice(0, tope);
    const max = visibles.length ? (visibles[0][metric] || 1) : 1;

    if (!porSku.size) {
      el.innerHTML = `<div class="empty"><h2>Sin productos en el período</h2>
        <p>El ranking se corta por mes; el rango elegido no cae en ningún mes con datos.</p></div>`;
      return;
    }

    // ── Cabecera: totales del ranking, con su mix ──────────────────────────
    const skusApp = filas.filter((r) => r.app[metric] > 0).length;
    const soloApp = filas.filter((r) => r.app[metric] > 0 && r.web[metric] === 0).length;

    const resumen = `<div class="prod-sum">
      <div class="prod-sumk">
        <span class="prod-sumv">${M.fmtC(total)}</span>
        <span class="prod-suml">${W.esc(M.label)} en el ranking</span>
        ${hayCanal ? W.splitBar(totalApp, totalWeb) + `<div class="prod-sums">${W.splitLabel(totalApp, totalWeb, M.fmtC)}</div>` : ''}
      </div>
      <div class="prod-sumk">
        <span class="prod-sumv">${W.fmtNum(porSku.size)}</span>
        <span class="prod-suml">productos distintos</span>
        ${hayCanal ? `<div class="prod-sums">${W.fmtNum(skusApp)} se venden por la app · ${W.fmtNum(soloApp)} solo por la app</div>` : ''}
      </div>
    </div>`;

    // ── Las filas ──────────────────────────────────────────────────────────
    const fila = (r, i) => {
      const v = r[metric] || 0;
      const a = r.app[metric] || 0;
      const w = r.web[metric] || 0;
      const ancho = Math.max(1.5, (v / max) * 100);
      const pApp = v ? (a / v) * 100 : 0;
      const share = total ? v / total : 0;
      // Etiqueta directa del mix, para que la identidad no dependa del color.
      const mixTxt = hayCanal ? `${W.fmtPct(v ? a / v : 0, 0)} app` : '';
      const tip = `<strong>${W.esc(r.name)}</strong>`
        + `<span class="tip-row">SKU ${W.esc(String(r.sku))}${r.dept ? ` · ${W.esc(r.dept)}` : ''}</span>`
        + `<span class="tip-row"><b>${M.fmt(v)}</b> ${W.esc(M.label.toLowerCase())} · ${W.fmtPct(share, 1)} del ranking</span>`
        + (hayCanal ? W.splitTip(a, w, M.fmt) : '')
        + `<span class="tip-row">${W.fmtNum(r.orders)} pedidos · ${W.fmtMoney(r.gmv)}</span>`;
      return `<tr ${W.chart.tip(tip)}>
        <td class="prod-i">${i + 1}</td>
        <td class="prod-n">
          <span class="prod-nm">${W.esc(r.name)}</span>
          <span class="prod-sk">${W.esc(String(r.sku))}${r.dept ? ` · ${W.esc(r.dept)}` : ''}</span>
        </td>
        <td class="prod-b">
          <div class="prod-track">
            <div class="prod-bar" style="width:${ancho}%">
              ${hayCanal
                ? `<span class="prod-seg app" style="width:${pApp}%"></span><span class="prod-seg web" style="width:${100 - pApp}%"></span>`
                : '<span class="prod-seg solo" style="width:100%"></span>'}
            </div>
          </div>
          ${mixTxt ? `<span class="prod-mix">${mixTxt}</span>` : ''}
        </td>
        <td class="num strong">${M.fmtC(v)}</td>
        <td class="num dim">${W.fmtPct(share, 1)}</td>
      </tr>`;
    };

    const leyenda = hayCanal
      ? `<div class="chleg"><span><i style="background:${CH.app}"></i>App</span><span><i style="background:${CH.web}"></i>Web</span></div>`
      : '';

    const aviso = mesesSinDato
      ? `<div class="chalert warn"><span class="chalert-ic">${W.icon('info', 16)}</span>
          <div><strong>Algunos meses del rango no tienen ranking</strong>
          <span>El ranking de productos se guarda por mes. ${mesesSinDato === 1 ? 'Un mes' : `${mesesSinDato} meses`} del rango elegido no tiene datos, así que no entra en la suma.</span></div>
        </div>`
      : '';

    const nota = meses.length === 1 && (range.from.slice(8) !== '01' || W.addDays(range.to, 1).slice(8) !== '01')
      ? `Ojo: el ranking se guarda por mes completo, así que estos números son de <b>${W.esc(W.fmtMonthLong(meses[0]))}</b> entero, no solo de los días elegidos.`
      : `${W.esc(meses.map(W.fmtMonth).join(' · '))} · ${segs.length === 1 ? W.esc(W.SEGMENT_LABEL[segs[0]]) : 'todos los segmentos'}`;

    el.innerHTML = `${aviso}${resumen}
      <div class="card">
        <div class="card-h">
          <h3>Top productos</h3>
          <div class="prod-tools">
            ${leyenda}
            ${toggle()}
            <input class="form-input prod-q" id="prod-q" placeholder="Buscar producto, SKU o categoría" value="${W.esc(q)}">
          </div>
        </div>
        <div class="tbl-wrap">
          <table class="tbl prod">
            <thead><tr>
              <th class="prod-i">#</th><th>Producto</th>
              <th>${W.esc(M.label)}${hayCanal ? ' · mix App / Web' : ''}</th>
              <th class="num">${W.esc(M.label)}</th><th class="num">% del top</th>
            </tr></thead>
            <tbody>${visibles.map(fila).join('')}</tbody>
          </table>
        </div>
        <div class="card-f dim">${nota}
          ${filas.length > tope ? ` · mostrando ${tope} de ${W.fmtNum(filas.length)}` : ''}
        </div>
        ${filas.length > tope ? `<div class="prod-more"><button class="btn" data-prodmore>Ver ${Math.min(25, filas.length - tope)} más</button></div>` : ''}
      </div>`;

    document.querySelectorAll('[data-prodmetric]').forEach((b) => b.addEventListener('click', () => {
      metric = b.dataset.prodmetric; W.store.set('prodMetric', metric); W.render();
    }));
    const input = document.getElementById('prod-q');
    if (input) {
      input.addEventListener('input', W.debounce(() => { q = input.value.trim(); tope = 25; W.render(); }, 250));
    }
    const more = document.querySelector('[data-prodmore]');
    if (more) more.addEventListener('click', () => { tope += 25; W.render(); });

    ctx.exports.productos = {
      filename: `productos_${range.from}_${range.to}.csv`,
      headers: ['#', 'SKU', 'Producto', 'Categoria', 'Unidades', 'Pedidos', 'GMV', 'Unidades App', 'Unidades Web'],
      rows: filas.map((r, i) => [i + 1, r.sku, r.name, r.dept, r.qty, r.orders, Math.round(r.gmv), r.app.qty, r.web.qty]),
    };
  };
}());

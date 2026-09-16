/* global window, document */
/**
 * Núcleo compartido de WebDash: carga de datasets, formateo, matemática de
 * rangos de fecha y exportación a CSV. Todo vive bajo window.W para que las
 * vistas (dashboard / analítica / audiencias) lo compartan sin bundler.
 */
(function () {
  const W = (window.W = window.W || {});

  // ── Persistencia local (preferencias, audiencias guardadas) ───────────────
  W.store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(`webdash:${key}`);
        return raw ? JSON.parse(raw) : fallback;
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(`webdash:${key}`, JSON.stringify(value)); } catch { /* modo privado */ }
    },
  };

  /**
   * Canal elegido: 'total' | 'app' | 'web'. Es estado global porque el dashboard
   * dejo de ser del canal web y paso a ser del ecommerce completo: el default es
   * el total, y el corte por canal es un filtro de arriba que TODAS las vistas
   * respetan, igual que el rango de fechas o el segmento.
   *
   * W.CHANNEL se queda en 'web' a proposito: es el prefijo de los datasets que
   * solo existen para ese canal (geo, tiendas, cohortes, audiencias, catalogo),
   * y esos se siguen leyendo de data/web/ sin importar el filtro.
   */
  W.CHANNEL = 'web';
  W.channel = W.store.get('channel', 'total');
  W.setChannel = function (ch) {
    W.channel = ch;
    W.store.set('channel', ch);
  };


  /**
   * Los dos canales del ecommerce. `web` es todo lo que NO viene de la app;
   * `app` son los pedidos con from=app, que los venia midiendo AppDash por
   * separado (repo vtex-utm-audit). Son complementarios: sumados dan el total
   * del ecommerce con 0,2-0,7% de diferencia contra el total que reporta VTEX,
   * medido sobre los 24 dias completos de agosto y septiembre.
   *
   * `has` dice que campos existen de verdad en cada canal, porque no miden lo
   * mismo: los agregados de App traen pedidos y GMV por segmento y nada mas.
   * La vista lo consulta para no dibujar un cero donde el dato no se mide.
   */
  W.CHANNELS = ['app', 'web'];
  W.CHANNEL_LABEL = { app: 'App', web: 'Web' };
  W.CHANNEL_DESC = { app: 'Pedidos con from=app', web: 'Todo lo que no es app' };
  // Slots de la paleta validada: violeta para app, azul para web.
  W.CHANNEL_COLOR = { app: '#4a3aa7', web: '#2a78d6' };
  W.CHANNEL_ICON = { app: 'bolt', web: 'store' };

  W.SEGMENTS = ['food', 'non-food', 'marketplace', 'quickcommerce'];
  W.SEGMENT_LABEL = { food: 'Food', 'non-food': 'Non Food', marketplace: 'Marketplace', quickcommerce: 'Quick Commerce' };
  W.SEGMENT_ICON = { food: '🥦', 'non-food': '🏠', marketplace: '🛒', quickcommerce: '⚡' };
  // Slots de la paleta validada (ver skill dataviz): aqua, azul, violeta, amarillo.
  W.SEGMENT_COLOR = { food: '#1baf7a', 'non-food': '#2a78d6', marketplace: '#4a3aa7', quickcommerce: '#eda100' };
  W.SEGMENT_ICON_NAME = { food: 'basket', 'non-food': 'home', marketplace: 'store', quickcommerce: 'bolt' };
  W.SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];

  /**
   * Toggle GMV/Pedidos reusable — mismo control que ya usaba el mapa de
   * provincias, ahora compartido por todos los rankings (tiendas, segmentos,
   * productos, categorías, medios de pago, marketing, cupones) para poder
   * mirar "qué mueve más plata" o "qué genera más pedidos" sin tener que
   * armar el mismo par de botones siete veces.
   */
  W.METRIC_LABEL = { gmv: 'GMV', orders: 'Pedidos' };
  W.metricToggle = function (current, attr) {
    return `<div class="seg-ctl">
      <button data-${attr}="gmv" class="${current === 'gmv' ? 'on' : ''}">GMV</button>
      <button data-${attr}="orders" class="${current === 'orders' ? 'on' : ''}">Pedidos</button>
    </div>`;
  };
  W.metricFmt = (metric) => (metric === 'orders' ? W.fmtNumC : W.fmtMoneyC);

  // ── Formato ───────────────────────────────────────────────────────────────
  const nf = (opts) => new Intl.NumberFormat('es-AR', opts);
  W.fmtMoney = (n) => nf({ style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n || 0);
  W.fmtMoneyC = (n) => nf({ style: 'currency', currency: 'ARS', notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
  W.fmtNum = (n) => nf({ maximumFractionDigits: 0 }).format(n || 0);
  W.fmtNumC = (n) => nf({ notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
  W.fmtDec = (n, d = 2) => nf({ minimumFractionDigits: d, maximumFractionDigits: d }).format(n || 0);
  W.fmtPct = (n, d = 1) => `${((n || 0) * 100).toFixed(d)}%`;
  // timeZone:'UTC' NO es un detalle: sin eso, un "2026-09-07" se construye como
  // medianoche UTC y se formatea en el huso del navegador — en Argentina
  // (UTC-3) eso cae a las 21:00 del día ANTERIOR y toda fecha del dashboard
  // salía corrida un día para atrás (el "vs. 6/9" cuando el día comparado era
  // el 7/9, los ejes de los gráficos, las cohortes, todo). Acá la fecha ya es
  // un día calendario, no un instante: se formatea tal cual está escrita.
  const dayFmt = (opts) => (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('es-AR', { timeZone: 'UTC', ...opts });
  W.fmtDay = dayFmt({ day: '2-digit', month: '2-digit' });
  W.fmtDayLong = dayFmt({ day: '2-digit', month: 'short', year: 'numeric' });
  /** "lun 7 sept" — el día de la semana es lo que hace entendible una
   * comparación contra "el mismo día de la semana pasada". Sin la coma que
   * mete es-AR ("lun, 7 sept"), que en una etiqueta corta sobra. */
  const fmtDayWeekRaw = dayFmt({ weekday: 'short', day: 'numeric', month: 'short' });
  W.fmtDayWeek = (d) => fmtDayWeekRaw(d).replace(',', '');
  /** "7 sep" — para los extremos de un rango, sin repetir el año. */
  W.fmtDayShort = dayFmt({ day: 'numeric', month: 'short' });
  W.timeAgo = (iso) => {
    const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (min < 1) return 'recién';
    if (min < 60) return `hace ${min} min`;
    return `hace ${Math.round(min / 60)} h`;
  };
  W.fmtMonth = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('es-AR', { timeZone: 'UTC', month: 'short', year: '2-digit' });
  /** Mes en palabras: "septiembre de 2026". En una frase, "sept 26" se lee como
   *  el dia 26 de septiembre; en un eje o un chip, la version corta esta bien. */
  W.fmtMonthLong = (m) => new Date(`${m}-01T00:00:00Z`)
    .toLocaleDateString('es-AR', { timeZone: 'UTC', month: 'long', year: 'numeric' })
    .replace(' de ', ' de ');
  W.esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  W.DOW_LABELS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

  /**
   * Foto del producto, por EAN, contra /api/product-image (que consulta VTEX).
   *
   * Vivia dentro de view-analytics, que era la unica vista con ranking. Ahora
   * que Productos tiene su propia vista lo comparten las dos, en vez de tener
   * dos implementaciones o —peor— una vista con fotos y otra sin.
   *
   * Cachea tambien los fallos: un EAN que VTEX no tiene no se vuelve a pedir en
   * cada re-render. El timeout de 3s es para que una foto lenta no frene la
   * tabla entera.
   */
  const imgCache = new Map();
  W.productImg = async function (sku) {
    const k = String(sku || '');
    if (imgCache.has(k)) return imgCache.get(k);
    if (!/^\d{8,14}$/.test(k)) { imgCache.set(k, null); return null; }
    let url = null;
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(`/api/product-image?ean=${encodeURIComponent(k)}`, { signal: ctrl.signal });
      clearTimeout(to);
      if (res.ok) url = (await res.json())?.image || null;
    } catch { /* sin red, timeout, o VTEX no lo tiene: se sigue sin imagen */ }
    imgCache.set(k, url);
    return url;
  };

  /** Para inputs de texto: re-renderizar en cada tecla tira la vista entera. */
  W.debounce = function (fn, ms = 250) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  };

  // ── Fechas ────────────────────────────────────────────────────────────────
  W.addDays = (dateStr, n) => {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  W.daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000) + 1;

  // Fecha de "hoy" en el huso horario de la operación (AR), no el del navegador
  // de quien mira el dashboard — el pipeline cierra los días en ese huso.
  W.arToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());

  // Hora AR actual, 0-23. Es lo que permite comparar un día en curso contra
  // otro día A LA MISMA HORA en vez de contra su total cerrado (comparar
  // medio día contra un día completo daba -74% en todo, que no es una caída:
  // es que el día todavía no terminó). hourCycle h23 para que medianoche sea
  // 0 y no 24.
  W.arHour = () => Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', hourCycle: 'h23',
  }).format(new Date()));

  // Día calendario (YYYY-MM-DD) en huso AR de un timestamp ISO cualquiera —
  // AR es UTC-3 fijo, sin horario de verano, así que restar 3h y leer la
  // fecha en UTC da el día correcto sin importar qué offset traiga el string
  // original. Necesario para filtrar pedidos por rango: un pedido creado a
  // las 00:30 UTC es todavía "ayer" en AR, y compararlo con el string ISO
  // crudo (que arranca con el día UTC) los ubicaba un día más tarde.
  W.arDateOf = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return new Date(d.getTime() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
  };

  W.presetRange = function (preset, days, startDate) {
    if (!days || !days.length) return null;
    const last = days[days.length - 1];
    switch (preset) {
      // 'today'/'yesterday' se calculan contra el reloj real, no contra el
      // último día del array: desde que el pipeline en vivo agrega el día de
      // hoy, el último día YA NO es siempre "ayer".
      case 'today': { const t = W.arToday(); return { from: t, to: t }; }
      case 'yesterday': { const t = W.addDays(W.arToday(), -1); return { from: t, to: t }; }
      case '7d': return { from: W.addDays(last, -6), to: last };
      case '30d': return { from: W.addDays(last, -29), to: last };
      case '90d': return { from: W.addDays(last, -89), to: last };
      case 'month': return { from: last.slice(0, 8) + '01', to: last };
      case 'all': return { from: startDate || days[0], to: last };
      default: return null;
    }
  };
  // Para rangos cortos (día, "ayer", una semana) compara contra el mismo
  // período hace exactamente 7 días — mismo día de semana — en vez del
  // período inmediatamente anterior: comparar un martes contra un domingo
  // (tráfico muy distinto) daba variaciones que no significaban nada. Para
  // rangos largos (mes, trimestre, todo) sigue comparando contra el bloque
  // inmediatamente anterior de igual longitud, que es lo que tiene sentido ahí.
  W.previousRange = (range) => {
    const n = W.daysBetween(range.from, range.to);
    const shift = n <= 7 ? 7 : n;
    return { from: W.addDays(range.from, -shift), to: W.addDays(range.to, -shift) };
  };

  /** Rango en texto corto: "7 sep" un día · "1 – 7 sep" mismo mes · "28 ago – 3 sep" si cruza. */
  W.rangeText = function (range) {
    if (range.from === range.to) return W.fmtDayShort(range.from);
    const sameMonth = range.from.slice(0, 7) === range.to.slice(0, 7);
    return sameMonth
      ? `${Number(range.from.slice(8, 10))} – ${W.fmtDayShort(range.to)}`
      : `${W.fmtDayShort(range.from)} – ${W.fmtDayShort(range.to)}`;
  };

  /**
   * Contra qué se compara, dicho en criollo. Antes la barra decía
   * "vs. 6/9 – 6/9": la misma fecha repetida dos veces, encima corrida un día
   * por el bug de huso de arriba, y sin decir en ningún lado POR QUÉ ese día.
   * Ahora nombra el período y el tooltip explica el criterio.
   */
  W.compareText = function (range) {
    const prev = W.previousRange(range);
    const n = W.daysBetween(range.from, range.to);
    if (range.from === range.to) {
      return {
        text: `vs. ${W.fmtDayWeek(prev.from)}`,
        tip: 'Se compara contra el MISMO día de la semana pasada, no contra ayer: un lunes contra un domingo da variaciones que no significan nada.',
      };
    }
    if (n <= 7) {
      return {
        text: `vs. semana anterior · ${W.rangeText(prev)}`,
        tip: 'Mismo largo de período corrido 7 días para atrás, así caen los mismos días de la semana.',
      };
    }
    return {
      text: `vs. período anterior · ${W.rangeText(prev)}`,
      tip: `Los ${n} días inmediatamente anteriores al rango elegido.`,
    };
  };

  // ── Carga de datasets (cacheada) ──────────────────────────────────────────
  const cache = {};

  /**
   * Los datasets del histórico de pedidos (`orders/…`, `order-index/…`) son
   * el 98% del peso de los datos pero solo se piden a demanda —el detalle de
   * una tienda, el export por estado, el drill-down de un cupón—, así que ya
   * no viajan en el deploy: viven en la rama `data-raw` y los sirve
   * /api/archive. Todo lo demás (daily-summary, catalog, geo, …) se sigue
   * sirviendo estático porque sí se necesita al abrir la página.
   */
  const ARCHIVE = /^(?:orders|order-index)\//;

  /**
   * Datasets que dependen del canal elegido. Pedir 'daily-summary' con el filtro
   * en "total" devuelve la fusion de los dos canales, asi las vistas que ya
   * existian pasan a mostrar el ecommerce completo sin cambiarles una linea.
   * Los demas datasets (geo, cohortes, catalogo, audiencias) siguen siendo del
   * canal web, que es el unico que los tiene.
   */
  const POR_CANAL = new Set(['daily-summary', 'products']);

  W.load = async function (name) {
    if (!POR_CANAL.has(name)) return W.loadRaw(name);

    const ch = W.channel || 'total';
    const key = `${ch}::${name}`;
    if (cache[key]) return cache[key];

    if (ch === 'app') {
      cache[key] = await W.loadChannel('app', name);
    } else if (ch === 'web') {
      cache[key] = await W.loadRaw(name);
    } else {
      const [app, web] = await Promise.all([
        W.loadChannel('app', name).catch(() => null),
        W.loadRaw(name),
      ]);
      // Si el canal app todavia no se genero, el total es el web solo: mejor un
      // dashboard que funciona con un canal que una pantalla de error. La vista
      // App + Web si avisa cuando falta.
      const merge = name === 'products' ? W.mergeProducts : W.mergeChannels;
      cache[key] = app ? merge({ app, web }) : web;
    }
    return cache[key];
  };

  /**
   * Tira la fusion cacheada para que el proximo W.load la reconstruya.
   *
   * El vivo y recent.json actualizan el dataset de WEB. La fusion App+Web se
   * DERIVA de los dos canales, asi que no se parchea: se invalida y se rearma.
   * Mutarla era la causa de que el total y los canales se contradijeran —
   * dependia de cual era el filtro activo cuando llego el dato nuevo.
   */
  W.invalidateMerged = function () {
    for (const k of Object.keys(cache)) if (k.startsWith('total::')) delete cache[k];
  };

  /** La carga cruda de siempre, del canal web. */
  W.loadRaw = async function (name) {
    if (cache[name]) return cache[name];

    let res;
    if (ARCHIVE.test(name)) {
      res = await fetch(`api/archive?path=${encodeURIComponent(`${name}.json`)}`, { cache: 'default' });
      // Si todavía no está configurado el token del archivo, se cae al
      // estático de siempre: así la transición no rompe nada mientras los
      // archivos sigan deployados.
      if (res.status === 503) res = null;
    }
    if (!res) res = await fetch(`data/${W.CHANNEL}/${name}.json`, { cache: 'no-store' });

    if (!res.ok) throw new Error(`No se pudo cargar ${name}.json (${res.status})`);
    cache[name] = await res.json();
    return cache[name];
  };

  /**
   * Igual que W.load pero para un canal explicito. W.load queda intacta y
   * sigue apuntando al canal web, asi que ninguna vista existente cambia de
   * comportamiento; las nuevas piden el canal que necesitan.
   */
  W.loadChannel = async function (channel, name) {
    const key = `${channel}/${name}`;
    if (cache[key]) return cache[key];
    const res = await fetch(`data/${channel}/${name}.json`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`No se pudo cargar ${channel}/${name}.json (${res.status})`);
    cache[key] = await res.json();
    return cache[key];
  };

  /**
   * Los dos canales, ya resueltos y con su cobertura de fechas.
   *
   * La cobertura no es un detalle: web arranca el 2026-01-01 y app el
   * 2026-05-01, asi que un rango que empiece antes de mayo tiene app en cero
   * por no existir, no por no haber vendido. Quien dibuja usa `covers` para
   * decirlo en vez de mostrar una caida que no paso.
   */
  W.loadChannels = async function () {
    // loadRaw, NO load: W.load es consciente del canal y con el filtro en "total"
    // devuelve la FUSION. Pedirla aca ponia el total en la columna de Web, y el
    // total de la matriz sumaba el total otra vez: 1.493 + 3.735 = 5.228, con el
    // mismo ticket en las dos tarjetas porque una era la suma de la otra.
    const [app, web] = await Promise.all([
      W.loadChannel('app', 'daily-summary'),
      W.loadRaw('daily-summary'),
    ]);
    const out = {};
    for (const [ch, data] of [['app', app], ['web', web]]) {
      const days = data.days || [];
      out[ch] = {
        data,
        has: data.has || null,   // web no lo declara: mide todo
        first: days.length ? days[0].date : null,
        last: days.length ? days[days.length - 1].date : null,
        generatedAt: data.generatedAt || null,
        // Cuando se trajo el DATO, que es lo que importa para comparar canales.
        // Para app es el ultimo fetched_at de VTEX; para web, generatedAt es
        // efectivamente eso (el pipeline escribe el archivo al terminar de leer).
        freshAt: data.dataFreshAt || data.generatedAt || null,
        covers(range) {
          if (!this.first) return false;
          return range.from >= this.first && range.to <= this.last;
        },
        /** Dias del rango que este canal no tiene, para nombrarlos. */
        missing(range) {
          if (!this.first) return { before: 0, after: 0 };
          const before = range.from < this.first ? W.daysBetween(range.from, W.addDays(this.first, -1)) : 0;
          const after = range.to > this.last ? W.daysBetween(W.addDays(this.last, 1), range.to) : 0;
          return { before, after };
        },
      };
    }
    return out;
  };

  /**
   * Fusiona los dos canales en UN dataset con el mismo schema, para que el
   * dashboard entero pase a ser del ecommerce total sin tocar las siete vistas
   * una por una: cada vista sigue pidiendo 'daily-summary' y recibe el canal
   * que este elegido.
   *
   * Se suma dia por dia y segmento por segmento. Los diccionarios (cupones,
   * fuentes, categorias, medios de pago) se suman por clave, asi un cupon que
   * existe en los dos canales queda con el total y no duplicado.
   *
   * Lo que un canal no mide no se inventa en cero: `has` de la fusion es la
   * interseccion, y ahi es donde el front se entera de que "medios de pago" es
   * solo de web y tiene que decirlo en vez de mostrar un total incompleto.
   */
  const DICTS = ['marketing', 'coupons', 'categories', 'categoriesN1', 'categoriesN2', 'payments', 'paymentBrands', 'installments'];

  /** Un dia fusionado vacio, listo para acumular canales. */
  W.emptyMergedDay = (date) => ({
    date, segments: {}, hourly: new Array(24).fill(0),
    statusStats: {}, discount: 0, newCustomers: 0, activeCustomers: 0,
    // De donde salio cada dia: un dia que solo tiene un canal no es comparable
    // con uno que tiene los dos, y el front lo avisa.
    channels: [],
  });

  /**
   * Suma UN dia de UN canal sobre un dia fusionado.
   *
   * Existe como funcion aparte porque hay dos lugares que fusionan: la carga
   * inicial (mergeChannels) y el empalme de recent.json / el vivo, que traen el
   * dia de web mas fresco y tienen que SUMARSE al de app en vez de pisarlo.
   * Cuando eran dos implementaciones, el empalme reemplazaba el dia entero y el
   * total del ultimo dia mostraba solo web: 2.242 pedidos en vez de 3.735.
   */
  W.mergeDayInto = function (d, day, ch) {
    d.channels.push(ch);

    for (const [seg, v] of Object.entries(day.segments || {})) {
      const t = (d.segments[seg] = d.segments[seg] || {
        gmv: 0, orders: 0, units: 0, hourly: new Array(24).fill(0),
        // El desglose se CONSERVA, no se pierde al sumar: es lo que permite
        // que cada total de la interfaz muestre su mix App/Web en el lugar,
        // sin que la vista tenga que volver a pedir los dos canales.
        byChannel: {},
      });
      t.gmv += v.gmv || 0;
      t.orders += v.orders || 0;
      t.units += v.units || 0;
      const bc = (t.byChannel[ch] = t.byChannel[ch] || { gmv: 0, orders: 0, units: 0 });
      bc.gmv += v.gmv || 0; bc.orders += v.orders || 0; bc.units += v.units || 0;
      if (v.hourly) v.hourly.forEach((n, h) => (t.hourly[h] += n || 0));
      for (const k of DICTS) {
        if (!v[k]) continue;
        const dst = (t[k] = t[k] || {});
        for (const [name, e] of Object.entries(v[k])) {
          const acc = (dst[name] = dst[name] || { orders: 0, gmv: 0, units: 0 });
          acc.orders += e.orders || 0; acc.gmv += e.gmv || 0; acc.units += e.units || 0;
        }
      }
    }

    (day.hourly || []).forEach((n, h) => (d.hourly[h] += n || 0));
    for (const [st, v] of Object.entries(day.statusStats || {})) {
      const e = (d.statusStats[st] = d.statusStats[st] || { orders: 0, gmv: 0 });
      e.orders += v.orders || 0; e.gmv += v.gmv || 0;
    }
    d.discount += day.discount || 0;
    // Clientes: se suman los de cada canal. Es un techo, no el unico real
    // —alguien que compro en los dos canales el mismo dia cuenta dos veces—
    // y el front lo aclara donde lo muestra.
    d.newCustomers += day.newCustomers || 0;
    d.activeCustomers += day.activeCustomers || 0;
    d.totalEcommOrders = Math.max(d.totalEcommOrders || 0, day.totalEcommOrders || 0);
    d.totalEcommGmv = Math.max(d.totalEcommGmv || 0, day.totalEcommGmv || 0);
    return d;
  };

  W.mergeChannels = function (porCanal) {
    const canales = Object.keys(porCanal);
    const porFecha = new Map();

    for (const ch of canales) {
      for (const day of porCanal[ch].days || []) {
        let d = porFecha.get(day.date);
        if (!d) { d = W.emptyMergedDay(day.date); porFecha.set(day.date, d); }
        W.mergeDayInto(d, day, ch);
      }
    }

    const has = {};
    for (const ch of canales) {
      const h = porCanal[ch].has;
      if (!h) continue;                         // web no lo declara: mide todo
      for (const [k, v] of Object.entries(h)) has[k] = k in has ? (has[k] && v) : v;
    }

    const days = [...porFecha.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    const fresh = canales.map((ch) => porCanal[ch].dataFreshAt || porCanal[ch].generatedAt).filter(Boolean).sort();

    return {
      channel: 'total',
      channels: canales,
      generatedAt: new Date().toISOString(),
      // La frescura del total es la del canal MAS ATRASADO: decir la del mas
      // fresco haria parecer todo el dataset mas actual de lo que es.
      dataFreshAt: fresh.length ? fresh[0] : null,
      has,
      days,
      // Los datasets de origen, indexados por fecha. El empalme de recent.json
      // y del vivo traen el dia de WEB mas fresco, y para no perder app tienen
      // que re-fusionar ese dia contra su origen en vez de reemplazarlo.
      sources: Object.fromEntries(canales.map((ch) => [
        ch, new Map((porCanal[ch].days || []).map((d) => [d.date, d])),
      ])),
      detailWindowStartDate: porCanal.web?.detailWindowStartDate || null,
    };
  };

  /**
   * Fusiona los rankings de productos de los dos canales. Tiene su propia forma
   * —segmento -> mes -> top— asi que no pasa por mergeChannels.
   *
   * Se suma por SKU, que es la clave estable: el nombre del producto cambia de
   * escritura entre pedidos y entre canales, asi que agrupar por nombre partiria
   * el mismo producto en dos filas. Se conserva el nombre mas largo de los dos,
   * que suele ser el menos truncado, y el `dept` del canal que lo tenga (los
   * rows de App no traen categoria).
   *
   * Ojo con el sesgo del top: cada canal publica su top 150 por mes, asi que un
   * producto que quedo afuera del top de un canal suma solo lo del otro. Para el
   * ranking general no mueve la aguja; para el numero exacto de un SKU puntual
   * hay que ir al detalle diario.
   */
  W.mergeProducts = function (porCanal) {
    const canales = Object.keys(porCanal);
    const segments = {};
    const meses = new Set();

    for (const ch of canales) {
      for (const [seg, porMes] of Object.entries(porCanal[ch].segments || {})) {
        const dstSeg = (segments[seg] = segments[seg] || {});
        for (const [ym, arr] of Object.entries(porMes || {})) {
          meses.add(ym);
          const acc = (dstSeg[ym] = dstSeg[ym] || new Map());
          for (const it of arr) {
            const k = String(it.sku || it.name);
            const e = acc.get(k) || { sku: it.sku, name: it.name, dept: '', qty: 0, gmv: 0, orders: 0, byChannel: {} };
            e.qty += it.qty || 0; e.gmv += it.gmv || 0; e.orders += it.orders || 0;
            const bc = (e.byChannel[ch] = e.byChannel[ch] || { qty: 0, gmv: 0, orders: 0 });
            bc.qty += it.qty || 0; bc.gmv += it.gmv || 0; bc.orders += it.orders || 0;
            if ((it.name || '').length > (e.name || '').length) e.name = it.name;
            if (!e.dept && it.dept) e.dept = it.dept;
            acc.set(k, e);
          }
        }
      }
    }

    for (const [seg, porMes] of Object.entries(segments)) {
      for (const [ym, mapa] of Object.entries(porMes)) {
        porMes[ym] = [...mapa.values()].sort((a, b) => b.qty - a.qty);
      }
    }

    return {
      channel: 'total',
      channels: canales,
      generatedAt: new Date().toISOString(),
      note: 'Productos de App + Web sumados por SKU. Cada canal publica su top por mes, '
        + 'asi que un producto que quedo afuera del top de un canal suma solo lo del otro.',
      months: [...meses].sort(),
      segments,
    };
  };

  /**
   * EL SPLIT: la pieza que hace que el dashboard sea del ecommerce total sin
   * esconder de donde viene cada numero.
   *
   * Decision de diseño: el total es siempre EL numero, y el mix App/Web viaja
   * pegado a el como una barra de una sola linea. Nadie tiene que cambiar de
   * vista ni de filtro para saber que parte es de la app — y como es una barra
   * apilada de dos tramos, se lee de un vistazo sin ocupar una fila de texto.
   *
   * Especificaciones que vienen del skill de dataviz y no son decorativas:
   *  - Dos tramos separados por un hueco de 2px del color de la SUPERFICIE. El
   *    hueco es lo que separa, no un borde: un stroke agrega tinta que no es dato.
   *  - El par violeta/azul esta validado con el script (CVD ΔE 13,0 contra un
   *    objetivo de 8; vision normal 16,3 contra un piso de 15), no elegido a ojo.
   *  - La identidad la da el swatch al lado del texto, nunca el color del texto:
   *    un texto violeta claro sobre blanco no llega a contraste.
   *  - El valor exacto de los dos canales vive en el tooltip Y en la leyenda de
   *    la barra, asi que el hover nunca es la unica forma de leerlo.
   */
  W.splitBar = function (app, web, opts = {}) {
    const t = (app || 0) + (web || 0);
    if (!t) return '';
    const pApp = ((app || 0) / t) * 100;
    const alto = opts.alto || 4;
    return `<div class="csplit" style="--h:${alto}px" aria-hidden="true">
      <span class="csplit-a" style="width:${pApp}%"></span>
      <span class="csplit-w" style="width:${100 - pApp}%"></span>
    </div>`;
  };

  /** Texto del mix, para poner debajo de la barra o al lado del valor. */
  W.splitLabel = function (app, web, fmt = W.fmtNumC) {
    const t = (app || 0) + (web || 0);
    if (!t) return '';
    return `<span class="csplit-l">
      <span class="csplit-k app"></span>${fmt(app || 0)}
      <span class="csplit-k web"></span>${fmt(web || 0)}
    </span>`;
  };

  /** Filas de tooltip con el desglose, para sumar al tip de cualquier tarjeta. */
  W.splitTip = function (app, web, fmt = W.fmtNum) {
    const t = (app || 0) + (web || 0);
    if (!t) return '';
    const pct = (v) => W.fmtPct(v / t, 0);
    return `<span class="tip-row"><b>App</b> ${fmt(app || 0)} · ${pct(app || 0)}</span>`
         + `<span class="tip-row"><b>Web</b> ${fmt(web || 0)} · ${pct(web || 0)}</span>`;
  };

  /** ¿Hay desglose para mostrar? (false cuando el filtro esta en un solo canal) */
  W.hasSplit = (bc) => !!bc && Object.keys(bc).length > 1;

  // ── Agregación de la serie diaria ─────────────────────────────────────────
  /**
   * Suma los días de `range` para uno o todos los segmentos.
   * bucket === 'all' suma los cuatro.
   */
  W.sumRange = function (daily, bucket, range) {
    const acc = {
      gmv: 0, orders: 0, units: 0, discount: 0, newCustomers: 0, activeCustomers: 0,
      marketing: {}, series: [], bySegment: {}, hourly: new Array(24).fill(0), statusStats: {},
      // Mix App/Web del rango, total y por segmento. Queda vacio cuando el
      // dataset es de un solo canal, y ahi la interfaz no dibuja el split.
      byChannel: {}, byChannelSeg: {},
      // Catálogo del rango, ya recortado al segmento elegido (schema 2).
      categories: {}, categoriesN1: {}, categoriesN2: {}, coupons: {}, payments: {},
      paymentBrands: {}, installments: {}, hasCatalog: false,
    };
    for (const s of W.SEGMENTS) acc.bySegment[s] = { gmv: 0, orders: 0, units: 0 };

    for (const day of daily.days) {
      if (day.date < range.from || day.date > range.to) continue;
      const buckets = bucket === 'all' ? W.SEGMENTS : [bucket];
      let dayGmv = 0, dayOrders = 0, dayUnits = 0;

      for (const b of buckets) {
        const seg = day.segments[b];
        if (!seg) continue;
        dayGmv += seg.gmv; dayOrders += seg.orders; dayUnits += seg.units || 0;
        acc.bySegment[b].gmv += seg.gmv;
        acc.bySegment[b].orders += seg.orders;
        acc.bySegment[b].units += seg.units || 0;
        for (const [ch, v] of Object.entries(seg.byChannel || {})) {
          const t = (acc.byChannel[ch] = acc.byChannel[ch] || { gmv: 0, orders: 0, units: 0 });
          t.gmv += v.gmv || 0; t.orders += v.orders || 0; t.units += v.units || 0;
          const ts = ((acc.byChannelSeg[b] = acc.byChannelSeg[b] || {})[ch]
            = acc.byChannelSeg[b][ch] || { gmv: 0, orders: 0, units: 0 });
          ts.gmv += v.gmv || 0; ts.orders += v.orders || 0; ts.units += v.units || 0;
        }
        for (const [name, v] of Object.entries(seg.marketing || {})) {
          const e = (acc.marketing[name] = acc.marketing[name] || { gmv: 0, orders: 0 });
          e.gmv += v.gmv; e.orders += v.orders;
        }
        for (const key of ['categories', 'categoriesN1', 'categoriesN2', 'coupons', 'payments', 'paymentBrands', 'installments']) {
          for (const [name, v] of Object.entries(seg[key] || {})) {
            acc.hasCatalog = true;
            const e = (acc[key][name] = acc[key][name] || { orders: 0, gmv: 0, units: 0 });
            e.orders += v.orders || 0; e.gmv += v.gmv || 0; e.units += v.units || 0;
          }
        }
        // El horario por segmento solo existe en schema 2; si no está, el
        // acumulado del día (más abajo) cubre únicamente la vista consolidada.
        if (seg.hourly) seg.hourly.forEach((n, h) => (acc.hourly[h] += n));
      }

      acc.gmv += dayGmv; acc.orders += dayOrders; acc.units += dayUnits;
      // Descuentos, nuevos y activos son a nivel día (no por segmento), así que
      // solo se suman cuando la vista mira el canal completo.
      if (bucket === 'all') {
        acc.discount += day.discount || 0;
        acc.newCustomers += day.newCustomers || 0;
        acc.activeCustomers += day.activeCustomers || 0;
        const segHasHourly = W.SEGMENTS.some((s2) => day.segments[s2]?.hourly);
        if (!segHasHourly) (day.hourly || []).forEach((n, h) => (acc.hourly[h] += n));
        // Los estados vienen del listado de VTEX (todos los pedidos del día,
        // no solo los que cuentan), así que solo aplican a la vista del canal completo.
        for (const [st, v] of Object.entries(day.statusStats || {})) {
          const e = (acc.statusStats[st] = acc.statusStats[st] || { orders: 0, gmv: 0 });
          e.orders += v.orders || 0;
          e.gmv += v.gmv || 0;
        }
      }
      acc.series.push({ date: day.date, gmv: dayGmv, orders: dayOrders, units: dayUnits, newCustomers: day.newCustomers || 0 });
    }
    return acc;
  };

  /**
   * La matriz que pide la vista unificada: para cada canal y cada segmento,
   * pedidos y GMV del rango, mas los totales por fila (segmento, sumando
   * canales) y por columna (canal, sumando segmentos).
   *
   * Se apoya en W.sumRange por canal en vez de reimplementar la suma, asi la
   * vista unificada y las vistas de un solo canal no pueden divergir en los
   * numeros.
   */
  W.channelMatrix = function (channels, range) {
    const porCanal = {};
    for (const ch of W.CHANNELS) porCanal[ch] = W.sumRange(channels[ch].data, 'all', range);

    const celdas = {};       // celdas[segmento][canal] = {orders, gmv, units}
    const porSegmento = {};  // total del segmento sumando canales
    for (const seg of W.SEGMENTS) {
      celdas[seg] = {};
      porSegmento[seg] = { orders: 0, gmv: 0, units: 0 };
      for (const ch of W.CHANNELS) {
        const c = porCanal[ch].bySegment[seg] || { orders: 0, gmv: 0, units: 0 };
        celdas[seg][ch] = c;
        porSegmento[seg].orders += c.orders;
        porSegmento[seg].gmv += c.gmv;
        porSegmento[seg].units += c.units || 0;
      }
    }

    const total = { orders: 0, gmv: 0, units: 0 };
    for (const ch of W.CHANNELS) {
      total.orders += porCanal[ch].orders;
      total.gmv += porCanal[ch].gmv;
      total.units += porCanal[ch].units || 0;
    }

    // Denominador honesto para la participacion: el total del ecommerce que
    // reporta VTEX, que trae el canal app. Es mas que app+web (sobran ~0,5%
    // de pedidos que no caen en ninguno de los dos), asi que usarlo evita
    // inflar las participaciones hasta sumar 100% a la fuerza.
    let ecommOrders = 0, ecommGmv = 0;
    for (const d of channels.app.data.days || []) {
      if (d.date < range.from || d.date > range.to) continue;
      ecommOrders += d.totalEcommOrders || 0;
      ecommGmv += d.totalEcommGmv || 0;
    }

    // Ese total sale del agregado de AppDash, que se escribe en SU propio
    // momento — no en el mismo que el resumen de web. Con el dia en curso los
    // dos snapshots son de horas distintas y el total puede quedar por DEBAJO
    // de app+web: paso en serio, 101 del agregado de las 09:48 contra 28+86
    // del de las 11:08, y la pantalla mostraba "112,9% del ecommerce" y dos
    // participaciones que sumaban 112,8%. Un porcentaje mayor a 100 no es un
    // dato, es un error mostrado como dato.
    //
    // Regla: el ecommerce no puede tener menos pedidos que los que ya
    // contamos. Si el total de referencia viene por debajo, esta viejo: se usa
    // app+web como denominador y se marca `ecommDesfasado` para que la vista
    // lo diga en vez de inventar una cobertura.
    const ecommDesfasado = ecommOrders > 0 && ecommOrders < total.orders;
    const baseOrders = Math.max(ecommOrders, total.orders);
    const baseGmv = Math.max(ecommGmv, total.gmv);

    return {
      porCanal, celdas, porSegmento, total,
      ecommOrders, ecommGmv, ecommDesfasado, baseOrders, baseGmv,
    };
  };

  // Estados que cuentan como cancelación. Tiene que coincidir con
  // config/status-filter.json > cancelledStatuses.
  W.CANCELLED_STATUSES = ['canceled', 'cancelled', 'cancel', 'request-cancel'];

  /** Resume los estados de un rango: cuánto se canceló y sobre qué total. */
  W.cancellations = function (statusStats) {
    let cancelledOrders = 0, cancelledGmv = 0, totalOrders = 0, totalGmv = 0;
    for (const [st, v] of Object.entries(statusStats || {})) {
      totalOrders += v.orders;
      totalGmv += v.gmv;
      if (W.CANCELLED_STATUSES.includes(st)) {
        cancelledOrders += v.orders;
        cancelledGmv += v.gmv;
      }
    }
    return {
      cancelledOrders, cancelledGmv, totalOrders, totalGmv,
      rate: totalOrders ? cancelledOrders / totalOrders : 0,
    };
  };

  // ── Ciclo de vida del cliente ─────────────────────────────────────────────
  /**
   * Estados de ciclo de vida. La clave es no definir churn como "hace X días
   * que no compra" a secas: un cliente que compra cada 60 días no está perdido
   * a los 45, y uno que compraba cada 7 sí lo está. Se compara la recencia
   * contra el intervalo TÍPICO DE ESE CLIENTE (churnRatio).
   */
  W.LIFECYCLE = {
    nuevo:      { label: 'Nuevo',      color: '#2a78d6', icon: 'sparkles', desc: 'primera compra reciente, todavía sin recompra' },
    activo:     { label: 'Activo',     color: '#1baf7a', icon: 'check',    desc: 'compra dentro de su ritmo habitual' },
    campeon:    { label: 'Campeón',    color: '#008300', icon: 'star',     desc: 'compra seguido, hace poco y gasta por encima del promedio' },
    riesgo:     { label: 'En riesgo',  color: '#eda100', icon: 'alert',    desc: 'se está estirando entre compras' },
    churn:      { label: 'Churn',      color: '#e34948', icon: 'trendDown',desc: 'dejó de comprar' },
    perdido:    { label: 'Perdido',    color: '#8b93a5', icon: 'sleep',    desc: 'sin comprar hace mucho' },
  };

  /**
   * Descripción de cada estado con los umbrales que están activos ahora mismo.
   * Los textos fijos mentirían apenas el usuario mueve un parámetro.
   */
  W.lifecycleDesc = function (key) {
    const C = W.CHURN;
    const d = (n) => `${n} día${n === 1 ? '' : 's'}`;
    const x = (n) => `${String(n).replace('.', ',')}×`;
    switch (key) {
      case 'nuevo':   return `primera compra hace menos de ${d(C.newDays)}, todavía sin recompra`;
      case 'activo':  return C.mode === 'dias' ? `compró hace menos de ${d(C.riskDays)}` : 'compra dentro de su ritmo habitual';
      case 'campeon': return 'compra seguido, hace poco y gasta por encima del promedio';
      case 'riesgo':  return C.mode === 'dias'
        ? `sin comprar hace ${d(C.riskDays)} o más`
        : `lleva ${x(C.riskRatio)} su intervalo habitual sin comprar`;
      case 'churn':   return C.mode === 'dias'
        ? `sin comprar hace ${d(C.churnDays)} o más`
        : `lleva ${x(C.churnRatio)} su intervalo habitual sin comprar`;
      case 'perdido': return `sin comprar hace más de ${d(C.lostDays)}`;
      default: return '';
    }
  };

  /** Resumen del criterio activo, para los subtítulos. */
  W.churnCriterion = function () {
    const C = W.CHURN;
    return C.mode === 'dias'
      ? `churn a los ${C.churnDays} días sin comprar`
      : `churn cuando pasa ${String(C.churnRatio).replace('.', ',')}× su propio intervalo entre compras`;
  };
  W.LIFECYCLE_ORDER = ['campeon', 'activo', 'nuevo', 'riesgo', 'churn', 'perdido'];

  /**
   * Umbrales del ciclo de vida. Son AJUSTABLES desde la vista de Audiencias y
   * quedan guardados en el navegador: no hay una definición universal de
   * churner, depende del negocio y de la campaña que se quiera armar.
   *
   * mode 'ratio'  -> churn cuando la recencia supera N veces el intervalo
   *                  propio del cliente (se adapta a cada uno).
   * mode 'dias'   -> churn cuando pasaron N días sin comprar, fijo para todos
   *                  (es lo que se suele pedir: "churners de 30/60/180 días").
   */
  W.CHURN_DEFAULTS = { mode: 'ratio', riskRatio: 1.5, churnRatio: 3, riskDays: 45, churnDays: 90, lostDays: 180, newDays: 45, fallbackInterval: 45 };
  W.CHURN = { ...W.CHURN_DEFAULTS, ...W.store.get('churnParams', {}) };
  W.setChurn = function (patch) {
    W.CHURN = { ...W.CHURN, ...patch };
    W.store.set('churnParams', W.CHURN);
  };
  W.resetChurn = function () {
    W.CHURN = { ...W.CHURN_DEFAULTS };
    W.store.set('churnParams', {});
  };

  /**
   * @param orders  pedidos del cliente
   * @param recency días desde la última compra
   * @param interval días promedio entre compras (0 si compró una sola vez)
   * @param gmv gasto total · avgGmv gasto promedio de la base (para 'campeón')
   */
  W.lifecycleOf = function (orders, recency, interval, gmv, avgGmv) {
    const C = W.CHURN;
    if (recency > C.lostDays) return 'perdido';
    if (orders === 1 && recency <= C.newDays) return 'nuevo';

    if (C.mode === 'dias') {
      if (recency >= C.churnDays) return 'churn';
      if (recency >= C.riskDays) return 'riesgo';
    } else {
      // Sin intervalo propio (una sola compra) se usa un valor de referencia.
      const base = interval > 0 ? interval : C.fallbackInterval;
      const ratio = recency / base;
      if (ratio >= C.churnRatio) return 'churn';
      if (ratio >= C.riskRatio) return 'riesgo';
    }
    if (orders >= 4 && gmv >= avgGmv * 1.5) return 'campeon';
    return 'activo';
  };

  W.churnRatio = (recency, interval) => recency / (interval > 0 ? interval : W.CHURN.fallbackInterval);

  W.ticket = (gmv, orders) => (orders ? gmv / orders : 0);
  W.unitsPerOrder = (units, orders) => (orders ? units / orders : 0);

  W.delta = function (cur, prev) {
    if (prev == null) return null;
    if (prev === 0 && cur === 0) return 0;
    if (prev === 0) return null;
    return (cur - prev) / prev;
  };

  W.deltaBadge = function (d) {
    if (d == null) return '<span class="delta flat">—</span>';
    const pct = d * 100;
    const cls = pct > 0.5 ? 'up' : pct < -0.5 ? 'down' : 'flat';
    const arrow = pct > 0.5 ? '↑' : pct < -0.5 ? '↓' : '→';
    return `<span class="delta ${cls}">${arrow} ${Math.abs(pct).toFixed(1)}%</span>`;
  };

  /** Media móvil centrada-a-izquierda de ventana `w`. */
  W.movingAvg = function (values, w) {
    const out = [];
    for (let i = 0; i < values.length; i++) {
      const from = Math.max(0, i - w + 1);
      let s = 0;
      for (let j = from; j <= i; j++) s += values[j];
      out.push(s / (i - from + 1));
    }
    return out;
  };

  /** Regresión lineal simple sobre y[i] vs i. Devuelve {slope, intercept, at(i)}. */
  W.linreg = function (values) {
    const n = values.length;
    if (!n) return { slope: 0, intercept: 0, at: () => 0 };
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sx += i; sy += values[i]; sxy += i * values[i]; sxx += i * i; }
    const d = n * sxx - sx * sx;
    const slope = d === 0 ? 0 : (n * sxy - sx * sy) / d;
    const intercept = (sy - slope * sx) / n;
    return { slope, intercept, at: (i) => intercept + slope * i };
  };

  // ── Exportación CSV ───────────────────────────────────────────────────────
  W.csvCell = function (v) {
    const s = String(v ?? '');
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  W.downloadCSV = function (filename, headers, rows) {
    const lines = [headers.map(W.csvCell).join(',')];
    for (const r of rows) lines.push(r.map(W.csvCell).join(','));
    // BOM para que Excel en Windows respete los acentos.
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // ── Mails desde el repo privado ────────────────────────────────────────────
  // Compartido por Audiencias (exportar la base) y por el detalle de pedidos
  // de una tienda en Analítica: los dos necesitan cruzar hash -> email.
  /** Parsea hash,email,dni (dni opcional: los archivos viejos no lo traen). */
  W.parseHashEmailCsv = function (text) {
    const lines = String(text).split(/\r?\n/);
    const map = new Map();
    const start = (lines[0] || '').toLowerCase().includes('hash') ? 1 : 0;
    for (let i = start; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const c = lines[i].split(',');
      const h = (c[0] || '').trim();
      const email = (c[1] || '').trim().replace(/^"|"$/g, '');
      const dni = (c[2] || '').trim().replace(/^"|"$/g, '');
      if (h && (email || dni)) map.set(h, { email, dni });
    }
    return map.size ? map : null;
  };

  // Una sola promesa compartida: si dos vistas piden el mapa a la vez (o la
  // misma vista dos veces), solo hay UN fetch al repo privado.
  let emailMapPromise = null;
  /** hash -> { email, dni } | null si no hay repo privado configurado. */
  W.loadEmailMap = function () {
    if (!emailMapPromise) {
      emailMapPromise = fetch('/api/audience-emails', { cache: 'no-store' })
        .then((res) => (res.ok ? res.text() : null))
        .then((text) => (text ? W.parseHashEmailCsv(text) : null))
        .catch(() => null);
    }
    return emailMapPromise;
  };

  /**
   * Toast. Dos cosas que antes estaban mal:
   *
   * 1. El texto se escapaba de la caja. Solo tenia max-width:90vw y ninguna
   *    regla de corte, asi que un token largo sin espacios —un codigo de cupon
   *    como CSTAR-46-EZGKM8HKTGSWDYV, un nombre de archivo— no se partia y se
   *    desbordaba. Ahora el ancho se mide en caracteres y el corte es explicito.
   * 2. El estado lo decia SOLO el color (verde/rojo). Un estado nunca puede
   *    depender del color solo: ahora viaja con su icono, y el texto se inserta
   *    con textContent porque puede venir de datos (nombres de cupon, de
   *    producto) y no de un literal del codigo.
   */
  const TOAST_ICON = { good: 'check', bad: 'alert' };

  W.toast = function (msg, kind) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    el.replaceChildren();
    const ic = document.createElement('span');
    ic.className = 'toast-ic';
    ic.innerHTML = W.icon(TOAST_ICON[kind] || 'info', 15);
    const tx = document.createElement('span');
    tx.className = 'toast-tx';
    tx.textContent = msg;
    el.append(ic, tx);
    el.className = `toast show ${kind || ''}`;
    clearTimeout(el._t);
    el._t = setTimeout(() => (el.className = 'toast'), 4000);
  };

})();

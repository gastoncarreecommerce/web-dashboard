/* global window, document */
/**
 * Núcleo compartido de WebDash: carga de datasets, formateo, matemática de
 * rangos de fecha y exportación a CSV. Todo vive bajo window.W para que las
 * vistas (dashboard / analítica / audiencias) lo compartan sin bundler.
 */
(function () {
  const W = (window.W = window.W || {});

  W.CHANNEL = 'web';
  W.SEGMENTS = ['food', 'non-food', 'marketplace', 'quickcommerce'];
  W.SEGMENT_LABEL = { food: 'Food', 'non-food': 'Non Food', marketplace: 'Marketplace', quickcommerce: 'Quick Commerce' };
  W.SEGMENT_ICON = { food: '🥦', 'non-food': '🏠', marketplace: '🛒', quickcommerce: '⚡' };
  // Slots de la paleta validada (ver skill dataviz): aqua, azul, violeta, amarillo.
  W.SEGMENT_COLOR = { food: '#1baf7a', 'non-food': '#2a78d6', marketplace: '#4a3aa7', quickcommerce: '#eda100' };
  W.SEGMENT_ICON_NAME = { food: 'basket', 'non-food': 'home', marketplace: 'store', quickcommerce: 'bolt' };
  W.SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];

  // ── Formato ───────────────────────────────────────────────────────────────
  const nf = (opts) => new Intl.NumberFormat('es-AR', opts);
  W.fmtMoney = (n) => nf({ style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(n || 0);
  W.fmtMoneyC = (n) => nf({ style: 'currency', currency: 'ARS', notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
  W.fmtNum = (n) => nf({ maximumFractionDigits: 0 }).format(n || 0);
  W.fmtNumC = (n) => nf({ notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
  W.fmtDec = (n, d = 2) => nf({ minimumFractionDigits: d, maximumFractionDigits: d }).format(n || 0);
  W.fmtPct = (n, d = 1) => `${((n || 0) * 100).toFixed(d)}%`;
  W.fmtDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
  W.fmtDayLong = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' });
  W.fmtMonth = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('es-AR', { month: 'short', year: '2-digit' });
  W.esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  W.DOW_LABELS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

  // ── Fechas ────────────────────────────────────────────────────────────────
  W.addDays = (dateStr, n) => {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  W.daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000) + 1;

  W.presetRange = function (preset, days, startDate) {
    if (!days || !days.length) return null;
    const last = days[days.length - 1];
    switch (preset) {
      case 'yesterday': return { from: last, to: last };
      case '7d': return { from: W.addDays(last, -6), to: last };
      case '30d': return { from: W.addDays(last, -29), to: last };
      case '90d': return { from: W.addDays(last, -89), to: last };
      case 'month': return { from: last.slice(0, 8) + '01', to: last };
      case 'all': return { from: startDate || days[0], to: last };
      default: return null;
    }
  };
  W.previousRange = (range) => {
    const n = W.daysBetween(range.from, range.to);
    return { from: W.addDays(range.from, -n), to: W.addDays(range.from, -1) };
  };

  // ── Carga de datasets (cacheada) ──────────────────────────────────────────
  const cache = {};
  W.load = async function (name) {
    if (cache[name]) return cache[name];
    const res = await fetch(`data/${W.CHANNEL}/${name}.json`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`No se pudo cargar ${name}.json (${res.status})`);
    cache[name] = await res.json();
    return cache[name];
  };

  // ── Agregación de la serie diaria ─────────────────────────────────────────
  /**
   * Suma los días de `range` para uno o todos los segmentos.
   * bucket === 'all' suma los cuatro.
   */
  W.sumRange = function (daily, bucket, range) {
    const acc = {
      gmv: 0, orders: 0, units: 0, discount: 0, newCustomers: 0, activeCustomers: 0,
      marketing: {}, series: [], bySegment: {}, hourly: new Array(24).fill(0), statusStats: {},
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
        for (const [name, v] of Object.entries(seg.marketing || {})) {
          const e = (acc.marketing[name] = acc.marketing[name] || { gmv: 0, orders: 0 });
          e.gmv += v.gmv; e.orders += v.orders;
        }
      }

      acc.gmv += dayGmv; acc.orders += dayOrders; acc.units += dayUnits;
      // Descuentos, nuevos y activos son a nivel día (no por segmento), así que
      // solo se suman cuando la vista mira el canal completo.
      if (bucket === 'all') {
        acc.discount += day.discount || 0;
        acc.newCustomers += day.newCustomers || 0;
        acc.activeCustomers += day.activeCustomers || 0;
        (day.hourly || []).forEach((n, h) => (acc.hourly[h] += n));
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
    riesgo:     { label: 'En riesgo',  color: '#eda100', icon: 'alert',    desc: 'se está estirando más de lo normal entre compras' },
    churn:      { label: 'Churn',      color: '#e34948', icon: 'trendDown',desc: 'lleva más del triple de su intervalo sin comprar' },
    perdido:    { label: 'Perdido',    color: '#8b93a5', icon: 'sleep',    desc: 'sin comprar hace más de 180 días' },
  };
  W.LIFECYCLE_ORDER = ['campeon', 'activo', 'nuevo', 'riesgo', 'churn', 'perdido'];

  /** Umbrales, expuestos para poder explicarlos en la UI y ajustarlos en un solo lugar. */
  W.CHURN = { riskRatio: 1.5, churnRatio: 3, lostDays: 180, newDays: 45, fallbackInterval: 45 };

  /**
   * @param orders  pedidos del cliente
   * @param recency días desde la última compra
   * @param interval días promedio entre compras (0 si compró una sola vez)
   * @param gmv gasto total · avgGmv gasto promedio de la base (para 'campeón')
   */
  W.lifecycleOf = function (orders, recency, interval, gmv, avgGmv) {
    if (recency > W.CHURN.lostDays) return 'perdido';
    // Sin intervalo propio (una sola compra) se usa un valor de referencia.
    const base = interval > 0 ? interval : W.CHURN.fallbackInterval;
    const ratio = recency / base;
    if (orders === 1 && recency <= W.CHURN.newDays) return 'nuevo';
    if (ratio >= W.CHURN.churnRatio) return 'churn';
    if (ratio >= W.CHURN.riskRatio) return 'riesgo';
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

  W.toast = function (msg, kind) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = `toast show ${kind || ''}`;
    clearTimeout(el._t);
    el._t = setTimeout(() => (el.className = 'toast'), 3200);
  };

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
})();

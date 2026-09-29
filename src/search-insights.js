'use strict';

/**
 * Inteligencia de búsqueda desde GA4, para analistas de buscador y SEO.
 *
 * El diagnóstico (inspect-search-diagnosis.js) responde "¿el buscador contesta
 * bien?". Esto responde lo otro: qué busca la gente, qué está subiendo o
 * bajando, cómo lo escribe (variantes y errores de tipeo que conviene cubrir
 * con sinónimos), cuándo busca, desde qué dispositivo, y si el tracking de GA4
 * está guardando bien los términos.
 *
 * Una sola corrida diaria, siete reportes de la Data API (muy por debajo de la
 * cuota). Salida: docs/data/web/search-insights.json.
 *
 * Uso: GOOGLE_SERVICE_ACCOUNT=<json> GA4_PROPERTY_ID=<id> node src/search-insights.js
 */
const fs = require('fs');
const path = require('path');

const OUT_PATH = path.join(__dirname, '..', 'docs', 'data', 'web', 'search-insights.json');
const TERMS_KEPT = 1000;   // términos que viajan al dashboard
const WEEKS = 8;

// ── Normalización ──────────────────────────────────────────────────────────
// La MISMA que usa el diagnóstico (normalizeTerm), así los dos reportes se
// cruzan por término: minúsculas, decodificado, espacios colapsados.
function normalizeTerm(raw) {
  let t = String(raw ?? '');
  try { t = decodeURIComponent(t.replace(/\+/g, ' ')); } catch { /* ya estaba decodificado */ }
  return t.replace(/\s+/g, ' ').trim().toLowerCase();
}
const sinTildes = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const isEncoded = (raw) => /%[0-9a-f]{2}/i.test(String(raw || ''));

function levenshtein(a, b, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Por qué una variante se parece a su término principal. El orden importa:
 * se devuelve la explicación más simple.
 */
function variantKind(head, v) {
  if (sinTildes(head) === sinTildes(v)) return 'tilde';
  if (head.replace(/[\s-]/g, '') === v.replace(/[\s-]/g, '')) return 'espacio';
  const h = sinTildes(head), w = sinTildes(v);
  if (h.replace(/s\b/g, '') === w.replace(/s\b/g, '')) return 'plural';
  // Umbrales conservadores: "coca"/"coco" o "leche"/"noche" no son errores de
  // tipeo, son otra búsqueda. Cortas no se comparan; largas toleran 2 letras.
  const max = h.length >= 10 && Math.abs(h.length - w.length) <= 1 ? 2 : 1;
  if (h.length >= 6 && levenshtein(h, w, max) <= max) return 'tipeo';
  return null;
}

/**
 * Arma el JSON del dashboard a partir de las filas crudas de GA4. Pura (sin
 * red) para poder probarla.
 *
 * raw = {
 *   periods: [{ term, cur, prev, users }]          30 días vs. 30 anteriores
 *   week:    [{ term, cur, prev }]                  7 días vs. 7 anteriores
 *   weekly:  [{ term, week: 'YYYYWW', n }]          últimas 8 semanas
 *   daily:   [{ date, event, n, users }]            90 días, search y view_search_results
 *   heat:    [{ dow, hour, n }]                     28 días
 *   devices: [{ device, event, n, users }]          30 días
 *   ranges:  { cur: [from, to], prev: [from, to] }
 * }
 */
function buildInsights(raw) {
  const agg = new Map(); // clave normalizada -> datos
  let emptyN = 0, encodedN = 0;
  const encodedTerms = new Map();
  let totalCur = 0, totalPrev = 0;

  for (const r of raw.periods || []) {
    totalCur += r.cur || 0;
    totalPrev += r.prev || 0;
    const key = normalizeTerm(r.term);
    if (!key || key === '(not set)') { emptyN += r.cur || 0; continue; }
    if (isEncoded(r.term)) {
      encodedN += r.cur || 0;
      encodedTerms.set(key, (encodedTerms.get(key) || 0) + (r.cur || 0));
    }
    let a = agg.get(key);
    if (!a) agg.set(key, (a = { t: key, n: 0, p: 0, u: 0, raw: new Map(), w: new Array(WEEKS).fill(0), n7: 0, p7: 0 }));
    a.n += r.cur || 0;
    a.p += r.prev || 0;
    a.u += r.users || 0;
    const shown = String(r.term).trim();
    a.raw.set(shown, (a.raw.get(shown) || 0) + (r.cur || 0));
  }

  for (const r of raw.week || []) {
    const a = agg.get(normalizeTerm(r.term));
    if (!a) continue;
    a.n7 += r.cur || 0;
    a.p7 += r.prev || 0;
  }

  const weeks = [...new Set((raw.weekly || []).map((r) => r.week))].sort().slice(-WEEKS);
  const wIdx = new Map(weeks.map((w, i) => [w, i + (WEEKS - weeks.length)]));
  for (const r of raw.weekly || []) {
    const a = agg.get(normalizeTerm(r.term));
    const i = wIdx.get(r.week);
    if (a && i != null) a.w[i] += r.n || 0;
  }

  const ranked = [...agg.values()].sort((x, y) => y.n - x.n || y.p - x.p);

  // Variantes: un término más chico que es la misma búsqueda mal escrita, con
  // o sin tilde, junto/separado o en plural. Se cuelga del término principal
  // más buscado que se le parezca. Solo se miran los primeros 1500 (los de más
  // abajo no mueven la aguja) y se compara por longitud parecida.
  const pool = ranked.slice(0, 1500);
  const variantOf = new Map();
  for (let i = 0; i < pool.length; i++) {
    const head = pool[i];
    if (variantOf.has(head.t) || head.t.length < 4) continue;
    for (let j = i + 1; j < pool.length; j++) {
      const v = pool[j];
      if (variantOf.has(v.t) || Math.abs(v.t.length - head.t.length) > 3) continue;
      const kind = variantKind(head.t, v.t);
      // Un "tipeo" con casi tanto volumen como el principal es otra búsqueda
      // legítima (una marca, otro producto), no un error.
      if (!kind || (kind === 'tipeo' && v.n > head.n * 0.3)) continue;
      variantOf.set(v.t, head.t);
      (head.vars = head.vars || []).push([v.t, v.n, kind]);
    }
  }

  const terms = ranked.slice(0, TERMS_KEPT).map((a) => {
    const forms = [...a.raw.entries()].sort((x, y) => y[1] - x[1]);
    const o = { t: a.t, n: a.n, p: a.p, u: a.u, n7: a.n7, p7: a.p7, w: a.w };
    if (forms.length > 1) o.f = forms.slice(0, 5);
    if (a.vars) o.v = a.vars.slice(0, 12);
    if (variantOf.has(a.t)) o.of = variantOf.get(a.t);
    return o;
  });

  // Serie diaria: búsquedas y usuarios, y cuántos llegaron a ver resultados.
  const byDate = new Map();
  for (const r of raw.daily || []) {
    const d = `${r.date.slice(0, 4)}-${r.date.slice(4, 6)}-${r.date.slice(6, 8)}`;
    const x = byDate.get(d) || { d, s: 0, su: 0, r: 0, ru: 0 };
    if (r.event === 'search') { x.s += r.n; x.su += r.users; }
    else if (r.event === 'view_search_results') { x.r += r.n; x.ru += r.users; }
    byDate.set(d, x);
  }
  const daily = [...byDate.values()].sort((a, b) => a.d.localeCompare(b.d));

  // Mapa de calor: GA4 da dayOfWeek 0=domingo.
  const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const r of raw.heat || []) {
    const d = Number(r.dow), h = Number(r.hour);
    if (d >= 0 && d < 7 && h >= 0 && h < 24) heat[d][h] += r.n || 0;
  }

  const dev = new Map();
  for (const r of raw.devices || []) {
    const x = dev.get(r.device) || { k: r.device, s: 0, su: 0, users: 0 };
    if (r.event === 'search') { x.s += r.n; x.su += r.users; }
    else if (r.event === 'session_start') x.users += r.users;
    dev.set(r.device, x);
  }

  const lens = ranked.slice(0, 1000);
  const volTop = (k) => ranked.slice(0, k).reduce((s, a) => s + a.n, 0);
  const words = lens.reduce((s, a) => s + a.n * a.t.split(' ').length, 0);
  const volLens = lens.reduce((s, a) => s + a.n, 0);
  const numeric = ranked.filter((a) => /^\d{5,14}$/.test(a.t.replace(/\s/g, '')));
  const caseForms = ranked.filter((a) => a.raw.size > 1).length;

  return {
    generatedAt: new Date().toISOString(),
    ranges: raw.ranges || null,
    weeks,
    totals: {
      cur: totalCur, prev: totalPrev,
      distinct: agg.size,
      top10: volTop(10), top100: volTop(100), top1000: volTop(1000),
      avgWords: volLens ? words / volLens : null,
    },
    quality: {
      empty: emptyN,
      encoded: encodedN,
      encodedTerms: [...encodedTerms.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
      caseForms,
      numeric: numeric.reduce((s, a) => s + a.n, 0),
      numericTerms: numeric.slice(0, 10).map((a) => [a.t, a.n]),
    },
    terms,
    daily,
    heat,
    devices: [...dev.values()].sort((a, b) => b.s - a.s),
  };
}

// ── GA4 ────────────────────────────────────────────────────────────────────
async function fetchRaw() {
  const { google } = require('googleapis');
  const propertyId = process.env.GA4_PROPERTY_ID;
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/analytics.readonly'] });
  const api = google.analyticsdata({ version: 'v1beta', auth });
  const run = async (name, body) => {
    try {
      const res = await api.properties.runReport({ property: `properties/${propertyId}`, requestBody: body });
      const rows = res.data.rows || [];
      console.log(`  ✓ ${name}: ${rows.length} filas`);
      return rows;
    } catch (e) {
      console.log(`  ✗ ${name}: ${e.message}`);
      return [];
    }
  };
  const isSearch = { filter: { fieldName: 'eventName', stringFilter: { value: 'search' } } };
  const inEvents = (values) => ({ filter: { fieldName: 'eventName', inListFilter: { values } } });
  const dim = (r, i) => r.dimensionValues[i].value;
  const met = (r, i) => Number(r.metricValues[i].value);
  const TERM_DIM = process.env.SEARCH_TERM_DIM || 'searchTerm';

  // Con dos rangos de fechas GA4 agrega la dimensión "dateRange" al final.
  const twoPeriods = async (name, cur, prev, withUsers) => {
    const rows = await run(name, {
      dateRanges: [{ ...cur, name: 'cur' }, { ...prev, name: 'prev' }],
      dimensions: [{ name: TERM_DIM }],
      metrics: withUsers ? [{ name: 'eventCount' }, { name: 'totalUsers' }] : [{ name: 'eventCount' }],
      dimensionFilter: isSearch,
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: '10000',
    });
    const m = new Map();
    for (const r of rows) {
      const term = dim(r, 0), range = dim(r, 1);
      const x = m.get(term) || { term, cur: 0, prev: 0, users: 0 };
      if (range === 'cur') { x.cur += met(r, 0); if (withUsers) x.users += met(r, 1); } else x.prev += met(r, 0);
      m.set(term, x);
    }
    return [...m.values()];
  };

  console.log(`Inteligencia de búsqueda (property ${propertyId})...`);
  const periods = await twoPeriods('30 días vs. 30 anteriores',
    { startDate: '30daysAgo', endDate: 'yesterday' }, { startDate: '60daysAgo', endDate: '31daysAgo' }, true);
  const week = await twoPeriods('7 días vs. 7 anteriores',
    { startDate: '7daysAgo', endDate: 'yesterday' }, { startDate: '14daysAgo', endDate: '8daysAgo' }, false);

  const weekly = (await run('semanas por término', {
    dateRanges: [{ startDate: `${WEEKS * 7}daysAgo`, endDate: 'yesterday' }],
    dimensions: [{ name: TERM_DIM }, { name: 'isoYearIsoWeek' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: isSearch,
    orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
    limit: '40000',
  })).map((r) => ({ term: dim(r, 0), week: dim(r, 1), n: met(r, 0) }));

  const daily = (await run('serie diaria', {
    dateRanges: [{ startDate: '90daysAgo', endDate: 'yesterday' }],
    dimensions: [{ name: 'date' }, { name: 'eventName' }],
    metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
    dimensionFilter: inEvents(['search', 'view_search_results']),
    limit: '1000',
  })).map((r) => ({ date: dim(r, 0), event: dim(r, 1), n: met(r, 0), users: met(r, 1) }));

  const heat = (await run('día y hora', {
    dateRanges: [{ startDate: '28daysAgo', endDate: 'yesterday' }],
    dimensions: [{ name: 'dayOfWeek' }, { name: 'hour' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: isSearch,
    limit: '200',
  })).map((r) => ({ dow: dim(r, 0), hour: dim(r, 1), n: met(r, 0) }));

  const devices = (await run('dispositivos', {
    dateRanges: [{ startDate: '30daysAgo', endDate: 'yesterday' }],
    dimensions: [{ name: 'deviceCategory' }, { name: 'eventName' }],
    metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
    dimensionFilter: inEvents(['search', 'session_start']),
    limit: '50',
  })).map((r) => ({ device: dim(r, 0), event: dim(r, 1), n: met(r, 0), users: met(r, 1) }));

  const iso = (d) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
  return {
    periods, week, weekly, daily, heat, devices,
    ranges: { cur: [iso(30), iso(1)], prev: [iso(60), iso(31)], week: [iso(7), iso(1)] },
  };
}

async function main() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT || !process.env.GA4_PROPERTY_ID) {
    console.log('⚠ Faltan GOOGLE_SERVICE_ACCOUNT y/o GA4_PROPERTY_ID — sin inteligencia de búsqueda. Salgo sin error.');
    return;
  }
  const raw = await fetchRaw();
  if (!raw.periods.length) {
    console.log('⚠ GA4 no devolvió términos: no se pisa el archivo anterior.');
    return;
  }
  const out = buildInsights(raw);
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out));
  const kb = (fs.statSync(OUT_PATH).size / 1024).toFixed(0);
  console.log(`\n${out.terms.length} términos · ${out.totals.cur.toLocaleString('es-AR')} búsquedas (30 días) · ${kb} KB → ${path.relative(process.cwd(), OUT_PATH)}`);
}

if (require.main === module) {
  main().catch((err) => { console.error('search-insights falló:', err.stack || err.message); process.exit(1); });
}

module.exports = { buildInsights, normalizeTerm, variantKind };

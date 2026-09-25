'use strict';

/**
 * Inteligencia del constructor de audiencias: se calcula en el pipeline sobre
 * los perfiles de cliente (Web + App) y viaja en audience-index.json como
 * columnas nuevas. Todo sale de nuestros propios pedidos — no depende de
 * servicios externos ni de datos personales (trabaja sobre el hash).
 *
 *  1. pv  — probabilidad (0-100) de que el cliente vuelva a comprar en los
 *           próximos 30 días. Regresión logística entrenada con el propio
 *           historial: se "rebobina" 30 días, se miran las features de cada
 *           cliente a esa fecha y se aprende quién volvió y quién no. La
 *           calidad se mide (AUC) sobre un 20% de clientes que el modelo no
 *           vio al entrenar, y viaja en el índice para mostrarla en pantalla.
 *  2. af  — afinidad: hasta 3 categorías (N1) donde el cliente compra bastante
 *           más que el promedio de la base (lift ≥ 1,5 y al menos 2 compras).
 *  3. nb  — próxima categoría probable (N1): la que todavía no compró y que
 *           más compran los clientes que compran lo mismo que él
 *           (co-ocurrencia entre categorías, "los que compran A también B").
 */

const HORIZON = 30;

function features(ds, ref, ticket) {
  const n = ds.length;
  const first = ds[0];
  const last = ds[n - 1];
  const rec = ref - last;
  const ten = ref - first;
  const ip = n > 1 ? (last - first) / (n - 1) : 0;
  const ratio = n > 1 ? rec / Math.max(ip, 1) : 0;
  return [
    Math.log1p(rec),
    Math.log1p(n),
    Math.log1p(ten),
    n > 1 ? 1 : 0,
    n > 1 ? Math.log1p(ratio) : 0,
    Math.log1p(ticket / 1000),
  ];
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/** AUC por ranking (Mann-Whitney): P(score de un positivo > score de un negativo). */
function auc(scores, labels) {
  const idx = scores.map((s, i) => i).sort((a, b) => scores[a] - scores[b]);
  let rankSumPos = 0, nPos = 0, nNeg = 0;
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && scores[idx[j + 1]] === scores[idx[i]]) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) {
      if (labels[idx[k]]) { rankSumPos += avgRank; nPos++; } else nNeg++;
    }
    i = j + 1;
  }
  if (!nPos || !nNeg) return null;
  return (rankSumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

function trainReturnModel(profiles, lastIdx) {
  const T = lastIdx - HORIZON;
  if (T < 60) return null; // muy poco historial para entrenar algo honesto

  const X = [], y = [], test = [];
  for (const [hash, p] of profiles) {
    const all = [...p.ds].filter((d) => d != null).sort((a, b) => a - b);
    const pre = all.filter((d) => d <= T);
    if (!pre.length) continue;
    X.push(features(pre, T, p.o ? p.g / p.o : 0));
    y.push(all.some((d) => d > T && d <= T + HORIZON) ? 1 : 0);
    test.push(parseInt(hash.slice(-2), 16) % 5 === 0);
  }
  const k = X[0]?.length || 0;
  const trainIdx = [], testIdx = [];
  test.forEach((t, i) => (t ? testIdx : trainIdx).push(i));
  if (trainIdx.length < 1000 || testIdx.length < 200) return null;

  // Estandarización con medias/desvíos del set de entrenamiento.
  const mu = new Array(k).fill(0), sd = new Array(k).fill(0);
  for (const i of trainIdx) for (let j = 0; j < k; j++) mu[j] += X[i][j];
  for (let j = 0; j < k; j++) mu[j] /= trainIdx.length;
  for (const i of trainIdx) for (let j = 0; j < k; j++) sd[j] += (X[i][j] - mu[j]) ** 2;
  for (let j = 0; j < k; j++) sd[j] = Math.sqrt(sd[j] / trainIdx.length) || 1;
  const Z = X.map((x) => x.map((v, j) => (v - mu[j]) / sd[j]));

  // Descenso por gradiente (batch), con una L2 chica para que no se dispare.
  const w = new Array(k + 1).fill(0);
  const lr = 0.5, l2 = 1e-4, iters = 300, m = trainIdx.length;
  for (let it = 0; it < iters; it++) {
    const grad = new Array(k + 1).fill(0);
    for (const i of trainIdx) {
      let z = w[0];
      for (let j = 0; j < k; j++) z += w[j + 1] * Z[i][j];
      const e = sigmoid(z) - y[i];
      grad[0] += e;
      for (let j = 0; j < k; j++) grad[j + 1] += e * Z[i][j];
    }
    w[0] -= (lr * grad[0]) / m;
    for (let j = 0; j < k; j++) w[j + 1] -= lr * (grad[j + 1] / m + l2 * w[j + 1]);
  }

  const predictZ = (x) => {
    let z = w[0];
    for (let j = 0; j < k; j++) z += w[j + 1] * ((x[j] - mu[j]) / sd[j]);
    return sigmoid(z);
  };
  const testScores = testIdx.map((i) => predictZ(X[i]));
  const testLabels = testIdx.map((i) => y[i]);
  const posRate = testLabels.reduce((t, v) => t + v, 0) / testLabels.length;

  return {
    predict: (ds, ref, ticket) => predictZ(features(ds, ref, ticket)),
    meta: {
      horizonDays: HORIZON,
      auc: Number((auc(testScores, testLabels) ?? 0).toFixed(3)),
      baseRate: Number(posRate.toFixed(3)),
      trainCustomers: trainIdx.length,
      testCustomers: testIdx.length,
      snapshotIndex: T,
    },
  };
}

/**
 * Calcula las tres columnas para cada perfil. Devuelve un Map hash ->
 * { pv, af: [nombreN1...], nb: nombreN1|null } y la meta del modelo.
 */
function scoreCustomers(profiles, lastIdx) {
  const model = trainReturnModel(profiles, lastIdx);

  // ── Afinidad y co-ocurrencia a nivel N1 ─────────────────────────────────
  const pop = {};
  let popTotal = 0;
  const buyers = {};          // cat -> clientes que la compraron
  const pair = {};            // a -> b -> clientes que compraron a y b
  for (const p of profiles.values()) {
    const cats = Object.keys(p.catsN1 || {});
    for (const [c, n] of Object.entries(p.catsN1 || {})) { pop[c] = (pop[c] || 0) + n; popTotal += n; }
    for (const a of cats) {
      buyers[a] = (buyers[a] || 0) + 1;
      const row = (pair[a] = pair[a] || {});
      for (const b of cats) if (b !== a) row[b] = (row[b] || 0) + 1;
    }
  }
  const allCats = Object.keys(buyers);

  const out = new Map();
  for (const [hash, p] of profiles) {
    let pv = null;
    if (model) {
      const ds = [...p.ds].filter((d) => d != null).sort((a, b) => a - b);
      if (ds.length) pv = Math.round(model.predict(ds, lastIdx, p.o ? p.g / p.o : 0) * 100);
    }

    const counts = p.catsN1 || {};
    const tot = Object.values(counts).reduce((t, v) => t + v, 0);
    const af = tot && popTotal
      ? Object.entries(counts)
        .filter(([, n]) => n >= 2)
        .map(([c, n]) => [c, (n / tot) / (pop[c] / popTotal)])
        .filter(([, lift]) => lift >= 1.5)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([c]) => c)
      : [];

    let nb = null;
    const mine = Object.keys(counts);
    if (mine.length) {
      let best = 0;
      for (const b of allCats) {
        if (counts[b]) continue;
        let sc = 0;
        for (const a of mine) sc += (pair[a]?.[b] || 0) / buyers[a];
        sc /= mine.length;
        if (sc > best) { best = sc; nb = b; }
      }
      if (best < 0.05) nb = null;
    }
    out.set(hash, { pv, af, nb });
  }
  return { scores: out, model: model ? model.meta : null };
}

/**
 * Fusiona docs/data/app/customers.json (perfiles HASHEADOS de App, ver
 * scripts/build-app-summary.mjs) en los perfiles de Web. Un mismo cliente que
 * compra por los dos canales queda UNA vez, con pedidos, gasto y fechas de
 * ambos. Devuelve cuántos se sumaron y cuántos eran nuevos (solo App).
 */
function mergeAppCustomers(profiles, app, dayPos) {
  if (!app?.h?.length || !app.base) return { merged: 0, onlyApp: 0 };
  const b0 = Date.parse(`${app.base}T00:00:00Z`);
  const dateOf = (off) => new Date(b0 + off * 86400000).toISOString().slice(0, 10);
  let merged = 0, onlyApp = 0;
  for (let i = 0; i < app.h.length; i++) {
    const dates = (app.d[i] || []).map(dateOf).filter((d) => dayPos.has(d));
    if (!dates.length) continue;
    const hash = app.h[i];
    let p = profiles.get(hash);
    if (!p) {
      p = { o: 0, g: 0, first: dates[0], last: dates[dates.length - 1], segs: {}, cats: {}, catsN1: {}, catsN2: {}, cp: 0, pms: {}, stores: {}, ds: new Set(), ch: 0 };
      profiles.set(hash, p);
      onlyApp++;
    }
    p.o += app.o[i];
    p.g += app.g[i];
    p.cp += app.cp[i] || 0;
    // Por nombre, no por posición: el orden de segmentos de App y de Web
    // no tiene por qué coincidir.
    (app.sg[i] || []).forEach((n, k) => { const sg = app.segments[k]; if (n && sg) p.segs[sg] = (p.segs[sg] || 0) + n; });
    for (const d of dates) {
      p.ds.add(dayPos.get(d));
      if (d < p.first) p.first = d;
      if (d > p.last) p.last = d;
    }
    p.ch |= 2;
    merged++;
  }
  return { merged, onlyApp };
}

module.exports = { scoreCustomers, mergeAppCustomers, HORIZON };

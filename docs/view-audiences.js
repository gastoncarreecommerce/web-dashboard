/* global window, document, FileReader, Blob, URL, TextEncoder, crypto */
/**
 * Vista "Audiencias": de "a quién le hablo" a "cuánto vendí de más por eso".
 *
 * Tres pestañas, en el orden en que se trabaja una campaña:
 *   1. Oportunidades — lo que la base pide HOY (a quién le toca reponer,
 *      quién está por volver, quién se está yendo), calculado solo.
 *   2. Crear audiencia — el constructor de condiciones, con el perfil, el
 *      incentivo recomendado y la reposición de la audiencia armada.
 *   3. Campañas — cada envío con su GRUPO DE CONTROL: una parte al azar de la
 *      audiencia que no se contacta. Lo que compró el grupo tratado por encima
 *      del control es lo que la campaña generó de verdad.
 *
 * El índice público identifica a cada cliente con un hash (no lleva datos
 * personales). Los mails viven en un repositorio PRIVADO y llegan por
 * /api/audience-emails; las campañas guardan solo hashes truncados.
 */
(function () {
  const W = (window.W = window.W || {});

  let idx = null;      // audience-index.json
  let D = null;        // columnas derivadas (recencia, churn, ciclo de vida, incentivo, reposición)
  let OPP = null;      // oportunidades, se recalculan cuando cambia D
  let emailMap = null; // hash -> { email, dni }, solo en memoria de esta pestaña
  let emailTried = false;
  let rules = W.store.get('audienceRules', [{ field: 'ciclo', op: 'es', value: 'churn' }]);
  let tab = W.store.get('audTab', 'opp');
  let insight = 'perfil';
  let modal = null;      // 'churn' | 'camp' | null
  let audName = '';      // nombre del objetivo elegido, para sugerir el de la campaña

  // Campañas
  let camps = null;      // lista (servidor + locales)
  let campsState = 'idle';
  let campsLocalOnly = false;
  const members = new Map(); // id -> { t, c } (hashes de 12, concatenados)
  const results = new Map(); // id -> resultado de medición
  let act = null, actState = 'idle', h12 = null;
  let campSel = null;
  let horizon = 30;

  const hasRules = (current, subset) => {
    const key = (r) => `${r.field}|${r.op}|${r.value}`;
    const have = new Set(current.map(key));
    return subset.every((r) => have.has(key(r)));
  };

  // ── Campos del constructor, agrupados por la pregunta que responden ───────
  const FIELDS = {
    ciclo:        { g: 'who', label: 'Ciclo de vida', type: 'lifecycle', ops: ['es', 'no es'] },
    canal:        { g: 'who', label: 'Canal de compra', type: 'channel', ops: ['es', 'no es'], needs: 'channel' },
    segDominante: { g: 'who', label: 'Segmento dominante', type: 'segment', ops: ['es', 'no es'] },
    medioPago:    { g: 'who', label: 'Medio de pago habitual', type: 'payment', ops: ['es', 'no es'], needs: 'payment' },
    comproEnTienda: { g: 'who', label: 'Compró en la tienda', type: 'store', ops: ['sí', 'no'], needs: 'store' },
    reponer:      { g: 'what', label: 'Le toca reponer', type: 'replenish', ops: ['sí', 'no'], needs: 'replenish' },
    catDomN1:     { g: 'what', label: 'Categoría N1 dominante', type: 'categoryN1', ops: ['es', 'no es'], needs: 'categoryLevels' },
    catDomN2:     { g: 'what', label: 'Categoría N2 dominante', type: 'categoryN2', ops: ['es', 'no es'], needs: 'categoryLevels' },
    catDominante: { g: 'what', label: 'Categoría N3 dominante', type: 'category', ops: ['es', 'no es'] },
    comproEnCat:  { g: 'what', label: 'Compró en la categoría (N3)', type: 'category', ops: ['sí', 'no'] },
    pedidos:      { g: 'much', label: 'Cantidad de pedidos', type: 'number', ops: ['≥', '≤', '='] },
    gasto:        { g: 'much', label: 'Gasto total (ARS)', type: 'number', ops: ['≥', '≤'] },
    ticket:       { g: 'much', label: 'Ticket promedio (ARS)', type: 'number', ops: ['≥', '≤'] },
    cuponPct:     { g: 'much', label: '% de pedidos con cupón', type: 'number', ops: ['≥', '≤'], needs: 'coupon' },
    cuponPedidos: { g: 'much', label: 'Pedidos con cupón', type: 'number', ops: ['≥', '≤', '='], needs: 'coupon' },
    recencia:     { g: 'when', label: 'Días desde la última compra', type: 'number', ops: ['≥', '≤'] },
    antiguedad:   { g: 'when', label: 'Días desde la primera compra', type: 'number', ops: ['≥', '≤'] },
    intervalo:    { g: 'when', label: 'Días promedio entre compras', type: 'number', ops: ['≥', '≤'] },
    churnRatio:   { g: 'when', label: 'Ratio de abandono (recencia ÷ intervalo)', type: 'number', ops: ['≥', '≤'] },
    probVuelta:   { g: 'ai', label: 'Probabilidad de volver en 30 días (%)', type: 'number', ops: ['≥', '≤'], needs: 'ai' },
    incentivo:    { g: 'ai', label: 'Incentivo recomendado', type: 'incentive', ops: ['es', 'no es'] },
    afinidad:     { g: 'ai', label: 'Afinidad alta con la categoría', type: 'categoryN1', ops: ['sí', 'no'], needs: 'ai' },
    proximaCat:   { g: 'ai', label: 'Próxima categoría probable', type: 'categoryN1', ops: ['es', 'no es'], needs: 'ai' },
  };
  const FIELD_GROUPS = [['who', 'Quién es'], ['what', 'Qué compra'], ['much', 'Cuánto compra'], ['when', 'Cuándo compra'], ['ai', 'Predicción con IA']];

  // Canal: bit 1 = compró por Web, bit 2 = compró por App (3 = los dos).
  const CHANNELS = { web: { label: 'Solo Web', v: 1 }, app: { label: 'Solo App', v: 2 }, ambos: { label: 'Web y App', v: 3 } };

  // ── Incentivo recomendado ─────────────────────────────────────────────────
  // Regalar un cupón a quien iba a comprar igual es margen tirado; no darle
  // nada a quien se está yendo es perderlo. La regla usa la probabilidad de
  // volver (IA) y el historial de cupones de cada cliente.
  const INC_KEYS = ['sin', 'chico', 'fuerte', 'solo'];
  const INCENTIVES = {
    sin:    { label: 'Sin cupón', color: '#1baf7a', icon: 'bolt', short: 'un recordatorio alcanza',
      desc: 'Tienen alta probabilidad de comprar igual. Un recordatorio o una novedad alcanza: darles cupón es regalar margen.' },
    chico:  { label: 'Cupón chico', color: '#2a78d6', icon: 'tag', short: '5–10% o envío gratis',
      desc: 'Están en duda. Un empujón chico (5–10% o envío gratis) suele alcanzar para que vuelvan.' },
    fuerte: { label: 'Cupón fuerte', color: '#e34948', icon: 'percent', short: '15% o más',
      desc: 'Se están yendo y es poco probable que vuelvan solos. Hace falta un incentivo claro (15% o más).' },
    solo:   { label: 'Solo con descuento', color: '#8a5cf6', icon: 'ticket', short: 'responden a cupón',
      desc: 'Compran casi siempre con cupón (70% o más de sus pedidos). Sin descuento difícilmente respondan.' },
  };

  // ── Atajos para arrancar, agrupados por intención ─────────────────────────
  const PRESETS = [
    { group: 'Ciclo de vida', items: [
      { name: 'Campeones', icon: 'star', rules: [{ field: 'ciclo', op: 'es', value: 'campeon' }] },
      { name: 'Nuevos sin recompra', icon: 'sparkles', rules: [{ field: 'ciclo', op: 'es', value: 'nuevo' }] },
      { name: 'En riesgo', icon: 'alert', rules: [{ field: 'ciclo', op: 'es', value: 'riesgo' }] },
      { name: 'Churners', icon: 'trendDown', rules: [{ field: 'ciclo', op: 'es', value: 'churn' }] },
      { name: 'Fieles', icon: 'heart', rules: [{ field: 'ciclo', op: 'es', value: 'activo' }, { field: 'pedidos', op: '≥', value: 4 }] },
    ]},
    { group: 'Reposición', needs: 'replenish', items: [
      { name: 'Le toca reponer', icon: 'refresh', rules: [{ field: 'reponer', op: 'sí', value: '*' }] },
    ]},
    { group: 'Predicción con IA', needs: 'ai', items: [
      { name: 'Listos para comprar', icon: 'target', rules: [{ field: 'probVuelta', op: '≥', value: 70 }] },
      { name: 'Valiosos que se enfrían', icon: 'money', rules: [{ field: 'gasto', op: '≥', value: 300000 }, { field: 'probVuelta', op: '≤', value: 25 }, { field: 'ciclo', op: 'no es', value: 'perdido' }] },
      { name: 'Churn recuperable', icon: 'refresh', rules: [{ field: 'ciclo', op: 'es', value: 'churn' }, { field: 'probVuelta', op: '≥', value: 30 }] },
      { name: 'Nuevos con potencial', icon: 'sparkles', rules: [{ field: 'pedidos', op: '=', value: 1 }, { field: 'recencia', op: '≤', value: 45 }, { field: 'probVuelta', op: '≥', value: 25 }] },
    ]},
    { group: 'Cupones', needs: 'coupon', items: [
      { name: 'Cupón-dependientes', icon: 'tag', rules: [{ field: 'cuponPct', op: '≥', value: 70 }, { field: 'pedidos', op: '≥', value: 2 }] },
      { name: 'Fieles a precio lleno', icon: 'shield', rules: [{ field: 'cuponPedidos', op: '=', value: 0 }, { field: 'pedidos', op: '≥', value: 5 }] },
    ]},
    { group: 'Canal', needs: 'channel', items: [
      { name: 'Solo App', icon: 'phone', rules: [{ field: 'canal', op: 'es', value: 'app' }] },
      { name: 'Web → llevar a la App', icon: 'phone', rules: [{ field: 'canal', op: 'es', value: 'web' }, { field: 'pedidos', op: '≥', value: 3 }] },
    ]},
    { group: 'Valor', items: [
      { name: 'Alto valor en fuga', icon: 'money', rules: [{ field: 'gasto', op: '≥', value: 500000 }, { field: 'churnRatio', op: '≥', value: 2 }] },
      { name: 'Ticket alto', icon: 'ticket', rules: [{ field: 'ticket', op: '≥', value: 200000 }] },
      { name: 'Compró una sola vez', icon: 'box', rules: [{ field: 'pedidos', op: '=', value: 1 }] },
    ]},
  ];

  // Oportunidades automáticas: cada una es una audiencia lista para mandar.
  const OPPS = [
    { key: 'listos', name: 'Listos para comprar', icon: 'target', needs: 'ai',
      why: 'La IA estima 70% o más de que vuelvan en 30 días. Un recordatorio con novedades, sin regalar margen.',
      rules: [{ field: 'probVuelta', op: '≥', value: 70 }] },
    { key: 'enfrian', name: 'Valiosos que se enfrían', icon: 'money', needs: 'ai',
      why: 'Gastaron $300 mil o más pero hoy es poco probable que vuelvan. Son los que más duele perder.',
      rules: [{ field: 'gasto', op: '≥', value: 300000 }, { field: 'probVuelta', op: '≤', value: 25 }, { field: 'ciclo', op: 'no es', value: 'perdido' }] },
    { key: 'churnrec', name: 'Churn recuperable', icon: 'refresh', needs: 'ai',
      why: 'Dejaron de comprar, pero todavía tienen 30% o más de chances de volver. El momento de ir a buscarlos es ahora.',
      rules: [{ field: 'ciclo', op: 'es', value: 'churn' }, { field: 'probVuelta', op: '≥', value: 30 }] },
    { key: 'nuevos', name: 'Nuevos con potencial', icon: 'sparkles', needs: 'ai',
      why: 'Compraron por primera vez hace poco y tienen más chances de volver que el resto de los nuevos. La segunda compra es la que fideliza.',
      rules: [{ field: 'pedidos', op: '=', value: 1 }, { field: 'recencia', op: '≤', value: 45 }, { field: 'probVuelta', op: '≥', value: 25 }] },
    { key: 'webapp', name: 'Web → llevar a la App', icon: 'phone', needs: 'channel',
      why: 'Compran seguido por la Web y nunca usaron la App. Buen público para una campaña de descarga.',
      rules: [{ field: 'canal', op: 'es', value: 'web' }, { field: 'pedidos', op: '≥', value: 3 }] },
    { key: 'cupon', name: 'Cupón-dependientes', icon: 'tag', needs: 'coupon',
      why: 'El 70% o más de sus pedidos fue con cupón. Solo responden a descuento: medí bien si conviene.',
      rules: [{ field: 'cuponPct', op: '≥', value: 70 }, { field: 'pedidos', op: '≥', value: 2 }] },
  ];

  // ── Derivadas: se calculan una vez al cargar el índice ────────────────────
  function derive() {
    const n = idx.count;
    const lastIdx = idx.days.length - 1;
    const recency = new Int32Array(n);
    const churn = new Float32Array(n);
    const life = new Array(n);
    const couponPct = new Float32Array(n);
    const inc = new Uint8Array(n);
    const due = new Array(n); // categorías N2 que le toca reponer HOY (o null)

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

      const pv = idx.pv ? idx.pv[i] : null;
      if (couponPct[i] >= 70 && idx.o[i] >= 2) inc[i] = 3;
      else if (pv != null) inc[i] = pv >= 60 ? 0 : pv >= 25 ? 1 : 2;
      else inc[i] = { campeon: 0, activo: 0, nuevo: 1, riesgo: 1 }[life[i]] ?? 2;

      // "Le toca": pasó entre 0,9 y 2 veces lo que suele tardar en volver a
      // comprar esa categoría. Antes es temprano; después ya la compra en otro lado.
      const rp = idx.rp?.[i];
      let d = null;
      if (rp && rp.length) {
        for (const [c, mean, last] of rp) {
          const q = (lastIdx - last) / (mean || 1);
          if (q >= 0.9 && q <= 2) (d = d || []).push(c);
        }
      }
      due[i] = d;
    }
    OPP = null;
    return { recency, churn, life, couponPct, inc, due, avgG, lastIdx };
  }

  function compile(rs) {
    return rs
      .map((r) => {
        const f = FIELDS[r.field];
        if (!f) return null;
        if (f.type === 'category') return { ...r, ci: idx.categories.indexOf(r.value) };
        if (f.type === 'categoryN1') return { ...r, ci: (idx.categoriesN1 || []).indexOf(r.value) };
        if (f.type === 'categoryN2') return { ...r, ci: (idx.categoriesN2 || []).indexOf(r.value) };
        if (f.type === 'replenish') return { ...r, ci: r.value === '*' ? -2 : (idx.categoriesN2 || []).indexOf(r.value) };
        if (f.type === 'incentive') return { ...r, ii: INC_KEYS.indexOf(r.value) };
        if (f.type === 'segment') return { ...r, si: idx.segments.indexOf(r.value) };
        if (f.type === 'payment') return { ...r, pi: (idx.payments || []).indexOf(r.value) };
        if (f.type === 'store') return { ...r, sti: (idx.stores || []).indexOf(r.value) };
        if (f.type === 'lifecycle' || f.type === 'channel') return { ...r };
        return { ...r, num: Number(r.value) || 0 };
      })
      .filter(Boolean);
  }

  const cmp = (v, op, t) => (op === '≥' ? v >= t : op === '≤' ? v <= t : v === t);

  function test(i, r) {
    switch (r.field) {
      case 'ciclo': return r.op === 'es' ? D.life[i] === r.value : D.life[i] !== r.value;
      case 'segDominante': return r.op === 'es' ? idx.sd[i] === r.si : idx.sd[i] !== r.si;
      case 'catDominante': return r.op === 'es' ? idx.cd[i] === r.ci : idx.cd[i] !== r.ci;
      case 'catDomN1': return r.op === 'es' ? idx.cd1?.[i] === r.ci : idx.cd1?.[i] !== r.ci;
      case 'catDomN2': return r.op === 'es' ? idx.cd2?.[i] === r.ci : idx.cd2?.[i] !== r.ci;
      case 'medioPago': return r.op === 'es' ? idx.pd?.[i] === r.pi : idx.pd?.[i] !== r.pi;
      case 'comproEnCat': { const has = idx.cs[i].includes(r.ci); return r.op === 'sí' ? has : !has; }
      case 'comproEnTienda': { const has = (idx.sts?.[i] || []).includes(r.sti); return r.op === 'sí' ? has : !has; }
      case 'pedidos': return cmp(idx.o[i], r.op, r.num);
      case 'gasto': return cmp(idx.g[i], r.op, r.num);
      case 'ticket': return cmp(idx.o[i] ? idx.g[i] / idx.o[i] : 0, r.op, r.num);
      case 'recencia': return cmp(D.recency[i], r.op, r.num);
      case 'antiguedad': return cmp(D.lastIdx - idx.f[i], r.op, r.num);
      case 'intervalo': return cmp(idx.ip ? idx.ip[i] : 0, r.op, r.num);
      case 'churnRatio': return cmp(D.churn[i], r.op, r.num);
      case 'cuponPct': return cmp(D.couponPct[i], r.op, r.num);
      case 'cuponPedidos': return cmp(idx.cp ? idx.cp[i] : 0, r.op, r.num);
      case 'canal': {
        const c = idx.ch ? idx.ch[i] : 1;
        const want = CHANNELS[r.value]?.v ?? 1;
        return r.op === 'es' ? c === want : c !== want;
      }
      case 'probVuelta': return idx.pv?.[i] != null && cmp(idx.pv[i], r.op, r.num);
      case 'afinidad': { const has = (idx.af?.[i] || []).includes(r.ci); return r.op === 'sí' ? has : !has; }
      case 'proximaCat': return r.op === 'es' ? idx.nb?.[i] === r.ci : idx.nb?.[i] !== r.ci;
      case 'incentivo': return r.op === 'es' ? D.inc[i] === r.ii : D.inc[i] !== r.ii;
      case 'reponer': {
        const d = D.due[i];
        const has = !!d && (r.ci === -2 || d.includes(r.ci));
        return r.op === 'sí' ? has : !has;
      }
      default: return true;
    }
  }

  /** Aplica todas las reglas (AND) y devuelve los índices que matchean. */
  function evaluate(rs = rules) {
    const n = idx.count;
    const out = [];
    const compiled = compile(rs);
    for (let i = 0; i < n; i++) {
      let ok = true;
      for (const r of compiled) if (!test(i, r)) { ok = false; break; }
      if (ok) out.push(i);
    }
    return out;
  }

  function summarize(m) {
    let orders = 0, gmv = 0, rec = 0, coup = 0, pvSum = 0, pvN = 0, app = 0, tkSum = 0;
    const bySeg = {}, byCat = {}, byLife = {}, byNext = {}, byCh = { 1: 0, 2: 0, 3: 0 }, byDue = {};
    const byInc = [0, 0, 0, 0];
    for (const i of m) {
      if (idx.pv?.[i] != null) { pvSum += idx.pv[i]; pvN++; }
      const ch = idx.ch ? idx.ch[i] : 1;
      byCh[ch] = (byCh[ch] || 0) + 1;
      if (ch & 2) app++;
      const nb = idx.nb?.[i];
      if (nb != null && nb >= 0) { const c = idx.categoriesN1[nb]; byNext[c] = (byNext[c] || 0) + 1; }
      const d = D.due[i];
      if (d) for (const c of d) byDue[c] = (byDue[c] || 0) + 1;
      byInc[D.inc[i]]++;
      orders += idx.o[i];
      gmv += idx.g[i];
      if (idx.o[i]) tkSum += idx.g[i] / idx.o[i];
      rec += D.recency[i];
      coup += idx.cp ? idx.cp[i] : 0;
      const s = idx.segments[idx.sd[i]] || 'sin_dato';
      bySeg[s] = (bySeg[s] || 0) + 1;
      const c = idx.categories[idx.cd[i]] || 'Sin categoría';
      byCat[c] = (byCat[c] || 0) + 1;
      byLife[D.life[i]] = (byLife[D.life[i]] || 0) + 1;
    }
    return {
      customers: m.length, orders, gmv, bySeg, byCat, byLife, byNext, byCh, byDue, byInc, tkSum,
      pvAvg: pvN ? pvSum / pvN : null, appShare: m.length ? app / m.length : 0,
      avgRecency: m.length ? rec / m.length : 0,
      couponRate: orders ? coup / orders : 0,
    };
  }
  const topInc = (byInc) => INC_KEYS[byInc.indexOf(Math.max(...byInc))];

  /** Qué datos por-cliente están disponibles en el índice actual. */
  function availability() {
    return {
      coupon: idx.hasCouponData !== false && (idx.cp || []).some((v) => v > 0),
      payment: idx.hasPaymentData !== false && (idx.payments || []).length > 0,
      categoryLevels: idx.hasCategoryLevels === true,
      store: idx.hasStoreData === true,
      channel: Array.isArray(idx.ch),
      ai: Array.isArray(idx.pv) && !!idx.aiModel,
      replenish: idx.hasReplenishment === true && Array.isArray(idx.rp),
    };
  }

  // ── Oportunidades: una pasada por audiencia, cacheadas hasta que cambie D ──
  function opportunities() {
    if (OPP) return OPP;
    const av = availability();
    const list = OPPS.filter((o) => !o.needs || av[o.needs]).map((o) => {
      const m = evaluate(o.rules);
      const s = summarize(m);
      return { ...o, n: m.length, potential: s.tkSum, inc: topInc(s.byInc), pv: s.pvAvg };
    });
    // Reposición por categoría, sobre toda la base.
    let dueAny = 0, dueTk = 0;
    const byCat = {};
    if (av.replenish) {
      for (let i = 0; i < idx.count; i++) {
        const d = D.due[i];
        if (!d) continue;
        dueAny++;
        if (idx.o[i]) dueTk += idx.g[i] / idx.o[i];
        for (const c of d) byCat[c] = (byCat[c] || 0) + 1;
      }
    }
    const dueCats = Object.entries(byCat).map(([c, n]) => [idx.categoriesN2[c], n]).sort((a, b) => b[1] - a[1]);
    const lifeAll = {};
    for (let i = 0; i < idx.count; i++) lifeAll[D.life[i]] = (lifeAll[D.life[i]] || 0) + 1;
    OPP = { list, dueAny, dueTk, dueCats, lifeAll };
    return OPP;
  }

  // ── Emails desde el repo privado ──────────────────────────────────────────
  async function loadEmails() {
    if (emailTried) return;
    emailTried = true;
    const map = await W.loadEmailMap();
    if (map) emailMap = map;
  }

  // ── Textos ────────────────────────────────────────────────────────────────
  function ruleLabel(r) {
    const f = FIELDS[r.field];
    if (!f) return `${r.field} ${r.op} ${r.value}`;
    let val = r.value;
    if (f.type === 'lifecycle') val = W.LIFECYCLE[r.value]?.label || r.value;
    else if (f.type === 'channel') val = CHANNELS[r.value]?.label || r.value;
    else if (f.type === 'incentive') val = INCENTIVES[r.value]?.label || r.value;
    else if (f.type === 'replenish') {
      const what = r.value === '*' ? 'alguna categoría' : r.value;
      return r.op === 'sí' ? `Le toca reponer ${what}` : `No le toca reponer ${what}`;
    } else if (r.field === 'probVuelta') val = `${Number(r.value)}%`;
    else if (f.type === 'segment') val = W.SEGMENT_LABEL[r.value] || r.value;
    else if (f.type === 'number') val = ['gasto', 'ticket'].includes(r.field) ? W.fmtMoney(Number(r.value)) : W.fmtNum(Number(r.value));
    return `${f.label} ${r.op} ${val}`;
  }

  const chLabel = (i) => ({ 1: 'Web', 2: 'App', 3: 'Web + App' })[idx.ch ? idx.ch[i] : 1];
  const nextCat = (i) => (idx.nb && idx.nb[i] >= 0 ? idx.categoriesN1[idx.nb[i]] : '');
  const afin = (i) => (idx.af?.[i] || []).map((c) => idx.categoriesN1[c]).join(' · ');
  const dueTxt = (i) => (D.due[i] || []).map((c) => idx.categoriesN2[c]).join(' · ');
  const today = () => W.arDateOf(new Date().toISOString());
  const aiTag = '<span class="ai-tag">IA</span>';
  const incPill = (k) => `<span class="au-inc" style="--c:${INCENTIVES[k].color}">${W.icon(INCENTIVES[k].icon, 12)}${W.esc(INCENTIVES[k].label)}</span>`;
  const dayTxt = (iso) => (W.fmtDayShort ? W.fmtDayShort(iso) : iso);

  // El modelo se valida contra clientes que NO vio al entrenar: se muestra esa
  // medida (AUC) para que se sepa cuánto confiar, no un número mágico.
  function aiTip() {
    const m = idx.aiModel;
    if (!m) return '';
    return `<strong>Predicción con IA</strong>`
      + `<span class="tip-row">Modelo entrenado con el historial de compras: aprende de quién volvió y quién no en los ${m.horizonDays} días siguientes al ${dayTxt(m.snapshotDate)}.</span>`
      + `<span class="tip-row">Precisión (AUC) sobre ${W.fmtNum(m.testCustomers)} clientes que no vio: <b>${Math.round(m.auc * 100)}%</b> (50% = azar).</span>`
      + `<span class="tip-row">En promedio vuelve el ${Math.round(m.baseRate * 100)}% de los clientes en ${m.horizonDays} días.</span>`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Render
  // ══════════════════════════════════════════════════════════════════════════
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
        el.innerHTML = '<div class="empty"><h2>Todavía no hay clientes</h2><p>Corré el backfill inicial (ver README).</p></div>';
        idx = null;
        return;
      }
      D = derive();
    }
    await loadEmails();
    if (campsState === 'idle') loadCamps();

    const matches = evaluate();
    const sum = summarize(matches);
    exportsFor(ctx, matches);

    const nCamps = camps ? camps.length : 0;
    const body = tab === 'opp' ? viewOpp() : tab === 'camp' ? viewCamps() : viewCreate(matches, sum);

    el.innerHTML = `
      <div class="au-head">
        <div class="seg-ctl au-tabs">
          <button data-tab="opp" class="${tab === 'opp' ? 'on' : ''}">${W.icon('sparkles', 14)}Oportunidades</button>
          <button data-tab="crear" class="${tab === 'crear' ? 'on' : ''}">${W.icon('filter', 14)}Crear audiencia</button>
          <button data-tab="camp" class="${tab === 'camp' ? 'on' : ''}">${W.icon('megaphone', 14)}Campañas${nCamps ? ` <span class="au-count">${nCamps}</span>` : ''}</button>
        </div>
        <button class="btn au-cfg" id="au-cfg" ${W.chart.tip(`<strong>Cómo se define el churn</strong><span class="tip-row">${W.esc(W.churnCriterion())}</span>`)}>${W.icon('clock', 14)}<span>${W.esc(W.churnCriterion())}</span></button>
      </div>
      ${body}
      ${modal === 'churn' ? churnModal() : ''}
      ${modal === 'camp' ? campModal(matches, sum) : ''}`;

    wire(matches, sum);
  };

  function exportsFor(ctx, matches) {
    ctx.exports.audienceData = {
      filename: `webdash-audiencia-datos-${today()}.csv`,
      headers: ['hash', 'ciclo_de_vida', 'pedidos', 'gasto_total', 'ticket_promedio', 'primera_compra',
        'ultima_compra', 'dias_sin_comprar', 'intervalo_promedio_dias', 'ratio_abandono',
        'pedidos_con_cupon', 'pct_con_cupon', 'segmento_dominante',
        'categoria_n1_dominante', 'categoria_n2_dominante', 'categoria_n3_dominante', 'medio_pago',
        'canal', 'prob_volver_30d_ia', 'afinidad_ia', 'proxima_categoria_ia', 'incentivo_recomendado', 'le_toca_reponer'],
      rows: matches.map((i) => [
        idx.h[i], W.LIFECYCLE[D.life[i]].label, idx.o[i], idx.g[i],
        Math.round(idx.o[i] ? idx.g[i] / idx.o[i] : 0),
        idx.days[idx.f[i]], idx.days[idx.l[i]], D.recency[i],
        idx.ip ? idx.ip[i] : 0, Number(D.churn[i].toFixed(2)),
        idx.cp ? idx.cp[i] : 0, D.couponPct[i] / 100,
        W.SEGMENT_LABEL[idx.segments[idx.sd[i]]] || '',
        (idx.categoriesN1 || [])[idx.cd1?.[i]] || '',
        (idx.categoriesN2 || [])[idx.cd2?.[i]] || '',
        idx.categories[idx.cd[i]] || '',
        (idx.payments || [])[idx.pd?.[i]] || '',
        chLabel(i), idx.pv?.[i] != null ? idx.pv[i] / 100 : '', afin(i), nextCat(i),
        INCENTIVES[INC_KEYS[D.inc[i]]].label, dueTxt(i),
      ]),
    };
  }

  // ── 1. Oportunidades ──────────────────────────────────────────────────────
  function viewOpp() {
    const av = availability();
    const O = opportunities();
    let contact = 0;
    if (emailMap) for (let i = 0; i < idx.count; i++) if (emailMap.get(idx.h[i])?.email) contact++;
    let app = 0;
    if (idx.ch) for (let i = 0; i < idx.count; i++) if (idx.ch[i] & 2) app++;
    const m = idx.aiModel;
    const running = (camps || []).filter((c) => campStatus(c).key === 'midiendo').length;

    const kpi = (icon, label, value, sub, tip) => `<div class="tile au-kpi"${tip ? ` ${W.chart.tip(tip)}` : ''}>
      <div class="tile-t"><span class="tile-l">${label}</span><span class="tile-ic">${W.icon(icon, 15)}</span></div>
      <div class="tile-v">${value}</div><div class="tile-s">${sub}</div></div>`;

    const repoCard = av.replenish && O.dueCats.length ? `
      <div class="card au-repo">
        <div class="card-h"><div><h3>${W.icon('refresh', 16)} Le toca reponer</h3>
          <p>clientes que compran una categoría con regularidad y ya se les cumplió el plazo — el mejor momento para recordarles</p></div>
          <button class="btn-p" data-opp-rules='${W.esc(JSON.stringify([{ field: 'reponer', op: 'sí', value: '*' }]))}' data-opp-name="Le toca reponer">
            ${W.fmtNum(O.dueAny)} clientes · armar campaña ${W.icon('chevronR', 14)}</button>
        </div>
        <div class="au-repo-list">${O.dueCats.slice(0, 12).map(([c, n]) => `
          <button class="au-repo-i" data-repo="${W.esc(c)}">
            <span class="au-repo-c">${W.esc(c)}</span>
            <span class="au-bar"><i style="width:${Math.max(3, Math.round((n / O.dueCats[0][1]) * 100))}%"></i></span>
            <span class="au-repo-n">${W.fmtNum(n)}</span>
          </button>`).join('')}</div>
        <p class="au-foot">Se calcula con el ritmo de cada cliente en cada categoría: si compra quesos cada 12 días y hace 13 que no compra, le toca.
          Solo cuenta a quien la compró al menos 3 veces con un ritmo parejo.</p>
      </div>` : '';

    return `
      <div class="au-kpis">
        ${kpi('users', 'Clientes en la base', W.fmtNumC(idx.count), `${W.fmtNum(idx.appCustomers?.onlyApp || 0)} solo por App`)}
        ${kpi('mail', 'Contactables por mail', emailMap ? W.fmtNumC(contact) : '—', emailMap ? `${W.fmtPct(contact / idx.count)} de la base` : 'contactos no disponibles')}
        ${kpi('phone', 'Compran por la App', idx.ch ? W.fmtPct(app / idx.count) : '—', idx.ch ? `${W.fmtNumC(app)} clientes` : 'sin datos de canal')}
        ${m ? kpi('brain', 'Precisión de la IA', `${Math.round(m.auc * 100)}%`, `probado con ${W.fmtNumC(m.testCustomers)} clientes`, aiTip()) : ''}
        ${kpi('megaphone', 'Campañas midiendo', W.fmtNum(running), camps && camps.length ? `${W.fmtNum(camps.length)} en total` : 'todavía ninguna')}
      </div>

      <div class="au-life">${W.LIFECYCLE_ORDER.map((k) => {
        const L = W.LIFECYCLE[k], n = O.lifeAll[k] || 0;
        return `<button class="au-life-i" data-life="${k}" ${W.chart.tip(`<strong>${W.esc(L.label)}</strong><span class="tip-row">${W.esc(W.lifecycleDesc(k))}</span>`)}>
          <span class="au-life-t"><i style="background:${L.color}"></i>${W.esc(L.label)}</span>
          <b>${W.fmtNumC(n)}</b><em>${W.fmtPct(idx.count ? n / idx.count : 0)}</em>
          <span class="au-life-bar"><i style="width:${Math.round((n / idx.count) * 100)}%;background:${L.color}"></i></span>
        </button>`;
      }).join('')}</div>

      ${repoCard}

      <h3 class="au-sec">Audiencias listas para mandar ${av.ai ? aiTag : ''}</h3>
      <div class="au-opps">${O.list.map((o) => `
        <div class="au-opp">
          <div class="au-opp-h"><span class="au-opp-ic">${W.icon(o.icon, 17)}</span><h4>${W.esc(o.name)}</h4></div>
          <div class="au-opp-n"><b>${W.fmtNum(o.n)}</b><span>clientes · ${W.fmtPct(o.n / idx.count)} de la base</span></div>
          <p>${W.esc(o.why)}</p>
          <div class="au-opp-m">
            <div ${W.chart.tip('Lo que entraría si cada cliente de la audiencia hace UNA compra más a su ticket promedio. Es el techo, no una promesa: la campaña te dice cuánto de esto se logró.')}><em>Potencial</em><b>${W.fmtMoneyC(o.potential)}</b></div>
            ${o.pv != null ? `<div><em>Prob. de volver</em><b>${Math.round(o.pv)}%</b></div>` : ''}
            <div><em>Incentivo sugerido</em>${incPill(o.inc)}</div>
          </div>
          <button class="btn au-opp-go" data-opp="${o.key}" ${o.n ? '' : 'disabled'}>Ver audiencia y armar campaña ${W.icon('chevronR', 14)}</button>
        </div>`).join('')}</div>`;
  }

  // ── 2. Crear audiencia ────────────────────────────────────────────────────
  function ruleRow(r, i, av) {
    const f = FIELDS[r.field];
    const fieldOpts = FIELD_GROUPS.map(([g, gl]) => {
      const opts = Object.entries(FIELDS).filter(([, v]) => v.g === g && (!v.needs || av[v.needs]))
        .map(([k, v]) => `<option value="${k}"${k === r.field ? ' selected' : ''}>${W.esc(v.label)}</option>`).join('');
      return opts ? `<optgroup label="${W.esc(gl)}">${opts}</optgroup>` : '';
    }).join('');
    const opOpts = f.ops.map((o) => `<option${o === r.op ? ' selected' : ''}>${o}</option>`).join('');
    const sel = (list) => `<select class="rule-v" data-i="${i}">${list
      .map(([v, l]) => `<option value="${W.esc(v)}"${String(v) === String(r.value) ? ' selected' : ''}>${W.esc(l)}</option>`).join('')}</select>`;

    let val;
    if (f.type === 'channel') val = sel(Object.entries(CHANNELS).map(([k, c]) => [k, c.label]));
    else if (f.type === 'lifecycle') val = sel(W.LIFECYCLE_ORDER.map((k) => [k, W.LIFECYCLE[k].label]));
    else if (f.type === 'incentive') val = sel(INC_KEYS.map((k) => [k, INCENTIVES[k].label]));
    else if (f.type === 'segment') val = sel(idx.segments.map((s) => [s, W.SEGMENT_LABEL[s] || s]));
    else if (f.type === 'payment') val = sel((idx.payments || []).map((p) => [p, p]));
    else if (f.type === 'store') val = sel((idx.stores || []).map((s) => [s, s]));
    else if (f.type === 'replenish') val = sel([['*', 'Cualquier categoría'], ...(idx.categoriesN2 || []).map((c) => [c, c])]);
    else if (f.type === 'category' || f.type === 'categoryN1' || f.type === 'categoryN2') {
      const list = f.type === 'categoryN1' ? (idx.categoriesN1 || []) : f.type === 'categoryN2' ? (idx.categoriesN2 || []) : idx.categories;
      val = sel(list.map((c) => [c, c]));
    } else val = `<input class="rule-v" data-i="${i}" type="number" value="${W.esc(r.value)}" />`;

    return `<div class="rule au-rule">
      <span class="rule-j">${i === 0 ? 'QUIENES' : 'Y'}</span>
      <select class="rule-f" data-i="${i}">${fieldOpts}</select>
      <select class="rule-o" data-i="${i}">${opOpts}</select>
      ${val}
      ${f.g === 'ai' && f.needs === 'ai' ? aiTag : ''}
      <button class="rule-x" data-i="${i}" title="Quitar condición">${W.icon('close', 14)}</button>
    </div>`;
  }

  function viewCreate(matches, sum) {
    const av = availability();
    const share = idx.count ? sum.customers / idx.count : 0;
    const saved = W.store.get('savedAudiences', []);
    let withMail = 0, withDni = 0;
    if (emailMap) {
      for (const i of matches) {
        const v = emailMap.get(idx.h[i]);
        if (!v) continue;
        if (v.email) withMail++;
        if (v.dni) withDni++;
      }
    }
    const tabs = [['perfil', 'Perfil'], ['incentivo', 'Incentivo'], ...(av.ai ? [['ofrecer', 'Qué ofrecerles']] : []),
      ...(av.replenish ? [['reponer', 'Reposición']] : []), ['clientes', 'Clientes']];
    if (!tabs.some(([k]) => k === insight)) insight = 'perfil';

    return `
      <div class="aud">
        <div>
          <div class="card">
            <div class="card-h"><div><h3>¿A quién le querés hablar?</h3>
              <p>empezá con un atajo o armá las condiciones — el resultado se actualiza al instante</p></div></div>
            <div class="au-qs">${PRESETS.map((g, gi) => {
              const off = g.needs && !av[g.needs];
              if (off) return '';
              return `<div class="au-qs-g"><span>${W.esc(g.group)}</span><div>${g.items.map((p, pi) => {
                const on = hasRules(rules, p.rules);
                return `<button class="pre${on ? ' on' : ''}" data-g="${gi}" data-p="${pi}">${W.icon(p.icon, 13)}${W.esc(p.name)}</button>`;
              }).join('')}</div></div>`;
            }).join('')}</div>

            <div class="au-rules">
              ${rules.length ? `<div class="rules">${rules.map((r, i) => ruleRow(r, i, av)).join('')}</div>`
                : '<p class="au-empty-r">Sin condiciones: la audiencia es toda la base. Sumá una condición o elegí un atajo.</p>'}
              <div class="rules-a">
                <button class="btn-s" id="add-rule">${W.icon('plus', 14)}Agregar condición</button>
                ${rules.length ? `<button class="btn-s" id="clear-rules">${W.icon('close', 13)}Limpiar</button>` : ''}
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-h"><div class="seg-ctl au-itabs">${tabs.map(([k, l]) =>
              `<button data-ins="${k}" class="${insight === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
            ${insightBody(matches, sum, av)}
          </div>
        </div>

        <aside class="aud-side">
          <div class="card stick">
            <div class="aud-n">
              <b>${W.fmtNum(sum.customers)}</b>
              <span>clientes en la audiencia</span>
              <em>${W.fmtPct(share)} de ${W.fmtNumC(idx.count)}</em>
              <span class="au-share"><i style="width:${Math.max(share > 0 ? 1 : 0, Math.round(share * 100))}%"></i></span>
            </div>
            <div class="aud-st">
              <div><em>Ticket promedio</em><b>${W.fmtMoney(W.ticket(sum.gmv, sum.orders))}</b></div>
              <div><em>Pedidos por cliente</em><b>${W.fmtDec(sum.customers ? sum.orders / sum.customers : 0, 1)}</b></div>
              <div><em>Días sin comprar</em><b>${W.fmtNum(sum.avgRecency)}</b></div>
              ${av.coupon ? `<div><em>Pedidos con cupón</em><b>${W.fmtPct(sum.couponRate)}</b></div>` : ''}
              ${av.channel ? `<div><em>Compran por la App</em><b>${W.fmtPct(sum.appShare)}</b></div>` : ''}
              ${av.ai && sum.pvAvg != null ? `<div ${W.chart.tip(aiTip())}><em>Prob. de volver ${aiTag}</em><b>${Math.round(sum.pvAvg)}%</b></div>` : ''}
            </div>
            <div class="au-potential" ${W.chart.tip('Si cada cliente de la audiencia hace UNA compra más a su ticket promedio.')}>
              <em>Potencial de una compra más</em><b>${W.fmtMoneyC(sum.tkSum)}</b>
            </div>
            <div class="au-contact">${W.icon('mail', 14)}${emailMap
              ? `<span><b>${W.fmtNum(withMail)}</b> con mail · <b>${W.fmtNum(withDni)}</b> con DNI</span>`
              : '<span>Contactos no disponibles — podés cargar tu CSV abajo.</span>'}</div>

            <button class="btn-p blk au-cta" id="new-camp" ${sum.customers ? '' : 'disabled'}>${W.icon('megaphone', 15)}Crear campaña medible</button>
            <p class="au-cta-s">Separa un grupo de control al azar y mide cuánto vendiste de más.</p>

            <details class="au-dl">
              <summary>${W.icon('download', 14)}Solo descargar la lista${W.icon('chevronD', 14)}</summary>
              <button class="btn blk" id="exp-mails" ${emailMap && (withMail || withDni) ? '' : 'disabled'}>${W.icon('mail', 14)}Base DNI + MAIL (mailing)</button>
              <button class="btn blk" id="exp-dni" ${emailMap && withDni ? '' : 'disabled'}>${W.icon('phone', 14)}Solo DNI (push / SMS)</button>
              <button class="btn blk gads" id="exp-gads" ${emailMap && withMail ? '' : 'disabled'} ${W.chart.tip('<strong>Para Google Ads (Customer Match)</strong><span class="tip-row">Baja los mails ya encriptados (SHA-256), en el formato que pide Google: ningún mail viaja en texto plano.</span><span class="tip-row">En Google Ads: Herramientas → Administrador de públicos → + → Lista de clientes → subir este archivo.</span>')}>${W.icon('target', 14)}Google Ads (encriptado)</button>
              <button class="btn blk" data-export="audienceData" ${sum.customers ? '' : 'disabled'}>${W.icon('layers', 14)}Datos sin mails</button>
              <label class="drop" id="drop">
                <input type="file" id="mail-file" accept=".csv,text/csv" hidden />
                ${emailMap ? 'Reemplazar contactos por un CSV propio' : 'Cargar CSV de contactos (hash,email)'}<br/><small>arrastralo o hacé clic — no se sube a ningún lado</small>
              </label>
            </details>

            <div class="saved">
              <h4>Audiencias guardadas</h4>
              <div class="saved-r">
                <input class="inp" id="save-name" type="text" placeholder="Nombre" value="${W.esc(audName)}" />
                <button class="btn-s" id="save-aud" title="Guardar">${W.icon('save', 14)}</button>
              </div>
              ${saved.length
                ? `<ul class="saved-l">${saved.map((s, i) =>
                    `<li><button class="saved-go" data-i="${i}">${W.esc(s.name)}</button><button class="saved-x" data-i="${i}">${W.icon('close', 13)}</button></li>`).join('')}</ul>`
                : '<p class="muted" style="font-size:.75rem;margin-top:.4rem">Todavía no guardaste ninguna.</p>'}
            </div>
          </div>
        </aside>
      </div>`;
  }

  function bars(items, total, attr) {
    return `<div class="au-bars">${items.map(([label, n, color, key]) => `
      <${attr ? `button ${attr}="${W.esc(key ?? label)}"` : 'div'} class="au-bars-i">
        <span class="au-bars-l">${color ? `<i style="background:${color}"></i>` : ''}${W.esc(label)}</span>
        <span class="au-bar"><i style="width:${total ? Math.max(n ? 2 : 0, Math.round((n / total) * 100)) : 0}%${color ? `;background:${color}` : ''}"></i></span>
        <span class="au-bars-n">${W.fmtNum(n)} <em>${W.fmtPct(total ? n / total : 0)}</em></span>
      </${attr ? 'button' : 'div'}>`).join('')}</div>`;
  }

  function insightBody(matches, sum, av) {
    const N = sum.customers;
    if (!N) return '<div class="chart-empty">Ninguna condición matchea clientes.</div>';

    if (insight === 'perfil') {
      const topCats = Object.entries(sum.byCat).sort((a, b) => b[1] - a[1]).slice(0, 8);
      const life = W.LIFECYCLE_ORDER.map((k) => [W.LIFECYCLE[k].label, sum.byLife[k] || 0, W.LIFECYCLE[k].color]);
      return `<div class="au-prof">
        <div><h4>Ciclo de vida</h4>${bars(life, N)}
          ${av.channel ? `<h4>Canal</h4>${bars([['Solo Web', sum.byCh[1] || 0], ['Solo App', sum.byCh[2] || 0], ['Web y App', sum.byCh[3] || 0]], N)}` : ''}</div>
        <div><h4>Segmento dominante</h4>${W.chart.donut({
          items: Object.entries(sum.bySeg).sort((a, b) => b[1] - a[1])
            .map(([s, v]) => ({ label: W.SEGMENT_LABEL[s] || s, value: v, color: W.SEGMENT_COLOR[s] || '#8b93a5' })),
          valueFmt: W.fmtNum, centerValue: W.fmtNumC(N), centerLabel: 'clientes', size: 160,
        })}</div>
        <div><h4>Qué compran</h4>${bars(topCats, N)}</div>
      </div>`;
    }

    if (insight === 'incentivo') {
      return `<p class="au-lead">Cuánto incentivo necesita cada cliente para comprar, según su probabilidad de volver ${av.ai ? aiTag : ''} y su historial de cupones.
        Mandá un cupón fuerte solo a quien lo necesita: el resto compra igual.</p>
        <div class="au-incs">${INC_KEYS.map((k, ki) => {
          const I = INCENTIVES[k], n = sum.byInc[ki];
          return `<button class="au-inc-c" data-inc="${k}" style="--c:${I.color}">
            <div class="au-inc-h">${W.icon(I.icon, 16)}<b>${W.esc(I.label)}</b><span>${W.esc(I.short)}</span></div>
            <div class="au-inc-n"><b>${W.fmtNum(n)}</b><em>${W.fmtPct(n / N)}</em></div>
            <span class="au-bar"><i style="width:${Math.round((n / N) * 100)}%;background:${I.color}"></i></span>
            <p>${W.esc(I.desc)}</p>
            <span class="au-inc-go">Quedarme con estos ${W.icon('chevronR', 12)}</span>
          </button>`;
        }).join('')}</div>`;
    }

    if (insight === 'ofrecer') {
      const list = Object.entries(sum.byNext).sort((a, b) => b[1] - a[1]).slice(0, 10);
      return `<p class="au-lead">La categoría que todavía no compraron y que más compran los clientes parecidos ${aiTag}. Hacé clic para quedarte con esa audiencia.</p>
        ${list.length ? bars(list, N, 'data-nextcat') : '<div class="chart-empty">Sin recomendaciones para esta audiencia.</div>'}`;
    }

    if (insight === 'reponer') {
      const list = Object.entries(sum.byDue).map(([c, n]) => [idx.categoriesN2[c], n]).sort((a, b) => b[1] - a[1]).slice(0, 12);
      let any = 0;
      for (const i of matches) if (D.due[i]) any++;
      return `<p class="au-lead"><b>${W.fmtNum(any)}</b> clientes de esta audiencia (${W.fmtPct(any / N)}) ya cumplieron su plazo habitual para reponer alguna categoría.
        Hacé clic en una para quedarte con esos clientes y mandarles justo eso.</p>
        ${list.length ? bars(list, N, 'data-repo-f') : '<div class="chart-empty">A nadie de esta audiencia le toca reponer hoy.</div>'}`;
    }

    // clientes
    const shown = matches.slice(0, 25);
    return `<p class="au-lead">Muestra de ${W.fmtNum(shown.length)} de ${W.fmtNum(N)} — la descarga trae todos.</p>
      <div class="tbl-wrap"><table class="tbl dense">
        <thead><tr><th>Cliente</th><th>Canal</th><th>Ciclo</th><th class="num">Pedidos</th><th class="num">Ticket</th><th class="num">Días sin comprar</th>${idx.pv ? '<th class="num">Prob. volver</th>' : ''}<th>Incentivo</th>${av.replenish ? '<th>Le toca reponer</th>' : ''}</tr></thead>
        <tbody>${shown.map((i) => {
          const email = emailMap?.get(idx.h[i])?.email;
          const L = W.LIFECYCLE[D.life[i]];
          return `<tr>
            <td>${email ? W.esc(email) : `<code>${W.esc(idx.h[i].slice(0, 10))}…</code>`}</td>
            <td>${W.esc(chLabel(i))}</td>
            <td><span class="dot" style="background:${L.color}"></span>${W.esc(L.label)}</td>
            <td class="num">${W.fmtNum(idx.o[i])}</td>
            <td class="num">${W.fmtMoney(idx.o[i] ? idx.g[i] / idx.o[i] : 0)}</td>
            <td class="num">${W.fmtNum(D.recency[i])}</td>
            ${idx.pv ? `<td class="num">${idx.pv[i] != null ? `${idx.pv[i]}%` : '—'}</td>` : ''}
            <td>${incPill(INC_KEYS[D.inc[i]])}</td>
            ${av.replenish ? `<td>${W.esc(dueTxt(i) || '—')}</td>` : ''}
          </tr>`;
        }).join('')}</tbody>
      </table></div>`;
  }

  // ── Modales ───────────────────────────────────────────────────────────────
  function churnModal() {
    const C = W.CHURN;
    return `<div class="modal-back" id="au-modal">
      <div class="modal-card au-modal">
        <div class="modal-hero"><span class="mi">${W.icon('clock', 20)}</span>
          <div><h3>Cómo se define el churn</h3><p>cambia el ciclo de vida de todos los clientes</p></div>
          <button class="au-x" id="au-modal-x">${W.icon('close', 16)}</button></div>
        <div class="modal-body au-mbody">
          <div class="churn-cfg">
            <div class="churn-mode">
              <label class="${C.mode === 'ratio' ? 'on' : ''}"><input type="radio" name="cmode" value="ratio" ${C.mode === 'ratio' ? 'checked' : ''}/>
                <b>Según el ritmo de cada cliente</b><em>churn cuando tarda N veces más de lo que suele tardar.</em></label>
              <label class="${C.mode === 'dias' ? 'on' : ''}"><input type="radio" name="cmode" value="dias" ${C.mode === 'dias' ? 'checked' : ''}/>
                <b>Días fijos sin comprar</b><em>churn a los N días para todos por igual.</em></label>
            </div>
            ${C.mode === 'dias' ? `
              <div class="churn-presets"><span>Atajos:</span>
                ${[30, 60, 90, 180].map((d) => `<button class="chip-sm${C.churnDays === d ? ' on' : ''}" data-cd="${d}">${d} días</button>`).join('')}
              </div>
              <div class="churn-fields">
                <label>En riesgo desde<input class="inp" type="number" min="1" data-c="riskDays" value="${C.riskDays}"/><span>días</span></label>
                <label>Churn desde<input class="inp" type="number" min="1" data-c="churnDays" value="${C.churnDays}"/><span>días</span></label>
              </div>`
            : `<div class="churn-fields">
                <label>En riesgo desde<input class="inp" type="number" min="1" step="0.1" data-c="riskRatio" value="${C.riskRatio}"/><span>× su intervalo</span></label>
                <label>Churn desde<input class="inp" type="number" min="1" step="0.1" data-c="churnRatio" value="${C.churnRatio}"/><span>× su intervalo</span></label>
                <label>Sin historial, asumir<input class="inp" type="number" min="1" data-c="fallbackInterval" value="${C.fallbackInterval}"/><span>días de intervalo</span></label>
              </div>`}
            <div class="churn-fields">
              <label>Perdido desde<input class="inp" type="number" min="1" data-c="lostDays" value="${C.lostDays}"/><span>días</span></label>
              <label>"Nuevo" hasta<input class="inp" type="number" min="1" data-c="newDays" value="${C.newDays}"/><span>días de su 1ª compra</span></label>
            </div>
            <div class="au-mfoot">
              <button class="btn" id="churn-reset">${W.icon('refresh', 14)}Volver al default</button>
              <button class="btn-p" id="au-modal-ok">Listo</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  }

  const CHANNEL_OPTS = [
    ['mail', 'Mailing', 'mail', 'Baja DNI + MAIL de los que reciben'],
    ['push', 'Push / SMS', 'phone', 'Baja solo DNI de los que reciben'],
    ['gads', 'Google Ads', 'target', 'Baja los mails encriptados para Customer Match'],
    ['otro', 'Otro canal', 'layers', 'Baja la lista de clientes (sin mails)'],
  ];

  function campModal(matches, sum) {
    const inc = topInc(sum.byInc);
    const pct = W.store.get('campCtl', 10);
    const ch = W.store.get('campCh', 'mail');
    const name = audName || (rules[0] ? ruleLabel(rules[0]) : 'Toda la base');
    const nC = Math.round((matches.length * pct) / 100);
    return `<div class="modal-back" id="au-modal">
      <div class="modal-card au-modal">
        <div class="modal-hero"><span class="mi">${W.icon('megaphone', 20)}</span>
          <div><h3>Nueva campaña medible</h3><p>${W.fmtNum(matches.length)} clientes en la audiencia</p></div>
          <button class="au-x" id="au-modal-x">${W.icon('close', 16)}</button></div>
        <div class="modal-body au-mbody">
          <label class="au-f"><span>Nombre</span><input class="inp" id="cp-name" maxlength="120" value="${W.esc(name)}"/></label>
          <div class="au-f2">
            <label class="au-f"><span>Fecha de envío</span><input class="inp" id="cp-date" type="date" value="${today()}"/></label>
            <label class="au-f"><span>Incentivo</span><select class="inp" id="cp-inc">
              ${INC_KEYS.map((k) => `<option value="${k}"${k === inc ? ' selected' : ''}>${W.esc(INCENTIVES[k].label)}${k === inc ? ' (sugerido)' : ''}</option>`).join('')}
            </select></label>
          </div>
          <div class="au-f"><span>Canal</span><div class="au-chs">${CHANNEL_OPTS.map(([k, l, ic, d]) => `
            <label class="au-ch${k === ch ? ' on' : ''}"><input type="radio" name="cp-ch" value="${k}" ${k === ch ? 'checked' : ''}/>${W.icon(ic, 15)}<b>${l}</b><em>${d}</em></label>`).join('')}</div></div>
          <div class="au-f"><span>Grupo de control ${W.icon('info', 12)}</span>
            <div class="seg-ctl au-ctl">${[0, 5, 10, 20].map((p) => `<button data-ctl="${p}" class="${p === pct ? 'on' : ''}">${p ? `${p}%` : 'Sin control'}</button>`).join('')}</div>
            <p class="au-ctl-t" id="cp-split">${splitText(matches.length, nC, pct)}</p>
          </div>
          <div class="au-mfoot">
            <button class="btn" id="au-modal-x2">Cancelar</button>
            <button class="btn-p" id="cp-go">${W.icon('download', 14)}Crear y descargar lista</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  function splitText(n, nC, pct) {
    if (!pct) return `<b>${W.fmtNum(n)}</b> reciben la campaña. <span class="au-warn">Sin grupo de control solo vas a ver cuántos compraron, no cuántos compraron <i>gracias</i> a la campaña.</span>`;
    return `Unos <b>${W.fmtNum(n - nC)}</b> reciben la campaña y <b>${W.fmtNum(nC)}</b> quedan afuera al azar como control.
      Comparar los dos grupos te dice cuánto vendiste <i>de más</i>. ${nC < 300 ? '<span class="au-warn">El control es chico: el resultado puede tardar en ser confiable.</span>' : ''}`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Campañas
  // ══════════════════════════════════════════════════════════════════════════
  async function loadCamps() {
    campsState = 'loading';
    let server = [];
    try {
      const r = await fetch('/api/campaigns', { cache: 'no-store' });
      if (r.ok) server = (await r.json()).campaigns || [];
      else campsLocalOnly = true;
    } catch { campsLocalOnly = true; }
    const local = W.store.get('localCampaigns', []);
    for (const c of local) if (c.t != null) members.set(c.id, { t: c.t, c: c.c });
    camps = [...server, ...local.map(({ t, c, ...rest }) => ({ ...rest, local: true }))]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    campsState = 'ready';
    if (tab === 'camp' || tab === 'opp') W.render();
  }

  async function loadAct() {
    actState = 'loading';
    try {
      act = await W.loadRaw('customer-activity');
      actState = act && act.generatedAt === idx.generatedAt ? 'ready' : 'mismatch';
      if (actState === 'ready' && !h12) {
        h12 = new Map();
        for (let i = 0; i < idx.count; i++) h12.set(idx.h[i].slice(0, 12), i);
      }
    } catch { actState = 'error'; }
    if (tab === 'camp') W.render();
  }

  async function loadMembers(c) {
    if (members.has(c.id)) return members.get(c.id);
    members.set(c.id, null); // en curso
    try {
      const r = await fetch(`/api/campaigns?id=${encodeURIComponent(c.id)}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      members.set(c.id, await r.json());
    } catch { members.set(c.id, { error: true }); }
    if (tab === 'camp') W.render();
    return members.get(c.id);
  }

  function campStatus(c) {
    if (c.sendDate > today()) return { key: 'prog', label: `Programada · ${dayTxt(c.sendDate)}`, cls: 'n' };
    if (!act) return { key: 'midiendo', label: 'Midiendo', cls: 'w' };
    const last = act.days[act.days.length - 1];
    const si = act.days.findIndex((d) => d >= c.sendDate);
    if (si < 0 || last < c.sendDate) return { key: 'midiendo', label: 'Esperando el primer día de datos', cls: 'w' };
    const el = act.days.length - si;
    return el >= 30 ? { key: 'fin', label: 'Terminada · 30 días', cls: 'ok' } : { key: 'midiendo', label: `Midiendo · día ${el} de 30`, cls: 'w' };
  }

  /** Mide un grupo: primer día de compra y GMV acumulado desde el envío. */
  function measureGroup(str, si) {
    const n = Math.floor((str || '').length / 12);
    const first = new Int32Array(30);
    const gmv = new Float64Array(30);
    let missing = 0;
    for (let k = 0; k < n; k++) {
      const i = h12.get(str.slice(k * 12, k * 12 + 12));
      if (i == null) { missing++; continue; }
      const a = act.a[i];
      if (!a || !a.length) continue;
      let f = -1;
      for (let j = 0; j < a.length; j += 2) {
        const d = a[j] - si;
        if (d < 0 || d >= 30) continue;
        if (f < 0) f = d;
        gmv[d] += a[j + 1];
      }
      if (f >= 0) first[f]++;
    }
    return { n, first, gmv, missing };
  }

  function measure(c) {
    if (results.has(c.id)) return results.get(c.id);
    const mem = members.get(c.id);
    if (!mem || mem.error || actState !== 'ready') return null;
    const si = act.days.findIndex((d) => d >= c.sendDate);
    if (si < 0) return { pending: true };
    const elapsed = Math.min(30, act.days.length - si);
    const T = measureGroup(mem.t, si), C = measureGroup(mem.c, si);
    const res = { elapsed, T, C, startClipped: c.sendDate < act.days[0] };
    results.set(c.id, res);
    return res;
  }

  /** Resultado a un horizonte: conversión, lift, incrementales y significancia. */
  function at(res, h) {
    const H = Math.min(h, res.elapsed);
    const sumTo = (arr) => { let s = 0; for (let d = 0; d < H; d++) s += arr[d]; return s; };
    const bT = sumTo(res.T.first), bC = sumTo(res.C.first);
    const gT = sumTo(res.T.gmv), gC = sumTo(res.C.gmv);
    const nT = res.T.n, nC = res.C.n;
    const pT = nT ? bT / nT : 0, pC = nC ? bC / nC : null;
    const out = { H, bT, bC, gT, gC, nT, nC, pT, pC };
    if (pC != null && nC) {
      out.lift = pC > 0 ? pT / pC - 1 : null;
      out.incBuyers = (pT - pC) * nT;
      out.incGmv = (gT / nT - gC / nC) * nT;
      const p = (bT + bC) / (nT + nC);
      const se = Math.sqrt(p * (1 - p) * (1 / nT + 1 / nC));
      out.z = se ? (pT - pC) / se : 0;
      out.sig = Math.abs(out.z) >= 1.96 ? 'ok' : Math.abs(out.z) >= 1.645 ? 'w' : 'n';
    }
    return out;
  }
  const sigLabel = { ok: 'Resultado confiable (95%)', w: 'Tendencia (90%)', n: 'Todavía no es concluyente' };
  const chName = (k) => (CHANNEL_OPTS.find((o) => o[0] === k) || [0, k || '—'])[1];

  function headline(c) {
    const st = campStatus(c);
    if (st.key === 'prog') return '<span class="muted">Todavía no se envió</span>';
    if (actState === 'loading' || actState === 'idle') return '<span class="muted">Cargando compras…</span>';
    if (actState !== 'ready') return '<span class="muted">Medición no disponible todavía</span>';
    const mem = members.get(c.id);
    if (mem === undefined) { loadMembers(c); return '<span class="muted">Calculando…</span>'; }
    if (mem === null) return '<span class="muted">Calculando…</span>';
    if (mem.error) return '<span class="muted">No se pudo leer la campaña</span>';
    const res = measure(c);
    if (!res || res.pending) return '<span class="muted">Esperando el primer día de datos</span>';
    const r = at(res, 30);
    if (r.pC == null) return `<b>${W.fmtPct(r.pT)}</b> compró <span class="muted">· sin control</span>`;
    const sign = r.incBuyers >= 0 ? '+' : '−';
    return `<b class="${r.incBuyers >= 0 ? 'pos' : 'neg'}">${sign}${W.fmtNum(Math.abs(Math.round(r.incBuyers)))} compradores</b>
      · <b>${sign}${W.fmtMoneyC(Math.abs(r.incGmv))}</b> <span class="pill ${r.sig}">${sigLabel[r.sig]}</span>`;
  }

  function viewCamps() {
    if (campsState !== 'ready') return '<div class="loading">Cargando campañas…</div>';
    if (actState === 'idle') loadAct();
    if (campSel) {
      const c = camps.find((x) => x.id === campSel);
      if (c) return campDetail(c);
      campSel = null;
    }
    const note = campsLocalOnly
      ? `<div class="chalert"><span class="chalert-ic">${W.icon('info', 15)}</span><div>Las campañas se están guardando solo en este navegador:
          el almacenamiento compartido no está disponible en este entorno.</div></div>` : '';
    const actNote = actState === 'mismatch' || actState === 'error'
      ? `<div class="chalert"><span class="chalert-ic">${W.icon('warn', 15)}</span><div>Las compras para medir se están actualizando
          (se publican con la corrida diaria). Volvé a entrar en un rato para ver los resultados.</div></div>` : '';
    if (!camps.length) {
      return `${note}<div class="card au-empty">
        <span class="au-empty-ic">${W.icon('megaphone', 26)}</span>
        <h3>Todavía no hay campañas</h3>
        <p>Armá una audiencia y tocá <b>Crear campaña medible</b>. Separamos al azar un grupo de control que no recibe nada,
          y a los 7, 14 y 30 días te mostramos cuánto compraron de más los que sí la recibieron.</p>
        <button class="btn-p" data-tab="opp">${W.icon('sparkles', 14)}Ver oportunidades</button>
      </div>`;
    }
    return `${note}${actNote}
      <div class="au-camps">${camps.map((c) => {
        const st = campStatus(c);
        return `<button class="au-camp" data-camp="${W.esc(c.id)}">
          <div class="au-camp-m">
            <b>${W.esc(c.name)}</b>
            <span>${dayTxt(c.sendDate)} · ${W.esc(chName(c.channel))}${c.incentive ? ` · ${W.esc(INCENTIVES[c.incentive]?.label || c.incentive)}` : ''}${c.createdBy ? ` · ${W.esc(c.createdBy)}` : ''}${c.local ? ' · solo en este navegador' : ''}</span>
          </div>
          <div class="au-camp-sz"><b>${W.fmtNum(c.nT)}</b><em>reciben</em></div>
          <div class="au-camp-sz"><b>${W.fmtNum(c.nC)}</b><em>control</em></div>
          <div class="au-camp-r"><span class="pill ${st.cls}">${W.esc(st.label)}</span><div>${headline(c)}</div></div>
          ${W.icon('chevronR', 16)}
        </button>`;
      }).join('')}</div>`;
  }

  function campDetail(c) {
    const st = campStatus(c);
    const back = `<button class="btn-s au-back" id="camp-back">${W.icon('chevronR', 13, 'flip')}Todas las campañas</button>`;
    const head = `<div class="card au-cd-h">
      <div><h2>${W.esc(c.name)}</h2>
        <p>Enviada el ${dayTxt(c.sendDate)} por ${W.esc(chName(c.channel))}${c.incentive ? ` · ${W.esc(INCENTIVES[c.incentive]?.label || c.incentive)}` : ''}${c.createdBy ? ` · creada por ${W.esc(c.createdBy)}` : ''}</p>
        ${c.ruleLabels?.length ? `<div class="au-cd-rules">${c.ruleLabels.map((l) => `<span class="chip-rule">${W.esc(l)}</span>`).join('')}</div>` : ''}
      </div>
      <div class="au-cd-a"><span class="pill ${st.cls}">${W.esc(st.label)}</span>
        ${c.rules?.length ? `<button class="btn" id="camp-reuse">${W.icon('refresh', 14)}Reusar audiencia</button>` : ''}
        <button class="btn au-del" id="camp-del">${W.icon('close', 14)}Borrar</button></div>
    </div>`;

    if (st.key === 'prog') return `${back}${head}<div class="card"><div class="chart-empty">La medición arranca el ${dayTxt(c.sendDate)}.</div></div>`;
    if (actState !== 'ready') return `${back}${head}<div class="card"><div class="chart-empty">${actState === 'loading' ? 'Cargando compras…' : 'Las compras para medir se están actualizando. Volvé en un rato.'}</div></div>`;
    const mem = members.get(c.id);
    if (mem === undefined) loadMembers(c);
    if (!mem) return `${back}${head}<div class="loading">Calculando resultados…</div>`;
    if (mem.error) return `${back}${head}<div class="card"><div class="chart-empty">No se pudo leer la lista de la campaña.</div></div>`;
    const res = measure(c);
    if (!res || res.pending) return `${back}${head}<div class="card"><div class="chart-empty">Todavía no hay compras cargadas desde el ${dayTxt(c.sendDate)}. Se actualiza todos los días.</div></div>`;

    const hs = [7, 14, 30];
    if (!hs.includes(horizon)) horizon = 30;
    const r = at(res, horizon);
    const hasC = r.pC != null;
    const partial = r.H < horizon;

    const kpi = (label, v, sub, cls = '') => `<div class="tile au-kpi"><div class="tile-t"><span class="tile-l">${label}</span></div>
      <div class="tile-v ${cls}">${v}</div><div class="tile-s">${sub}</div></div>`;
    const sgn = (v) => (v >= 0 ? '+' : '−');

    const cumT = [], cumC = [];
    let aT = 0, aC = 0;
    for (let d = 0; d < res.elapsed; d++) {
      aT += res.T.first[d]; aC += res.C.first[d];
      cumT.push(res.T.n ? (aT / res.T.n) * 100 : 0);
      cumC.push(res.C.n ? (aC / res.C.n) * 100 : 0);
    }
    const labels = cumT.map((_, d) => d + 1);
    const series = [{ name: 'Recibieron la campaña', color: '#4f46e5', values: cumT, tipFmt: (v) => `${v.toFixed(1)}%` }];
    if (hasC) series.push({ name: 'Grupo de control', color: '#eb6834', values: cumC, dashed: true, tipFmt: (v) => `${v.toFixed(1)}%` });

    return `${back}${head}
      <div class="au-hz">
        <div class="seg-ctl">${hs.map((h) => `<button data-hz="${h}" class="${h === horizon ? 'on' : ''}"${res.elapsed < h && h !== 7 && res.elapsed < 7 ? '' : ''}>${h} días</button>`).join('')}</div>
        <span class="muted">${partial ? `van ${r.H} de ${horizon} días — el número todavía se mueve` : `primeros ${horizon} días desde el envío`}</span>
      </div>
      <div class="au-kpis">
        ${hasC ? kpi('Compradores de más', `${sgn(r.incBuyers)}${W.fmtNum(Math.abs(Math.round(r.incBuyers)))}`, 'que compraron gracias a la campaña', r.incBuyers >= 0 ? 'pos' : 'neg') : ''}
        ${hasC ? kpi('Venta de más', `${sgn(r.incGmv)}${W.fmtMoneyC(Math.abs(r.incGmv))}`, 'GMV incremental vs. el control', r.incGmv >= 0 ? 'pos' : 'neg') : ''}
        ${kpi('Compraron (recibieron)', W.fmtPct(r.pT), `${W.fmtNum(r.bT)} de ${W.fmtNum(r.nT)}`)}
        ${hasC ? kpi('Compraron (control)', W.fmtPct(r.pC), `${W.fmtNum(r.bC)} de ${W.fmtNum(r.nC)}`) : kpi('GMV de los que recibieron', W.fmtMoneyC(r.gT), 'sin control no se puede separar lo incremental')}
        ${hasC && r.lift != null ? kpi('Lift', `${sgn(r.lift)}${W.fmtPct(Math.abs(r.lift))}`, 'más conversión que el control', r.lift >= 0 ? 'pos' : 'neg') : ''}
      </div>
      ${hasC ? `<div class="au-verdict ${r.sig}">${W.icon(r.sig === 'ok' ? 'check' : r.sig === 'w' ? 'info' : 'clock', 16)}<div>
        <b>${sigLabel[r.sig]}</b>
        <span>${r.sig === 'ok' ? `La diferencia entre los dos grupos es demasiado grande para ser casualidad (z = ${r.z.toFixed(2)}).`
          : r.sig === 'w' ? `Hay señal, pero todavía podría ser azar (z = ${r.z.toFixed(2)}). Esperá unos días más.`
          : `Con ${W.fmtNum(r.nC)} clientes en el control, la diferencia todavía puede ser casualidad (z = ${r.z.toFixed(2)}).`}</span>
      </div></div>` : ''}
      <div class="card">
        <div class="card-h"><div><h3>Qué porcentaje de cada grupo ya compró</h3>
          <p>acumulado día a día desde el envío — la distancia entre las dos líneas es lo que generó la campaña</p></div></div>
        ${W.chart.line({ labels, series, height: 240, id: 'camp-ch', yFmt: (v) => `${Math.round(v)}%`,
          xFmt: (d) => `día ${d}`, tipTitle: (d) => `Día ${d} desde el envío`, empty: 'Hace falta al menos dos días de datos para dibujar la curva.' })}
        ${res.T.missing + res.C.missing ? `<p class="au-foot">${W.fmtNum(res.T.missing + res.C.missing)} clientes de la campaña ya no están en el índice y se cuentan como que no compraron.</p>` : ''}
        ${res.startClipped ? '<p class="au-foot">La campaña es anterior a la ventana de compras guardada: los primeros días no se ven.</p>' : ''}
      </div>`;
  }

  // ── Crear la campaña: partir, guardar, descargar ──────────────────────────
  const HCHUNK = 12 * 40000;

  async function createCampaign(matches, sum, form, btn) {
    const pct = form.pct;
    const seed = (Math.random() * 2 ** 32) >>> 0;
    const T = [], C = [];
    for (const i of matches) {
      const v = ((parseInt(idx.h[i].slice(0, 8), 16) ^ seed) >>> 0) % 1000;
      (v < pct * 10 ? C : T).push(i);
    }
    let pvSum = 0, pvN = 0;
    for (const i of T) if (idx.pv?.[i] != null) { pvSum += idx.pv[i]; pvN++; }
    const meta = {
      name: form.name, sendDate: form.date, rules: JSON.parse(JSON.stringify(rules)), ruleLabels: rules.map(ruleLabel),
      channel: form.ch, controlPct: pct, incentive: form.inc, nT: T.length, nC: C.length,
      pvT: pvN ? Math.round(pvSum / pvN) : null,
    };
    const tStr = T.map((i) => idx.h[i].slice(0, 12)).join('');
    const cStr = C.map((i) => idx.h[i].slice(0, 12)).join('');

    btn.disabled = true;
    btn.textContent = 'Guardando…';
    let id = null;
    try {
      const r = await fetch('/api/campaigns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta) });
      if (r.ok) {
        const out = await r.json();
        id = out.id;
        for (const [g, s] of [['t', tStr], ['c', cStr]]) {
          const nk = out.chunks?.[g] || 0;
          for (let k = 0; k < nk; k++) {
            btn.textContent = `Guardando… ${g === 't' ? 'tratados' : 'control'} ${k + 1}/${nk}`;
            const pr = await fetch(`/api/campaigns?id=${id}&g=${g}&k=${k}`, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: s.slice(k * HCHUNK, (k + 1) * HCHUNK) });
            if (!pr.ok) throw new Error(`chunk ${pr.status}`);
          }
        }
        members.set(id, { t: tStr, c: cStr });
        campsState = 'idle';
      } else if (r.status === 503 || r.status === 404 || r.status === 405) {
        id = null;
      } else {
        throw new Error(String(r.status));
      }
    } catch (e) {
      W.toast('No se pudo guardar la campaña. Probá de nuevo en un rato.', 'bad');
      btn.disabled = false;
      btn.textContent = 'Crear y descargar lista';
      return;
    }

    if (!id) {
      // Sin almacenamiento compartido (entorno local): queda en este navegador.
      id = `l${Date.now().toString(36)}`;
      const local = W.store.get('localCampaigns', []);
      const big = tStr.length + cStr.length > 1500000;
      local.unshift({ ...meta, id, createdAt: new Date().toISOString(), createdBy: '', chunks: {}, complete: true, t: big ? null : tStr, c: big ? null : cStr });
      W.store.set('localCampaigns', local.slice(0, 20));
      members.set(id, big ? { error: true } : { t: tStr, c: cStr });
      campsState = 'idle';
      W.toast('Campaña guardada en este navegador (el almacenamiento compartido no está disponible).', 'warn');
    }

    await downloadFor(form.ch, T, form.name);
    W.toast(`Campaña creada: ${W.fmtNum(T.length)} reciben, ${W.fmtNum(C.length)} de control.`, 'good');
    modal = null;
    tab = 'camp';
    W.store.set('audTab', tab);
    campSel = id;
    loadCamps();
    W.render();
  }

  // ── Descargas ─────────────────────────────────────────────────────────────
  const slug = (s) => String(s || 'audiencia').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

  function saveText(name, text, type = 'text/csv;charset=utf-8;') {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportMails(list, base) {
    const rows = [];
    for (const i of list) {
      const v = emailMap?.get(idx.h[i]);
      if (!v || (!v.email && !v.dni)) continue;
      rows.push([v.dni || '', v.email || '']);
    }
    if (!rows.length) { W.toast('Ningún cliente de la audiencia tiene datos de contacto.', 'bad'); return 0; }
    W.downloadXLSX(`webdash-${base}-mailing-${today()}.xlsx`, [{ name: 'Contactos', rows: [['DNI', 'MAIL'], ...rows] }]);
    return rows.length;
  }

  function exportDni(list, base) {
    const rows = [];
    for (const i of list) { const v = emailMap?.get(idx.h[i]); if (v?.dni) rows.push([v.dni]); }
    if (!rows.length) { W.toast('Ningún cliente de la audiencia tiene DNI.', 'bad'); return 0; }
    W.downloadXLSX(`webdash-${base}-push-dni-${today()}.xlsx`, [{ name: 'DNI', rows: [['DNI'], ...rows] }]);
    return rows.length;
  }

  // Google Ads Customer Match: SHA-256 del mail normalizado (minúsculas, sin
  // espacios; en gmail/googlemail sin puntos antes de la @, como pide Google)
  // y Country. Sin BOM: Google no reconoce el encabezado si arranca con uno.
  async function exportGads(list, base, btn) {
    if (!emailMap || !window.crypto?.subtle) { W.toast('Este navegador no permite encriptar el archivo.', 'bad'); return 0; }
    const norm = (m) => {
      let v = String(m).trim().toLowerCase();
      const at = v.lastIndexOf('@');
      if (at > 0 && /^(gmail|googlemail)\.com$/.test(v.slice(at + 1))) v = v.slice(0, at).replace(/\./g, '') + v.slice(at);
      return v;
    };
    const mails = [...new Set(list.map((i) => emailMap.get(idx.h[i])?.email).filter(Boolean).map(norm))];
    if (!mails.length) { W.toast('Ningún cliente de la audiencia tiene mail.', 'bad'); return 0; }
    const enc = new TextEncoder();
    const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const out = ['Email,Country'];
    const LOTE = 2000;
    for (let k = 0; k < mails.length; k += LOTE) {
      const hs = await Promise.all(mails.slice(k, k + LOTE).map((m) => crypto.subtle.digest('SHA-256', enc.encode(m))));
      for (const h of hs) out.push(`${hex(h)},AR`);
      if (btn) btn.textContent = `Encriptando… ${Math.min(100, Math.round(((k + LOTE) / mails.length) * 100))}%`;
    }
    saveText(`google-ads-${base}-${today()}.csv`, out.join('\n'));
    return mails.length;
  }

  function exportHashes(list, base) {
    saveText(`webdash-${base}-clientes-${today()}.csv`, ['hash', ...list.map((i) => idx.h[i])].join('\n'));
    return list.length;
  }

  async function downloadFor(ch, list, name) {
    const base = slug(name);
    if (!emailMap && ch !== 'otro') {
      W.toast('Los contactos no están disponibles: se descarga la lista de clientes (hash) para cruzar.', 'warn');
      return exportHashes(list, base);
    }
    if (ch === 'mail') return exportMails(list, base);
    if (ch === 'push') return exportDni(list, base);
    if (ch === 'gads') return exportGads(list, base, null);
    return exportHashes(list, base);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Eventos
  // ══════════════════════════════════════════════════════════════════════════
  function persist() { W.store.set('audienceRules', rules); W.render(); }

  /** Suma condiciones (toggle) en vez de pisar todo lo armado. */
  function toggleRules(newRules) {
    const key = (r) => `${r.field}|${r.op}|${r.value}`;
    const newKeys = new Set(newRules.map(key));
    const allAlreadyOn = newRules.every((nr) => rules.some((r) => key(r) === key(nr)));
    if (allAlreadyOn) {
      rules = rules.filter((r) => !newKeys.has(key(r)));
    } else {
      const fields = new Set(newRules.map((r) => r.field));
      rules = [...rules.filter((r) => !fields.has(r.field)), ...newRules];
    }
    persist();
  }

  function goCreate(rs, name) {
    rules = JSON.parse(JSON.stringify(rs));
    audName = name || '';
    tab = 'crear';
    insight = 'perfil';
    W.store.set('audTab', tab);
    persist();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function applyChurn(patch) {
    W.setChurn(patch);
    D = derive();
    W.render();
  }

  function wire(matches, sum) {
    const $ = (s) => document.querySelector(s);
    const $$ = (s) => [...document.querySelectorAll(s)];

    $$('[data-tab]').forEach((b) => b.addEventListener('click', () => {
      tab = b.dataset.tab === 'crear' ? 'crear' : b.dataset.tab;
      if (tab === 'camp') { campSel = null; if (campsState === 'ready') { campsState = 'idle'; results.clear(); } }
      W.store.set('audTab', tab);
      W.render();
    }));
    $('#au-cfg')?.addEventListener('click', () => { modal = 'churn'; W.render(); });

    // Modales
    const close = () => { modal = null; W.render(); };
    $('#au-modal-x')?.addEventListener('click', close);
    $('#au-modal-x2')?.addEventListener('click', close);
    $('#au-modal-ok')?.addEventListener('click', close);
    $('#au-modal')?.addEventListener('click', (e) => { if (e.target.id === 'au-modal') close(); });
    $$('input[name="cmode"]').forEach((r) => r.addEventListener('change', (e) => applyChurn({ mode: e.target.value })));
    $$('[data-c]').forEach((inp) => inp.addEventListener('change', (e) => {
      const v = Number(e.target.value);
      if (Number.isFinite(v) && v > 0) applyChurn({ [e.target.dataset.c]: v });
    }));
    $$('[data-cd]').forEach((b) => b.addEventListener('click', () => {
      const d = Number(b.dataset.cd);
      applyChurn({ mode: 'dias', churnDays: d, riskDays: Math.max(1, Math.round(d / 2)) });
    }));
    $('#churn-reset')?.addEventListener('click', () => { W.resetChurn(); D = derive(); W.render(); });

    // Modal de campaña: se actualiza en el lugar para no perder lo tipeado.
    $$('[data-ctl]').forEach((b) => b.addEventListener('click', () => {
      const p = Number(b.dataset.ctl);
      W.store.set('campCtl', p);
      $$('[data-ctl]').forEach((x) => x.classList.toggle('on', x === b));
      $('#cp-split').innerHTML = splitText(matches.length, Math.round((matches.length * p) / 100), p);
    }));
    $$('input[name="cp-ch"]').forEach((r) => r.addEventListener('change', (e) => {
      W.store.set('campCh', e.target.value);
      $$('.au-ch').forEach((l) => l.classList.toggle('on', l.contains(e.target)));
    }));
    $('#cp-go')?.addEventListener('click', (e) => {
      const name = ($('#cp-name').value || '').trim();
      const date = $('#cp-date').value;
      if (!name) { W.toast('Poné un nombre para la campaña.', 'bad'); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { W.toast('Elegí la fecha de envío.', 'bad'); return; }
      createCampaign(matches, sum, {
        name, date, inc: $('#cp-inc').value,
        ch: document.querySelector('input[name="cp-ch"]:checked')?.value || 'mail',
        pct: W.store.get('campCtl', 10),
      }, e.currentTarget);
    });

    // Oportunidades
    $$('[data-opp]').forEach((b) => b.addEventListener('click', () => {
      const o = OPPS.find((x) => x.key === b.dataset.opp);
      goCreate(o.rules, o.name);
    }));
    $$('[data-opp-rules]').forEach((b) => b.addEventListener('click', () => goCreate(JSON.parse(b.dataset.oppRules), b.dataset.oppName)));
    $$('.au-life-i').forEach((b) => b.addEventListener('click', () => {
      goCreate([{ field: 'ciclo', op: 'es', value: b.dataset.life }], W.LIFECYCLE[b.dataset.life].label);
    }));
    $$('.au-repo-i').forEach((b) => b.addEventListener('click', () => {
      goCreate([{ field: 'reponer', op: 'sí', value: b.dataset.repo }], `Reponer ${b.dataset.repo}`);
    }));

    // Constructor
    $$('.pre[data-g]').forEach((b) => b.addEventListener('click', () => {
      const p = PRESETS[+b.dataset.g].items[+b.dataset.p];
      audName = p.name;
      toggleRules(JSON.parse(JSON.stringify(p.rules)));
    }));
    $$('[data-ins]').forEach((b) => b.addEventListener('click', () => { insight = b.dataset.ins; W.render(); }));
    $$('[data-nextcat]').forEach((b) => b.addEventListener('click', () => toggleRules([{ field: 'proximaCat', op: 'es', value: b.dataset.nextcat }])));
    $$('[data-repo-f]').forEach((b) => b.addEventListener('click', () => toggleRules([{ field: 'reponer', op: 'sí', value: b.dataset.repoF }])));
    $$('[data-inc]').forEach((b) => b.addEventListener('click', () => toggleRules([{ field: 'incentivo', op: 'es', value: b.dataset.inc }])));

    $$('.rule-f').forEach((sel) => sel.addEventListener('change', (e) => {
      const i = +e.target.dataset.i, field = e.target.value, f = FIELDS[field];
      const dflt = {
        lifecycle: 'churn', segment: idx.segments[0], category: idx.categories[0],
        categoryN1: (idx.categoriesN1 || [])[0], categoryN2: (idx.categoriesN2 || [])[0],
        payment: (idx.payments || [])[0] || '', store: (idx.stores || [])[0] || '', number: 1, channel: 'app',
        incentive: 'sin', replenish: '*',
      }[f.type];
      rules[i] = { field, op: f.ops[0], value: dflt };
      persist();
    }));
    $$('.rule-o').forEach((sel) => sel.addEventListener('change', (e) => { rules[+e.target.dataset.i].op = e.target.value; persist(); }));
    $$('.rule-v').forEach((inp) => inp.addEventListener('change', (e) => { rules[+e.target.dataset.i].value = e.target.value; persist(); }));
    $$('.rule-x').forEach((b) => b.addEventListener('click', (e) => { rules.splice(+e.currentTarget.dataset.i, 1); persist(); }));
    $('#add-rule')?.addEventListener('click', () => { rules.push({ field: 'pedidos', op: '≥', value: 2 }); persist(); });
    $('#clear-rules')?.addEventListener('click', () => { rules = []; audName = ''; persist(); });
    $('#new-camp')?.addEventListener('click', () => { modal = 'camp'; W.render(); });

    // Carga manual del CSV de contactos (alternativa al repo privado)
    const drop = $('#drop'), input = $('#mail-file');
    const handle = (file) => {
      if (!file) return;
      const rd = new FileReader();
      rd.onload = () => {
        const map = W.parseHashEmailCsv(rd.result);
        if (!map) { W.toast('No se encontraron pares hash,email en el archivo.', 'bad'); return; }
        emailMap = map;
        W.toast(`Cargados ${W.fmtNum(map.size)} contactos (solo en este navegador).`, 'good');
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

    const base = slug(audName || 'audiencia');
    $('#exp-mails')?.addEventListener('click', () => { const n = exportMails(matches, base); if (n) W.toast(`Exportados ${W.fmtNum(n)} contactos.`, 'good'); });
    $('#exp-dni')?.addEventListener('click', () => { const n = exportDni(matches, base); if (n) W.toast(`Exportados ${W.fmtNum(n)} DNI.`, 'good'); });
    $('#exp-gads')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const n = await exportGads(matches, base, btn);
      if (n) W.toast(`Listo: ${W.fmtNum(n)} mails encriptados para Google Ads.`, 'good');
      W.render();
    });

    $('#save-aud')?.addEventListener('click', () => {
      const name = ($('#save-name')?.value || '').trim();
      if (!name) { W.toast('Poné un nombre para guardar la audiencia.', 'bad'); return; }
      const list = W.store.get('savedAudiences', []);
      list.push({ name, rules: JSON.parse(JSON.stringify(rules)) });
      W.store.set('savedAudiences', list);
      audName = name;
      W.toast(`Audiencia "${name}" guardada.`, 'good');
      W.render();
    });
    $$('.saved-go').forEach((b) => b.addEventListener('click', (e) => {
      const s = W.store.get('savedAudiences', [])[+e.target.dataset.i];
      rules = JSON.parse(JSON.stringify(s.rules));
      audName = s.name;
      persist();
    }));
    $$('.saved-x').forEach((b) => b.addEventListener('click', (e) => {
      const list = W.store.get('savedAudiences', []);
      list.splice(+e.currentTarget.dataset.i, 1);
      W.store.set('savedAudiences', list);
      W.render();
    }));

    // Campañas
    $$('[data-camp]').forEach((b) => b.addEventListener('click', () => { campSel = b.dataset.camp; horizon = 30; W.render(); window.scrollTo({ top: 0 }); }));
    $('#camp-back')?.addEventListener('click', () => { campSel = null; W.render(); });
    $$('[data-hz]').forEach((b) => b.addEventListener('click', () => { horizon = Number(b.dataset.hz); W.render(); }));
    $('#camp-reuse')?.addEventListener('click', () => {
      const c = camps.find((x) => x.id === campSel);
      if (c) goCreate(c.rules, c.name);
    });
    $('#camp-del')?.addEventListener('click', async () => {
      const c = camps.find((x) => x.id === campSel);
      if (!c || !window.confirm(`¿Borrar la campaña "${c.name}"? Se pierde su medición para todo el equipo.`)) return;
      if (c.local) {
        W.store.set('localCampaigns', W.store.get('localCampaigns', []).filter((x) => x.id !== c.id));
      } else {
        const r = await fetch(`/api/campaigns?id=${encodeURIComponent(c.id)}`, { method: 'DELETE' }).catch(() => null);
        if (!r || !r.ok) { W.toast('No se pudo borrar la campaña.', 'bad'); return; }
      }
      members.delete(c.id); results.delete(c.id);
      camps = camps.filter((x) => x.id !== c.id);
      campSel = null;
      W.toast('Campaña borrada.', 'good');
      W.render();
    });
  }
})();

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildInsights, normalizeTerm, variantKind } = require('../src/search-insights');

test('normalizeTerm: decodifica, minúsculas y colapsa espacios', () => {
  assert.equal(normalizeTerm('Papel%20Higienico'), 'papel higienico');
  assert.equal(normalizeTerm('  Leche   Entera '), 'leche entera');
  assert.equal(normalizeTerm('coca+cola'), 'coca cola');
  assert.equal(normalizeTerm('100%'), '100%'); // un % suelto no rompe
});

test('variantKind: reconoce tildes, espacios, plurales y tipeos, y no confunde búsquedas distintas', () => {
  assert.equal(variantKind('azucar', 'azúcar'), 'tilde');
  assert.equal(variantKind('coca cola', 'cocacola'), 'espacio');
  assert.equal(variantKind('fideos', 'fideo'), 'plural');
  assert.equal(variantKind('queso rallado', 'queso rayado'), 'tipeo');
  assert.equal(variantKind('coca', 'coco'), null);
  assert.equal(variantKind('leche', 'noche'), null);
  assert.equal(variantKind('palta', 'paleta'), null);
  assert.equal(variantKind('galletitas', 'galletas'), null);
});

test('buildInsights: junta formas del mismo término, cuenta vacíos y codificados, arma variantes', () => {
  const out = buildInsights({
    periods: [
      { term: 'Leche', cur: 100, prev: 80, users: 70 },
      { term: 'leche', cur: 50, prev: 40, users: 30 },
      { term: 'leches', cur: 10, prev: 2, users: 8 },
      { term: 'papel%20higienico', cur: 30, prev: 0, users: 20 },
      { term: '', cur: 25, prev: 20, users: 20 },
      { term: '7790080001234', cur: 5, prev: 0, users: 5 },
    ],
    week: [{ term: 'leche', cur: 40, prev: 20 }],
    weekly: [{ term: 'Leche', week: '202638', n: 30 }, { term: 'leche', week: '202637', n: 20 }],
    daily: [{ date: '20260928', event: 'search', n: 9, users: 5 }, { date: '20260928', event: 'view_search_results', n: 3, users: 2 }],
    heat: [{ dow: '1', hour: '20', n: 7 }],
    devices: [{ device: 'mobile', event: 'search', n: 10, users: 6 }, { device: 'mobile', event: 'session_start', n: 1, users: 50 }],
  });
  const leche = out.terms.find((t) => t.t === 'leche');
  assert.equal(leche.n, 150);
  assert.equal(leche.p, 120);
  assert.equal(leche.n7, 40);
  assert.deepEqual(leche.w.slice(-2), [20, 30]);
  assert.equal(leche.f.length, 2);                // "Leche" y "leche"
  assert.deepEqual(leche.v, [['leches', 10, 'plural']]);
  assert.equal(out.terms.find((t) => t.t === 'leches').of, 'leche');
  assert.equal(out.quality.empty, 25);
  assert.equal(out.quality.encoded, 30);
  assert.equal(out.quality.numeric, 5);
  assert.equal(out.totals.cur, 220);
  assert.deepEqual(out.daily[0], { d: '2026-09-28', s: 9, su: 5, r: 3, ru: 2 });
  assert.equal(out.heat[1][20], 7);
  assert.deepEqual(out.devices[0], { k: 'mobile', s: 10, su: 6, users: 50 });
});

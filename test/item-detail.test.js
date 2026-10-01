const test = require('node:test');
const assert = require('node:assert');
const { itemDetail } = require('../src/fetch-day.js');

test('itemDetail: descuento por promoción, sin contar el envío', () => {
  const d = itemDetail({
    ean: '779', refId: 'R1', id: '11', quantity: 2, listPrice: 100000, sellingPrice: 80000,
    additionalInfo: { brandName: 'Marca' },
    priceTags: [
      { name: 'discount@price-p1#x', value: -30000, identifier: 'p1' },
      { name: 'discount@price-p2#x', value: -10000, identifier: 'p2' },
      { name: 'discount@shipping-p3#x', value: -5000, identifier: 'p3' },
      { name: 'tax', value: 1000 },
    ],
  });
  assert.deepStrictEqual(d.pr, ['p1', 'p2', 'p3']);
  assert.deepStrictEqual(d.pd, [300, 100, 0]);
  assert.strictEqual(d.d, 400);
  assert.strictEqual(d.ds, 50);
  assert.strictEqual(d.lp, 1000);
  assert.strictEqual(d.up, 800);
});

test('itemDetail: productos por peso llevan la lista a la unidad de venta', () => {
  const d = itemDetail({ quantity: 3, listPrice: 699900, sellingPrice: 174975, unitMultiplier: 0.25 });
  assert.strictEqual(d.lp, 1749.75);
  assert.strictEqual(d.up, 1749.75);
  assert.strictEqual(d.pr, undefined);
});

test('pedidos de App: guardan detalle aparte y no suman a las métricas de Web', () => {
  const { newDayAcc, applyOrderToAcc } = require('../src/fetch-day.js');
  const acc = newDayAcc();
  const full = {
    orderId: 'A1-01', creationDate: '2026-10-02T15:00:00Z', status: 'invoiced', salesChannel: '1',
    customData: { customApps: [{ id: 'from-help-info', fields: { from: 'app' } }] },
    marketingData: { coupon: 'APP10' },
    clientProfileData: { email: 'x@y.com' },
    ratesAndBenefitsData: { rateAndBenefitsIdentifiers: [{ id: 'p1', name: '10% App', matchedParameters: { 'couponCode@Marketing': 'APP10' } }] },
    items: [{ name: 'Leche', quantity: 2, sellingPrice: 90000, listPrice: 100000, ean: '779', seller: '1',
      priceTags: [{ name: 'discount@price-p1#x', value: -20000, identifier: 'p1' }] }],
    totals: [],
  };
  assert.strictEqual(applyOrderToAcc(acc, full), false);
  assert.strictEqual(acc.webOrders, 0);
  assert.strictEqual(acc.orders.length, 0);
  assert.strictEqual(acc.appOrders.length, 1);
  const o = acc.appOrders[0];
  assert.strictEqual(o.c, 'app');
  assert.deepStrictEqual(o.cp, ['APP10']);
  assert.deepStrictEqual(o.pm, [['p1', '10% App', 'APP10']]);
  assert.deepStrictEqual(o.it[0].pd, [200]);
});

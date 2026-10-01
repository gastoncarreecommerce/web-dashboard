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

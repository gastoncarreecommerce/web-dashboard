'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const W = require(path.join(__dirname, '..', 'docs', 'xlsx.js'));
const sheetXml = W._sheetXml;

/** Los splits y el panel activo declarados en el XML de una hoja. */
function panel(xml) {
  const m = xml.match(/<pane([^>]*)\/>/);
  if (!m) return null;
  const at = (k) => (m[1].match(new RegExp(`${k}="([^"]*)"`)) || [, null])[1];
  return { xSplit: at('xSplit'), ySplit: at('ySplit'), activePane: at('activePane'),
    topLeftCell: at('topLeftCell') };
}

const filas = [['a', 'b', 'c'], [1, 2, 3], [4, 5, 6]];

// ── El panel activo ─────────────────────────────────────────────────────────
// Excel abria el archivo con "contenido que no se puede leer" y lo reparaba
// quitando la vista de la hoja. El motivo: con solo ySplit los paneles que
// existen son topLeft y bottomLeft, y se escribia activePane="bottomRight",
// que nombra un panel inexistente. openpyxl lo perdonaba, Excel no.

test('con solo fila congelada, el panel activo es bottomLeft', () => {
  const p = panel(sheetXml({ rows: filas }));
  assert.strictEqual(p.ySplit, '1');
  assert.strictEqual(p.xSplit, null);
  assert.strictEqual(p.activePane, 'bottomLeft',
    'bottomRight nombraria un panel que no existe y Excel repara el archivo');
});

test('con fila y columnas congeladas, es bottomRight', () => {
  const p = panel(sheetXml({ rows: filas, columnasFijas: 2 }));
  assert.strictEqual(p.xSplit, '2');
  assert.strictEqual(p.ySplit, '1');
  assert.strictEqual(p.activePane, 'bottomRight');
});

test('con solo columnas congeladas, es topRight', () => {
  const p = panel(sheetXml({ rows: filas, columnasFijas: 2, fijarEncabezado: false }));
  assert.strictEqual(p.xSplit, '2');
  assert.strictEqual(p.ySplit, null);
  assert.strictEqual(p.activePane, 'topRight');
});

test('la seleccion apunta al MISMO panel que activePane', () => {
  for (const hoja of [{ rows: filas }, { rows: filas, columnasFijas: 2 },
    { rows: filas, columnasFijas: 1, fijarEncabezado: false }]) {
    const xml = sheetXml(hoja);
    const p = panel(xml);
    assert.ok(xml.includes(`<selection pane="${p.activePane}"/>`),
      `la seleccion tiene que nombrar ${p.activePane}`);
  }
});

test('sin panel fijo no se escribe <pane> vacio', () => {
  const xml = sheetXml({ rows: filas, fijarEncabezado: false });
  assert.strictEqual(panel(xml), null);
  assert.ok(!xml.includes('<pane'), 'un pane sin splits tambien es invalido');
});

// ── El resto de la estructura ───────────────────────────────────────────────

test('el autofiltro cubre del encabezado a la ultima fila', () => {
  const xml = sheetXml({ rows: filas });
  assert.ok(xml.includes('<autoFilter ref="A1:C3"/>'), xml);
});

test('el autofiltro arranca en la fila del encabezado, no en la 1', () => {
  const conTitulo = [['Título'], [], ['a', 'b'], [1, 2]];
  const xml = sheetXml({ rows: conTitulo, filaEncabezado: 3 });
  assert.ok(xml.includes('<autoFilter ref="A3:B4"/>'), xml);
});

test('sin filas de datos no se pone autofiltro', () => {
  const xml = sheetXml({ rows: [['a', 'b']] });
  assert.ok(!xml.includes('autoFilter'), 'un filtro sobre una sola fila no filtra nada');
});

test('el orden de los elementos es el que exige el esquema', () => {
  // sheetViews < cols < sheetData < autoFilter < mergeCells. Con los elementos
  // al revés Excel no abre el archivo.
  const xml = sheetXml({ rows: filas, widths: [10, 10, 10], merges: ['A1:C1'] });
  const orden = ['<sheetViews', '<cols>', '<sheetData>', '<autoFilter', '<mergeCells'];
  const pos = orden.map((t) => xml.indexOf(t));
  assert.ok(pos.every((x) => x > 0), `faltan elementos: ${JSON.stringify(pos)}`);
  for (let i = 1; i < pos.length; i++) {
    assert.ok(pos[i] > pos[i - 1], `${orden[i]} tiene que ir despues de ${orden[i - 1]}`);
  }
});

test('los numeros van como numeros y el encabezado con su estilo', () => {
  const xml = sheetXml({ rows: filas });
  assert.ok(xml.includes('<c r="A2"'), xml);
  assert.ok(!/<c r="B2"[^>]*t="inlineStr"/.test(xml), 'un numero no puede ir como texto');
  assert.ok(/<c r="A1" s="1"/.test(xml), 'el encabezado lleva el estilo 1');
});

test('el rango de la hoja cubre todas las columnas de la fila mas larga', () => {
  const desparejas = [['a', 'b', 'c', 'd'], [1, 2]];
  assert.ok(sheetXml({ rows: desparejas }).includes('<dimension ref="A1:D2"/>'));
});

// ── Compresión ─────────────────────────────────────────────────────────────
// El archivo se armaba sin comprimir, porque para unas pocas tablas no se
// notaba. Con una hoja de un renglón por PEDIDO son ~100.000 filas por mes: sin
// comprimir daba 44,5 MB. Un xlsx es un ZIP de XML, o sea texto, que comprime
// como diez a uno.

test('el archivo sale comprimido con deflate', async () => {
  const zlib = require('zlib');
  const filas = [['a', 'b', 'c'], ...Array.from({ length: 300 }, (_, i) => [`fila ${i}`, i, i * 2])];
  const blob = await new Promise((resolve) => {
    // downloadXLSX toca el DOM: se prueba el zip a través de él capturando el
    // Blob que arma, con stubs mínimos del navegador.
    const urls = [];
    global.URL = { createObjectURL: (b) => { urls.push(b); return 'blob:x'; }, revokeObjectURL() {} };
    global.document = { createElement: () => ({ click() {}, style: {}, set href(v) {}, set download(v) {} }),
      body: { appendChild() {}, removeChild() {} } };
    W.downloadXLSX('x.xlsx', [{ name: 'Datos', rows: filas }]).then(() => resolve(urls[0]));
  });
  const buf = Buffer.from(await blob.arrayBuffer());

  // En el encabezado local de la primera entrada, el método está en el byte 8.
  const metodo = buf.readUInt16LE(8);
  assert.strictEqual(metodo, 8, 'método 8 es deflate; 0 sería sin comprimir');

  // Y el tamaño comprimido tiene que ser menor que el original, que son los
  // dos campos siguientes del mismo encabezado.
  const comprimido = buf.readUInt32LE(18);
  const original = buf.readUInt32LE(22);
  assert.ok(comprimido < original, `${comprimido} tiene que ser menor que ${original}`);

  // Y lo comprimido tiene que descomprimir a lo original: un ZIP con el CRC o
  // los tamaños mal declarados no lo abre nadie.
  const nombreLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const datos = buf.subarray(30 + nombreLen + extraLen, 30 + nombreLen + extraLen + comprimido);
  const crudo = zlib.inflateRawSync(datos);
  assert.strictEqual(crudo.length, original, 'el tamaño original declarado tiene que ser el real');
  assert.ok(crudo.toString('utf8').startsWith('<?xml'), 'y descomprimir a XML válido');
});

test('un objeto en una celda se serializa, no queda "[object Object]"', () => {
  // Pasó dos veces: en el comparador de precios y en la columna Cliente del
  // export, esa con 73.000 filas así. String() de un objeto no dice nada y el
  // error se descubre recién al abrir el archivo.
  const xml = sheetXml({ rows: [['a'], [{ email: 'x@y.com', dni: '123' }]] });
  assert.ok(!xml.includes('[object Object]'), xml.slice(0, 300));
  assert.ok(xml.includes('x@y.com'), 'se tiene que poder ver qué dato era');
});

test('una fecha en una celda sale legible y no como objeto', () => {
  const xml = sheetXml({ rows: [['a'], [new Date('2026-09-22T10:00:00Z')]] });
  assert.ok(!xml.includes('[object Object]'));
});

test('una lista en una celda se serializa visible, no como [object Object]', () => {
  // Un pedido puede llevar varios cupones y el campo es una lista. Con
  // String() daba "[object Object]"; ahora se ve qué había, que es lo que
  // permitió encontrarlo al primer archivo generado.
  const xml = sheetXml({ rows: [['a'], [['cupon-1', 'cupon-2']]] });
  assert.ok(!xml.includes('[object Object]'));
  assert.ok(xml.includes('cupon-1'));
});

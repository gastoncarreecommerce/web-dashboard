/* global window, Blob, URL, document */
/**
 * Escritor mínimo de .xlsx, sin dependencias.
 *
 * El sitio tiene CSP estricta y no puede cargar SheetJS ni nada de un CDN, así
 * que se arma el archivo a mano: un .xlsx es un ZIP con unos pocos XML adentro.
 * Se usa el método de compresión "stored" (sin comprimir) — el archivo pesa más
 * que uno comprimido, pero evita implementar DEFLATE y Excel lo abre igual.
 *
 * Soporta varias hojas, números como números (para que Excel pueda sumarlos, no
 * como texto), ancho de columnas, panel fijo, autofiltro, celdas combinadas y
 * una paleta de estilos con nombre (encabezado, moneda, porcentaje, deltas en
 * verde/rojo, notas al pie).
 *
 * Los índices de estilo 0 a 4 se mantienen EXACTOS a como estaban: los usan
 * todas las exportaciones del dashboard, y cambiarlos les habría cambiado el
 * formato sin que nadie lo pidiera. Los nuevos se agregan del 5 en adelante.
 */
(function () {
  // En el navegador esto es `window`. Se resuelve asi para que el archivo
  // tambien se pueda cargar en node y testear el XML que genera: el bug del
  // panel activo paso la revision porque openpyxl lo perdona y Excel no, o sea
  // que mirar el archivo con un lector tolerante no alcanza.
  const raiz = typeof window !== 'undefined' ? window : globalThis;
  const W = (raiz.W = raiz.W || {});

  // ── CRC32 (lo exige el formato ZIP) ───────────────────────────────────────
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  const enc = new TextEncoder();

  /**
   * Comprime con DEFLATE usando la compresion nativa del navegador.
   *
   * Por que ahora importa: el archivo se armaba "stored" —sin comprimir— porque
   * para unas pocas tablas la diferencia no se notaba. Con una hoja de un
   * renglon por PEDIDO son ~100.000 filas por mes, y sin comprimir eso da
   * decenas de MB. Un xlsx es un ZIP de XML, o sea texto, que comprime como
   * diez a uno.
   *
   * CompressionStream es parte del navegador, no una libreria: no viola la CSP
   * del sitio, que es lo que obligo a escribir este archivo a mano. Si no esta
   * disponible se vuelve a "stored", que sigue abriendo igual, solo que pesado.
   */
  async function deflate(bytes) {
    if (typeof CompressionStream !== 'function') return null;
    try {
      const cs = new CompressionStream('deflate-raw');
      const stream = new Blob([bytes]).stream().pipeThrough(cs);
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch { return null; }
  }

  async function zip(files) {
    const chunks = [];
    const central = [];
    let offset = 0;

    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const cruda = enc.encode(f.content);
      const crc = crc32(cruda);
      // El CRC y el tamaño sin comprimir se declaran SIEMPRE sobre el original;
      // solo cambia lo que se escribe y el método. Confundir los dos tamaños
      // deja un ZIP que no abre.
      const comprimida = await deflate(cruda);
      const usaDeflate = Boolean(comprimida && comprimida.length < cruda.length);
      const data = usaDeflate ? comprimida : cruda;
      const metodo = usaDeflate ? 8 : 0;

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);   // firma
      local.setUint16(4, 20, true);           // versión necesaria
      local.setUint16(6, 0x0800, true);       // flag: nombres en UTF-8
      local.setUint16(8, metodo, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);      // comprimido
      local.setUint32(22, cruda.length, true);     // original
      local.setUint16(26, nameBytes.length, true);
      chunks.push(new Uint8Array(local.buffer), nameBytes, data);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, metodo, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, data.length, true);
      cd.setUint32(24, cruda.length, true);
      cd.setUint16(28, nameBytes.length, true);
      cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer), nameBytes);

      offset += 30 + nameBytes.length + data.length;
    }

    const centralSize = central.reduce((s, c) => s + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);

    return new Blob([...chunks, ...central, new Uint8Array(end.buffer)],
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const colName = (n) => {
    let s = '';
    for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  };

  // Estilos de número (ver xl/styles.xml más abajo): 2 = entero con separador
  // de miles, 3 = decimal con separador de miles, 4 = porcentaje. El símbolo
  // real (punto de miles, coma decimal) lo pone Excel según la configuración
  // regional de quien lo abre — acá solo se dice "esto es un entero/decimal/%",
  // nunca un string armado a mano, así Excel también puede sumar la columna.
  const NUM_STYLE = { int: 2, dec: 3, pct: 4 };

  /**
   * Los estilos, por nombre. El número es el índice dentro de <cellXfs> de
   * xl/styles.xml (ver más abajo), que es como Excel los referencia.
   *
   * Del 0 al 4 son los de siempre y no se tocan. Del 5 en adelante son los
   * nuevos.
   */
  const E = W.XLSX_ESTILO = {
    normal: 0,
    encabezado: 1,          // blanco y negrita sobre azul, centrado
    entero: 2,
    decimal: 3,
    porcentaje: 4,          // 0.00% — el valor tiene que ser fracción (0,35)
    moneda: 5,              // $ #,##0.00
    monedaBarata: 6,        // el más barato de la fila: verde sobre verde claro
    monedaCara: 7,          // rojo
    monedaDudosa: 8,        // ámbar en itálica: precio sin verificar
    pct1: 9,                // 0,0%
    delta: 10,              // +0,0% / -0,0%
    deltaBuena: 11,         // verde
    deltaMala: 12,          // rojo
    ean: 13,                // monoespaciada gris
    titulo: 14,             // 14pt negrita
    nota: 15,               // 9pt gris itálica
    envuelto: 16,           // texto con salto de línea
    subtitulo: 17,          // negrita sobre gris claro
  };

  /**
   * Adivina el formato de cada columna mirando el encabezado (fila 0) y, si
   * no dice nada, si los valores de esa columna tienen decimales. Pensado
   * para no tener que anotar `formats` a mano en cada exportación — con que
   * las columnas se llamen razonable (gmv, ticket, pct_algo, share_algo)
   * alcanza. `pct` asume que el valor YA es una fracción 0–1 (0.2557, no 25.57).
   */
  function detectFormats(rows) {
    if (rows.length < 2) return [];
    const header = rows[0];
    const dataRows = rows.slice(1);
    return header.map((h, c) => {
      const name = String(h ?? '').toLowerCase();
      if (/pct|share|tasa|porcentaje|participaci|%/.test(name)) return 'pct';
      const vals = dataRows.map((r) => r[c]).filter((v) => typeof v === 'number' && Number.isFinite(v));
      if (!vals.length) return null;
      return vals.some((v) => !Number.isInteger(v)) ? 'dec' : 'int';
    });
  }

  function sheetXml(hoja) {
    const { rows } = hoja;
    const fmts = hoja.formats || detectFormats(rows);
    // Fila del encabezado, 1-based. Por defecto la primera, que es como venia
    // funcionando; una hoja con titulo arriba pasa 3, por ejemplo.
    const hEnc = hoja.filaEncabezado || 1;
    const nCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const ultCol = colName(nCols - 1);

    const body = rows.map((row, r) => {
      const cells = row.map((v, c) => {
        const ref = `${colName(c)}${r + 1}`;
        const isNum = typeof v === 'number' && Number.isFinite(v);
        // El estilo lo decide la hoja si quiere; si no, el de siempre.
        const propio = hoja.estiloDe ? hoja.estiloDe(r + 1, c, v) : null;
        const styleIdx = propio != null
          ? (typeof propio === 'number' ? propio : E[propio] || 0)
          : (r + 1 === hEnc ? E.encabezado : (isNum && NUM_STYLE[fmts[c]]) || 0);
        const style = styleIdx ? ` s="${styleIdx}"` : '';
        // Los números van sin t="inlineStr" para que Excel los trate como número.
        if (isNum) return `<c r="${ref}"${style}><v>${v}</v></c>`;
        // UN OBJETO EN UNA CELDA ES SIEMPRE UN ERROR DE QUIEN ARMA LA HOJA,
        // pero String() lo convierte en "[object Object]", que no dice nada y
        // se descubre recien al abrir el archivo. Paso dos veces: en el
        // comparador de precios y en la columna Cliente del export, esa con
        // 73.000 filas asi.
        //
        // Se serializa a JSON: sigue estando mal, pero se VE que dato es y de
        // donde salio, que es la diferencia entre un bug de diez minutos y uno
        // de una tarde.
        const text = v == null ? ''
          : (typeof v === 'object' ? JSON.stringify(v) : String(v));
        if (!text) return `<c r="${ref}"${style}/>`;
        return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
      }).join('');
      // `customHeight` para que el encabezado respire, y las notas al pie
      // no se corten.
      const alto = r + 1 === hEnc ? ' ht="26" customHeight="1"' : '';
      return `<row r="${r + 1}"${alto}>${cells}</row>`;
    }).join('');

    // ── Panel fijo ─────────────────────────────────────────────────────────
    // Se congela por debajo del encabezado y, si la hoja lo pide, a la derecha
    // de las primeras columnas: en una tabla de 5 tiendas hace la diferencia
    // entre poder leerla y no.
    const xs = hoja.columnasFijas || 0;
    const ys = hoja.fijarEncabezado === false ? 0 : hEnc;
    // EL PANEL ACTIVO DEPENDE DE QUE SPLITS HAY, y no siempre es bottomRight.
    //
    // Con solo ySplit los paneles que existen son topLeft y bottomLeft, asi que
    // activePane="bottomRight" nombra un panel que no existe. Excel no lo
    // acepta: abre el archivo con "contenido que no se puede leer" y lo repara
    // quitando la vista de la hoja. openpyxl lo perdonaba, y por eso la
    // verificacion no lo habia detectado.
    //
    // Afectaba a TODAS las exportaciones del dashboard, que congelan solo la
    // fila del encabezado, no solo a las del comparador.
    const panelActivo = xs && ys ? 'bottomRight' : ys ? 'bottomLeft' : 'topRight';
    const pane = (xs || ys)
      ? `<pane${xs ? ` xSplit="${xs}"` : ''}${ys ? ` ySplit="${ys}"` : ''}`
        + ` topLeftCell="${colName(xs)}${ys + 1}" activePane="${panelActivo}" state="frozen"/>`
        + `<selection pane="${panelActivo}"/>`
      : '';
    const vistas = `<sheetViews><sheetView workbookViewId="0"${hoja.zoom ? ` zoomScale="${hoja.zoom}"` : ''}>`
      + `${pane}</sheetView></sheetViews>`;

    // ── Ancho de columnas ──────────────────────────────────────────────────
    const anchos = hoja.widths && hoja.widths.length
      ? `<cols>${hoja.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
      : '';

    // ── Autofiltro ─────────────────────────────────────────────────────────
    // Va DESPUES de sheetData: el esquema de Excel exige ese orden, y con los
    // elementos al revés no abre el archivo.
    const filtro = hoja.filtro === false || rows.length <= hEnc
      ? ''
      : `<autoFilter ref="A${hEnc}:${ultCol}${rows.length}"/>`;
    const merges = hoja.merges && hoja.merges.length
      ? `<mergeCells count="${hoja.merges.length}">${hoja.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`
      : '';

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${ultCol}${rows.length}"/>${vistas}<sheetFormatPr defaultRowHeight="15"/>${anchos}<sheetData>${body}</sheetData>${filtro}${merges}</worksheet>`;
  }

  /**
   * Descarga un .xlsx.
   * @param filename nombre del archivo
   * @param sheets lista de hojas. Cada una:
   *   name             nombre de la pestaña
   *   rows             [[celda, …], …]
   *   formats          ['int'|'dec'|'pct'|null, …] por columna (si no, se adivina)
   *   widths           ancho por columna, en caracteres
   *   filaEncabezado   fila del encabezado, 1-based (por defecto 1)
   *   columnasFijas    cuántas columnas congelar a la izquierda
   *   fijarEncabezado  false para no congelar la fila del encabezado
   *   filtro           false para no poner autofiltro
   *   merges           ['A1:E1', …]
   *   zoom             % de zoom inicial
   *   estiloDe(f,c,v)  nombre de W.XLSX_ESTILO o índice, por celda (f es 1-based)
   */
  // Se expone para los tests: es la funcion que armaba mal el panel activo.
  W._sheetXml = sheetXml;

  W.downloadXLSX = async function (filename, sheets) {
    const list = sheets.filter((s) => s.rows && s.rows.length);
    if (!list.length) {
      // El comparador es una pagina independiente y no carga core.js, asi que
      // W.toast puede no existir.
      if (W.toast) W.toast('No hay datos para exportar.', 'bad');
      else window.alert('No hay datos para exportar.');
      return;
    }

    const files = [
      { name: '[Content_Types].xml', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${
        list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` },
      { name: '_rels/.rels', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
      { name: 'xl/workbook.xml', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${
        list.map((s, i) => `<sheet name="${esc((s.name || `Hoja${i + 1}`).slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
      { name: 'xl/_rels/workbook.xml.rels', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
        list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
      // Los indices de <cellXfs> son los de W.XLSX_ESTILO. Del 0 al 4 quedan
      // igual que antes para no cambiarle el formato a las exportaciones que ya
      // existen; del 5 en adelante son los nuevos. 3/4/10 son numFmtId estandar
      // de Excel (#,##0 / #,##0.00 / 0.00%) y no hay que declararlos.
      { name: 'xl/styles.xml', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3">
<numFmt numFmtId="164" formatCode="&quot;$&quot;\\ #,##0.00"/>
<numFmt numFmtId="165" formatCode="0.0%"/>
<numFmt numFmtId="166" formatCode="+0.0%;\\-0.0%;0.0%"/>
</numFmts>
<fonts count="9">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
<font><i/><sz val="9"/><color rgb="FF6B7280"/><name val="Calibri"/></font>
<font><b/><sz val="14"/><color rgb="FF111827"/><name val="Calibri"/></font>
<font><sz val="10"/><color rgb="FF6B7280"/><name val="Consolas"/></font>
<font><b/><sz val="11"/><color rgb="FF067A55"/><name val="Calibri"/></font>
<font><sz val="11"/><color rgb="FFB91C1C"/><name val="Calibri"/></font>
<font><i/><sz val="11"/><color rgb="FF92400E"/><name val="Calibri"/></font>
</fonts>
<fills count="7">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF2A78D6"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE8F8F0"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFDECEC"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFF8E1"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF3F4F6"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FFD1D5DB"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="18">
<xf xfId="0"/>
<xf xfId="0" fontId="2" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf xfId="0" numFmtId="3" applyNumberFormat="1"/>
<xf xfId="0" numFmtId="4" applyNumberFormat="1"/>
<xf xfId="0" numFmtId="10" applyNumberFormat="1"/>
<xf xfId="0" numFmtId="164" applyNumberFormat="1"/>
<xf xfId="0" numFmtId="164" fontId="6" fillId="3" applyNumberFormat="1" applyFont="1" applyFill="1"/>
<xf xfId="0" numFmtId="164" fontId="7" applyNumberFormat="1" applyFont="1"/>
<xf xfId="0" numFmtId="164" fontId="8" fillId="5" applyNumberFormat="1" applyFont="1" applyFill="1"/>
<xf xfId="0" numFmtId="165" applyNumberFormat="1"/>
<xf xfId="0" numFmtId="166" applyNumberFormat="1"/>
<xf xfId="0" numFmtId="166" fontId="6" applyNumberFormat="1" applyFont="1"/>
<xf xfId="0" numFmtId="166" fontId="7" applyNumberFormat="1" applyFont="1"/>
<xf xfId="0" fontId="5" applyFont="1"/>
<xf xfId="0" fontId="4" applyFont="1"/>
<xf xfId="0" fontId="3" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf xfId="0" fontId="1" fillId="6" borderId="1" applyFont="1" applyFill="1" applyBorder="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="0"/>
</styleSheet>` },
      ...list.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, content: sheetXml(s) })),
    ];

    const url = URL.createObjectURL(await zip(files));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.W;

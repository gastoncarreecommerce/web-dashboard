/* global window, Blob, URL, document */
/**
 * Escritor mínimo de .xlsx, sin dependencias.
 *
 * El sitio tiene CSP estricta y no puede cargar SheetJS ni nada de un CDN, así
 * que se arma el archivo a mano: un .xlsx es un ZIP con unos pocos XML adentro.
 * Se usa el método de compresión "stored" (sin comprimir) — el archivo pesa más
 * que uno comprimido, pero evita implementar DEFLATE y Excel lo abre igual.
 *
 * Soporta varias hojas, encabezado en negrita y números como números (para que
 * Excel pueda sumarlos, no como texto).
 */
(function () {
  const W = (window.W = window.W || {});

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

  function zip(files) {
    const chunks = [];
    const central = [];
    let offset = 0;

    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const data = enc.encode(f.content);
      const crc = crc32(data);

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);   // firma
      local.setUint16(4, 20, true);           // versión necesaria
      local.setUint16(6, 0x0800, true);       // flag: nombres en UTF-8
      local.setUint16(8, 0, true);            // método: stored
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      chunks.push(new Uint8Array(local.buffer), nameBytes, data);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, data.length, true);
      cd.setUint32(24, data.length, true);
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

  function sheetXml(rows, formats) {
    const fmts = formats || detectFormats(rows);
    const body = rows.map((row, r) => {
      const cells = row.map((v, c) => {
        const ref = `${colName(c)}${r + 1}`;
        const isNum = typeof v === 'number' && Number.isFinite(v);
        const styleIdx = r === 0 ? 1 : (isNum && NUM_STYLE[fmts[c]]) || 0;
        const style = styleIdx ? ` s="${styleIdx}"` : '';
        // Los números van sin t="inlineStr" para que Excel los trate como número.
        if (isNum) return `<c r="${ref}"${style}><v>${v}</v></c>`;
        const text = v == null ? '' : String(v);
        if (!text) return `<c r="${ref}"${style}/>`;
        return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
      }).join('');
      return `<row r="${r + 1}">${cells}</row>`;
    }).join('');

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
  }

  /**
   * Descarga un .xlsx.
   * @param filename nombre del archivo
   * @param sheets [{ name, rows: [[celda, …], …] }] — la primera fila es el encabezado
   */
  W.downloadXLSX = function (filename, sheets) {
    const list = sheets.filter((s) => s.rows && s.rows.length);
    if (!list.length) { W.toast('No hay datos para exportar.', 'bad'); return; }

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
      // 0 normal, 1 negrita (encabezado), 2 entero con miles, 3 decimal con
      // miles, 4 porcentaje — 3/4/10 son IDs de formato estándar de Excel
      // (#,##0 / #,##0.00 / 0.00%), no hace falta declararlos aparte.
      { name: 'xl/styles.xml', content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="5"><xf xfId="0"/><xf xfId="0" fontId="1" applyFont="1"/><xf xfId="0" numFmtId="3" applyNumberFormat="1"/><xf xfId="0" numFmtId="4" applyNumberFormat="1"/><xf xfId="0" numFmtId="10" applyNumberFormat="1"/></cellXfs></styleSheet>` },
      ...list.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, content: sheetXml(s.rows, s.formats) })),
    ];

    const url = URL.createObjectURL(zip(files));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
})();

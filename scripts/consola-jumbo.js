/* ───────────────────────────────────────────────────────────────────────────
   PARA PEGAR EN LA CONSOLA DEL NAVEGADOR, ESTANDO EN www.jumbo.com.ar

   Que averigua: de donde saca la ficha de Jumbo el precio con promo. Desde el
   navegador la sesion ya tiene la ubicacion elegida, asi que las mismas APIs
   que desde un servidor devuelven el precio base pueden devolver aca el precio
   real. Si es asi, la diferencia es la region, y eso se puede reproducir.

   Como usarlo:
     1. Abrir la ficha del producto (la que muestra el precio con descuento).
     2. F12 -> pestana "Console".
     3. Pegar TODO esto y Enter.
     4. Copiar lo que imprime.

   No cambia nada: solo lee. No manda nada a ningun lado.
   ─────────────────────────────────────────────────────────────────────────── */
(async () => {
  const EAN = '7799155000197';          // agua Villavicencio 2 L
  const CP = '1425';
  const log = (...a) => console.log('%c[precio]', 'color:#2a78d6;font-weight:bold', ...a);
  const bien = (n) => (typeof n === 'number' ? n.toLocaleString('es-AR') : String(n));
  const get = async (u) => {
    const r = await fetch(u, { credentials: 'include' });
    return { ok: r.ok, status: r.status, body: await r.text() };
  };
  const json = (x) => { try { return JSON.parse(x.body); } catch { return null; } };

  // ── 1. Que dice la cookie de sesion de VTEX ──────────────────────────────
  // vtex_segment es base64 de un JSON con regionId, canal y politica comercial.
  // Es LA respuesta a "que le esta diciendo el navegador a VTEX que yo no digo".
  const seg = document.cookie.split('; ').find((c) => c.startsWith('vtex_segment='));
  if (seg) {
    try {
      const d = JSON.parse(atob(decodeURIComponent(seg.split('=')[1])));
      log('SESION:', { regionId: d.regionId, channel: d.channel, cultureInfo: d.cultureInfo });
    } catch (e) { log('SESION: la cookie esta pero no se pudo leer:', e.message); }
  } else {
    log('SESION: no hay cookie vtex_segment. Elegi una direccion o sucursal y volve a correr esto.');
  }

  // ── 2. Quien despacha en el CP ───────────────────────────────────────────
  const reg = await get(`/api/checkout/pub/regions?country=ARG&postalCode=${CP}`);
  const regJ = json(reg);
  log(`REGIONES (HTTP ${reg.status}):`, Array.isArray(regJ)
    ? regJ.map((x) => ({ regionId: x.id, sellers: (x.sellers || []).map((s) => s.id) }))
    : reg.body.slice(0, 200));
  const sellers = Array.isArray(regJ)
    ? [...new Set(regJ.flatMap((x) => (x.sellers || []).map((s) => String(s.id))))]
    : [];

  // ── 3. El catalogo, CON la sesion del navegador ──────────────────────────
  const cat = json(await get(`/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${EAN}`));
  const item = cat?.[0]?.items?.[0];
  const oferta = item?.sellers?.[0]?.commertialOffer;
  log('CATALOGO con sesion:', oferta
    ? { Price: bien(oferta.Price), ListPrice: bien(oferta.ListPrice),
        teasers: (oferta.Teasers || []).map((t) => t.Name) }
    : '(no devolvio el producto)');
  log('   itemId:', item?.itemId, ' sellers del catalogo:', item?.sellers?.map((s) => s.sellerId));

  // ── 4. Intelligent Search, CON la sesion ─────────────────────────────────
  const is = json(await get(`/api/io/_v/api/intelligent-search/product_search/?query=${EAN}&count=1`));
  const isOf = is?.products?.[0]?.items?.[0]?.sellers?.[0]?.commertialOffer;
  log('INTELLIGENT SEARCH con sesion:', isOf
    ? { Price: bien(isOf.Price), ListPrice: bien(isOf.ListPrice), spotPrice: bien(isOf.spotPrice),
        teasers: (isOf.teasers || isOf.Teasers || []).map((t) => t.name || t.Name) }
    : '(no devolvio el producto)');

  // ── 5. La simulacion, probando cada seller que aparecio ──────────────────
  const candidatos = [...new Set([...sellers, ...(item?.sellers || []).map((s) => String(s.sellerId))])];
  log('SIMULACION — sellers a probar:', candidatos);
  for (const sl of candidatos) {
    const r = await fetch('/api/checkout/pub/orderForms/simulation', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [{ id: String(item?.itemId), quantity: 1, seller: sl }],
        country: 'ARG', postalCode: CP,
      }),
    });
    const j = await r.json().catch(() => null);
    const it = j?.items?.[0];
    log(`   seller=${sl} (HTTP ${r.status}):`, it
      ? { sellingPrice: bien(it.sellingPrice / 100), listPrice: bien(it.listPrice / 100),
          promos: (j.ratesAndBenefitsData?.rateAndBenefitsIdentifiers || []).map((b) => b.name) }
      : (j?.messages || []).map((m) => m.text).join(' | ') || '(sin item y sin motivo)');
  }

  log('LISTO. El precio que muestra la ficha arriba: ¿aparece en alguna de estas lineas?');
})();

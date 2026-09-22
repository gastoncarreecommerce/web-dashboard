/**
 * GET /api/product-image?ean=XXXXXXXXXXXXX — imagen real del producto, desde
 * el catálogo público de VTEX (no un tercero como OpenFoodFacts, que no
 * conoce marcas propias de Carrefour ni gran parte del surtido local).
 *
 * El buscador de catálogo de VTEX (`/api/catalog_system/pub/products/search`)
 * es público — lo mismo que usa cualquier storefront para mostrar productos,
 * sin necesitar VTEX_APP_KEY/TOKEN — así que esta función solo necesita saber
 * el NOMBRE de la cuenta (VTEX_ACCOUNT_NAME) para armar la URL. No es un dato
 * sensible (es el subdominio público de la tienda), pero como Vercel y
 * GitHub Actions tienen cada uno sus propias env vars, hay que cargarla acá
 * también aunque ya exista como secret de Actions.
 *
 * Env vars en Vercel:
 *   VTEX_ACCOUNT_NAME   nombre de cuenta VTEX (ej. "carrefourar")
 *   VTEX_ENVIRONMENT    (opcional) default 'vtexcommercestable'
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });

  // Se acepta `sku` (cualquier identificador) y `ean` (el nombre viejo del
  // parametro, que sigue funcionando).
  const sku = String(req.query?.sku || req.query?.ean || '').trim();
  if (!sku || sku.length > 60 || /[\s"']/.test(sku)) {
    return res.status(400).json({ error: 'invalid_sku' });
  }

  const account = process.env.VTEX_ACCOUNT_NAME;
  const environment = process.env.VTEX_ENVIRONMENT || 'vtexcommercestable';
  if (!account) {
    return res.status(404).json({ error: 'not_configured', message: 'Falta VTEX_ACCOUNT_NAME en Vercel.' });
  }

  /**
   * Por que hay varias formas de buscar y no una.
   *
   * Los productos propios se identifican por EAN, y con eso alcanzaba. Los de
   * MARKETPLACE no: su identificador es el codigo del seller —"LTDRI0714PB0-DRN",
   * "91DB50X3110-NWSN"— y el cliente ni siquiera lo consultaba, porque filtraba
   * todo lo que no fueran 8 a 14 digitos. Por eso esas filas salian con el
   * cuadrito gris de "sin foto".
   *
   * Ese codigo parece ser <sku del seller>-<seller>, asi que se prueba tambien
   * sin el sufijo. Se devuelve CUAL funciono, para no tener que adivinar despues
   * si una foto falta porque el producto no esta o porque se busco mal.
   */
  const intentos = /^\d{8,14}$/.test(sku)
    ? [['alternateIds_Ean', sku]]
    : [
      ['alternateIds_RefId', sku],
      // Sin el sufijo del seller, si lo tiene.
      ...(sku.includes('-') ? [['alternateIds_RefId', sku.slice(0, sku.lastIndexOf('-'))]] : []),
      // Por las dudas, como EAN: algun marketplace podria mandar el EAN ahi.
      ['alternateIds_Ean', sku],
    ];

  try {
    for (const [campo, valor] of intentos) {
      const url = `https://${account}.${environment}.com.br/api/catalog_system/pub/products/search`
        + `?fq=${campo}:${encodeURIComponent(valor)}`;
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!r.ok) continue;
      const products = await r.json();
      const image = products?.[0]?.items?.[0]?.images?.[0]?.imageUrl || null;
      if (!image) continue;

      // Las imagenes de catalogo no cambian de un minuto a otro: cachear fuerte
      // evita pegarle a VTEX de nuevo por el mismo sku en cada carga del panel.
      res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
      return res.status(200).json({ image, encontradoPor: `${campo}:${valor}` });
    }
    // Que no este no es un error del servidor: se cachea el "no" un rato para
    // no reintentar los mismos skus en cada render.
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(404).json({ error: 'not_found', probados: intentos.map(([c, v]) => `${c}:${v}`) });
  } catch (e) {
    return res.status(502).json({ error: 'fetch_failed', message: e.message });
  }
}

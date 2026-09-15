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

  const ean = String(req.query?.ean || '').trim();
  if (!/^\d{8,14}$/.test(ean)) return res.status(400).json({ error: 'invalid_ean' });

  const account = process.env.VTEX_ACCOUNT_NAME;
  const environment = process.env.VTEX_ENVIRONMENT || 'vtexcommercestable';
  if (!account) {
    return res.status(404).json({ error: 'not_configured', message: 'Falta VTEX_ACCOUNT_NAME en Vercel.' });
  }

  try {
    const url = `https://${account}.${environment}.com.br/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${encodeURIComponent(ean)}`;
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) return res.status(404).json({ error: 'not_found' });

    const products = await r.json();
    const image = products?.[0]?.items?.[0]?.images?.[0]?.imageUrl || null;
    if (!image) return res.status(404).json({ error: 'not_found' });

    // Las imágenes de catálogo no cambian de un minuto a otro: cachear fuerte
    // evita pegarle a VTEX de nuevo por el mismo EAN en cada carga del panel.
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    return res.status(200).json({ image });
  } catch (e) {
    return res.status(502).json({ error: 'fetch_failed', message: e.message });
  }
}

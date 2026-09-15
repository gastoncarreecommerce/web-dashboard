/**
 * GET /api/archive?path=<ruta> — sirve los archivos pesados del histórico de
 * pedidos, que YA NO viajan en el deploy.
 *
 * Por qué existe: `orders/` (983 MB) y `order-index/` (108 MB) sumaban el 98%
 * del peso del repo pero NO se leen nunca al renderizar una vista. Solo se
 * piden a demanda en tres lugares: el detalle de una tienda (view-tiendas),
 * el export XLSX por estado (view-analytics) y el drill-down de un cupón
 * (view-coupons). Tenerlos en la rama que deploya Vercel obligaba a
 * transferir 2,9 GB en cada deploy para servir 40 MB. Ahora viven en la rama
 * `data-raw`, que Vercel no deploya, y este endpoint los trae de ahí cuando
 * alguien realmente hace click.
 *
 * Costo: cero. La API de GitHub es gratis y estas lecturas son esporádicas.
 *
 * Seguridad: el `path` que llega del cliente NO se usa tal cual — se valida
 * contra una lista blanca de formas exactas (ver SAFE_PATH). Sin eso, este
 * endpoint sería un lector arbitrario de archivos del repo. El token de
 * GitHub vive solo acá, en el servidor, y nunca llega al browser (mismo
 * criterio que las credenciales de VTEX).
 *
 * Env vars en Vercel:
 *   ARCHIVE_REPO_TOKEN  — PAT de GitHub, fine-grained, solo Contents: read
 *                         sobre este repo. Sin esto el endpoint da 503 y los
 *                         drill-downs avisan que el archivo no está
 *                         disponible, pero el resto del dashboard anda igual.
 *   ARCHIVE_REPO        — opcional, "owner/repo". Por defecto se toma de
 *                         VERCEL_GIT_REPO_OWNER/VERCEL_GIT_REPO_SLUG.
 *   ARCHIVE_REF         — opcional, la rama del archivo. Por defecto data-raw.
 */
import { createGzip } from 'zlib';
import { Readable } from 'stream';
import { verifySession } from './_session.js';

const DEFAULT_REF = 'data-raw';

/**
 * Las dos únicas formas de ruta que este endpoint acepta. Cualquier otra
 * cosa (`..`, rutas absolutas, otros directorios del repo, extensiones
 * distintas) se rechaza con 400 antes de tocar la red.
 *
 *   order-index/2026-09.json
 *   orders/<código de tienda>/2026-09.json   (y el viejo 2026-H2.json)
 *
 * El código de tienda puede ser numérico ("0009") o alfanumérico ("QX",
 * "GrupoOLTradicional"), así que se permite [A-Za-z0-9_-] sin puntos ni
 * barras — eso es lo que impide escapar del directorio.
 */
const SAFE_PATH = /^(?:order-index\/\d{4}-\d{2}|orders\/[A-Za-z0-9_-]{1,64}\/\d{4}-(?:\d{2}|H[12]))\.json$/;

/** El mes que representa la ruta, para decidir cuánto puede cachear el browser. */
function monthOf(p) {
  const m = p.match(/(\d{4})-(\d{2}|H[12])\.json$/);
  if (!m) return null;
  // Un semestre se trata como su último mes: H1 → junio, H2 → diciembre.
  if (m[2] === 'H1') return `${m[1]}-06`;
  if (m[2] === 'H2') return `${m[1]}-12`;
  return `${m[1]}-${m[2]}`;
}

/**
 * Un período ya cerrado no vuelve a cambiar nunca, así que se puede cachear
 * agresivamente. El mes en curso sí cambia (una vez al día), así que va con
 * una ventana corta.
 */
function cacheControl(p) {
  const month = monthOf(p);
  const nowMonth = new Date().toISOString().slice(0, 7);
  return month && month < nowMonth
    ? 'private, max-age=604800, immutable'
    : 'private, max-age=300';
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  if (!verifySession(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const path = String(req.query?.path || '');
  if (!SAFE_PATH.test(path)) {
    res.status(400).json({ error: 'bad_path' });
    return;
  }

  const token = process.env.ARCHIVE_REPO_TOKEN;
  const repo = process.env.ARCHIVE_REPO
    || (process.env.VERCEL_GIT_REPO_OWNER && process.env.VERCEL_GIT_REPO_SLUG
      ? `${process.env.VERCEL_GIT_REPO_OWNER}/${process.env.VERCEL_GIT_REPO_SLUG}`
      : null);
  if (!token || !repo) {
    res.status(503).json({ error: 'not_configured' });
    return;
  }

  const ref = process.env.ARCHIVE_REF || DEFAULT_REF;
  const url = `https://api.github.com/repos/${repo}/contents/docs/data/web/${path}?ref=${encodeURIComponent(ref)}`;

  let gh;
  try {
    gh = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.raw',
        'User-Agent': 'webdash-archive',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch {
    res.status(502).json({ error: 'upstream_unreachable' });
    return;
  }

  if (gh.status === 404) {
    // Normal: un mes sin pedidos para esa tienda no tiene archivo. El cliente
    // ya trata esto como "sin datos" en vez de como un error.
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (!gh.ok || !gh.body) {
    res.status(502).json({ error: 'upstream_error', status: gh.status });
    return;
  }

  // Se comprime al pasar en vez de bufferear: así el tamaño del archivo no
  // choca contra el límite de respuesta de una función serverless, y de paso
  // un JSON de pedidos baja ~4x en la red.
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Encoding', 'gzip');
  res.setHeader('Cache-Control', cacheControl(path));

  const gz = createGzip();
  gz.pipe(res);
  Readable.fromWeb(gh.body).pipe(gz);
}

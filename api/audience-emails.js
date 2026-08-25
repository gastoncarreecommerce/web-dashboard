/**
 * GET /api/audience-emails — devuelve el mapeo hash → email,dni para el
 * constructor de audiencias.
 *
 * Los emails NO viven en este repo (que puede ser público) ni en el bundle del
 * sitio: viven en un repo privado aparte. Esta función los busca con un token
 * que existe solo como env var en Vercel — nunca llega al navegador — y los
 * devuelve únicamente a alguien con sesión válida.
 *
 * El mapeo completo de VTEX Master Data pesa ~500MB (5,1M de clientes); una
 * función de Vercel no puede devolver más de ~4,5MB. Por eso el repo privado
 * guarda, además de la base completa, un juego aparte en audiencias/NN.csv
 * con SOLO los clientes que aparecen en el índice de audiencias (los que
 * tienen pedidos) — es lo único que el dashboard puede llegar a pedir, y
 * junto entero pesa unos pocos MB. Ver src/shard-emails.js.
 *
 * Env vars en Vercel:
 *   PRIVATE_DATA_REPO   owner/repo del repositorio privado (ej. carrefour/webdash-private)
 *   PRIVATE_DATA_TOKEN  PAT de GitHub con permiso de LECTURA de contenidos SOLO en ese repo
 *   PRIVATE_DATA_PATH   (opcional) carpeta con los pedazos, default 'audiencias'
 *   PRIVATE_DATA_REF    (opcional) rama, default 'main'
 */
import { verifySession } from './_session.js';

async function ghFetch(url, token) {
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.raw',
      'User-Agent': 'webdash',
    },
  });
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });

  if (!verifySession(req)) return res.status(401).json({ error: 'No autenticado' });

  const repo = process.env.PRIVATE_DATA_REPO;
  const token = process.env.PRIVATE_DATA_TOKEN;
  if (!repo || !token) {
    // No es un error: simplemente todavía no se conectó el repo privado. El
    // frontend cae al modo manual (cargar el CSV a mano) sin romperse.
    return res.status(404).json({ error: 'not_configured', message: 'El repo privado de emails no está configurado.' });
  }

  const dir = process.env.PRIVATE_DATA_PATH || 'audiencias';
  const ref = process.env.PRIVATE_DATA_REF || 'main';

  try {
    // 1) Qué pedazos hay — el manifest evita listar el directorio (una
    //    llamada menos a la API, que tiene límite de rate).
    const manifestRes = await ghFetch(
      `https://api.github.com/repos/${repo}/contents/${dir}/manifest.json?ref=${encodeURIComponent(ref)}`,
      token
    );
    if (manifestRes.status === 404) {
      return res.status(404).json({ error: 'not_found', message: `No se encontró ${dir}/manifest.json en ${repo} (rama ${ref}). ¿Corrió ya el sync?` });
    }
    if (!manifestRes.ok) {
      return res.status(502).json({ error: 'github_error', message: `GitHub respondió ${manifestRes.status} al leer el manifest.` });
    }
    const manifest = JSON.parse(await manifestRes.text());

    // 2) Bajar todos los pedazos en paralelo y concatenarlos. Cada uno trae
    //    su propio encabezado "hash,email,dni"; se descarta menos el primero.
    const bodies = await Promise.all(
      manifest.shards.map(async (shard) => {
        const r = await ghFetch(
          `https://api.github.com/repos/${repo}/contents/${dir}/${shard}.csv?ref=${encodeURIComponent(ref)}`,
          token
        );
        if (!r.ok) throw new Error(`pedazo ${shard} respondió ${r.status}`);
        return r.text();
      })
    );

    const csv = bodies
      .map((body, i) => (i === 0 ? body : body.replace(/^[^\n]*\n/, '')))
      .join('');

    // Nunca cachear PII en el CDN ni en el navegador.
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return res.status(200).send(csv);
  } catch (e) {
    return res.status(502).json({ error: 'fetch_failed', message: e.message });
  }
}

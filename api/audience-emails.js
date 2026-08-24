/**
 * GET /api/audience-emails — devuelve el mapeo hash → email para el constructor
 * de audiencias.
 *
 * Los emails NO viven en este repo (que puede ser público) ni en el bundle del
 * sitio: viven en un repo privado aparte. Esta función los busca con un token
 * que existe solo como env var en Vercel — nunca llega al navegador — y los
 * devuelve únicamente a alguien con sesión válida.
 *
 * Env vars en Vercel:
 *   PRIVATE_DATA_REPO   owner/repo del repositorio privado (ej. carrefour/webdash-private)
 *   PRIVATE_DATA_TOKEN  PAT de GitHub con permiso de LECTURA de contenidos SOLO en ese repo
 *   PRIVATE_DATA_PATH   (opcional) ruta del archivo, default 'hash-email.csv'
 *   PRIVATE_DATA_REF    (opcional) rama, default 'main'
 */
import { verifySession } from './_session.js';

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

  const path = process.env.PRIVATE_DATA_PATH || 'hash-email.csv';
  const ref = process.env.PRIVATE_DATA_REF || 'main';
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`;

  try {
    const gh = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.raw',
        'User-Agent': 'webdash',
      },
    });

    if (gh.status === 404) {
      return res.status(404).json({ error: 'not_found', message: `No se encontró ${path} en ${repo} (rama ${ref}).` });
    }
    if (!gh.ok) {
      return res.status(502).json({ error: 'github_error', message: `GitHub respondió ${gh.status}. Revisá el token y sus permisos.` });
    }

    const body = await gh.text();
    // Nunca cachear PII en el CDN ni en el navegador.
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return res.status(200).send(body);
  } catch (e) {
    return res.status(502).json({ error: 'fetch_failed', message: e.message });
  }
}

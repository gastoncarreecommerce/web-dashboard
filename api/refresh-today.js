/**
 * POST /api/refresh-today — dispara AHORA el workflow "WebDash hoy en vivo"
 * (.github/workflows/webdash-live.yml) en vez de esperar a que le toque el
 * turno del cron de cada 30 min.
 *
 * Por qué el navegador no le pega directo a VTEX: las credenciales de VTEX
 * (VTEX_APP_KEY/VTEX_APP_TOKEN) son secrets de GitHub Actions — exponerlas acá
 * significaría mandarlas al navegador de cualquiera que abra el dashboard.
 * En cambio, esta función usa un token de GitHub (con permiso SOLO de
 * disparar workflows de ESTE repo, nada de leer/escribir código) para pedirle
 * a Actions que corra el mismo fetch-day.js + aggregate.js + commit que ya
 * corre solo cada 30 min. Como ese workflow empuja el commit a la rama que
 * sirve Vercel, el resultado queda guardado para todos los que entren
 * después — no hace falta que cada uno dispare su propia corrida.
 *
 * Es async de verdad: esto solo empieza la corrida, no espera a que termine
 * (fetch-day.js puede tardar unos minutos según cuántos pedidos lleve el día).
 * El frontend avisa que se está actualizando y el usuario ve el resultado
 * cuando refresque en un rato — no hay forma de "esperar" sin bloquear la
 * función mucho más de lo que Vercel permite.
 *
 * Env vars en Vercel:
 *   WORKFLOW_DISPATCH_TOKEN  PAT de GitHub (fine-grained) con permiso
 *     "Actions: read and write" SOLO en gastoncarreecommerce/web-dashboard.
 *     No necesita ningún otro permiso — no toca código ni otros repos.
 */
import { verifySession } from './_session.js';

const OWNER = 'gastoncarreecommerce';
const REPO = 'web-dashboard';
const WORKFLOW_FILE = 'webdash-live.yml';
const BRANCH = 'claude/carrefour-webdash-analytics-xojjfs';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });
  if (!verifySession(req)) return res.status(401).json({ error: 'No autenticado' });

  const token = process.env.WORKFLOW_DISPATCH_TOKEN;
  if (!token) {
    console.error('refresh-today: falta WORKFLOW_DISPATCH_TOKEN en las env vars de Vercel');
    return res.status(404).json({ error: 'not_configured' });
  }

  try {
    const r = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'webdash',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: BRANCH }),
      }
    );

    // GitHub responde 204 sin cuerpo cuando el dispatch se aceptó.
    if (r.status === 204) {
      return res.status(202).json({ ok: true });
    }
    // El detalle técnico queda en el log del servidor; al usuario nunca le
    // sirve ver "GitHub respondió 403: ..." — solo lo confunde.
    const body = await r.text().catch(() => '');
    console.error(`refresh-today: GitHub respondió ${r.status}: ${body.slice(0, 300)}`);
    return res.status(502).json({ error: 'upstream_error' });
  } catch (e) {
    console.error('refresh-today: fetch_failed', e);
    return res.status(502).json({ error: 'upstream_error' });
  }
}

/**
 * /api/campaigns — campañas de Audiencias, compartidas por todo el equipo.
 *
 * Una campaña es una audiencia "congelada" en el momento de mandarla, partida
 * en dos: el grupo TRATADO (a quien se le manda) y un grupo de CONTROL (una
 * parte al azar que se deja afuera a propósito). El dashboard después compara
 * cuánto compró cada grupo desde la fecha de envío: la diferencia es lo que
 * la campaña generó de verdad, no lo que igual iba a pasar.
 *
 * Se guarda en el mismo Redis (Upstash) que usa "Hoy en vivo". Los integrantes
 * van como hash de cliente TRUNCADO a 12 caracteres (48 bits — sin mails ni
 * DNI, y con colisiones despreciables para 265 mil clientes), concatenados y
 * partidos en pedazos para no chocar contra el límite de tamaño por request.
 *
 *   GET    /api/campaigns                  lista (sin integrantes)
 *   GET    /api/campaigns?id=X             integrantes: { t: "hhhh…", c: "hhhh…" }
 *   POST   /api/campaigns                  crea: { name, sendDate, rules, ruleLabels, channel, controlPct, nT, nC } → { id }
 *   PUT    /api/campaigns?id=X&g=t|c&k=N   sube el pedazo N de un grupo (texto plano)
 *   DELETE /api/campaigns?id=X             borra
 */
import { verifySession } from './_session.js';
import { getRedis } from './_live-cache.js';

const INDEX = 'webdash:campaigns:v1';
const memberKey = (id, g, k) => `webdash:campaign:v1:${id}:${g}:${k}`;
const ID_RE = /^[a-z0-9]{6,24}$/;
const CHUNK_RE = /^[0-9a-f]*$/;
const MAX_CHUNK = 12 * 40000; // 40 mil clientes por pedazo (~480 KB)

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    return typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);
  }
  let data = '';
  for await (const chunk of req) data += chunk;
  return data;
}

async function list(redis) {
  const raw = await redis.get(INDEX);
  if (!raw) return [];
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

export default async function handler(req, res) {
  const session = verifySession(req);
  if (!session) return res.status(401).json({ error: 'No autenticado' });
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: 'not_configured' });

  const id = String(req.query?.id || '');
  if (id && !ID_RE.test(id)) return res.status(400).json({ error: 'bad_id' });

  try {
    if (req.method === 'GET' && !id) {
      return res.status(200).json({ campaigns: await list(redis) });
    }

    if (req.method === 'GET' && id) {
      const c = (await list(redis)).find((x) => x.id === id);
      if (!c) return res.status(404).json({ error: 'not_found' });
      const out = {};
      for (const g of ['t', 'c']) {
        const keys = Array.from({ length: c.chunks?.[g] || 0 }, (_, k) => memberKey(id, g, k));
        const parts = keys.length ? await redis.mget(...keys) : [];
        out[g] = parts.map((p) => p || '').join('');
      }
      return res.status(200).json(out);
    }

    if (req.method === 'POST') {
      const b = JSON.parse(await readBody(req) || '{}');
      const name = String(b.name || '').trim().slice(0, 120);
      const sendDate = String(b.sendDate || '');
      if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(sendDate)) return res.status(400).json({ error: 'bad_request' });
      const newId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const nT = Math.max(0, Number(b.nT) || 0), nC = Math.max(0, Number(b.nC) || 0);
      const camp = {
        id: newId, name, sendDate,
        createdAt: new Date().toISOString(),
        createdBy: session.username || '',
        channel: String(b.channel || '').slice(0, 40),
        controlPct: Math.min(50, Math.max(0, Number(b.controlPct) || 0)),
        rules: Array.isArray(b.rules) ? b.rules.slice(0, 30) : [],
        ruleLabels: Array.isArray(b.ruleLabels) ? b.ruleLabels.slice(0, 30).map((x) => String(x).slice(0, 200)) : [],
        incentive: String(b.incentive || '').slice(0, 60),
        nT, nC,
        pvT: Number.isFinite(Number(b.pvT)) && b.pvT !== null ? Math.round(Number(b.pvT)) : null,
        chunks: { t: Math.ceil((nT * 12) / MAX_CHUNK), c: Math.ceil((nC * 12) / MAX_CHUNK) },
        complete: false,
      };
      const all = await list(redis);
      all.unshift(camp);
      await redis.set(INDEX, JSON.stringify(all.slice(0, 200)));
      return res.status(200).json({ id: newId, chunks: camp.chunks });
    }

    if (req.method === 'PUT' && id) {
      const g = String(req.query?.g || '');
      const k = Number(req.query?.k);
      if (!['t', 'c'].includes(g) || !Number.isInteger(k) || k < 0) return res.status(400).json({ error: 'bad_request' });
      const all = await list(redis);
      const c = all.find((x) => x.id === id);
      if (!c) return res.status(404).json({ error: 'not_found' });
      if (k >= (c.chunks?.[g] || 0)) return res.status(400).json({ error: 'bad_chunk' });
      const body = (await readBody(req)).trim();
      if (!CHUNK_RE.test(body) || body.length % 12 || body.length > MAX_CHUNK) return res.status(400).json({ error: 'bad_chunk_body' });
      await redis.set(memberKey(id, g, k), body);
      // Se marca completa cuando llega el último pedazo del control (el
      // cliente sube primero el tratado y después el control, en orden).
      const last = g === 'c' ? k === c.chunks.c - 1 : c.chunks.c === 0 && k === c.chunks.t - 1;
      if (last && !c.complete) {
        c.complete = true;
        await redis.set(INDEX, JSON.stringify(all));
      }
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE' && id) {
      const all = await list(redis);
      const c = all.find((x) => x.id === id);
      if (!c) return res.status(404).json({ error: 'not_found' });
      const keys = [];
      for (const g of ['t', 'c']) for (let k = 0; k < (c.chunks?.[g] || 0); k++) keys.push(memberKey(id, g, k));
      if (keys.length) await redis.del(...keys);
      await redis.set(INDEX, JSON.stringify(all.filter((x) => x.id !== id)));
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Método no permitido' });
  } catch (e) {
    console.error('campaigns:', e);
    return res.status(500).json({ error: 'server_error' });
  }
}

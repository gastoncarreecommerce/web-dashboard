/**
 * POST /api/sfmc-contacts  { dnis: ["12345678", …] }  (hasta 500 por pedido)
 *   → { results: [{ dni, email, status }], notFound: [dni], invalid: [texto] }
 *
 * Busca en Salesforce Marketing Cloud el mail asociado a cada DNI. En esta
 * cuenta la Clave del Suscriptor (SubscriberKey) ES el DNI (así lo declara la
 * ficha de BaseMaestra_Ecommerce: "DNI__c se refiere al suscriptor de Clave
 * del suscriptor"), así que alcanza con un Retrieve SOAP del objeto
 * Subscriber filtrando por SubscriberKey — agrupado de a 25 DNIs por llamada
 * (filtro OR anidado), igual que la auditoría de SFMC.
 *
 * Devuelve datos personales: solo lo pueden usar los administradores y
 * quienes tengan habilitado el módulo "Contactos SFMC" en Accesos (se chequea
 * acá, además del middleware). Cada consulta queda registrada (quién, cuándo,
 * cuántos DNIs) — nunca se guardan los DNIs ni los mails.
 *
 * Env vars en Vercel (las mismas del Installed Package de la auditoría):
 *   SFMC_CLIENT_ID, SFMC_CLIENT_SECRET, SFMC_SUBDOMAIN, SFMC_PARENT_ACCOUNT_ID
 */
import { verifySession } from './_session.js';
import { readAccess, viewsFor } from './_access.js';
import { getRedis } from './_live-cache.js';

const MAX_DNIS = 500;
const BATCH = 25;
const CONCURRENCY = 6;
const AUDIT_KEY = 'webdash:audit:sfmc-contacts';

let token = null, tokenExp = 0;

function cfg() {
  const { SFMC_CLIENT_ID, SFMC_CLIENT_SECRET, SFMC_SUBDOMAIN, SFMC_PARENT_ACCOUNT_ID } = process.env;
  const faltan = ['SFMC_CLIENT_ID', 'SFMC_CLIENT_SECRET', 'SFMC_SUBDOMAIN'].filter((k) => !process.env[k]);
  return { id: SFMC_CLIENT_ID, secret: SFMC_CLIENT_SECRET, sub: SFMC_SUBDOMAIN, mid: SFMC_PARENT_ACCOUNT_ID, faltan };
}

async function getToken(c) {
  if (token && Date.now() < tokenExp - 60000) return token;
  const body = { grant_type: 'client_credentials', client_id: c.id, client_secret: c.secret };
  if (c.mid) body.account_id = c.mid;
  const r = await fetch(`https://${c.sub}.auth.marketingcloudapis.com/v2/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`autenticación con Marketing Cloud falló (${r.status})`);
  const j = JSON.parse(t);
  token = j.access_token;
  tokenExp = Date.now() + (j.expires_in || 1200) * 1000;
  return token;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const leaf = (v) => `<Property>SubscriberKey</Property><SimpleOperator>equals</SimpleOperator><Value>${esc(v)}</Value>`;
// Filtro OR anidado: (a OR (b OR (c …))).
function orInner(values) {
  if (values.length === 1) return leaf(values[0]);
  const [first, ...rest] = values;
  return `<LeftOperand xsi:type="SimpleFilterPart">${leaf(first)}</LeftOperand><LogicalOperator>OR</LogicalOperator>`
    + `<RightOperand xsi:type="${rest.length === 1 ? 'SimpleFilterPart' : 'ComplexFilterPart'}">${orInner(rest)}</RightOperand>`;
}
const filterXml = (values) => `<Filter xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="${values.length === 1 ? 'SimpleFilterPart' : 'ComplexFilterPart'}">${orInner(values)}</Filter>`;

// Parser mínimo del SOAP de respuesta (sin dependencias): solo lo que se usa.
const tag = (xml, name) => { const m = xml.match(new RegExp(`<(?:\\w+:)?${name}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`)); return m ? m[1] : null; };
const unesc = (s) => (s == null ? s : s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'));

async function soap(c, inner, action) {
  const tk = await getToken(c);
  const xml = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">`
    + `<soapenv:Header><fueloauth xmlns="http://exacttarget.com">${tk}</fueloauth></soapenv:Header><soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`;
  const r = await fetch(`https://${c.sub}.soap.marketingcloudapis.com/Service.asmx`, {
    method: 'POST', headers: { 'Content-Type': 'text/xml', SOAPAction: action }, body: xml,
  });
  const t = await r.text();
  if (!r.ok || /<(?:\w+:)?Fault>/.test(t)) throw new Error(`Marketing Cloud respondió con error (${r.status}): ${unesc(tag(t, 'faultstring')) || ''}`.trim());
  return t;
}

async function lookupBatch(c, dnis) {
  const props = ['SubscriberKey', 'EmailAddress', 'Status'].map((p) => `<Properties>${p}</Properties>`).join('');
  let out = [];
  let reqId = null;
  for (let guard = 0; guard < 20; guard++) {
    const body = reqId
      ? `<RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI"><RetrieveRequest><ContinueRequest>${reqId}</ContinueRequest></RetrieveRequest></RetrieveRequestMsg>`
      : `<RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI"><RetrieveRequest><ObjectType>Subscriber</ObjectType>${props}${filterXml(dnis)}</RetrieveRequest></RetrieveRequestMsg>`;
    const xml = await soap(c, body, 'Retrieve');
    const results = xml.match(/<(?:\w+:)?Results[^>]*>[\s\S]*?<\/(?:\w+:)?Results>/g) || [];
    out = out.concat(results.map((r) => ({
      key: unesc(tag(r, 'SubscriberKey')), email: unesc(tag(r, 'EmailAddress')), status: unesc(tag(r, 'Status')),
    })));
    if (tag(xml, 'OverallStatus') !== 'MoreDataAvailable') break;
    reqId = tag(xml, 'RequestID');
  }
  return out;
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
  let d = '';
  for await (const ch of req) d += ch;
  return JSON.parse(d || '{}');
}

export default async function handler(req, res) {
  const s = verifySession(req);
  if (!s) return res.status(401).json({ error: 'No autenticado' });
  let access = null;
  try { access = await readAccess(); } catch { /* sin Redis: solo admins (ver viewsFor) */ }
  if (!viewsFor(s.username, access).includes('contactos')) {
    return res.status(403).json({ error: 'Este módulo no está habilitado para tu usuario.' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const c = cfg();
  if (c.faltan.length) return res.status(503).json({ error: 'not_configured', faltan: c.faltan });

  let body;
  try { body = await readBody(req); } catch { return res.status(400).json({ error: 'bad_request' }); }
  const raw = Array.isArray(body.dnis) ? body.dnis.slice(0, MAX_DNIS + 1) : [];
  if (raw.length > MAX_DNIS) return res.status(400).json({ error: `Máximo ${MAX_DNIS} DNIs por pedido.` });

  const invalid = [];
  const dnis = [];
  const seen = new Set();
  for (const x of raw) {
    const d = String(x ?? '').replace(/\D/g, '').replace(/^0+/, '');
    if (d.length < 6 || d.length > 9) { if (String(x ?? '').trim()) invalid.push(String(x).slice(0, 40)); continue; }
    if (!seen.has(d)) { seen.add(d); dnis.push(d); }
  }

  const batches = [];
  for (let i = 0; i < dnis.length; i += BATCH) batches.push(dnis.slice(i, i + BATCH));
  const found = new Map();
  try {
    let next = 0;
    const worker = async () => {
      while (next < batches.length) {
        const b = batches[next++];
        for (const r of await lookupBatch(c, b)) {
          if (!r.key) continue;
          const k = String(r.key).replace(/\D/g, '').replace(/^0+/, '');
          if (!found.has(k)) found.set(k, []);
          if (r.email) found.get(k).push({ email: r.email.trim(), status: r.status || '' });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
  } catch (e) {
    console.error('sfmc-contacts:', e.message);
    return res.status(502).json({ error: e.message });
  }

  const results = [];
  const notFound = [];
  for (const d of dnis) {
    const list = found.get(d) || [];
    if (!list.length) { notFound.push(d); continue; }
    for (const x of list) results.push({ dni: d, email: x.email, status: x.status });
  }

  // Registro de auditoría: quién, cuándo y cuántos. Sin DNIs ni mails.
  const entry = { u: s.username, at: new Date().toISOString(), n: dnis.length, found: dnis.length - notFound.length };
  console.log('sfmc-contacts', JSON.stringify(entry));
  try {
    const redis = getRedis();
    if (redis) { await redis.lpush(AUDIT_KEY, JSON.stringify(entry)); await redis.ltrim(AUDIT_KEY, 0, 999); }
  } catch { /* el registro no frena la consulta */ }

  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json({ results, notFound, invalid });
}

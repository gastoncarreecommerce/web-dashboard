/**
 * Helpers compartidos para "Hoy en vivo": el cache incremental en Redis
 * (Upstash) y la lógica de clasificación de canal, reutilizadas por
 * api/today-live.js. No es una ruta — no exporta un handler default,
 * Vercel no la trata como endpoint.
 *
 * Por qué Redis y no re-pedirle todo a VTEX en cada consulta: WebDash es el
 * canal WEB, el mayoritario — a diferencia de un dashboard que solo mira un
 * puñado curado de vendedores, acá "hoy" puede tener miles de pedidos. Si
 * cada poll (cada 15s mientras la pantalla está abierta) le pidiera a VTEX
 * el detalle de TODOS de nuevo para saber cuáles son web, sería carísimo y
 * cada vez más lento según avanza el día. Este cache guarda, pedido por
 * pedido, si ya se sabe su canal — así cada poll solo pide detalle de los
 * pedidos NUEVOS desde la última vez (normalmente unos pocos).
 *
 * Env vars en Vercel (agregar el storage "Upstash for Redis" desde Vercel
 * las carga solas, no hace falta escribirlas a mano):
 *   KV_REST_API_URL / KV_REST_API_TOKEN            (nombre histórico de Vercel KV)
 *   o UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (nombre nativo de Upstash)
 */
import { Redis } from '@upstash/redis';
import fs from 'fs';
import path from 'path';

let redisClient;
export function getRedis() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  // responseEncoding:false — el default (base64) es innecesario acá: solo
  // guardamos JSON de texto plano (nada binario), y así el wire format es
  // más simple de razonar/depurar.
  if (!redisClient) redisClient = new Redis({ url, token, responseEncoding: false });
  return redisClient;
}

let _channelMap;
export function getChannelMap() {
  if (!_channelMap) {
    _channelMap = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config', 'channel-map.json'), 'utf8'));
  }
  return _channelMap;
}

let _statusFilter;
export function getStatusFilter() {
  if (!_statusFilter) {
    _statusFilter = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config', 'status-filter.json'), 'utf8'));
  }
  return _statusFilter;
}

/** Misma regla que src/classify.js#orderChannel — duplicada a propósito para
 * no depender de un require() cruzado entre CJS (src/) y ESM (api/). */
export function orderChannel(order, channelMap) {
  const { appId, fieldName } = channelMap.customAppsField;
  const apps = order.customData?.customApps || [];
  const app = apps.find((a) => a.id === appId);
  const raw = app?.fields?.[fieldName];
  const value = raw == null ? null : String(raw).trim();
  return value === channelMap.appValue ? 'app' : 'web';
}

export function vtexBaseUrl() {
  const account = process.env.VTEX_ACCOUNT_NAME;
  const environment = process.env.VTEX_ENVIRONMENT || 'vtexcommercestable';
  return `https://${account}.${environment}.com.br`;
}

export function vtexHeaders() {
  return {
    'X-VTEX-API-AppKey': process.env.VTEX_APP_KEY,
    'X-VTEX-API-AppToken': process.env.VTEX_APP_TOKEN,
    Accept: 'application/json',
  };
}

export async function vtexGetOrder(orderId) {
  const res = await fetch(`${vtexBaseUrl()}/api/oms/pvt/orders/${encodeURIComponent(orderId)}`, {
    headers: vtexHeaders(),
  });
  if (!res.ok) throw new Error(`VTEX ${res.status} pidiendo el pedido ${orderId}`);
  return res.json();
}

export function todayAR() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function cacheKey(dateAR) {
  return `webdash:live:${dateAR}`;
}

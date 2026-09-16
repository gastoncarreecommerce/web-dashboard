/**
 * Helpers compartidos para "Hoy en vivo": el cache incremental en Redis
 * (Upstash), usado por api/today-live.js.
 *
 * La clasificación de cada pedido (canal, segmento, categorías, provincia,
 * tienda, medios de pago, etc.) NO se duplica acá — se importa directo de
 * src/fetch-day.js (newDayAcc/applyOrderToAcc/finalizeDay), que es exactamente
 * la misma función que usa el pipeline por lotes. Es un módulo CJS puro (sin
 * I/O propio más allá de leer config/*.json), y Node permite importar un
 * módulo CommonJS desde un archivo ESM sin problema — se probó explícitamente
 * antes de este cambio. Así "hoy en vivo" y el histórico committeado nunca
 * pueden desviarse en cómo cuentan un pedido.
 *
 * Por qué Redis y no re-pedirle todo a VTEX en cada consulta: WebDash es el
 * canal WEB, el mayoritario — a diferencia de un dashboard que solo mira un
 * puñado curado de vendedores, acá "hoy" puede tener miles de pedidos. Si
 * cada poll (cada 15s mientras la pantalla está abierta) le pidiera a VTEX
 * el detalle de TODOS de nuevo, sería carísimo y cada vez más lento según
 * avanza el día. Este cache guarda, pedido por pedido, el JSON completo que
 * devuelve VTEX — así cada poll solo pide detalle de los pedidos NUEVOS desde
 * la última vez (normalmente unos pocos), y el resto se relee del cache para
 * reconstruir el acumulado del día completo.
 *
 * Env vars en Vercel (agregar el storage "Upstash for Redis" desde Vercel las
 * carga solas, no hace falta escribirlas a mano):
 *   KV_REST_API_URL / KV_REST_API_TOKEN            (nombre histórico de Vercel KV)
 *   o UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (nombre nativo de Upstash)
 */
import { Redis } from '@upstash/redis';

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

// v2: los deltas ahora guardan el canal del pedido. Los de v1 no lo tenian y
// los de app venian vacios (bucket:null), asi que reusar la misma key dejaria
// "hoy" sin los pedidos de app ya cacheados hasta el dia siguiente.
export function cacheKey(dateAR) {
  return `webdash:live:v2:${dateAR}`;
}

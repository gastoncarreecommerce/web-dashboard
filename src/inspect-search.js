'use strict';

/**
 * Herramienta de investigación (no forma parte del pipeline productivo).
 *
 * Objetivo: averiguar de dónde se puede sacar información real del
 * buscador del sitio web (qué busca la gente, qué búsquedas no traen
 * resultados) para el módulo "Buscador" — antes de construir nada, porque
 * la API de Intelligent Search de VTEX solo EJECUTA una búsqueda que ya le
 * pedís, no informa qué buscó la gente en el pasado. Ese dato solo puede
 * salir de un tracking del lado del sitio (típicamente GA4).
 *
 * Este script NO asume que el tracking existe: prueba en orden y reporta
 * qué encontró en cada paso, para decidir con datos reales en vez de
 * adivinar.
 *   1) Lista TODOS los eventos de GA4 de los últimos 30 días (volumen por
 *      evento) — para ver si existe algo tipo "view_search_results"/"search"
 *      y cuánto volumen tiene.
 *   2) Si existe, intenta traer el TÉRMINO buscado en dos variantes de
 *      nombre de dimensión (GA4 solo permite desglosar por un parámetro de
 *      evento si alguien lo registró como "custom dimension" en el admin de
 *      la property — puede que el evento exista pero el término no sea
 *      consultable todavía).
 *
 * Uso: GOOGLE_SERVICE_ACCOUNT=<json> GA4_PROPERTY_ID=<id> node src/inspect-search.js
 *
 * Env:
 *   GOOGLE_SERVICE_ACCOUNT  JSON del service account con acceso Viewer a la
 *                           property de GA4 del SITIO WEB (no la de la app —
 *                           puede ser una property distinta).
 *   GA4_PROPERTY_ID         ID numérico de esa property.
 */
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const DAYS = Number(process.env.INSPECT_SEARCH_DAYS || 30);
const OUT_PATH = path.join(__dirname, '..', 'config', 'search-inspect.report.json');

async function runReport(analyticsdata, propertyId, body) {
  return analyticsdata.properties.runReport({ property: `properties/${propertyId}`, requestBody: body });
}

async function main() {
  const propertyId = process.env.GA4_PROPERTY_ID;
  if (!process.env.GOOGLE_SERVICE_ACCOUNT || !propertyId) {
    console.log('⚠ Faltan GOOGLE_SERVICE_ACCOUNT y/o GA4_PROPERTY_ID — no se puede inspeccionar GA4. Salgo sin error.');
    return;
  }

  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/analytics.readonly'] });
  const analyticsdata = google.analyticsdata({ version: 'v1beta', auth });

  const dateRange = { startDate: `${DAYS}daysAgo`, endDate: 'yesterday' };
  const report = { propertyId, days: DAYS, generatedAt: new Date().toISOString() };

  // ── Paso 1: censo de eventos ─────────────────────────────────────────────
  console.log(`\n1) Eventos de la property ${propertyId}, últimos ${DAYS} días...`);
  const eventsRes = await runReport(analyticsdata, propertyId, {
    dateRanges: [dateRange],
    dimensions: [{ name: 'eventName' }],
    metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
    limit: '1000',
    orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
  }).catch((e) => ({ error: e.message }));

  if (eventsRes.error) {
    report.eventsError = eventsRes.error;
    console.log('  ✗ No se pudo consultar eventos:', eventsRes.error);
  } else {
    const events = (eventsRes.data.rows || []).map((r) => ({
      event: r.dimensionValues[0].value,
      count: Number(r.metricValues[0].value),
      users: Number(r.metricValues[1].value),
    }));
    report.events = events;
    console.log(`  ${events.length} eventos distintos encontrados. Top 15 por volumen:`);
    for (const e of events.slice(0, 15)) console.log(`    ${e.event.padEnd(30)} ${e.count} eventos · ${e.users} usuarios`);

    const searchEventNames = events.filter((e) => /search/i.test(e.event)).map((e) => e.event);
    report.searchEventNames = searchEventNames;
    if (!searchEventNames.length) {
      console.log('\n  ⚠ Ningún evento con "search" en el nombre. El buscador del sitio no parece estar trackeado en GA4 todavía.');
    } else {
      console.log(`\n  ✓ Eventos relacionados a búsqueda: ${searchEventNames.join(', ')}`);
    }

    // ── Paso 2: intentar el término buscado ────────────────────────────────
    // Solo para "search": ya confirmamos en una corrida anterior que
    // "view_search_results" guarda RUTAS DE CATEGORÍA en ese campo (navegar
    // por categorías), no texto libre tipeado — no sirve para este
    // diagnóstico. Traer un TOP grande (no solo 30): los problemas reales
    // del buscador (términos sin resultados, mal escritos, marcas
    // específicas) están en la cola larga, no en los términos genéricos más
    // buscados — esos casi nunca fallan.
    const TERM_LIMIT = Number(process.env.INSPECT_SEARCH_TERM_LIMIT || 1000);
    report.searchTermAttempts = [];
    for (const eventName of searchEventNames.filter((n) => n === 'search')) {
      for (const dim of ['searchTerm', 'customEvent:search_term']) {
        console.log(`\n2) Intentando desglosar "${eventName}" por dimensión "${dim}" (hasta ${TERM_LIMIT} términos)...`);
        const res = await runReport(analyticsdata, propertyId, {
          dateRanges: [dateRange],
          dimensions: [{ name: dim }],
          metrics: [{ name: 'eventCount' }],
          dimensionFilter: { filter: { fieldName: 'eventName', stringFilter: { value: eventName } } },
          orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
          limit: String(TERM_LIMIT),
        }).catch((e) => ({ error: e.message }));

        if (res.error) {
          console.log(`  ✗ ${dim} no funcionó: ${res.error}`);
          report.searchTermAttempts.push({ eventName, dim, ok: false, error: res.error });
          continue;
        }
        const rows = (res.data.rows || []).map((r) => ({ term: r.dimensionValues[0].value, count: Number(r.metricValues[0].value) }));
        console.log(`  ✓ ${dim} funcionó — ${rows.length} términos distintos. Top 10:`);
        for (const r of rows.slice(0, 10)) console.log(`    "${r.term}" — ${r.count}`);
        report.searchTermAttempts.push({ eventName, dim, ok: true, sample: rows });
      }
    }
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
  console.log(`\nReporte guardado en ${path.relative(process.cwd(), OUT_PATH)}`);
}

main().catch((err) => {
  console.error('inspect-search falló:', err.message);
  process.exit(1);
});

# WebDash — Analytics de pedidos canal WEB (Carrefour Argentina)

Contraparte de **AppDash** (repo `gastoncarreecommerce/vtex-utm-audit`, rama `main`), mismo stack:
GitHub Actions (pipeline de datos) + VTEX Order API como fuente + hosting estático (Vercel /
GitHub Pages). Filtra el canal **web** (todo lo que NO sea `from=app`) y segmenta en **Food**,
**Non Food**, **Marketplace** y **Quick Commerce**, replicando la clasificación real de AppDash.

## Las tres vistas

| Vista | Qué resuelve |
|---|---|
| **Dashboard** | Resumen ejecutivo: KPIs con sparkline y variación vs. período anterior, pedidos por día con media móvil y línea de tendencia, proyección de cierre de mes, mix de GMV por segmento, heatmap día×hora, fuentes de marketing, y un panel de **insights automáticos** que traduce los números a "qué mejorar". |
| **Analítica** | Detalle: comparativa de los 4 segmentos, ranking de productos (con buscador), categorías, cupones, medios de pago, **retención por cohorte mensual**, distribución horaria y por día de semana. |
| **Audiencias** | **Constructor de segmentaciones**: combinás condiciones (categoría dominante, segmento, cantidad de pedidos, gasto, ticket, recencia, antigüedad) y obtenés el grupo de clientes en vivo, con su composición y matriz RFM. Exportás la audiencia y, cruzando el archivo privado, la **lista de mails**. |

Todos los paneles tienen exportación a **CSV** (con BOM, para que Excel respete los acentos).

## ⚠️ Cómo se manejan los emails (leer antes de tocar la parte de audiencias)

El dashboard es un sitio **público**. Si el constructor de audiencias leyera emails desde un JSON
publicado, la base de clientes quedaría expuesta a cualquiera con la URL. Por eso:

1. **Nada de lo que se publica tiene PII.** `audience-index.json` identifica a cada cliente con un
   hash SHA-256 truncado (`src/customer-key.js`), nunca con su email. Todos los paneles, conteos y
   métricas del constructor funcionan sobre esos hashes.
2. **Los emails viven fuera del sitio.** El workflow manual
   `WebDash export audiencia (PRIVADO · contiene PII)` corre `src/export-audience.js` y sube el
   mapeo `hash → email` como **artifact de GitHub Actions** — solo lo descarga quien tiene acceso
   al repo, y se borra solo a los N días.
3. **El cruce pasa en tu navegador.** En el tab Audiencias arrastrás ese CSV: se parsea local, se
   cruza contra la audiencia y se descarga la lista de mails. El archivo **no se sube a ningún
   lado** ni queda en el repo (`private-out/` está en `.gitignore`).

> Nota de costo: el email solo viene en el detalle de cada pedido, y el pipeline público a
> propósito no lo guarda. Por eso el export privado vuelve a pedirle el rango a VTEX y cuesta como
> una pasada de backfill — conviene correrlo por tramos y solo cuando vas a activar una campaña.

## Arquitectura de datos: 1 archivo por día + agregación

Con ~3.170 pedidos web/día, recalcular todo desde VTEX en cada corrida no escala. Igual que
AppDash, se guarda **un archivo por día** y se agrega encima:

1. `src/fetch-day.js` procesa un día calendario argentino: trae los pedidos, filtra canal y status,
   clasifica el segmento, y escribe `docs/data/web/daily/YYYY-MM-DD.json` con los agregados de ese
   día (GMV, pedidos, unidades, productos top, categorías, cupones, medios de pago, distribución
   horaria y perfiles de cliente hasheados). **No reprocesa un día que ya existe** → backfill y
   pipeline diario son resumibles.
2. `src/aggregate.js` suma todos los días desde `config/pipeline-config.json >
   detailWindowStartDate` (**2026-01-01**) y produce los datasets que consume el front:
   `daily-summary.json`, `catalog.json`, `cohorts.json`, `audience-index.json`,
   `<segmento>/metrics.json` y `_meta/run-info.json`.
3. `.github/workflows/webdash-pipeline.yml` corre 1×día a las 06:00 UTC (03:00 AR, igual que
   AppDash): `fetch-day` de ayer + `aggregate`.
4. `.github/workflows/webdash-backfill.yml` es manual (`from`/`to`) para completar historial en
   tandas.

### Por qué la ventana empieza en 2026-01-01

Canal, segmento, recencia y recompra necesitan el **detalle completo** de cada pedido
(`customData`, `items[].seller`, cliente) — el listado de VTEX no alcanza. Con ~3.170 pedidos
web/día, cubrir desde 2022 son 4-5 millones de pedidos a los que pedirles detalle uno por uno:
inviable (el backfill de recompra web de AppDash tardó hasta 3 horas para **20 días**). Se acordó
arrancar el 1/1/2026. Ampliar hacia atrás es correr más tandas de backfill, no rehacer nada.

### Un límite honesto de la vista Analítica

`catalog.json` (productos, categorías, cupones, medios de pago) se agrega sobre **toda la ventana**,
no día por día — guardar el catálogo diario completo haría crecer el repo sin control. Esos paneles
llevan un chip `ventana completa` y **no responden al filtro de fechas**; el resto de la vista sí.

## Decisiones heredadas de AppDash

- **Canal web/app**: `customData.customApps` con id `from-help-info`, campo `from`. La regla real es
  "todo lo que NO sea `from=app` es web" — incluye pedidos sin el campo (anteriores a la app), que
  se cuentan como web correctamente.
- **Segmentación por `seller` de VTEX**, no por categoría de producto: `carrefourar0899` = non-food,
  lista fija de sellers 3rd-party = marketplace, `salesChannel=3` = Quick Commerce, resto = food.
  Clasificación a nivel de pedido completo, sin prorrateo.
- **Cadencia**: 1×día, 06:00 UTC.

## Lo que falta confirmar

**`config/status-filter.json`** — puse una convención default razonable (excluye `canceled`,
`payment-pending`, etc.), pero no la encontré explícita en el código de AppDash. Confirmarla para
que los números sean comparables entre ambos dashboards.

## Puesta en marcha

1. Cargar los secrets del repo: `VTEX_ACCOUNT_NAME`, `VTEX_APP_KEY`, `VTEX_APP_TOKEN`
   (`VTEX_ENVIRONMENT` opcional).
2. Actions → **WebDash backfill (rango manual)** → correr en tandas de ~1 mes desde `2026-01-01`.
   Es seguro repetirlo o cortarlo: los días ya procesados no se vuelven a pedir.
3. A partir de ahí el cron diario mantiene todo al día solo.

```bash
# local
npm install    # sin dependencias externas, usa fetch nativo de Node 20+
VTEX_ACCOUNT_NAME=... VTEX_APP_KEY=... VTEX_APP_TOKEN=... node src/fetch-day.js 2026-08-24
node src/aggregate.js
npx serve docs
```

## Reusabilidad

`src/metrics.js` y `src/classify.js` no tienen nada de "canal" ni "segmento" hardcodeado: reciben
agregados y calculan. Están listos para moverse a un paquete compartido con AppDash — avisá si
querés que lo arme.

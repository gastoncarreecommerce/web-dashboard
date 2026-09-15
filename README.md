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

## 🔐 Acceso y manejo de emails (leer antes de tocar la parte de audiencias)

### El dashboard está detrás de usuario y contraseña

`middleware.js` es un **Vercel Edge Middleware**: corre en el borde **antes** de servir cualquier
archivo, así que protege también los JSON de `docs/data/**`. Esto importa: un login hecho solo en
JavaScript escondería la pantalla pero dejaría los datos descargables escribiendo la URL directa.

- `api/login.js` valida usuario + contraseña y devuelve una cookie `HttpOnly` firmada con HMAC-SHA256
  (12hs de validez). La contraseña nunca vuelve al navegador.
- Env vars necesarias en Vercel: **`DASHBOARD_PASSWORD`**, **`SESSION_SECRET`** (string largo y
  aleatorio) y, opcionalmente, **`DASHBOARD_USERS`** (usuarios habilitados, separados por coma).
- Si falta alguna de las dos primeras, el sitio devuelve 503 entero en vez de quedar abierto.
- A diferencia de AppDash, la lista de usuarios **no va hardcodeada en el código**: una lista de
  nombres de empleados también es dato personal y este repo puede ser público.

### Los emails viven en un repo privado aparte, nunca en este

Este repo puede ser público, y lo que se commitea acá queda accesible desde
`raw.githubusercontent.com` sin importar qué contraseña tenga Vercel. Por eso:

1. **Nada de lo que se publica tiene PII.** `audience-index.json` identifica a cada cliente con un
   hash SHA-256 truncado (`src/customer-key.js`). Todos los paneles, conteos y métricas del
   constructor de audiencias funcionan sobre esos hashes.
2. **El mapeo `hash → email` vive en un repositorio privado separado.** El workflow
   `WebDash export audiencia` lo genera y lo pushea ahí — y **aborta si el repo destino no figura
   como privado**, que es justamente el error que este diseño existe para evitar.
3. **El dashboard lo lee por `/api/audience-emails`**, una función serverless que guarda el token de
   GitHub del lado del servidor (nunca llega al navegador), verifica la sesión y responde
   `Cache-Control: no-store` para que la PII no quede cacheada en el CDN.
4. **Modo manual como alternativa**: si el repo privado todavía no está conectado, el workflow deja
   el CSV como artifact de Actions; lo arrastrás al tab Audiencias y el cruce ocurre entero en tu
   navegador. En ningún caso el archivo se sube al sitio.

Para conectar el repo privado, cargar estos secrets/env vars:

| Dónde | Nombre | Para qué |
|---|---|---|
| Secrets del repo (Actions) | `PRIVATE_DATA_REPO` | `owner/repo` del repositorio privado |
| Secrets del repo (Actions) | `PRIVATE_DATA_TOKEN` | PAT con **escritura** de contenidos solo en ese repo |
| Env vars de Vercel | `PRIVATE_DATA_REPO` | el mismo `owner/repo` |
| Env vars de Vercel | `PRIVATE_DATA_TOKEN` | PAT con **lectura** de contenidos solo en ese repo |
| Env vars de Vercel (opcional) | `PRIVATE_DATA_PATH` | ruta del archivo, default `hash-email.csv` |

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

### Dos ramas: qué se deploya y qué no

Los datos están repartidos en **dos ramas** a propósito, y esto es lo más importante a entender
antes de tocar el pipeline o los workflows:

| Rama | Qué tiene | Peso | La deploya Vercel |
|---|---|---|---|
| `claude/carrefour-webdash-analytics-xojjfs` | código + los agregados que el dashboard necesita al abrir la página (`daily-summary`, `catalog`, `cohorts`, `audience-index`, `geo`, `products`, `<segmento>/metrics`) | ~42 MB | **sí** |
| `data-raw` | `data/daily/` (volcados crudos de VTEX) + `docs/data/web/orders/` + `docs/data/web/order-index/` | ~2,7 GB | no |

**Por qué.** Antes todo vivía en la rama deployada: 2,7 GB que Vercel se traía completos en cada
deploy para servir 42 MB. El 98% del peso eran `orders/` y `order-index/`, que **no se leen nunca
al renderizar una vista** — solo a demanda, en el detalle de una tienda (`view-tiendas`), el
export XLSX por estado (`view-analytics`) y el drill-down de un cupón (`view-coupons`). Y encima
se reescribían enteros 10 veces por día, sumando ~500 MB diarios al repo. Resultado: deploys de
12 minutos que empeoraban solo.

Ahora ese histórico se sirve **a demanda** con `api/archive.js`, que lo lee de `data-raw` por la
API de GitHub. Costo cero: la API de GitHub es gratis y estas lecturas son esporádicas. El
cliente no cambia — `W.load()` (en `docs/core.js`) rutea solo los datasets `orders/…` y
`order-index/…` por ahí, y si el token no está configurado cae al estático de siempre.

**Env vars que necesita** (en Vercel): `ARCHIVE_REPO_TOKEN`, un PAT fine-grained de GitHub con
**solo** `Contents: read` sobre este repo. Opcionales: `ARCHIVE_REPO` (default: el repo del
deploy) y `ARCHIVE_REF` (default: `data-raw`).

**Las tres raíces del pipeline** son configurables por entorno justamente para poder escribir en
los dos checkouts distintos (ver el `env:` de los workflows):

- `WEBDASH_DAILY_DIR` — de dónde leer/escribir los volcados crudos (default: `data/daily`)
- `WEBDASH_OUT_ROOT` — raíz de los agregados chicos (default: el repo)
- `WEBDASH_ARCHIVE_ROOT` — raíz de `orders/` y `order-index/` (default: el repo)

Sin ninguna de las tres seteadas, `node src/aggregate.js` local funciona exactamente como antes.

### Por qué `orders/` se parte por mes y no por semestre

Un archivo semestral de una tienda grande llegaba a 57 MB, y para agregarle los pedidos de hoy
había que reescribirlo entero. Git no guarda "la diferencia" de un JSON de una línea: guarda un
blob nuevo completo. Partido por mes, **un mes cerrado no vuelve a cambiar nunca** → git lo guarda
una sola vez. Solo churnea el mes en curso. El formato interno sigue siendo `{ "<mes>": [pedidos] }`,
ahora con una sola clave por archivo.

### Por qué el workflow de 30 minutos ya no commitea agregados

`webdash-live.yml` corre cada 30 min pero **solo guarda el volcado crudo en `data-raw`**. Los
números de hoy en pantalla salen de `/api/today-live` (VTEX + Redis, refresco cada 15s), no de un
commit. Antes cada corrida reescribía `daily-summary.json` (20 MB) y `audience-index.json` (18 MB)
enteros y disparaba un deploy: 10 deploys por día, y como Vercel clona con `--depth=10` esos 10
commits se transferían en cada uno. Ahora el agregado corre una sola vez por día
(`webdash-pipeline.yml`) → **1 deploy por día en vez de 10**.

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

1. **Secrets del repo** (Settings → Secrets → Actions): `VTEX_ACCOUNT_NAME`, `VTEX_APP_KEY`,
   `VTEX_APP_TOKEN` (`VTEX_ENVIRONMENT` opcional).
2. **Env vars de Vercel**: `DASHBOARD_PASSWORD` y `SESSION_SECRET`. Sin esto el sitio responde 503
   a propósito, para no quedar abierto por un olvido de configuración.
3. Actions → **WebDash backfill (rango manual)** → correr en tandas de ~1 mes desde `2026-01-01`.
   Es seguro repetirlo o cortarlo: los días ya procesados no se vuelven a pedir.
4. A partir de ahí el cron diario mantiene todo al día solo.
5. Para las listas de mails: crear el repo privado y cargar los secrets/env vars de la tabla de
   arriba, después correr **WebDash export audiencia**.

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

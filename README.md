# WebDash — Analytics de pedidos canal WEB (Carrefour Argentina)

Contraparte de **AppDash** (repo `gastoncarreecommerce/vtex-utm-audit`, rama `main`), mismo stack:
GitHub Actions (pipeline de datos) + VTEX Order API como fuente + GitHub Pages como hosting
estático. Filtra por el canal **web** (todo lo que NO sea `from=app`) y separa las métricas en
4 pestañas, replicando la segmentación real de AppDash: **Food**, **Non Food**, **Marketplace**
y **Quick Commerce**.

## Arquitectura: 1 archivo por día + agregación (no ventana rolling)

El volumen real de pedidos web (~3.170/día, medido sobre datos reales de agosto 2026) hace que
recalcular todo desde VTEX en cada corrida no sea viable ni siquiera para una ventana de unos
pocos meses. Por eso, igual que AppDash, WebDash guarda **un archivo por día**:

1. `src/fetch-day.js` procesa un día calendario argentino completo: trae los pedidos de VTEX,
   filtra por canal (web) y status, clasifica cada pedido en uno de los 4 segmentos
   (`config/segment-map.json`), y escribe `docs/data/web/daily/YYYY-MM-DD.json` con los
   agregados de ese día (GMV, pedidos, unidades, clientes únicos por segmento). **No vuelve a
   pedir un día que ya tiene archivo**, así que backfill y pipeline diario son resumibles.
2. `src/aggregate.js` lee todos los días disponibles desde `config/pipeline-config.json` >
   `detailWindowStartDate` (**2026-01-01**, decidido con el usuario) hasta hoy, los suma, y
   escribe `docs/data/web/<segmento>/metrics.json` — un archivo final por pestaña que el
   dashboard consume directo.
3. `.github/workflows/webdash-pipeline.yml` corre 1 vez por día (06:00 UTC / 03:00 AR, igual que
   AppDash): `fetch-day.js` para el día de ayer + `aggregate.js`.
4. `.github/workflows/webdash-backfill.yml` es manual (`workflow_dispatch` con `from`/`to`):
   sirve para completar historial hacia atrás en tandas, igual que `backfill-web-recompra.yml`
   de AppDash. Ver "Cómo completar el historial" abajo.
5. GitHub Pages sirve `docs/` como sitio estático; `docs/app.js` lee los `metrics.json` y pinta
   las 4 pestañas. No hay backend corriendo 24/7.

### Por qué no vamos más atrás de 2026-01-01 con detalle completo

Canal, segmento, recompra y frecuencia necesitan el **detalle completo** de cada pedido
(`customData`, `items[].seller`, email del cliente) — no alcanza con el listado. Con ~3.170
pedidos web/día, cubrir desde 2022 son 4-5 millones de pedidos a los que pedirles detalle uno
por uno: inviable (el propio backfill de recompra web de AppDash tardó hasta 3 horas para
**20 días** — escalar eso a años se va a decenas/cientos de horas). Se decidió arrancar el 1 de
enero de 2026 como ventana de detalle. Se puede ampliar hacia atrás corriendo más tandas de
`webdash-backfill.yml` si hace falta — no es una decisión permanente, solo el punto de partida.

## Decisiones tomadas a partir del código real de AppDash

Tenía acceso a la sesión donde se armó AppDash y encontré 3 cosas que corrigieron supuestos míos
anteriores (ver commits previos de este repo para el detalle de cada corrección):

- **Canal web/app**: `customData.customApps` con id `from-help-info`, campo `from`. La regla
  real es "todo lo que NO sea `from=app` es web" (`lib/order-attribution.js` /
  `fetch-orders.js#getCustomAppFrom`), **no** una lista explícita de valores — esto incluye
  pedidos que no tienen el campo en absoluto (de antes de que existiera la app), que se cuentan
  como web correctamente sin necesidad de una fecha de corte especial.
- **Food/Non-Food/Marketplace/Quick Commerce se deciden por `seller` de VTEX**
  (`fetch-orders.js#categorizeOrder`), no por categoría de producto: `carrefourar0899` = seller
  interno non-food, una lista fija de sellers 3rd-party = marketplace, `salesChannel=3` = Quick
  Commerce, resto = food. Clasificación a nivel de PEDIDO completo (prioridad QC > Marketplace >
  Non Food > Food), sin prorrateo.
- **Cadencia real: 1 vez por día**, 06:00 UTC.

## Privacidad: hash en vez de email plano

AppDash persiste el email del cliente en texto plano en sus archivos diarios públicos
(`docs/data/daily/*-rows.json`). WebDash decidió **no** replicar eso: `src/customer-key.js` guarda
un hash SHA-256 truncado (64 bits) del email en vez del email real en los archivos diarios
públicos de GitHub Pages. Alcanza para contar clientes únicos y repurchase sin poder revertir el
hash a un email — mismo resultado analítico, menor exposición de PII.

## Lo que falta completar

### 1. Credenciales de VTEX (GitHub Secrets)
`VTEX_ACCOUNT_NAME`, `VTEX_APP_KEY`, `VTEX_APP_TOKEN`, `VTEX_ENVIRONMENT` (opcional).

### 2. `config/status-filter.json` — convención de estados VTEX
Puse una convención default razonable (excluye `canceled`, `payment-pending`, etc.), pero no la
encontré explícita en el código de AppDash revisado — confirmarla para que las métricas de
WebDash sean comparables con AppDash.

### 3. Correr el backfill inicial
Ver sección siguiente.

## Cómo completar el historial (backfill)

Actions → **"WebDash backfill (rango manual)"** → Run workflow, con `from`/`to`. Recomendado
empezar con rangos de ~1 mes (ver estimaciones de volumen arriba) y repetir hasta cubrir desde
`2026-01-01`. Cada corrida es segura de repetir o cortar a la mitad: los días ya procesados no
se vuelven a pedir.

## Diferencia de arquitectura restante vs. AppDash

En AppDash, repurchase rate y frecuencia de compra se calculan sobre TODOS los clientes del canal
(global), y solo el conteo de pedidos/GMV se separa por segmento. WebDash calcula repurchase/
frecuencia **por pestaña** (food, non-food, etc. por separado), tal como se pidió originalmente.
Esto significa que el repurchase de la pestaña Food de WebDash no es directamente comparable al
repurchase global de AppDash — son métricas distintas a propósito. Avisame si preferís que
también sea global.

## Módulo compartido / reusabilidad

`src/metrics.js` y `src/classify.js` no conocen nada de "canal" ni "segmento" hardcodeado: reciben
agregados ya armados y calculan repurchase rate, frecuencia, basket size, participación por
segmento y proyección mensual. Están pensados para poder moverse a un paquete/repo compartido y
ser consumidos también por AppDash sin duplicar lógica — avisame si querés que arme ese paquete.

## Correr localmente

```bash
npm install    # sin dependencias externas, usa fetch nativo de Node 20+
VTEX_ACCOUNT_NAME=... VTEX_APP_KEY=... VTEX_APP_TOKEN=... node src/fetch-day.js 2026-08-24
VTEX_ACCOUNT_NAME=... VTEX_APP_KEY=... VTEX_APP_TOKEN=... node src/backfill.js 2026-01-01 2026-01-31
node src/aggregate.js
npx serve docs   # ver el dashboard
```

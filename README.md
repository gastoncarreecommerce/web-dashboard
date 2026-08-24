# WebDash — Analytics de pedidos canal WEB (Carrefour Argentina)

Contraparte de **AppDash** (repo `gastoncarreecommerce/vtex-utm-audit`, rama `main`), mismo stack:
GitHub Actions (pipeline de datos) + VTEX Order API como fuente + GitHub Pages como hosting
estático. Filtra por el canal **web** (storefront) en vez de app, y separa las métricas en 4
pestañas, replicando la segmentación real de AppDash: **Food**, **Non Food**, **Marketplace**
y **Quick Commerce**.

## Cómo funciona

1. `.github/workflows/webdash-pipeline.yml` corre 1 vez por día a las 06:00 UTC (03:00 AR) —
   misma cadencia que `fetch-daily.yml` de AppDash — y también con `workflow_dispatch` manual.
2. `src/pipeline.js` trae pedidos de la VTEX Order API, los filtra por canal (`config/channel-map.json`)
   y por status (`config/status-filter.json`), clasifica cada PEDIDO COMPLETO en uno de los 4
   segmentos (`config/segment-map.json`) y calcula las métricas (`src/metrics.js`).
3. Escribe el resultado en `docs/data/web/<segmento>/metrics.json` (uno por pestaña).
4. GitHub Pages sirve `docs/` como sitio estático; `docs/app.js` lee esos JSON y pinta las 4 pestañas.
   No hay backend corriendo 24/7.

## Decisiones tomadas a partir del código real de AppDash

Tenía acceso a la sesión donde se armó AppDash (`gastoncarreecommerce/vtex-utm-audit`, rama `main`)
y encontré 3 cosas que corrigieron supuestos míos anteriores:

- **Food/Non-Food NO se decide por categoría de producto**, se decide por **seller de VTEX**
  (`fetch-orders.js#categorizeOrder`): `carrefourar0899` es el seller interno para non-food, una
  lista fija de sellers 3rd-party es "marketplace", `salesChannel=3` es Quick Commerce, y todo lo
  demás es food. Copiado 1:1 a `config/segment-map.json`.
- **Clasificación a nivel de pedido completo**, no por línea de ítem — un pedido cae en un solo
  segmento (prioridad: Quick Commerce > Marketplace > Non Food > Food), sin prorrateo.
- **Cadencia real: 1 vez por día**, no cada 6 horas como había puesto por default.

El campo de canal web/app (`customData.customApps` con id `from-help-info`, campo `from`) también
está confirmado contra ese mismo patrón, usado igual en `lib/order-attribution.js` de AppDash.

## ⚠️ Lo que falta completar antes de que los números sean reales

### 1. Credenciales de VTEX (GitHub Secrets)
Configurar en `Settings > Secrets and variables > Actions` del repo:
- `VTEX_ACCOUNT_NAME`
- `VTEX_APP_KEY`
- `VTEX_APP_TOKEN`
- `VTEX_ENVIRONMENT` (opcional, default `vtexcommercestable`)

### 2. `config/channel-map.json` — ya completado y verificado
Usa `customData.customApps` (id `from-help-info`, campo `from` = `web`/`app`). Verificado contra
200 pedidos reales: 145 web, 54 app, 1 sin clasificar.

### 3. `config/segment-map.json` — ya completado (copiado de AppDash)
Si en VTEX se dan de alta o de baja sellers de marketplace, hay que actualizar
`marketplaceSellerIds` a mano acá, igual que se actualiza en AppDash (no hay un endpoint que lo
derive automáticamente).

### 4. `config/status-filter.json` — convención de estados VTEX
Puse una convención default razonable (excluye `canceled`, `payment-pending`, etc.), pero **hay
que confirmarla contra la convención real de AppDash** (no la encontré explícita en el código
revisado) para que las métricas de WebDash sean comparables con AppDash.

## Diferencia de arquitectura a tener en cuenta

AppDash guarda un JSON **por día** (`docs/data/daily/YYYY-MM-DD.json`) y agrega meses leyendo esos
archivos (`scripts/comercial-lib.mjs`). WebDash, en cambio, recalcula todo sobre una ventana
rolling de `PIPELINE_LOOKBACK_DAYS` (400 por default) en cada corrida, sin guardar historial diario.
Es más simple para las 4 pestañas actuales, pero si más adelante se quiere un gráfico de evolución
día a día (como tiene AppDash), hay que migrar a guardar un JSON por día. Avisame si lo querés ya.

También vale aclarar: en AppDash, repurchase rate y frecuencia de compra se calculan sobre TODOS
los clientes del canal (global), no por segmento — solo el conteo de pedidos/GMV se separa por
segmento. WebDash calcula repurchase/frecuencia **por pestaña** (food, non-food, etc. por
separado), tal como se pidió originalmente. Esto significa que el número de repurchase de la
pestaña Food de WebDash no es directamente comparable al repurchase global de AppDash — son
métricas distintas a propósito. Avisame si preferís que también sea global.

## Módulo compartido / reusabilidad

`src/metrics.js` y `src/classify.js` no conocen nada de "canal" ni "segmento" hardcodeado: reciben
"vistas de pedido" ya filtradas y calculan repurchase rate, frecuencia, basket size, participación
por segmento y proyección mensual sobre lo que les pasen. Están pensados para poder moverse a un
paquete/repo compartido y ser consumidos también por AppDash sin duplicar lógica — quedaron en
este repo por ahora; avisame si querés que arme ese paquete separado.

## Correr el pipeline localmente

```bash
npm install    # no hay dependencias externas, usa fetch nativo de Node 20+
VTEX_ACCOUNT_NAME=... VTEX_APP_KEY=... VTEX_APP_TOKEN=... PIPELINE_CHANNEL=web npm run pipeline
```

## Ver el dashboard localmente

```bash
npx serve docs
```

# WebDash — Analytics de pedidos canal WEB (Carrefour Argentina)

Contraparte de **AppDash**, mismo stack: GitHub Actions (pipeline de datos) + VTEX Order API
como fuente + GitHub Pages como hosting estático. Este dashboard filtra por el canal **web**
(storefront) en vez del canal app, y separa las métricas en dos pestañas: **Food** y **Non Food**.

## Cómo funciona

1. `.github/workflows/webdash-pipeline.yml` corre el pipeline cada 6 horas (default, ver más abajo)
   y en cada push manual (`workflow_dispatch`).
2. `src/pipeline.js` trae pedidos de la VTEX Order API, los filtra por canal (`config/channel-map.json`)
   y por status (`config/status-filter.json`), clasifica cada línea de pedido como food/non-food
   (`config/category-map.json`) y calcula las métricas (`src/metrics.js`).
3. Escribe el resultado en `docs/data/web/food/metrics.json` y `docs/data/web/non-food/metrics.json`.
4. GitHub Pages sirve `docs/` como sitio estático; `docs/app.js` lee esos JSON y pinta las 2 pestañas.
   No hay backend corriendo 24/7.

## ⚠️ Lo que falta completar antes de que los números sean reales

Armé todo el esqueleto y lo dejé funcionando con datos vacíos de arranque (seed) para que el
dashboard no se rompa, pero **3 cosas están como placeholder a propósito** porque dependen de
esta cuenta específica de VTEX y no las quise adivinar:

### 1. Credenciales de VTEX (GitHub Secrets)
Configurar en `Settings > Secrets and variables > Actions` del repo:
- `VTEX_ACCOUNT_NAME`
- `VTEX_APP_KEY`
- `VTEX_APP_TOKEN`
- `VTEX_ENVIRONMENT` (opcional, default `vtexcommercestable`)

### 2. `config/channel-map.json` — IDs de salesChannel para web vs app
Correr localmente (o en un workflow manual) con las credenciales reales:
```
VTEX_ACCOUNT_NAME=... VTEX_APP_KEY=... VTEX_APP_TOKEN=... npm run inspect:channels
```
Esto escribe `config/channel-map.report.json` con los valores reales de `salesChannel`/`origin`
observados en los últimos 14 días de pedidos. Con eso se completan los `REPLACE_WITH_...` del
archivo. El pipeline **falla explícitamente** si detecta placeholders sin completar, para no
calcular métricas sobre un filtro de canal incorrecto en silencio.

### 3. `config/category-map.json` — departamentos food / non-food
```
VTEX_ACCOUNT_NAME=... VTEX_APP_KEY=... VTEX_APP_TOKEN=... npm run inspect:categories
```
Esto trae el árbol de categorías de la Catalog API y lo vuelca en
`config/category-map.report.json` para elegir a mano qué `departmentId` es food y cuál non-food.

También queda configurable, sin tocar código, `mixedOrderStrategy`:
- `"line-item"` (default): un pedido con ítems de ambas categorías se cuenta completo en las dos
  pestañas, cada una solo con sus ítems/GMV correspondientes.
- `"prorate"`: el pedido se reparte fraccionalmente entre ambas pestañas según el % de GMV de cada categoría.

### 4. `config/status-filter.json` — convención de estados VTEX
Puse una convención default razonable (excluye `canceled`, `payment-pending`, etc.), pero **hay
que confirmarla contra la convención ya usada en AppDash** para que Food/Non-Food de WebDash sean
comparables con AppDash. Si me pasás el archivo equivalente de AppDash, lo alineo.

### 5. Cadencia del pipeline
Dejé `cron: '0 */6 * * *'` (cada 6 horas) como default razonable. Decime la cadencia real de
AppDash y la ajusto en `.github/workflows/webdash-pipeline.yml`.

## Módulo compartido / reusabilidad

`src/metrics.js` y `src/classify.js` no conocen nada de "canal" ni "food/non-food": reciben
"vistas de pedido" ya filtradas y calculan repurchase rate, frecuencia, basket size, participación
por segmento y proyección mensual sobre lo que les pasen. Estos módulos están pensados para poder
moverse a un paquete/repo compartido y ser consumidos también por AppDash sin duplicar lógica —
quedó todo en este repo por ahora porque no tuve acceso al repo de AppDash; si me pasás su
owner/repo puedo extraer esto a un paquete separado y dejar ambos dashboards consumiéndolo.

## Correr el pipeline localmente

```bash
npm install    # no hay dependencias externas, usa fetch nativo de Node 20+
VTEX_ACCOUNT_NAME=... VTEX_APP_KEY=... VTEX_APP_TOKEN=... PIPELINE_CHANNEL=web npm run pipeline
```

## Ver el dashboard localmente

```bash
npx serve docs
```

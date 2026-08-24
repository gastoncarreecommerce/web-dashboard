'use strict';

/**
 * Herramienta de investigación (no forma parte del pipeline productivo).
 * Trae el árbol de categorías (departamentos) de VTEX Catalog API y lo vuelca
 * en config/category-map.report.json para poder elegir a mano qué departamentos
 * son food y cuáles non-food en config/category-map.json.
 *
 * Uso: VTEX_ACCOUNT_NAME=... VTEX_APP_KEY=... VTEX_APP_TOKEN=... node src/inspect-categories.js
 */
const fs = require('fs');
const path = require('path');
const { getCategoryTree } = require('./vtex-client');

async function main() {
  const tree = await getCategoryTree(2);
  const departments = tree.map((d) => ({
    id: d.id,
    name: d.name,
    hasChildren: (d.children || []).length,
    childrenNames: (d.children || []).map((c) => c.name),
  }));

  const report = {
    generatedAt: new Date().toISOString(),
    departments,
    howToUse:
      'Revisar la lista de departamentos y clasificar cada `id` como food o non-food en ' +
      'config/category-map.json (foodDepartmentIds / nonFoodDepartmentIds). Los ids no listados ' +
      'caen en unmappedDepartmentPolicy.',
  };

  const outPath = path.join(__dirname, '..', 'config', 'category-map.report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`Reporte escrito en ${outPath}`);
  console.log(JSON.stringify(departments, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

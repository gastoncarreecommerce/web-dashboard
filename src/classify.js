'use strict';

const PLACEHOLDER_RE = /^(REPLACE_WITH_|TBD_PENDING_INVESTIGATION)/;

function assertConfigured(list, configName) {
  if (!Array.isArray(list) || list.length === 0 || list.some((v) => PLACEHOLDER_RE.test(v))) {
    throw new Error(
      `${configName} todavía tiene valores placeholder sin completar. ` +
        'Corré los scripts de inspección (npm run inspect:channels / inspect:categories) ' +
        'y completá config/*.json con los IDs reales antes de correr el pipeline.'
    );
  }
}

function assertConfiguredScalar(value, configName) {
  if (!value || PLACEHOLDER_RE.test(value)) {
    throw new Error(
      `${configName} todavía tiene un valor placeholder sin completar. ` +
        'Completá config/channel-map.json antes de correr el pipeline.'
    );
  }
}

/**
 * Busca en order.customData.customApps el item con id === appId y devuelve
 * el valor crudo de fields[fieldName] (ej. customApps[{id:'from-help-info', fields:{from:'web'}}] -> 'web').
 * Devuelve null si el pedido no trae ese customApp (pedidos previos a que se empezara a trackear esto).
 */
function extractCustomAppFieldValue(order, appId, fieldName) {
  const customApps = order.customData?.customApps || [];
  const app = customApps.find((a) => a.id === appId);
  const raw = app?.fields?.[fieldName];
  return raw == null ? null : String(raw).trim();
}

function orderChannel(order, channelMap) {
  const appId = channelMap.customAppsField?.appId;
  const fieldName = channelMap.customAppsField?.fieldName;
  assertConfiguredScalar(appId, 'channel-map.json > customAppsField.appId');
  assertConfiguredScalar(fieldName, 'channel-map.json > customAppsField.fieldName');

  const value = extractCustomAppFieldValue(order, appId, fieldName);
  if (value == null) return 'unknown';

  for (const [name, cfg] of Object.entries(channelMap.channels)) {
    assertConfiguredScalar(cfg.matchValue, `channel-map.json > channels.${name}.matchValue`);
    if (cfg.matchValue === value) return name;
  }
  return 'unknown';
}

function isIncludedStatus(order, statusFilter) {
  const status = order.status;
  if (statusFilter.includeStatuses.includes(status)) return true;
  if (statusFilter.excludeStatuses.includes(status)) return false;
  return false; // status desconocido: excluido por defecto (ver policy en el config)
}

/**
 * Clasifica cada item de un pedido como food/non-food usando el árbol de categorías.
 * item.productCategoryIds suele venir como "/1000/1100/" (ids separados por '/').
 */
function itemCategoryBucket(item, categoryMap) {
  assertConfigured(categoryMap.foodDepartmentIds, 'category-map.json > foodDepartmentIds');
  const raw = item.productCategoryIds || item.categoryId || '';
  const ids = String(raw).split('/').filter(Boolean);
  const departmentId = ids[0];

  if (categoryMap.foodDepartmentIds.includes(departmentId)) return 'food';
  if (categoryMap.nonFoodDepartmentIds.includes(departmentId)) return 'non-food';
  return categoryMap.unmappedDepartmentPolicy === 'food' ? 'food' : 'non-food';
}

/**
 * Divide un pedido en "vistas" por categoría según mixedOrderStrategy.
 * Devuelve un array de { bucket, order, items, gmv, weight } — weight=1 salvo prorate.
 */
function splitOrderByCategory(order, categoryMap) {
  const items = order.items || [];
  const buckets = { food: [], 'non-food': [] };
  for (const item of items) {
    const bucket = itemCategoryBucket(item, categoryMap);
    buckets[bucket].push(item);
  }

  const gmvOf = (items) => items.reduce((sum, i) => sum + (i.sellingPrice * i.quantity) / 100, 0);
  const foodGmv = gmvOf(buckets.food);
  const nonFoodGmv = gmvOf(buckets['non-food']);
  const totalGmv = foodGmv + nonFoodGmv || 1;

  if (categoryMap.mixedOrderStrategy === 'prorate') {
    const views = [];
    if (buckets.food.length) {
      views.push({ bucket: 'food', order, items: buckets.food, gmv: foodGmv, weight: foodGmv / totalGmv });
    }
    if (buckets['non-food'].length) {
      views.push({
        bucket: 'non-food',
        order,
        items: buckets['non-food'],
        gmv: nonFoodGmv,
        weight: nonFoodGmv / totalGmv,
      });
    }
    return views;
  }

  // line-item (default): el pedido aparece completo en cada pestaña que tenga items de esa categoría
  const views = [];
  if (buckets.food.length) views.push({ bucket: 'food', order, items: buckets.food, gmv: foodGmv, weight: 1 });
  if (buckets['non-food'].length) {
    views.push({ bucket: 'non-food', order, items: buckets['non-food'], gmv: nonFoodGmv, weight: 1 });
  }
  return views;
}

module.exports = { orderChannel, isIncludedStatus, itemCategoryBucket, splitOrderByCategory };

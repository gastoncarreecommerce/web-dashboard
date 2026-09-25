/**
 * Usuarios habilitados y su nombre para mostrar, desde la env var
 * DASHBOARD_USERS (nunca hardcodeados: este repo es público y una lista de
 * empleados es dato personal).
 *
 * Formato: entradas separadas por coma o salto de línea, cada una
 *   usuario                 → entra, se muestra el usuario
 *   usuario=Nombre Apellido → entra, se muestra el nombre
 * Ej.: "gaston_ruiz=Gaston Ruiz, berenice_fraga=Berenice Fraga"
 */
export function normUser(u) {
  return String(u || '').trim().toLowerCase().replace(/@.*$/, '');
}

export function parseUsers(raw = process.env.DASHBOARD_USERS || '') {
  const map = new Map();
  for (const entry of String(raw).split(/[,\n]/)) {
    const [u, ...rest] = entry.split('=');
    const user = normUser(u);
    if (user) map.set(user, rest.join('=').trim() || user);
  }
  return map;
}

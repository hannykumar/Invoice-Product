/**
 * Issue #344 — every API route, in one enumerable table. The dispatcher in server.ts serves exactly
 * these; #343 generates its permission tests from them.
 */
import { CORE_ROUTES } from './core.ts';
import { SALES_ROUTES } from './sales.ts';
import { GST_ROUTES } from './gst.ts';
import { PURCHASING_ROUTES } from './purchasing.ts';
import { MONEY_ROUTES } from './money.ts';
import { BOOKS_ROUTES } from './books.ts';
import { PRIVACY_ROUTES } from './privacy.ts';
import type { Route } from './route.ts';

export const ROUTES: readonly Route[] = [...CORE_ROUTES, ...SALES_ROUTES, ...GST_ROUTES, ...PURCHASING_ROUTES, ...MONEY_ROUTES, ...BOOKS_ROUTES, ...PRIVACY_ROUTES];

/** A route's identity: two routes may not share one, which `matchRoute` relies on. */
export const routeKey = (route: Pick<Route, 'method' | 'path'>): string => `${route.method} ${route.path}`;

interface Compiled { readonly route: Route; readonly pattern: RegExp; readonly names: readonly string[] }
const literal = new Map<string, Route>();
const parameterised: Compiled[] = [];
for (const route of ROUTES) {
  const key = routeKey(route);
  if (literal.has(key) || parameterised.some((compiled) => routeKey(compiled.route) === key)) throw new Error(`Two API routes are declared as ${key}.`);
  if (!route.path.includes('/:')) { literal.set(key, route); continue; }
  const names: string[] = [];
  const source = route.path.split('/').map((segment) => {
    if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    names.push(segment.slice(1));
    return '([^/]+)';
  }).join('/');
  parameterised.push({ route, pattern: new RegExp(`^${source}$`), names });
}

/**
 * The route for this method and path, and its decoded `:params`. Literal paths win over
 * parameterised ones, so `/api/purchases/preview` is never read as a purchase called "preview".
 */
export const matchRoute = (method: string, pathname: string): { route: Route; params: Record<string, string> } | undefined => {
  const exact = literal.get(`${method} ${pathname}`);
  if (exact !== undefined) return { route: exact, params: {} };
  for (const { route, pattern, names } of parameterised) {
    if (route.method !== method) continue;
    const match = pattern.exec(pathname);
    if (match === null) continue;
    const params: Record<string, string> = {};
    try { names.forEach((name, index) => { params[name] = decodeURIComponent(match[index + 1]!); }); }
    catch { return undefined; } // A broken %-escape names nothing that could exist.
    return { route, params };
  }
  return undefined;
};

/**
 * Issue #347 — Appendix A of docs/security/threat-model.md is the list of every route in
 * server.ts, with its gate. This keeps it true both ways: a route added without a row fails, a row
 * left behind for a route that is gone fails, a gate that changed in the route table without the
 * appendix following fails, and the route count in §4.1 must match.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ROUTES } from '../src/server.ts';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

/**
 * Every route the server serves, as `METHOD /path` with each `:name` written `:param`. Issue #344:
 * read from the route table itself, which is the only thing the server serves, so nothing can be
 * written in a shape this reader misses (it used to read server.ts as text).
 */
const apiRoutes = (): string[] => ROUTES.map((route) => `${route.method} ${route.path.replace(/:\w+/g, ':param')}`);

/** What Appendix A's Gate column says for a POST, from the code. */
const gateOf = (path: string): string => {
  const route = ROUTES.find((candidate) => candidate.method === 'POST' && candidate.path.replace(/:\w+/g, ':param') === path);
  const gate = route?.access.kind === 'gate' ? route.access : undefined;
  if (gate === undefined) return '—';
  if (gate.all.length > 0) return gate.all.map((permission) => `\`${permission}\``).join(' + ');
  return gate.any.map((permission) => `\`${permission}\``).join(' or ');
};

const appendix = (): Map<string, string> => {
  const model = read('../../../docs/security/threat-model.md');
  const rows = new Map<string, string>();
  for (const match of model.slice(model.indexOf('## Appendix A')).matchAll(/^\| ([A-Z]+) \| `([^`]+)` \| (.+) \|$/gm)) {
    rows.set(`${match[1]} ${match[2]}`, match[3]!);
  }
  return rows;
};

test('every API route is in the threat model, and every row there is a route', () => {
  const routes = apiRoutes();
  assert.ok(routes.length > 100, 'the route reader found too few routes to be right');
  const rows = appendix();
  assert.deepEqual(routes.filter((route) => !rows.has(route)), [], 'add these routes to Appendix A of docs/security/threat-model.md');
  assert.deepEqual([...rows.keys()].filter((row) => !routes.includes(row)), [], 'these rows in Appendix A are no longer routes; remove them');

  const model = read('../../../docs/security/threat-model.md');
  assert.match(model, new RegExp(`### 4\\.1 HTTP API — ${routes.length} routes`), `§4.1 must say ${routes.length} routes`);
});

test('the Gate column says what the route table checks', () => {
  const rows = appendix();
  const wrong: string[] = [];
  for (const [route, gate] of rows) {
    const [method, path] = route.split(' ') as [string, string];
    if (method === 'POST') {
      if (gate !== gateOf(path)) wrong.push(`${route}: appendix says ${gate}, the code checks ${gateOf(path)}`);
    } else if (gate !== 'service' && gate !== '—') {
      wrong.push(`${route}: a GET has no gate in the route table, so its row says service or —, not ${gate}`);
    }
  }
  assert.deepEqual(wrong, []);
});

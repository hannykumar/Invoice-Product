/**
 * Issue #347 — every route in server.ts appears in docs/security/threat-model.md. A route added
 * tomorrow without a row in the model's appendix fails here.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

export const apiRoutes = (): string[] => {
  const source = read('../src/server.ts');
  const handleApi = source.slice(source.indexOf('export async function handleApi('));
  const found: string[] = [];
  for (const match of handleApi.matchAll(/method === '(GET|POST)' && ([^)\n]+)/g)) {
    const literal = /^pathname === '([^']+)'/.exec(match[2]!);
    if (literal) { found.push(`${match[1]} ${literal[1]}`); continue; }
    const variable = /^(\w+)\?\.\[1\]/.exec(match[2]!);
    const pattern = variable && new RegExp(`const ${variable[1]} = /\\^(.+?)\\$/\\.exec\\(pathname\\)`).exec(handleApi);
    assert.ok(pattern, `cannot read the route in: ${match[0]}`);
    found.push(`${match[1]} ${pattern[1]!.replaceAll('\\/', '/').replaceAll('([^/]+)', ':param')}`);
  }
  return found;
};

test('every API route is in the threat model', () => {
  const model = read('../../../docs/security/threat-model.md');
  const routes = apiRoutes();
  assert.ok(routes.length > 100, 'the route reader found too few routes to be right');
  const missing = routes.filter((route) => {
    const [method, path] = route.split(' ');
    return !model.includes(`| ${method} | \`${path}\` |`);
  });
  assert.deepEqual(missing, [], 'add these routes to Appendix A of docs/security/threat-model.md');
});

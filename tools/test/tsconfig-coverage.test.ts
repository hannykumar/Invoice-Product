/** Issue #498 — every directory of TypeScript is covered by tsconfig.json's `include`, so `npm run lint` cannot silently skip a suite. */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const include = (JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8')) as { include: string[] }).include;

function hasTypeScript(dir: string): boolean {
  return readdirSync(dir).some((name) => {
    if (name === 'node_modules') return false;
    const path = join(dir, name);
    return statSync(path).isDirectory() ? hasTypeScript(path) : name.endsWith('.ts');
  });
}

test('#498: every top-level code and test directory holding TypeScript is in tsconfig.json include', () => {
  const dirs = ['apps', 'ops', 'packages', 'tools', ...readdirSync(join(root, 'tests')).map((d) => `tests/${d}`)];
  for (const dir of dirs) {
    const full = join(root, dir);
    if (!existsSync(full) || !statSync(full).isDirectory() || !hasTypeScript(full)) continue;
    const covered = include.some((pattern) => pattern === `${dir}/**/*.ts` || pattern === `${dir.split('/')[0]}/**/*.ts` || pattern === 'tests/**/*.ts' && dir.startsWith('tests/'));
    assert.ok(covered, `${dir} holds TypeScript that tsconfig.json include does not cover, so npm run lint never checks it`);
  }
});

/**
 * Issue #44 — the register has to stay true.
 *
 * "Every production regression receives a permanent test" is only a promise while nothing checks
 * it. These checks make it a build failure: an entry whose test has been renamed or deleted, or an
 * entry that does not say what broke, stops the build rather than quietly becoming decoration.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REGRESSIONS } from './regressions.ts';

const sourceOf = (file: string): string =>
  readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), 'utf8');

test('every regression in the register is pinned by a test that exists', () => {
  for (const regression of REGRESSIONS) {
    const source = sourceOf(regression.inFile);
    assert.ok(
      source.includes(regression.pinnedBy),
      `${regression.id} says it is pinned by "${regression.pinnedBy}" in ${regression.inFile}, and no such test is there. `
      + 'Either the test was renamed and the register was not, or the guarantee is no longer being checked.',
    );
  }
});

test('every regression says what broke and which guarantee it broke', () => {
  for (const regression of REGRESSIONS) {
    assert.match(regression.id, /^[A-Z][A-Z0-9_]+$/, 'ids are shouted so they can be grepped for');
    assert.match(regression.foundOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(regression.symptom.length > 80, `${regression.id} does not describe the damage in enough detail to recognise it again`);
    assert.ok(regression.invariant.length > 30, `${regression.id} does not name the guarantee it broke`);
    assert.ok(regression.cause.length > 60, `${regression.id} does not say where the fault was`);
  }
});

test('no two regressions share an id', () => {
  const ids = REGRESSIONS.map((regression) => regression.id);
  assert.equal(new Set(ids).size, ids.length);
});

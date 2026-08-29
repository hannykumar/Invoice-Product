/**
 * Issue #48 [E48] — every defect we have found still has a test standing over it.
 *
 * The acceptance criterion is "every discovered financial defect gains a regression test". This
 * turns that from a promise into something CI checks: a register entry whose test file has been
 * deleted or renamed fails the build, and so does an entry that does not say what went wrong.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGRESSION_REGISTER } from '../src/regressions.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('every defect in the register still has the test that guards it', () => {
  assert.ok(REGRESSION_REGISTER.length > 0, 'the register should not be empty while defects have been found');
  for (const entry of REGRESSION_REGISTER) {
    const path = join(repoRoot, entry.guardedBy);
    assert.ok(existsSync(path), `${entry.foundIn} is guarded by ${entry.guardedBy}, which no longer exists`);
  }
});

test('every entry says what went wrong and why it mattered', () => {
  for (const entry of REGRESSION_REGISTER) {
    assert.ok(entry.defect.length > 40, `${entry.foundIn} does not say what the product did wrong`);
    assert.ok(
      entry.consequence.length > 40,
      `${entry.foundIn} does not say why it mattered, so someone will simplify the guard away`,
    );
    assert.match(entry.fixedOn, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('no defect is listed twice', () => {
  const seen = new Set<string>();
  for (const entry of REGRESSION_REGISTER) {
    const key = `${entry.foundIn}:${entry.defect.slice(0, 30)}`;
    assert.equal(seen.has(key), false, `${entry.foundIn} appears twice`);
    seen.add(key);
  }
});

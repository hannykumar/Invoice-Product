/** Issue #1 [E01] — the published specification pages must match their JSON source. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { generated } from '../spec-docs/generate.ts';
import { repoRoot } from '../spec-docs/render.ts';

for (const g of generated) {
  test(`generated doc is up to date: ${relative(repoRoot, g.path)}`, () => {
    const onDisk = readFileSync(g.path, 'utf8');
    assert.equal(
      onDisk,
      g.render(),
      `${relative(repoRoot, g.path)} is stale. Run: node --experimental-strip-types tools/spec-docs/generate.ts`,
    );
  });
}

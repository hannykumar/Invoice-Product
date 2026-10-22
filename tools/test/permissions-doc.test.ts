/** Issue #343 — docs/permissions.md is what the code says. Run `npm run permissions:docs` to rewrite it. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PERMISSIONS_DOC, permissionsDoc } from '../permissions/generate.ts';

test('#343: docs/permissions.md matches the role table and the route table', () => {
  assert.equal(readFileSync(PERMISSIONS_DOC, 'utf8'), permissionsDoc(), 'docs/permissions.md is out of date: run npm run permissions:docs');
});

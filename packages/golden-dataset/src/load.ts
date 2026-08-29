/**
 * Issue #43 [E43] — reading the fixtures off disk.
 *
 * They are plain JSON files rather than TypeScript so that any lane, in any language, can replay
 * the same dataset. Validation happens on load: a fixture that does not hold together should fail
 * where it is read, not deep inside a comparison.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertValidFixture, type GoldenFixture } from './schema.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(here, '..', 'fixtures');

export const fixtureNames = (): string[] =>
  readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.json')).sort();

export const loadFixture = (name: string): GoldenFixture => {
  const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as unknown;
  return assertValidFixture(raw, name);
};

export const loadAllFixtures = (): { name: string; fixture: GoldenFixture }[] =>
  fixtureNames().map((name) => ({ name, fixture: loadFixture(name) }));

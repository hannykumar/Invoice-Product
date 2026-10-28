/**
 * Issue #495 — the convention "assert behaviour, not source text", enforced.
 *
 * A test that reads `app.js`, `index.html` or `styles.css` and matches a regular expression against
 * them proves only that a string exists. It passes while the button is dead, the handler is
 * unreachable or the screen is hidden — the page can be broken and every such test stays green. The
 * tests for the page load it in a browser, drive it, and assert what a person sees and what it sends
 * (see docs/testing.md, "Testing the web app").
 *
 * This guard fails when a test file reads one of the page's own source files from disk. A file
 * that must keep doing so for a stated reason is listed below with that reason; the list may only
 * get shorter. Adding a name to it needs the owner's agreement, written next to the entry.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const repo = resolve(import.meta.dirname, '../../..');

/** The files the page is made of, as a test would name them. */
const PAGE_SOURCES = /(?:^|[\/'"`\s(])(?:app\.js|index\.html|styles\.css|done-screen\.js|sale-slides\.js|item-picker\.js|books\.js)\b/;
/** Reading a file from disk, however it is spelled. */
const READS_A_FILE = /\b(?:readFile|readFileSync|createReadStream|openAsBlob)\b|\bfs\.promises\b/;

/** Does this test file's source read a page source file from disk? Comments are ignored. */
export function readsPageSource(source: string): boolean {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  return READS_A_FILE.test(code) && PAGE_SOURCES.test(code);
}

/**
 * Files that predate this rule and still read the page's sources, each with why, so the list can be
 * worked down. None of them is a model for a new test.
 */
const ALLOWED: Readonly<Record<string, string>> = {
  'apps/web/test/locale-copy.test.ts': 'Reads the `copy` table in app.js and EVALUATES it as data (English and Hindi sentences compared; the done-screen helpers fed real wording). It never searches the source text.',
  'apps/web/test/bill-frames.test.ts': 'A security lint (#399): every frame app.js fills or prints must be a sandboxed frame. Predates #495; the behavioural half is tests/browser/security-headers.spec.ts.',
  'apps/web/test/shop-words.test.ts': 'A wording policy (#312): no developer word anywhere a shopkeeper can read, over the language tables and page copy.',
  'apps/web/test/static-files.test.ts': 'Checks the web server hands out the page\'s own files and nothing else (#393): it compares served bytes with the files on disk.',
  'apps/api/test/einvoice-decided.test.ts': 'Checks the E-invoice screen has no field that asks about turnover (#239). Belongs with the E-invoice screen\'s own browser test; owned by the e-invoice work.',
};

async function testFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !/\.(?:test|spec)\.ts$/.test(entry.name)) continue;
    const path = resolve(entry.parentPath, entry.name);
    if (path.includes('node_modules')) continue;
    found.push(path.slice(repo.length + 1));
  }
  return found.sort();
}

test('no test reads app.js, index.html or styles.css from disk to assert on its text', async () => {
  const roots = ['apps', 'packages', 'ops', 'tools', 'tests'].map((name) => resolve(repo, name));
  const files = (await Promise.all(roots.map((root) => testFiles(root).catch(() => [] as string[])))).flat();
  assert.ok(files.length > 100, `the scan found the repository's tests (${files.length})`);
  const offenders: string[] = [];
  for (const file of files) {
    if (file === 'apps/web/test/web-test-conventions.test.ts') continue;
    if (readsPageSource(await readFile(resolve(repo, file), 'utf8')) && !(file in ALLOWED)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `These tests read the page's source files. Load the page in a browser and assert what a person sees and what it sends instead (docs/testing.md, "Testing the web app"):\n  ${offenders.join('\n  ')}`);
});

test('every exception is still needed: a file that no longer reads a page source is taken off the list', async () => {
  const stale: string[] = [];
  for (const file of Object.keys(ALLOWED)) {
    const source = await readFile(resolve(repo, file), 'utf8').catch(() => null);
    if (source === null || !readsPageSource(source)) stale.push(file);
  }
  assert.deepEqual(stale, [], 'remove these from ALLOWED: they are gone or already behave');
});

test('the guard itself can fail: it spots the ways a test reads the page\'s text', () => {
  // The shapes the old web.test.ts used.
  assert.equal(readsPageSource(`const read = (name) => readFile(resolve(root, name), "utf8");\nconst script = await read("app.js");\nassert.match(script, /\\/api\\/returns\\/preview/);`), true);
  assert.equal(readsPageSource(`const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');`), true);
  assert.equal(readsPageSource(`const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");`), true);
  assert.equal(readsPageSource(`import fs from 'node:fs'; fs.readFileSync(path.join(root, 'app.js'))`), true);
  // A test that drives the page, or reads something else, is fine.
  assert.equal(readsPageSource(`await page.goto(base + '/app.js'); const reply = await fetch(base + '/index.html');`), false);
  assert.equal(readsPageSource(`const seed = await readFile(resolve(root, 'seed.json'), 'utf8');`), false);
  assert.equal(readsPageSource(`// we used to readFile app.js here\nawait page.click('#bill-button');`), false);
});

/**
 * Issue #396 — one company's migrations can never close another's.
 *
 * Workspaces used to share one store of eight slots across every business, so a ninth
 * `POST /api/migration/start` from anyone dropped somebody else's half-finished import. Now a
 * session's own extra workspaces close only its own oldest, a business has its own cap, and a
 * workspace closes when nobody has touched it for two hours.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { useFixedAppClock } from '../src/app-clock.ts';
import { WORKSPACE_IDLE_MS, WORKSPACES_PER_COMPANY, WORKSPACES_PER_SESSION } from '../src/migration-application.ts';
import { KONKAN_OWNER, SAMPOORNA_OWNER, signIn } from './sign-in-helper.ts';

const COMPANY_A = '00000000-0000-4000-8000-000000000001';
const COMPANY_B = '00000000-0000-4000-8000-000000000011';
const START = Date.parse('2026-08-29T10:00:00.000Z');
let window = 0;
let now = START;
const at = (offsetMs: number): void => {
  now = START + window * 12 * WORKSPACE_IDLE_MS + offsetMs;
  useFixedAppClock(new Date(now).toISOString());
};
/** Each test runs hours after the last, so what an earlier test left open has closed by itself. */
const freshWindow = (): void => {
  window += 1;
  at(0);
};
freshWindow();

const request = async (path: string, body: Record<string, unknown>, session: string) => {
  const response = await handleApi('POST', path, body, `Bearer ${session}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

const start = async (session: string) => request('/api/migration/start', {}, session);

const analyse = async (session: string, started: Record<string, any>) => {
  const sample = started.samples[0];
  return request('/api/migration/analyse', { workspaceId: started.workspaceId, fileName: sample.fileName, content: sample.content }, session);
};

test('a company opening many workspaces never closes another company’s import', async () => {
  freshWindow();
  const ownerA = await signIn(SAMPOORNA_OWNER, COMPANY_A);
  const ownerB = await signIn(KONKAN_OWNER, COMPANY_B);
  const importOfB = await start(ownerB);
  assert.equal(importOfB.status, 200);

  for (let opened = 0; opened < 20; opened += 1) assert.equal((await start(ownerA)).status, 200);

  const stillThere = await analyse(ownerB, importOfB.body);
  assert.equal(stillThere.status, 200, JSON.stringify(stillThere.body));
  assert.equal(stillThere.body.state, 'ANALYSED');
});

test('a session that opens more than its share closes only its own oldest', async () => {
  freshWindow();
  const first = await signIn(SAMPOORNA_OWNER, COMPANY_A);
  const colleague = await signIn(SAMPOORNA_OWNER, COMPANY_A);
  const theirs = await start(colleague);

  const mine = [];
  for (let opened = 0; opened <= WORKSPACES_PER_SESSION; opened += 1) mine.push((await start(first)).body);

  const oldest = await analyse(first, mine[0]!);
  assert.equal(oldest.status, 404);
  assert.match(oldest.body.message, /expired or was not found/);
  for (const workspace of mine.slice(1)) assert.equal((await analyse(first, workspace)).status, 200);
  assert.equal((await analyse(colleague, theirs.body)).status, 200, 'a colleague in the same business keeps theirs');
});

test('a business with too many imports open is told to finish one, and nothing of anyone else closes', async () => {
  freshWindow();
  const sessions = [];
  for (let index = 0; index < Math.ceil(WORKSPACES_PER_COMPANY / WORKSPACES_PER_SESSION) + 1; index += 1) {
    sessions.push(await signIn(KONKAN_OWNER, COMPANY_B));
  }
  const ownerA = await signIn(SAMPOORNA_OWNER, COMPANY_A);
  const importOfA = await start(ownerA);

  let opened = 0;
  let refused: { status: number; body: Record<string, any> } | undefined;
  const open: { session: string; started: Record<string, any> }[] = [];
  for (const session of sessions) {
    for (let index = 0; index < WORKSPACES_PER_SESSION && refused === undefined; index += 1) {
      const started = await start(session);
      if (started.status !== 200) refused = started;
      else {
        opened += 1;
        open.push({ session, started: started.body });
      }
    }
  }
  assert.ok(refused, 'the business reached its cap');
  assert.equal(opened, WORKSPACES_PER_COMPANY, 'every session of the business shares one cap');
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'MIGRATION_TOO_MANY_OPEN');
  assert.match(refused.body.message, /already has 8 imports open/);
  assert.match(refused.body.message, /2 hours/);

  for (const { session, started } of open) assert.equal((await analyse(session, started)).status, 200, 'refusing closes nothing');
  assert.equal((await start(ownerA)).status, 200, 'another business still opens its own');
  assert.equal((await analyse(ownerA, importOfA.body)).status, 200);
});

test('a workspace closes after two hours unused, and use keeps it open', async () => {
  freshWindow();
  const owner = await signIn(SAMPOORNA_OWNER, COMPANY_A);
  const idle = (await start(owner)).body;
  const busy = (await start(owner)).body;

  at(WORKSPACE_IDLE_MS - 60_000);
  assert.equal((await analyse(owner, busy)).status, 200, 'still open one minute before the limit');

  at(WORKSPACE_IDLE_MS);
  const expired = await analyse(owner, idle);
  assert.equal(expired.status, 404);
  assert.match(expired.body.message, /expired or was not found/);
  const kept = await analyse(owner, { ...busy, samples: [busy.samples[1]] });
  assert.equal(kept.status, 200, 'the workspace in use is still open');
});

test('an over-long file is refused at the door with the row limit', async () => {
  freshWindow();
  const owner = await signIn(SAMPOORNA_OWNER, COMPANY_A);
  const started = (await start(owner)).body;
  const content = ['Party Name,Phone No', ...Array.from({ length: 5_001 }, (_unused, index) => `Party ${index},98450${String(index).padStart(5, '0')}`)].join('\n');
  const refused = await request('/api/migration/analyse', { workspaceId: started.workspaceId, fileName: 'parties.csv', content }, owner);
  assert.equal(refused.status, 422);
  assert.equal(refused.body.code, 'MIGRATION_TOO_MANY_ROWS');
  assert.match(refused.body.message, /5,001 rows/);
});

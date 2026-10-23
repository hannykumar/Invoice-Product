/**
 * Issue #404 — on PostgreSQL, the assistant writes to the company's own audit trail.
 *
 * What the person asked, what was shown, the platform command it became and the report all land in
 * `audit_events`, under the person who asked (never the assistant), beside every other record of
 * the company; the command is kept in `command_records` with the company's other commands; and the
 * plan is in `agent_plans`. A restart loses none of it, because none of it is kept in memory.
 *
 * Needs DATABASE_URL (the owner). Skipped locally without it; fails in CI.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { ChildProcess } from 'node:child_process';
import type { TransactionalExecutor } from '../../../packages/platform/src/database.ts';
import { signInOverHttp, KONKAN_OWNER, SAMPOORNA_OWNER } from './sign-in-helper.ts';
import { appDatabase, callApi, freePort, killProcess, startApi } from './processes.ts';

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error('DATABASE_URL must be set in CI so the assistant audit tests run.');
const skip = url === undefined && 'DATABASE_URL is not set';

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';
const KONKAN = '00000000-0000-4000-8000-000000000011';
let database: Awaited<ReturnType<typeof appDatabase>> | undefined;
let owner: TransactionalExecutor;
let port: number;
let api: ChildProcess | undefined;

before(async () => {
  if (url === undefined) return;
  database = await appDatabase(url);
  owner = database.owner;
  port = await freePort();
});

after(async () => {
  await killProcess(api);
  await database?.close();
});

test('#404: what the assistant was asked and did is on the company trail, under the person, and survives a restart', { skip }, async () => {
  api = await startApi(database!.appUrl, port);
  const call = callApi(port);
  const token = (await signInOverHttp(`http://127.0.0.1:${port}`, SAMPOORNA_OWNER, SAMPOORNA)).split('=')[1]!;

  const planned = await call('POST', '/api/agent/plan', { request: 'Who owes me money?', today: new Date().toISOString().slice(0, 10) }, token);
  assert.equal(planned.status, 200, JSON.stringify(planned));
  assert.equal(planned.needsApproval, false);
  const done = await call('POST', '/api/agent/execute', { planId: planned.id, fingerprint: planned.fingerprint, idempotencyKey: `agent-404-${planned.id}` }, token);
  assert.equal(done.status, 200, JSON.stringify(done));

  const person = (await owner.query('SELECT id FROM users WHERE email = $1', [SAMPOORNA_OWNER])).rows[0]!.id;
  const lines = (await owner.query(
    "SELECT action, actor_id, after_json FROM audit_events WHERE company_id = $1 AND correlation_id = $2 ORDER BY seq", [SAMPOORNA, planned.id])).rows;
  assert.deepEqual(lines.map((row) => row.action), ['agent.requested', 'agent.previewed', 'agent.reported']);
  assert.ok(lines.every((row) => row.actor_id === person), 'under the person who asked, not the assistant');
  const commandId = (lines[1]!.after_json as { details: { commandId: string } }).details.commandId;
  assert.ok(commandId, 'the line names the command the plan became');

  // The command is one of the company's own, and its lifecycle is on the same trail.
  const command = (await owner.query('SELECT action, status, actor_id FROM command_records WHERE company_id = $1 AND id = $2', [SAMPOORNA, commandId])).rows[0];
  assert.deepEqual(command, { action: 'agent.run', status: 'finalised', actor_id: person });
  const lifecycle = (await owner.query('SELECT action FROM audit_events WHERE company_id = $1 AND correlation_id = $2 ORDER BY seq', [SAMPOORNA, commandId])).rows.map((row) => row.action);
  assert.deepEqual(lifecycle, ['agent.run.created', 'agent.run.submitted', 'agent.run.approved', 'agent.run.finalised']);
  assert.equal((await owner.query('SELECT state FROM agent_plans WHERE company_id = $1 AND id = $2', [SAMPOORNA, planned.id])).rows[0]?.state, 'EXECUTED');

  // A restart: the history is read back from the database, not from the process that wrote it.
  await killProcess(api);
  api = await startApi(database!.appUrl, port);
  const again = (await signInOverHttp(`http://127.0.0.1:${port}`, SAMPOORNA_OWNER, SAMPOORNA)).split('=')[1]!;
  const history = await call('GET', '/api/agent/history', undefined, again);
  assert.equal(history.status, 200);
  const actions = history.audit.map((line: { action: string }) => line.action);
  assert.ok(actions.includes('agent.requested') && actions.includes('agent.reported'), JSON.stringify(actions));

  // And one company never reads another's.
  const konkan = (await signInOverHttp(`http://127.0.0.1:${port}`, KONKAN_OWNER, KONKAN)).split('=')[1]!;
  const theirs = await call('GET', '/api/agent/history', undefined, konkan);
  assert.ok(!JSON.stringify(theirs.audit).includes(planned.id), 'another company sees none of these lines');
});

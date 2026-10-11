/**
 * Issue #358 — no fault is swallowed in silence. A request that fails on our side, a provider that
 * failed behind a friendly message, a rejected promise nobody waited for: each reaches the error
 * report with the request it happened in. The tracker (ADR 0007: Sentry, EU, ids only) is given
 * ids, the error's kind and a scrubbed message — never a name, GST number or amount.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { DemoApplication } from '../src/demo-application.ts';
import { captureLog, inRequest, annotate } from '../src/log.ts';
import { apiErrorReporter } from '../src/error-reporting.ts';
import { framesOf, parseDsn, scrubMessage, sentryEvent, sentryReporter } from '../src/sentry.ts';
import { RecordingErrorReporter, reportError, useErrorReporter } from '../../../packages/platform/src/error-reporting.ts';
import { InvoiceDeliveryService } from '../../../packages/delivery/src/index.ts';

const COMPANY_A = '00000000-0000-4000-8000-000000000001';
const EU_DSN = 'https://publickey123@o4501.ingest.de.sentry.io/4507';

const ownerSession = async (): Promise<string> => {
  const response = await handleApi('POST', '/api/auth/login', { companyId: COMPANY_A, email: 'owner@sampoorna.example.invalid', password: 'karobar-demo' });
  return `Bearer ${JSON.parse(String(response.body)).sessionId}`;
};

test('#358: a request that fails on our side is reported once, under its route and request id', async (context) => {
  const recorder = new RecordingErrorReporter();
  context.after(useErrorReporter(recorder));
  const owner = await ownerSession();
  context.mock.method(DemoApplication.prototype, 'reports', () => { throw new TypeError('a fault of ours'); });
  const result = await handleApi('GET', '/api/reports', {}, owner);
  assert.equal(result.status, 500);
  assert.deepEqual(recorder.wheres(), ['api.request']);
  assert.equal(recorder.reports[0]!.context.route, 'GET /api/reports');
  assert.match(String((recorder.reports[0]!.error as Error).message), /a fault of ours/);
  // What the shopkeeper did wrong is not a fault, and is not reported.
  await handleApi('POST', '/api/sales/cancel/preview', [1, 2], owner);
  assert.deepEqual(recorder.wheres(), ['api.request']);
});

test('#358: a provider failure behind a friendly "could not be completed" is reported with its reason', async (context) => {
  const recorder = new RecordingErrorReporter();
  context.after(useErrorReporter(recorder));
  const service = new InvoiceDeliveryService({ async send() { throw new Error('SMTP 421 try later'); } }, async () => ({ filename: 'INV-1.pdf', bytes: Buffer.from('%PDF-1.7\nx') }), () => 100);
  const scope = { companyId: 'co', actorId: 'owner', permissions: new Set(['invoice.delivery.manage']) };
  const queued = service.queue(scope, { invoiceId: 'INV-1', recipientId: 'customer-1', channel: 'email', idempotencyKey: 'k-1' });
  const failed = await service.send(scope, queued.id, 'https://example.test/doc');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.lastError, 'Delivery could not be completed. Retry is available.');
  assert.deepEqual(recorder.wheres(), ['delivery.send']);
  assert.match((recorder.reports[0]!.error as Error).message, /SMTP 421/);
});

test('#358: reporting never throws, even when the reporter itself does', (context) => {
  context.after(useErrorReporter({ report() { throw new Error('the reporter is broken'); } }));
  const written: string[] = [];
  context.mock.method(process.stderr, 'write', (chunk: string) => { written.push(String(chunk)); return true; });
  assert.doesNotThrow(() => reportError('somewhere', new Error('first')));
  context.mock.restoreAll();
  assert.match(written.join(''), /the reporter is broken/);
});

test('#358: the API reporter writes the log line with the request it was in', async (context) => {
  const lines: Record<string, any>[] = [];
  context.after(captureLog((_level, line) => { lines.push(JSON.parse(line)); }));
  context.after(useErrorReporter(apiErrorReporter({})));
  await inRequest('req-358-a', async () => {
    annotate({ route: 'POST /api/x', company_id: 'company-1', user_id: 'user-1' });
    await Promise.resolve();
    reportError('collections.send', new RangeError('the reminder could not be built'), { reminder_id: 'r-1' });
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.message, 'An error was reported');
  assert.equal(lines[0]!.where, 'collections.send');
  assert.equal(lines[0]!.request_id, 'req-358-a');
  assert.equal(lines[0]!.company_id, 'company-1');
  assert.equal(lines[0]!.reminder_id, 'r-1');
  assert.match(lines[0]!.stack, /RangeError: the reminder could not be built/);
});

test('#358: only a DSN in Sentry\'s EU region is accepted, and a wrong one falls back to the log, said once', (context) => {
  assert.equal(typeof parseDsn(EU_DSN), 'object');
  assert.match(String(parseDsn('https://key@o1.ingest.us.sentry.io/2')), /not Sentry's EU region/);
  assert.match(String(parseDsn('https://key@o1.ingest.sentry.io/2')), /not Sentry's EU region/);
  assert.match(String(parseDsn('not a dsn')), /not a Sentry DSN/);
  const lines: Record<string, any>[] = [];
  context.after(captureLog((_level, line) => { lines.push(JSON.parse(line)); }));
  apiErrorReporter({ SENTRY_DSN: 'https://key@o1.ingest.us.sentry.io/2' });
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.message, 'Error reports go to the log only');
});

test('#358: the tracker is sent ids, the kind of error and a scrubbed message — no names, GST numbers or amounts', async () => {
  const sent: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => { sent.push({ url, init }); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
  const reporter = sentryReporter({ dsn: EU_DSN, environment: 'staging', release: 'abc123', fetch: fakeFetch });
  const error = new RangeError('"ABC Traders" (29BBBBB1111B1ZJ) owes ₹1,18,000 to owner@shop.example.invalid, PAN AAAPZ1234C');
  reporter.report({ where: 'api.request', error, context: { request_id: 'b1f0c9e2-0000-4000-8000-000000000001', route: 'POST /api/sales/record', company_id: COMPANY_A, user_id: 'user-9', delivery_id: '3f2a9c1e-77', note: 'sent to 9800000000' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, 'https://o4501.ingest.de.sentry.io/api/4507/envelope/');
  assert.match(String((sent[0]!.init.headers as Record<string, string>)['x-sentry-auth']), /sentry_key=publickey123/);
  const [header, item, eventLine] = String(sent[0]!.init.body).split('\n');
  assert.equal(JSON.parse(header!).dsn, EU_DSN);
  assert.equal(JSON.parse(item!).type, 'event');
  const event = JSON.parse(eventLine!);
  assert.equal(event.environment, 'staging');
  assert.equal(event.release, 'abc123');
  assert.equal(event.tags.request_id, 'b1f0c9e2-0000-4000-8000-000000000001');
  assert.equal(event.tags.route, 'POST /api/sales/record');
  assert.equal(event.tags.delivery_id, '3f2a9c1e-77', 'an id is kept whole, so the record can be found');
  assert.equal(event.tags.note, 'sent to #', 'any other label is scrubbed');
  assert.deepEqual(event.user, { id: 'user-9' });
  assert.deepEqual(event.contexts, { company: { id: COMPANY_A } });
  assert.equal(event.exception.values[0].type, 'RangeError');
  const everything = String(sent[0]!.init.body);
  for (const leaked of ['ABC Traders', '29BBBBB1111B1ZJ', '1,18,000', 'owner@shop', 'AAAPZ1234C']) assert.ok(!everything.includes(leaked), `${leaked} reached the tracker`);
  assert.ok(event.exception.values[0].stacktrace.frames.length > 0, 'the stack is readable');
  assert.match(event.exception.values[0].stacktrace.frames.at(-1).filename, /^apps\/api\/test\/error-reporting\.test\.ts$/);
});

test('#358: stack frames are oldest first, with repository paths', () => {
  const frames = framesOf('TypeError: x\n    at outer (file:///srv/karobar/apps/api/src/server.ts:10:5)\n    at inner (file:///srv/karobar/packages/sales/src/service.ts:20:7)\n    at node:internal/process/task_queues:95:5');
  assert.deepEqual(frames.map((frame) => [frame.function, frame.filename, frame.lineno, frame.in_app]), [
    ['<anonymous>', 'node:internal/process/task_queues', 95, false],
    ['inner', 'packages/sales/src/service.ts', 20, true],
    ['outer', 'apps/api/src/server.ts', 10, true],
  ]);
  assert.equal(scrubMessage("Cannot read properties of undefined (reading 'lines')"), "Cannot read properties of undefined (reading 'lines')");
  assert.equal(sentryEvent({ where: 'w', error: 'a string', context: {} }, { environment: 'production' }, 'e').exception.values[0]!.type, 'Error');
});

test('#358: the error-check route throws only in staging, and only for an operator', async (context) => {
  const recorder = new RecordingErrorReporter();
  context.after(useErrorReporter(recorder));
  const owner = await ownerSession();
  assert.equal((await handleApi('POST', '/api/operations/error-check', {}, owner)).status, 404);
  assert.deepEqual(recorder.wheres(), []);
  const before = process.env.NODE_ENV;
  context.after(() => { if (before === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = before; });
  process.env.NODE_ENV = 'staging';
  const thrown = await handleApi('POST', '/api/operations/error-check', {}, owner);
  assert.equal(thrown.status, 500);
  assert.deepEqual(recorder.wheres(), ['api.request']);
  const viewer = JSON.parse(String((await handleApi('POST', '/api/auth/login', { companyId: COMPANY_A, email: 'viewer@sampoorna.example.invalid', password: 'viewer-demo' })).body)).sessionId;
  assert.equal((await handleApi('POST', '/api/operations/error-check', {}, `Bearer ${viewer}`)).status, 403);
});

test('#358: a promise rejected with nobody waiting is reported, and the process carries on', () => {
  const reporting = fileURLToPath(new URL('../src/error-reporting.ts', import.meta.url));
  const script = `
    import { installErrorReporting } from ${JSON.stringify(reporting)};
    installErrorReporting();
    Promise.reject(new TypeError('nobody waited for this'));
    setTimeout(() => process.stdout.write('still running\\n'), 50);
  `;
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /still running/);
  const line = run.stderr.split('\n').find((text) => text.includes('process.unhandledRejection'));
  assert.ok(line, `no report on stderr: ${run.stderr}`);
  assert.match(JSON.parse(line).stack, /nobody waited for this/);
});

/**
 * Issue #357 — one JSON line per event: the request id from a response header finds every line of
 * that request, each names the company and the user once they are known, and what a person typed
 * that is secret or personal never reaches the log.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { serveApi } from '../src/server.ts';
import { DemoApplication } from '../src/demo-application.ts';
import { captureLog, inRequest, log } from '../src/log.ts';
import { apiErrorReporter } from '../src/error-reporting.ts';
import { useErrorReporter } from '../../../packages/platform/src/error-reporting.ts';
import { signInOverHttp } from './sign-in-helper.ts';
import { DEMO_SIGN_IN_CODE } from '../../../packages/platform/src/seed.ts';

const COMPANY_A = '00000000-0000-4000-8000-000000000001';

const listen = async () => {
  const server = createServer(serveApi);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};

test('#357: the request id in the response header finds every line of that request, with its company and user', async (context) => {
  const lines: Record<string, any>[] = [];
  const raw: string[] = [];
  context.after(captureLog((_level, line) => { raw.push(line); lines.push(JSON.parse(line)); }));
  context.after(useErrorReporter(apiErrorReporter({})));
  const { server, base } = await listen();
  context.after(() => server.close());

  const cookie = await signInOverHttp(base);
  // A fault deep inside the request: its line must join the request's own.
  context.mock.method(DemoApplication.prototype, 'reports', () => { throw new TypeError('a fault deep inside'); });
  const reports = await fetch(`${base}/api/reports?from=2026-04-01`, { headers: { cookie } });
  assert.equal(reports.status, 500);
  const requestId = reports.headers.get('x-request-id')!;

  const mine = lines.filter((line) => line.request_id === requestId);
  assert.deepEqual(mine.map((line) => [line.level, line.message]), [['error', 'An error was reported'], ['info', 'request']]);
  for (const line of mine) {
    assert.equal(line.company_id, COMPANY_A);
    assert.equal(typeof line.user_id, 'string');
    assert.equal(line.route, 'GET /api/reports');
    assert.match(line.time, /^\d{4}-\d{2}-\d{2}T/);
  }
  const access = mine.at(-1)!;
  assert.equal(access.status, 500);
  assert.equal(access.path, '/api/reports', 'the query string is not logged');
  assert.equal(typeof access.duration_ms, 'number');
  assert.match(mine[0]!.stack, /a fault deep inside/);

  // Signing in carried a code and handed back a session: neither is in any line.
  const everything = raw.join('\n');
  assert.ok(!/password/i.test(everything), 'a log line mentions a password');
  assert.ok(!everything.includes(DEMO_SIGN_IN_CODE));
  assert.ok(!everything.includes(cookie.split('=')[1]!));
  assert.ok(!everything.includes('owner@sampoorna.example.invalid'));
});

test('#357: PAN, bank account, UPI id, phone and email are redacted; ordinary fields are not', (context) => {
  const lines: Record<string, any>[] = [];
  context.after(captureLog((_level, line) => { lines.push(JSON.parse(line)); }));
  log.info('payee changed', {
    pan: 'AAAPZ1234C', accountNumber: '50100012345678', ifsc: 'HDFC0001234', upiId: 'shop@okhdfcbank',
    phone: '9800000000', email: 'owner@shop.example.invalid', authorization: 'Bearer abc.def', password: 'hunter2',
    company: 'Sampoorna Traders', note: 'mailed owner@shop.example.invalid about it',
  });
  const [line] = lines;
  for (const key of ['pan', 'accountNumber', 'ifsc', 'upiId', 'phone', 'email', 'authorization', 'password']) assert.equal(line![key], '[REDACTED]', key);
  assert.equal(line!.company, 'Sampoorna Traders');
  assert.equal(line!.note, 'mailed [EMAIL] about it');
});

test('#357: a line logged later in the same request, after an await, still carries the request; none can relabel it', async (context) => {
  const lines: Record<string, any>[] = [];
  context.after(captureLog((_level, line) => { lines.push(JSON.parse(line)); }));
  await inRequest('request-one', async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    log.warn('later', { request_id: 'someone-else' });
  });
  log.info('outside');
  assert.equal(lines[0]!.request_id, 'request-one');
  assert.equal('request_id' in lines[1]!, false);
});

test('#357: debug is never written in production, even when asked for', (context) => {
  const lines: string[] = [];
  context.after(captureLog((_level, line) => { lines.push(line); }));
  const before = { NODE_ENV: process.env.NODE_ENV, LOG_LEVEL: process.env.LOG_LEVEL };
  context.after(() => {
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  });
  process.env.NODE_ENV = 'production';
  process.env.LOG_LEVEL = 'debug';
  log.debug('hidden');
  log.info('shown');
  delete process.env.NODE_ENV;
  log.debug('shown in development');
  process.env.LOG_LEVEL = 'warn';
  log.info('below the level');
  assert.deepEqual(lines.map((line) => JSON.parse(line).message), ['shown', 'shown in development']);
});

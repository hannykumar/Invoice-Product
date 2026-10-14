/**
 * Issue #344 — one way to write a route: every input is validated at the boundary, every list is
 * paged, every reply carries a request id, and a fault on our side is a plain 500 that says nothing
 * of what went wrong inside.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { handleApi, ROUTES, serveApi } from '../src/server.ts';
import { DemoApplication } from '../src/demo-application.ts';
import { PAGE_LIMIT_MAX } from '../src/routes/route.ts';
import { captureLog } from '../src/log.ts';
import { apiErrorReporter } from '../src/error-reporting.ts';
import { useErrorReporter } from '../../../packages/platform/src/error-reporting.ts';
import { PdfRenderingError } from '../../../packages/invoice-templates/src/pdf.ts';

const COMPANY_A = '00000000-0000-4000-8000-000000000001';
const COMPANY_B = '00000000-0000-4000-8000-000000000011';

const parse = (result: { body: string | Buffer }) => JSON.parse(String(result.body)) as Record<string, any>;
const signIn = async (companyId: string, email: string): Promise<string> => {
  const response = await handleApi('POST', '/api/auth/login', { companyId, email, password: 'karobar-demo' });
  assert.equal(response.status, 200);
  return `Bearer ${parse(response).sessionId}`;
};
const pathOf = (path: string) => path.replace(/:\w+/g, 'probe');

const assertFailureShape = (body: Record<string, any>, headers: Readonly<Record<string, string | string[] | undefined>>) => {
  assert.equal(body.state, 'failed');
  assert.equal(typeof body.title, 'string');
  assert.equal(typeof body.message, 'string');
  assert.match(body.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(headers['x-request-id'], body.requestId);
  assert.doesNotMatch(JSON.stringify(body), /\bat [\w.<>]+ \(|node:internal|\.ts:\d+/, 'no stack trace reaches the caller');
};

test('#344: garbage JSON sent to any route over HTTP is a clean 400 in the one error shape', async (context) => {
  context.after(captureLog(() => {})); // one access line per request: not this test's subject
  const server = createServer(serveApi);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    // A GET carries no body: its query is checked by the list tests below.
    for (const route of ROUTES.filter((candidate) => candidate.method === 'POST')) {
      const response = await fetch(`${base}${pathOf(route.path)}`, { method: 'POST', body: '{"half": "a body', headers: { 'content-type': 'application/json' } });
      assert.equal(response.status, 400, `${route.path} answered ${response.status}`);
      const body = await response.json() as Record<string, any>;
      assertFailureShape(body, Object.fromEntries(response.headers));
      assert.equal(body.code, 'INVALID_INPUT');
    }
    // The id is always our own: one a caller chose could collide with another request's in the log.
    const traced = await fetch(`${base}/api/nowhere`, { headers: { 'x-request-id': 'support-ticket-1234' } });
    assert.equal(traced.status, 404);
    assert.notEqual(traced.headers.get('x-request-id'), 'support-ticket-1234');
    assert.equal((await traced.json() as Record<string, any>).requestId, traced.headers.get('x-request-id'));
    // A path the URL parser rejects is a 404, not a crashed server.
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const raw = request({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: '//', method: 'GET' }, (response) => { response.resume(); resolve(response.statusCode ?? 0); });
      raw.on('error', reject); raw.end();
    });
    assert.equal(status, 404);
    // A path that looks like the signed webhook but normalises to another route is still checked as
    // that route: a write from another website is refused, never routed past the check.
    const smuggled = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const raw = request({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: '/api/webhooks/government/x\\..\\..\\..\\sales\\record', method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' } }, (response) => {
        let text = ''; response.on('data', (chunk) => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text }));
      });
      raw.on('error', reject); raw.end('{}');
    });
    assert.equal(smuggled.status, 403);
    assert.equal(JSON.parse(smuggled.body).code, 'CROSS_SITE_REQUEST');
  } finally {
    server.close();
  }
});

test('#344: a body that is not an object, or a list where one value belongs, is a 400 naming the field', async () => {
  const owner = await signIn(COMPANY_A, 'owner@sampoorna.example.invalid');
  for (const route of ROUTES.filter((candidate) => candidate.method === 'POST' && candidate.path !== '/api/webhooks/government/:kind')) {
    const result = await handleApi('POST', pathOf(route.path), ['not', 'an', 'object'], route.access.kind === 'public' ? undefined : owner);
    assert.equal(result.status, 400, `${route.path} answered ${result.status} to a list`);
    const body = parse(result);
    assertFailureShape(body, result.headers);
    assert.equal(body.code, 'INVALID_INPUT');
  }
  // A list sent as JSON text that is not JSON is the caller's mistake, not a fault on our side.
  const badText = await handleApi('POST', '/api/sales/preview', { customerId: 'sampoorna:party:customer', date: '2026-08-29', lines: '[{not json' }, owner);
  assert.equal(badText.status, 400);
  assert.equal(parse(badText).code, 'INVALID_INPUT');
  const wrongType = await handleApi('POST', '/api/sales/cancel/preview', { invoice: { id: 'x' }, reason: ['a', 'b'] }, owner);
  assert.equal(wrongType.status, 400);
  const body = parse(wrongType);
  assert.equal(body.code, 'INVALID_INPUT');
  assert.match(body.message, /invoice should be a single value/);
  assert.match(body.message, /reason should be a single value/);
});

test('#344: a thrown TypeError is a generic 500 with the request id; its message stays in the log', async (context) => {
  const owner = await signIn(COMPANY_A, 'owner@sampoorna.example.invalid');
  const logged: string[] = [];
  context.after(captureLog((_level, line) => { logged.push(line); }));
  context.after(useErrorReporter(apiErrorReporter({})));
  context.mock.method(DemoApplication.prototype, 'dashboard', () => { throw new TypeError("Cannot read properties of undefined (reading 'internalSecretShape')"); });
  const result = await handleApi('GET', '/api/dashboard', {}, owner);
  assert.equal(result.status, 500);
  const body = parse(result);
  assertFailureShape(body, result.headers);
  assert.equal(body.code, 'INTERNAL');
  assert.match(body.message, /^Something went wrong on our side\. Nothing was saved\./);
  assert.ok(body.message.includes(body.requestId), 'the shopkeeper is given the id to quote');
  assert.doesNotMatch(String(result.body), /internalSecretShape|TypeError/);
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /internalSecretShape/);
  assert.ok(logged[0]!.includes(body.requestId), 'the log line carries the same request id');
});

test('#344: a PDF the browser engine could not make is a 500; where Chrome lives stays in the log', async (context) => {
  const owner = await signIn(COMPANY_A, 'owner@sampoorna.example.invalid');
  const logged: string[] = [];
  context.after(captureLog((_level, line) => { logged.push(line); }));
  context.after(useErrorReporter(apiErrorReporter({})));
  context.mock.method(DemoApplication.prototype, 'invoicePrint', async () => { throw new PdfRenderingError(new Error('Could not find Chrome (cache path /root/.cache/puppeteer)')); });
  const result = await handleApi('GET', '/api/sales/any-bill/pdf', {}, owner);
  assert.equal(result.status, 500);
  assert.doesNotMatch(String(result.body), /Chrome|puppeteer/);
  assert.match(logged.join('\n'), /Could not find Chrome/);
});

test('#344: a plain Error the product throws on purpose still tells the shopkeeper what went wrong', async (context) => {
  const owner = await signIn(COMPANY_A, 'owner@sampoorna.example.invalid');
  // The kernel's parsers answer a date typed in a form they cannot read with a RangeError: the caller's to fix.
  const badDate = await handleApi('POST', '/api/sales/preview', { customerId: 'sampoorna:party:customer', date: '31-02-2026' }, owner);
  assert.equal(badDate.status, 400);
  assert.match(parse(badDate).message, /is not a date/);
  // Any other RangeError is a fault in our own code: a plain 500, not a developer's sentence on screen.
  context.mock.method(DemoApplication.prototype, 'reports', () => { throw new RangeError('divideRound: denominator must not be zero'); });
  const internal = await handleApi('GET', '/api/reports', {}, owner);
  assert.equal(internal.status, 500);
  assert.doesNotMatch(String(internal.body), /divideRound/);
  context.mock.method(DemoApplication.prototype, 'dashboard', () => { throw new Error('This bill has no rate for the item.'); });
  const result = await handleApi('GET', '/api/dashboard', {}, owner);
  assert.equal(result.status, 400);
  assert.equal(parse(result).message, 'This bill has no rate for the item.');
});

test('#344: every list route takes a cursor and a limit, and walking the cursors returns the whole list once', async () => {
  const owner = await signIn(COMPANY_A, 'owner@sampoorna.example.invalid');
  const lists = ROUTES.filter((route) => route.list !== undefined);
  assert.ok(lists.length >= 10, `only ${lists.length} list routes`);
  const get = async (path: string) => { const result = await handleApi('GET', path, {}, owner); return { status: result.status, body: parse(result) }; };
  for (const route of lists) {
    const key = route.list!;
    const whole = await get(`${route.path}?limit=${PAGE_LIMIT_MAX}`);
    assert.equal(whole.status, 200, `${route.path} answered ${whole.status}`);
    const all = whole.body[key] as unknown[];
    assert.ok(Array.isArray(all), `${route.path} has no "${key}" list`);
    const walked: unknown[] = [];
    let cursor: string | undefined;
    do {
      const page = await get(`${route.path}?limit=1${cursor === undefined ? '' : `&cursor=${cursor}`}`);
      assert.equal(page.status, 200);
      assert.ok(page.body[key].length <= 1, `${route.path} ignored the limit`);
      walked.push(...page.body[key]);
      cursor = page.body.nextCursor;
    } while (cursor !== undefined);
    assert.deepEqual(walked, all, `${route.path} lost or repeated items across pages`);
    for (const bad of ['limit=0', `limit=${PAGE_LIMIT_MAX + 1}`, 'limit=ten', 'cursor=bm90LWEtY3Vyc29y']) {
      const refused = await get(`${route.path}?${bad}`);
      assert.equal(refused.status, 400, `${route.path}?${bad} answered ${refused.status}`);
      assert.equal(refused.body.code, 'INVALID_INPUT');
    }
  }
  // At least one list has more than one item, so the walk above crossed a page boundary.
  assert.ok((await get('/api/einvoices/invoices?limit=1')).body.nextCursor !== undefined);
});

test('#344: an unknown route is a 404 in the one shape, and no two routes share a method and path', async () => {
  const result = await handleApi('GET', '/api/no-such-thing');
  assert.equal(result.status, 404);
  assertFailureShape(parse(result), result.headers);
  assert.equal((await handleApi('DELETE', '/api/dashboard')).status, 404);
  const keys = ROUTES.map((route) => `${route.method} ${route.path}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('#344: another company\'s bill, asked for by id in the path, is not found', async () => {
  const ownerA = await signIn(COMPANY_A, 'owner@sampoorna.example.invalid');
  const ownerB = await signIn(COMPANY_B, 'owner@konkan.example.invalid');
  const billsOfA = parse(await handleApi('GET', '/api/einvoices/invoices', {}, ownerA)).invoices as { id: string }[];
  assert.ok(billsOfA.length > 0);
  const own = await handleApi('GET', `/api/sales/${encodeURIComponent(billsOfA[0]!.id)}/preview`, {}, ownerA);
  assert.equal(own.status, 200);
  const other = await handleApi('GET', `/api/sales/${encodeURIComponent(billsOfA[0]!.id)}/preview`, {}, ownerB);
  assert.equal(other.status, 404);
  assertFailureShape(parse(other), other.headers);
});

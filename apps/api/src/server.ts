import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { DomainError, UnreadableValue } from '@invoice/kernel';
import { CurrencyMismatchError } from '../../../packages/kernel/src/money.ts';
import { UnitMismatchError } from '../../../packages/kernel/src/quantity.ts';
import { PlatformError, redactSecretText } from '../../../packages/platform/src/index.ts';
import { ConnectorError } from '../../../packages/platform/src/connectors.ts';
import { MasterDataError } from '../../../packages/masters/src/masters.ts';
import { UnitConversionError } from '../../../packages/masters/src/units.ts';
import { InboxError } from '../../../packages/purchasing/src/inbox.ts';
import { WebhookNotAuthenticated } from '../../../packages/gsp/src/index.ts';
import { permissionPortFromActor, type ActorContext } from '@invoice/ledger';
import { apiRuntime, AuthenticationError, startRuntime } from './runtime.ts';
import { SignInUnavailable, sessionTokenFrom } from './sign-in.ts';
import { expensiveLimit, LIMITS, RateLimited } from '../../../packages/platform/src/rate-limits.ts';
import { costOf } from './routes/costs.ts';
import { both } from './language.ts';
import { spend } from './spending.ts';
import { openPersistence, securityOf } from './persistence.ts';
import { sealStoredAppRecords } from './field-encryption.ts';
import { configureGovernmentWebhooks } from './government-webhooks.ts';
import { asOneAction, asOneRead } from './durable.ts';
import { annotate, inRequest, log, requestScope } from './log.ts';
import { reportError } from '../../../packages/platform/src/error-reporting.ts';
import { installErrorReporting } from './error-reporting.ts';
import { applySecurityHeaders, applyTimeouts, bodyLimitFor, BodyTooLarge, isCrossSiteWrite, isSignedCallback, isUnnamedWrite, MAX_STORED_FILE_BODY_BYTES, readLimitedBody, STORED_FILE_ROUTE } from './http-hardening.ts';
import { localObjectStore, MAX_STORED_FILE_BYTES } from './files-application.ts';
import { matchRoute, ROUTES } from './routes/index.ts';
import { asMasterDataCaller } from './master-data.ts';
import { pageOf, Reply, type ApiResult, type Gate, type PublicRoute, type Route, type WebhookDelivery } from './routes/route.ts';

export type { ApiResult, WebhookDelivery } from './routes/route.ts';
export { ROUTES } from './routes/index.ts';

// Redaction happens on the finished text, not on the object: walking the object can only reach the
// shapes the walker recognises, and a secret carried by a class instance or a Map would walk past it.
export const jsonResponse = (status: number, body: unknown) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: redactSecretText(JSON.stringify(body, (_key, value) => typeof value === 'bigint' ? value.toString() : value) ?? '') });
const json = jsonResponse;

const requirePermission = (actor: ActorContext, gate: Gate): void => {
  for (const permission of gate.all) permissionPortFromActor.require(actor, permission, gate.what);
  if (gate.any.length > 0 && !gate.any.some((permission) => actor.permissions.includes(permission))) permissionPortFromActor.require(actor, gate.any[0]!, gate.what);
};

/**
 * Errors the product raises on purpose to tell the shopkeeper what went wrong: their message is
 * written for the screen. A plain `Error` with no `code` is one too — about 88 throw sites in
 * packages/* speak to the shopkeeper that way (migrating them to DomainError is a follow-up). So is
 * UnreadableValue: the kernel's parsers raise it for a date, amount, quantity or tax period typed in
 * a form they cannot read ("31-02-2026" is not a real date), which is the caller's to correct.
 * Anything else — a TypeError, any other RangeError, a file or database error, a PDF not produced —
 * is a fault on our side.
 */
const SPOKEN_TO_THE_SHOPKEEPER = [UnreadableValue, MasterDataError, UnitConversionError, InboxError, ConnectorError, CurrencyMismatchError, UnitMismatchError];
const isMeantForTheScreen = (error: unknown): error is Error =>
  error instanceof Error && ((error.constructor === Error && !('code' in error)) || SPOKEN_TO_THE_SHOPKEEPER.some((kind) => error instanceof kind));

/** The status a known error answers with, or `undefined` for a fault on our side. */
const statusOf = (error: unknown): number | undefined => {
  if (error instanceof AuthenticationError) return 401;
  if (error instanceof SignInUnavailable) return 503;
  if (error instanceof RateLimited) return 429;
  // A provider that signed its callback wrongly is told so, and told nothing else.
  if (error instanceof WebhookNotAuthenticated) return 401;
  if (error instanceof ZodError) return 400;
  // Text the service had to read as JSON (`lines`, `bills`) or as a whole number, and could not.
  if (error instanceof SyntaxError) return 400;
  if (error instanceof DomainError) {
    if (error.kind === 'FORBIDDEN') return 403;
    if (error.kind === 'NOT_FOUND') return 404;
    if (error.kind === 'CONFLICT' || error.kind === 'NOT_ALLOWED') return 409;
    return 422;
  }
  // Issue #489 — a document that is not this company's is "not found" and nothing else, so its id cannot be probed.
  if (error instanceof InboxError) return error.code === 'INVALID_STATE' ? 409 : 404;
  if (error instanceof PlatformError) {
    if (error.code === 'FORBIDDEN') return 403;
    if (error.code === 'NOT_FOUND' || error.code === 'TENANT_ISOLATION') return 404;
    if (error.code === 'SESSION_EXPIRED' || error.code === 'SESSION_REVOKED') return 401;
    // Issue #367 — the shop is busy; nothing in the request was wrong.
    if (error.code === 'TRY_AGAIN') return 503;
    return 409;
  }
  if (isMeantForTheScreen(error)) return 400;
  return undefined;
};

/** "lines.0.rate" → "lines → 1 → rate", so the message names the field the way a person counts. */
const fieldName = (path: readonly PropertyKey[]): string => path.length === 0 ? 'the request' : path.map((part) => typeof part === 'number' ? String(part + 1) : String(part)).join(' → ');
const invalidInputMessage = (error: ZodError): string => {
  const problems = error.issues.slice(0, 5).map((issue) => {
    if (issue.path.length === 0 && issue.code === 'invalid_type') return 'the request should be a set of named fields';
    return `${fieldName(issue.path)} ${issue.code === 'invalid_type' || issue.code === 'invalid_union' ? 'should be a single value, not a list or a group' : issue.message.toLowerCase()}`;
  });
  return `Nothing was saved, because part of what was sent could not be read: ${problems.join('; ')}.`;
};

/** Issue #344 — the one error shape every route answers with. */
export const failure = (status: number, requestId: string, fields: { title: string; message: string; code?: string | undefined; details?: unknown }) =>
  withRequestId(json(status, { state: 'failed', ...fields, requestId }), requestId);

const withRequestId = (result: ApiResult, requestId: string): ApiResult => ({ ...result, headers: { ...result.headers, 'x-request-id': requestId } });

const failureOf = (error: unknown, requestId: string, routeName: string): ApiResult => {
  const status = statusOf(error);
  if (status === undefined) {
    // The detail goes to the log and the error tracker, under the same request id, never to the caller.
    reportError('api.request', error, { route: routeName });
    return failure(500, requestId, {
      title: 'Something went wrong',
      code: 'INTERNAL',
      message: `Something went wrong on our side. Nothing was saved. Quote ${requestId} if you contact us.`,
    });
  }
  if (error instanceof RateLimited) {
    const refused = failure(429, requestId, { title: both('Please wait a little', 'थोड़ा रुकें'), code: 'TOO_MANY_REQUESTS', message: both(error.message, error.hindi) });
    return { ...refused, headers: { ...refused.headers, 'retry-after': String(error.retryAfterSeconds) } };
  }
  if (error instanceof ZodError) return failure(400, requestId, { title: 'Nothing was saved', code: 'INVALID_INPUT', message: invalidInputMessage(error) });
  if (error instanceof SyntaxError) return failure(400, requestId, { title: 'Nothing was saved', code: 'INVALID_INPUT', message: 'Nothing was saved, because a number or a list that was sent could not be read. Check what was typed and try again.' });
  const known = error as Error;
  // Issue #298 — a refusal carrying a Hindi sentence in its details answers in the screen's language.
  const hiMessage = requestScope().locale === 'hi-IN' && error instanceof DomainError && typeof error.details['hi-IN'] === 'string' ? error.details['hi-IN'] : null;
  return failure(status, requestId, {
    title: error instanceof AuthenticationError ? 'Sign in required' : 'Nothing was saved',
    code: error instanceof DomainError || error instanceof PlatformError ? error.code : undefined,
    message: hiMessage ?? known.message,
    // Issue #262 — the facts behind a refusal (never secrets: errors are logged), for the screen.
    ...(error instanceof DomainError && Object.keys(error.details).length > 0 ? { details: error.details } : {}),
  });
};

const isPublic = (route: Route): route is PublicRoute => route.access.kind === 'public';

/**
 * Issue #344 — serve one API call from the route table: match the route, sign the caller in, check
 * the permission (before reading the input, #280), validate the input, run the handler.
 * `pathname` may carry a `?query`; a GET's input is its query, merged over `body` for in-process callers.
 */
export function handleApi(method: string, pathname: string, body: unknown = {}, authorization?: string, delivery?: WebhookDelivery, requestId: string = randomUUID(), clientIp?: string): Promise<ApiResult> {
  return inRequest(requestId, () => dispatch(method, pathname, body, authorization, delivery, requestId, clientIp));
}

/**
 * Issue #350 — the limits every signed-in request counts against, after its permission (a refusal
 * is always 403, never 429): the person's own pace, then heavy work per company by plan, then a
 * paid service's daily allowance per company and Karobar's daily spending cap for it.
 */
const countRequest = async (runtime: ReturnType<typeof apiRuntime>, route: Route, context: { companyId: string; actorId: string }, app: { planId(actor: ActorContext): Promise<string> }, actor: ActorContext): Promise<void> => {
  await runtime.limits.take(LIMITS.perUser, context.actorId);
  const cost = costOf(route.method, route.path);
  if (cost === undefined) return;
  await runtime.limits.take(expensiveLimit(await app.planId(actor)), context.companyId);
  if (cost.paid === undefined) return;
  await spend(runtime.limits, cost.paid, context.companyId);
};

/** Public routes never limited per address: the health check, and the provider callback that proves itself by its signature. */
const UNLIMITED_PUBLIC: ReadonlySet<string> = new Set(['/api/status', '/api/webhooks/government/:kind', '/api/webhooks/purchase-inbox/:channel']);

async function dispatch(method: string, pathname: string, body: unknown, authorization: string | undefined, delivery: WebhookDelivery | undefined, requestId: string, clientIp?: string): Promise<ApiResult> {
  // A path the URL parser rejects (`//`, a stray space) names nothing that could exist.
  const url = URL.parse(pathname, 'http://localhost');
  const found = url === null ? undefined : matchRoute(method, url.pathname);
  if (url === null || found === undefined) return failure(404, requestId, { title: 'Not found', message: 'That API route does not exist. Nothing was saved.' });
  const { route, params } = found;
  annotate({ route: `${route.method} ${route.path}` });
  try {
    const runtime = apiRuntime();
    const raw = method === 'GET' ? { ...(body !== null && typeof body === 'object' ? body : {}), ...Object.fromEntries(url.searchParams) } : body;
    // Issue #298 — the language this request answers in, asked by the screen as `locale` on any
    // call. It sits on the request's scope so a bilingual sentence is picked where it is turned
    // into JSON, not passed down every call. Anything but `hi-IN` is answered in English.
    if (raw !== null && typeof raw === 'object' && (raw as Record<string, unknown>).locale === 'hi-IN') annotate({ locale: 'hi-IN' });
    let reply: unknown;
    if (isPublic(route)) {
      // Signed-out callers are limited per address — but never the health check a load balancer polls
      // from one address, nor a provider's signed callback; sign-in's own limits are in its route (core.ts).
      if (clientIp !== undefined && !UNLIMITED_PUBLIC.has(route.path) && !route.path.startsWith('/api/auth/')) await runtime.limits.take(LIMITS.signedOutPerIp, clientIp);
      reply = await route.handle({ input: await route.input.parseAsync(raw), params, runtime, requestId, delivery, authorization, clientIp });
    } else {
      let context;
      try { context = await runtime.authenticate(authorization); }
      catch (error) {
        // Issue #350 — guessing at sessions: requests with no valid session count per address.
        if (error instanceof AuthenticationError && clientIp !== undefined) await runtime.limits.take(LIMITS.signedOutPerIp, clientIp);
        throw error;
      }
      annotate({ company_id: context.companyId, user_id: context.actorId });
      const actor = runtime.actor(context);
      if (route.access.kind === 'gate') requirePermission(actor, route.access);
      const input = await route.input.parseAsync(raw);
      const app = await runtime.application(context);
      await countRequest(runtime, route, context, app, actor);
      const handle = async (): Promise<unknown> => asMasterDataCaller(context, () => route.handle({ input, params, runtime, requestId, delivery, context, actor, app }));
      // Issue #340 — one request that changes something is one business action, and so one
      // transaction (#363): the bill, its entry in the books, its stock movement and its audit record
      // are saved together or not at all. Reads need none; their repositories read on their own.
      const db = runtime.database;
      reply = db === null ? await handle() : method === 'GET' || route.ownUnitsOfWork ? await asOneRead(handle) : await asOneAction(db, context.companyId, handle);
      if (route.list !== undefined) reply = pageOf(reply, route.list, input as Parameters<typeof pageOf>[2]);
    }
    if (!(reply instanceof Reply)) return withRequestId(json(200, reply), requestId);
    const result = reply.result;
    if (!('json' in result)) return withRequestId(result, requestId);
    const answered = json(result.status, result.json);
    return withRequestId(result.setCookie === undefined ? answered : { ...answered, headers: { ...answered.headers, 'set-cookie': result.setCookie } }, requestId);
  } catch (error) {
    return failureOf(error, requestId, `${route.method} ${route.path}`);
  }
}

/**
 * The body, kept twice: parsed for every ordinary route, and raw for the one that verifies a
 * signature over it. Re-serialising a parsed object produces a different string, which would fail
 * to verify against a signature that was perfectly correct. Issue #349: never more than the
 * route's limit (`bodyLimitFor`), so one large POST cannot fill the server's memory.
 */
const readBody = async (request: IncomingMessage, limit: number): Promise<{ parsed: unknown; raw: string }> => {
  const bytes = await readLimitedBody(request, limit);
  if (bytes.length === 0) return { parsed: {}, raw: '' };
  const raw = bytes.toString('utf8');
  return { parsed: JSON.parse(raw) as unknown, raw };
};

const send = (response: ServerResponse, result: ApiResult): void => {
  response.writeHead(result.status, result.headers);
  response.end(result.body);
};

export async function serveApi(request: IncomingMessage, response: ServerResponse): Promise<void> {
  applySecurityHeaders(response);
  // Always our own id: one a caller chose could collide with another request's in the log.
  const requestId = randomUUID();
  const started = performance.now();
  const method = request.method ?? 'GET';
  // Parsed once, here: the cross-site check, the body limit and the router must all see the same
  // path. A raw path such as `/api/webhooks/government/x\..\..\sales\record` normalises to
  // another route entirely, so checking the raw text and routing the parsed one would let it past.
  const url = URL.parse(request.url ?? '/', 'http://localhost');
  const pathname = url?.pathname ?? '/';
  await inRequest(requestId, async () => {
    const result = url === null
      ? failure(404, requestId, { title: 'Not found', message: 'That API route does not exist. Nothing was saved.' })
      : await answer(request, response, method, url, requestId);
    send(response, result);
    // One line per request. The query string is left out: it can carry what a person typed.
    log.info('request', { method, path: pathname, status: result.status, duration_ms: Math.round(performance.now() - started) });
  });
}

/**
 * Issue #350 — who is asking, for the limits per IP. Behind a proxy (#356) every request arrives
 * from the proxy, so with KAROBAR_TRUSTED_PROXY=1 the address the proxy saw is used instead: the
 * last hop it added to X-Forwarded-For, which a client cannot forge past it.
 */
const TRUST_PROXY = process.env.KAROBAR_TRUSTED_PROXY === '1';
if (!TRUST_PROXY && process.env.NODE_ENV?.trim().toLowerCase() === 'production') {
  log.warn('KAROBAR_TRUSTED_PROXY is not set: if this server is behind a load balancer, every customer looks like the load balancer and shares one set of sign-in limits.');
}
/**
 * One address per caller: `::ffff:1.2.3.4` is `1.2.3.4`, and an IPv6 address counts by its /64 — a
 * home or phone connection is given a whole /64, so counting single addresses would let one caller
 * pick a new one for every request.
 */
export const normaliseAddress = (address: string): string => {
  const plain = address.trim().replace(/^::ffff:/i, '');
  if (!plain.includes(':')) return plain;
  const [head = '', tail = ''] = plain.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === '' ? [] : tail.split(':');
  const groups = plain.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((group) => group.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
};
export const clientAddress = (request: Pick<IncomingMessage, 'headers' | 'socket'>, trustProxy = TRUST_PROXY): string => {
  const forwarded = request.headers['x-forwarded-for'];
  if (trustProxy && typeof forwarded === 'string' && forwarded.trim() !== '') return normaliseAddress(forwarded.split(',').at(-1)!);
  return normaliseAddress(request.socket.remoteAddress ?? 'unknown');
};

const answer = async (request: IncomingMessage, response: ServerResponse, method: string, url: URL, requestId: string): Promise<ApiResult> => {
  const { pathname } = url;
  // Issue #349 — refused before the body is read, so a hostile page cannot even make us read it.
  // Issue #342 — the session is the cookie, and only the cookie: an `Authorization` header is not read
  // over HTTP. A write that carries the cookie must also say which page sent it (ADR D2); every
  // browser sends `Origin` on a POST, so a request without one did not come from Karobar's page.
  const session = sessionTokenFrom(request.headers.cookie);
  if (!isSignedCallback(pathname) && (isCrossSiteWrite(method, request.headers) || (session !== undefined && isUnnamedWrite(method, request.headers)))) {
    return failure(403, requestId, { title: 'Nothing was saved', code: 'CROSS_SITE_REQUEST', message: 'This came from another website, so it was refused. Open Karobar itself and try again.' });
  }
  // Issue #341 — the local file store's signed address (development and tests). The token is the
  // whole of its authority: it names one file, one method, one content type and an expiry.
  if (pathname === STORED_FILE_ROUTE) return storedFile(request, response, method, url, requestId);
  let read: { parsed: unknown; raw: string };
  try { read = await readBody(request, bodyLimitFor(pathname)); }
  catch (error) {
    if (error instanceof BodyTooLarge) {
      // The rest of the upload is not read; closing the connection stops the client sending it.
      response.setHeader('connection', 'close');
      return failure(413, requestId, { title: 'Nothing was saved', code: 'REQUEST_TOO_LARGE', message: `That is too much to send at once (more than ${Math.round(error.limit / (1024 * 1024))} MB). If you were adding a picture or a file, use a smaller one.` });
    }
    return failure(400, requestId, { title: 'Nothing was saved', code: 'INVALID_INPUT', message: 'Nothing was saved, because what was sent is not valid JSON.' });
  }
  const signature = request.headers['x-provider-signature'];
  // The parsed path, and the query with it: a GET's input is its query.
  return handleApi(method, `${pathname}${url.search}`, read.parsed, session === undefined ? undefined : `Bearer ${session}`, {
    rawBody: read.raw,
    signature: typeof signature === 'string' ? signature : '',
  }, requestId, clientAddress(request));
}

const storedFile = async (request: IncomingMessage, response: ServerResponse, method: string, url: URL, requestId: string): Promise<ApiResult> => {
  const local = localObjectStore();
  if (local === null || (method !== 'PUT' && method !== 'GET')) return failure(404, requestId, { title: 'Not found', message: 'That API route does not exist. Nothing was saved.' });
  let body: Buffer = Buffer.alloc(0);
  if (method === 'PUT') {
    try { body = await readLimitedBody(request, MAX_STORED_FILE_BODY_BYTES); } catch (error) {
      if (!(error instanceof BodyTooLarge)) throw error;
      response.setHeader('connection', 'close');
      return failure(413, requestId, { title: 'Nothing was saved', code: 'REQUEST_TOO_LARGE', message: 'This file is too large to keep.' });
    }
  }
  const done = await local.accept(url.searchParams.get('token') ?? '', { method, contentType: String(request.headers['content-type'] ?? ''), body, maxBytes: MAX_STORED_FILE_BYTES });
  if (done.status !== 200) return failure(done.status, requestId, { title: 'Not allowed', message: done.status === 413 ? 'This file is too large to keep.' : 'This address has expired or does not allow this. Ask for a new one.' });
  return withRequestId({ status: 200, headers: { 'cache-control': 'no-store', ...done.headers }, body: done.body ?? '' }, requestId);
};

export const apiServer = applyTimeouts(createServer(serveApi));

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installErrorReporting();
  // Issue #340 — the database is chosen before the first request, and production without one stops here.
  const persistence = await openPersistence();
  // #352 — seal anything a pre-encryption database still holds in the clear, before requests begin.
  if (persistence.kind === 'postgres') await sealStoredAppRecords(persistence.db, securityOf(persistence).encryption);
  startRuntime(persistence);
  configureGovernmentWebhooks(persistence.kind === 'postgres' ? persistence.db : null, process.env, (message) => log.warn(message, {}));
  log.info('The API keeps its books', { in: persistence.kind });
  const port = Number(process.env.API_PORT ?? 4172);
  apiServer.listen(port, '127.0.0.1', () => log.info('The API is listening', { url: `http://127.0.0.1:${port}` }));
  // Issue #122: the host supplies the tick; the runner owns schedules, overlap and retry state.
  // Issue #345 — only in memory. With a database the worker (`npm run worker`) runs it, out of the
  // request path, and keeps running it when this process restarts.
  if (persistence.kind === 'postgres') log.info('E-invoices and recurring work are sent by the worker. Run it beside this server: npm run worker', {});
  if (persistence.kind === 'memory') {
    const recurringTimer = setInterval(() => {
      // Each job's own failure is kept in its queue state for operators; this is the tick itself failing.
      void apiRuntime().runRecurringWork().catch((error: unknown) => reportError('api.recurringTick', error));
    }, 60_000);
    recurringTimer.unref();
  }
}

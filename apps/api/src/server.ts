import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { DomainError } from '@invoice/kernel';
import { CurrencyMismatchError } from '../../../packages/kernel/src/money.ts';
import { UnitMismatchError } from '../../../packages/kernel/src/quantity.ts';
import { PlatformError, redactSecretText } from '../../../packages/platform/src/index.ts';
import { ConnectorError } from '../../../packages/platform/src/connectors.ts';
import { MasterDataError } from '../../../packages/masters/src/masters.ts';
import { UnitConversionError } from '../../../packages/masters/src/units.ts';
import { InboxError } from '../../../packages/purchasing/src/inbox.ts';
import { WebhookNotAuthenticated } from '../../../packages/gsp/src/index.ts';
import { permissionPortFromActor, type ActorContext } from '@invoice/ledger';
import { apiRuntime, AuthenticationError } from './runtime.ts';
import { annotate, errorFields, inRequest, log } from './log.ts';
import { applySecurityHeaders, applyTimeouts, bodyLimitFor, BodyTooLarge, isCrossSiteWrite, isSignedCallback, readLimitedBody } from './http-hardening.ts';
import { matchRoute, ROUTES } from './routes/index.ts';
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
 * packages/* speak to the shopkeeper that way (migrating them to DomainError is a follow-up). So is a
 * RangeError: the kernel's parsers raise it for a date, amount, quantity or tax period that was typed
 * in a form they cannot read ("31-02-2026" is not a real date), which is the caller's to correct.
 * Anything else — a TypeError, a file or database error, a PDF not produced — is a fault on our side.
 */
const SPOKEN_TO_THE_SHOPKEEPER = [MasterDataError, UnitConversionError, InboxError, ConnectorError, CurrencyMismatchError, UnitMismatchError];
const isMeantForTheScreen = (error: unknown): error is Error =>
  error instanceof Error && ((error.constructor === Error && !('code' in error)) || error instanceof RangeError || SPOKEN_TO_THE_SHOPKEEPER.some((kind) => error instanceof kind));

/** The status a known error answers with, or `undefined` for a fault on our side. */
const statusOf = (error: unknown): number | undefined => {
  if (error instanceof AuthenticationError) return 401;
  // A provider that signed its callback wrongly is told so, and told nothing else.
  if (error instanceof WebhookNotAuthenticated) return 401;
  if (error instanceof ZodError) return 400;
  // A field the service reads as JSON text (`lines`, `bills`) that is not JSON: the caller's mistake.
  if (error instanceof SyntaxError) return 400;
  if (error instanceof DomainError) {
    if (error.kind === 'FORBIDDEN') return 403;
    if (error.kind === 'NOT_FOUND') return 404;
    if (error.kind === 'CONFLICT' || error.kind === 'NOT_ALLOWED') return 409;
    return 422;
  }
  if (error instanceof PlatformError) {
    if (error.code === 'FORBIDDEN') return 403;
    if (error.code === 'NOT_FOUND' || error.code === 'TENANT_ISOLATION') return 404;
    if (error.code === 'SESSION_EXPIRED' || error.code === 'SESSION_REVOKED') return 401;
    return 409;
  }
  if (isMeantForTheScreen(error)) return 400;
  return undefined;
};

/** "lines.0.rate" → "lines → 1 → rate", so the message names the field the way a person counts. */
const fieldName = (path: readonly (string | number)[]): string => path.length === 0 ? 'the request' : path.map((part) => typeof part === 'number' ? String(part + 1) : part).join(' → ');
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
    // The detail goes to the log, under the same request id, and never to the caller.
    log.error('The request failed on our side', { route: routeName, ...errorFields(error) });
    return failure(500, requestId, {
      title: 'Something went wrong',
      code: 'INTERNAL',
      message: `Something went wrong on our side. Nothing was saved. Quote ${requestId} if you contact us.`,
    });
  }
  if (error instanceof ZodError) return failure(400, requestId, { title: 'Nothing was saved', code: 'INVALID_INPUT', message: invalidInputMessage(error) });
  if (error instanceof SyntaxError) return failure(400, requestId, { title: 'Nothing was saved', code: 'INVALID_INPUT', message: 'Nothing was saved, because a list that was sent as text is not valid JSON.' });
  const known = error as Error;
  return failure(status, requestId, {
    title: error instanceof AuthenticationError ? 'Sign in required' : 'Nothing was saved',
    code: error instanceof DomainError || error instanceof PlatformError ? error.code : undefined,
    message: known.message,
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
export function handleApi(method: string, pathname: string, body: unknown = {}, authorization?: string, delivery?: WebhookDelivery, requestId: string = randomUUID()): Promise<ApiResult> {
  return inRequest(requestId, () => dispatch(method, pathname, body, authorization, delivery, requestId));
}

async function dispatch(method: string, pathname: string, body: unknown, authorization: string | undefined, delivery: WebhookDelivery | undefined, requestId: string): Promise<ApiResult> {
  // A path the URL parser rejects (`//`, a stray space) names nothing that could exist.
  const url = URL.parse(pathname, 'http://localhost');
  const found = url === null ? undefined : matchRoute(method, url.pathname);
  if (url === null || found === undefined) return failure(404, requestId, { title: 'Not found', message: 'That API route does not exist. Nothing was saved.' });
  const { route, params } = found;
  annotate({ route: `${route.method} ${route.path}` });
  try {
    const runtime = apiRuntime();
    const raw = method === 'GET' ? { ...(body !== null && typeof body === 'object' ? body : {}), ...Object.fromEntries(url.searchParams) } : body;
    let reply: unknown;
    if (isPublic(route)) {
      reply = await route.handle({ input: await route.input.parseAsync(raw), params, runtime, requestId, delivery });
    } else {
      const context = runtime.authenticate(authorization);
      annotate({ company_id: context.companyId, user_id: context.actorId });
      const actor = runtime.actor(context);
      if (route.access.kind === 'gate') requirePermission(actor, route.access);
      const input = await route.input.parseAsync(raw);
      const app = await runtime.application(context);
      reply = await route.handle({ input, params, runtime, requestId, delivery, context, actor, app });
      if (route.list !== undefined) reply = pageOf(reply, route.list, input as Parameters<typeof pageOf>[2]);
    }
    if (!(reply instanceof Reply)) return withRequestId(json(200, reply), requestId);
    const result = reply.result;
    return withRequestId('json' in result ? json(result.status, result.json) : result, requestId);
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
  const pathname = (request.url ?? '/').split('?')[0]!;
  await inRequest(requestId, async () => {
    const result = await answer(request, response, method, pathname, requestId);
    send(response, result);
    // One line per request. The query string is left out: it can carry what a person typed.
    log.info('request', { method, path: pathname, status: result.status, duration_ms: Math.round(performance.now() - started) });
  });
}

const answer = async (request: IncomingMessage, response: ServerResponse, method: string, pathname: string, requestId: string): Promise<ApiResult> => {
  // Issue #349 — refused before the body is read, so a hostile page cannot even make us read it.
  if (!isSignedCallback(pathname) && isCrossSiteWrite(method, request.headers)) {
    return failure(403, requestId, { title: 'Nothing was saved', code: 'CROSS_SITE_REQUEST', message: 'This came from another website, so it was refused. Open Karobar itself and try again.' });
  }
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
  // The whole URL, query included: a GET's input is its query.
  return handleApi(method, request.url ?? '/', read.parsed, request.headers.authorization, {
    rawBody: read.raw,
    signature: typeof signature === 'string' ? signature : '',
  }, requestId);
}

export const apiServer = applyTimeouts(createServer(serveApi));

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.API_PORT ?? 4172);
  apiServer.listen(port, '127.0.0.1', () => log.info('The API is listening', { url: `http://127.0.0.1:${port}` }));
  // Issue #122: the host supplies the tick; the runner owns schedules, overlap and retry state.
  const recurringTimer = setInterval(() => {
    void apiRuntime().runRecurringWork().catch((error: unknown) => log.error('Recurring work tick failed; its queue state is available to operators', errorFields(error)));
  }, 60_000);
  recurringTimer.unref();
}

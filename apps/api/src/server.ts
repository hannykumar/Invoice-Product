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
import { matchRoute, ROUTES } from './routes/index.ts';
import { pageOf, Reply, type ApiResult, type Gate, type PublicRoute, type Route, type WebhookDelivery } from './routes/route.ts';

export type { ApiResult, WebhookDelivery } from './routes/route.ts';
export { ROUTES } from './routes/index.ts';

// Redaction happens on the finished text, not on the object: walking the object can only reach the
// shapes the walker recognises, and a secret carried by a class instance or a Map would walk past it.
export const jsonResponse = (status: number, body: unknown) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: redactSecretText(JSON.stringify(body, (_key, value) => typeof value === 'bigint' ? value.toString() : value) ?? '') });
const json = jsonResponse;

/**
 * Issue #280 — what each gated POST needs, read off the route table. Kept for the callers that
 * looked it up by path before the table existed (#344); `ROUTES` is the source.
 */
export const POST_PERMISSIONS: Readonly<Record<string, Omit<Gate, 'kind'>>> = Object.fromEntries(
  ROUTES.flatMap((route) => route.method === 'POST' && route.access.kind === 'gate' ? [[route.path, route.access]] : []),
);

const requirePermission = (actor: ActorContext, gate: Gate): void => {
  for (const permission of gate.all) permissionPortFromActor.require(actor, permission, gate.what);
  if (gate.any.length > 0 && !gate.any.some((permission) => actor.permissions.includes(permission))) permissionPortFromActor.require(actor, gate.any[0]!, gate.what);
};

/**
 * Errors the product raises on purpose to tell the shopkeeper what went wrong: their message is
 * written for the screen. A plain `Error` with no `code` is one too — about 88 throw sites in
 * packages/* speak to the shopkeeper that way (migrating them to DomainError is a follow-up).
 * Anything else — a TypeError, a RangeError, a file or database error — is a fault on our side.
 */
const SPOKEN_TO_THE_SHOPKEEPER = [MasterDataError, UnitConversionError, InboxError, ConnectorError, CurrencyMismatchError, UnitMismatchError];
const isMeantForTheScreen = (error: unknown): error is Error =>
  error instanceof Error && ((error.constructor === Error && !('code' in error)) || SPOKEN_TO_THE_SHOPKEEPER.some((kind) => error instanceof kind));

/** The status a known error answers with, or `undefined` for a fault on our side. */
const statusOf = (error: unknown): number | undefined => {
  if (error instanceof AuthenticationError) return 401;
  // A provider that signed its callback wrongly is told so, and told nothing else.
  if (error instanceof WebhookNotAuthenticated) return 401;
  if (error instanceof ZodError) return 400;
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
    // The detail goes to the log, never to the caller (#357 turns this into the structured logger).
    console.error(redactSecretText(JSON.stringify({ level: 'error', requestId, route: routeName, error: error instanceof Error ? error.name : typeof error, message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined })));
    return failure(500, requestId, {
      title: 'Something went wrong',
      code: 'INTERNAL',
      message: `Something went wrong on our side. Nothing was saved. Quote ${requestId} if you contact us.`,
    });
  }
  if (error instanceof ZodError) return failure(400, requestId, { title: 'Nothing was saved', code: 'INVALID_INPUT', message: invalidInputMessage(error) });
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

const REQUEST_ID = /^[A-Za-z0-9._:-]{8,64}$/;
/** A request id a proxy in front of us already gave, if it is one we can safely echo; otherwise a fresh one. */
export const requestIdOf = (given: unknown): string => typeof given === 'string' && REQUEST_ID.test(given) ? given : randomUUID();

/**
 * Issue #344 — serve one API call from the route table: match the route, sign the caller in, check
 * the permission (before reading the input, #280), validate the input, run the handler.
 * `pathname` may carry a `?query`; a GET's input is its query, merged over `body` for in-process callers.
 */
export async function handleApi(method: string, pathname: string, body: unknown = {}, authorization?: string, delivery?: WebhookDelivery, requestId: string = randomUUID()): Promise<ApiResult> {
  const url = new URL(pathname, 'http://localhost');
  const found = matchRoute(method, url.pathname);
  if (found === undefined) return failure(404, requestId, { title: 'Not found', message: 'That API route does not exist. Nothing was saved.' });
  const { route, params } = found;
  try {
    const runtime = apiRuntime();
    const raw = method === 'GET' ? { ...(body !== null && typeof body === 'object' ? body : {}), ...Object.fromEntries(url.searchParams) } : body;
    let reply: unknown;
    if (isPublic(route)) {
      reply = await route.handle({ input: await route.input.parseAsync(raw), params, runtime, requestId, delivery });
    } else {
      const context = runtime.authenticate(authorization);
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
 * to verify against a signature that was perfectly correct.
 */
const readBody = async (request: IncomingMessage): Promise<{ parsed: unknown; raw: string }> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return { parsed: {}, raw: '' };
  const raw = Buffer.concat(chunks).toString('utf8');
  return { parsed: JSON.parse(raw) as unknown, raw };
};

const send = (response: ServerResponse, result: ApiResult): void => {
  response.writeHead(result.status, result.headers);
  response.end(result.body);
};

export async function serveApi(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const requestId = requestIdOf(request.headers['x-request-id']);
  let read: { parsed: unknown; raw: string };
  try { read = await readBody(request); }
  catch { return send(response, failure(400, requestId, { title: 'Nothing was saved', code: 'INVALID_INPUT', message: 'Nothing was saved, because what was sent is not valid JSON.' })); }
  const signature = request.headers['x-provider-signature'];
  send(response, await handleApi(request.method ?? 'GET', request.url ?? '/', read.parsed, request.headers.authorization, {
    rawBody: read.raw,
    signature: typeof signature === 'string' ? signature : '',
  }, requestId));
}

export const apiServer = createServer(serveApi);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.API_PORT ?? 4172);
  apiServer.listen(port, '127.0.0.1', () => console.log(`Karobar API: http://127.0.0.1:${port}`));
  // Issue #122: the host supplies the tick; the runner owns schedules, overlap and retry state.
  const recurringTimer = setInterval(() => {
    void apiRuntime().runRecurringWork().catch(() => console.error('Recurring work tick failed; its queue state is available to operators.'));
  }, 60_000);
  recurringTimer.unref();
}

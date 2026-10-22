/**
 * Issue #344 — the only way to declare an API route. Every route names its method, its path, the
 * shape of what it accepts, and who may call it; the type will not let one be declared without all
 * four. `apps/api/src/routes/index.ts` collects them into `ROUTES`, which the dispatcher in
 * `server.ts` serves and the tests enumerate. See docs/api-conventions.md.
 */
import { z } from 'zod';
import type { ActorContext } from '@invoice/ledger';
import type { Permission, RequestContext } from '../../../../packages/platform/src/index.ts';
import type { ApiRuntime } from '../runtime.ts';
import type { DemoApplication } from '../demo-application.ts';

export { z };

export interface WebhookDelivery {
  /** The bytes exactly as they arrived: a signature is over what was sent, not over its meaning. */
  readonly rawBody: string;
  readonly signature: string;
}

export interface ApiResult { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: string | Buffer; }

/**
 * Issue #280 — what a route needs, checked before its input is read. `all` must every one be held;
 * `any` needs one of them (the service then checks the exact one, e.g. a quotation against a proforma).
 */
export interface Gate { readonly kind: 'gate'; readonly what: string; readonly all: readonly Permission[]; readonly any: readonly Permission[] }
/** No session at all: the caller has none yet (signing in) or proves itself another way (a signed webhook). */
export interface Public { readonly kind: 'public'; readonly reason: string }
/** Any signed-in member of the company. Today's rule for reads; #343 tightens them one by one. */
export interface SignedIn { readonly kind: 'signedIn'; readonly reason: string }
export type Access = Gate | Public | SignedIn;

export const need = (what: string, ...all: Permission[]): Gate => ({ kind: 'gate', what, all, any: [] });
export const needAny = (what: string, ...any: Permission[]): Gate => ({ kind: 'gate', what, all: [], any });
export const publicRoute = (reason: string): Public => ({ kind: 'public', reason });
export const signedIn = (reason: string): SignedIn => ({ kind: 'signedIn', reason });
/** Today's rule for every read. #343 replaces it route by route with the permission each one needs. */
export const READ = signedIn('any signed-in member may read this; the service checks what they may see (#343 tightens it)');

/** What every handler is given. `params` are the `:name` parts of the path, already decoded. */
export interface PublicCall<I> {
  readonly input: I;
  readonly params: Readonly<Record<string, string>>;
  readonly runtime: ApiRuntime;
  readonly requestId: string;
  readonly delivery: WebhookDelivery | undefined;
  /** The session the caller sent, if any (`Bearer …`). Public routes may only end it, never use it. */
  readonly authorization?: string | undefined;
}
export interface SessionCall<I> extends PublicCall<I> {
  readonly context: RequestContext;
  readonly actor: ActorContext;
  readonly app: DemoApplication;
}

/** A reply that is not `200` + JSON: a file, or a status of the handler's own choosing. */
export class Reply {
  readonly result: ApiResult | { readonly status: number; readonly json: unknown; readonly setCookie?: string };
  constructor(result: Reply['result']) { this.result = result; }
}
export const replyJson = (status: number, json: unknown): Reply => new Reply({ status, json });
/** Issue #342 — a JSON reply that also sets (or clears) the session cookie. */
export const replyWithCookie = (json: unknown, setCookie: string): Reply => new Reply({ status: 200, json, setCookie });
export const replyPdf = (fileName: string, pdf: Buffer): Reply => new Reply({
  status: 200,
  headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${fileName}"`, 'cache-control': 'private, no-store' },
  body: pdf,
});

export type Method = 'GET' | 'POST';
// The handler's input type is erased once a route is in the table; it was checked where it was declared.
type AnyInput = any;
interface RouteBase {
  readonly method: Method;
  readonly path: string;
  readonly input: z.ZodType<unknown, z.ZodTypeDef, unknown>;
  /** On a list route, the key of the array the dispatcher pages with `cursor` and `limit`. */
  readonly list?: string;
}
export interface PublicRoute extends RouteBase { readonly access: Public; handle(call: PublicCall<AnyInput>): unknown }
export interface SessionRoute extends RouteBase { readonly access: Gate | SignedIn; handle(call: SessionCall<AnyInput>): unknown }
export type Route = PublicRoute | SessionRoute;

interface Declared<S extends z.ZodTypeAny, A extends Access> { readonly input: S; readonly access: A }
type Handler<S extends z.ZodTypeAny, A extends Access> = (call: A extends Public ? PublicCall<z.output<S>> : SessionCall<z.output<S>>) => unknown;

const declare = (method: Method) => <S extends z.ZodTypeAny, A extends Access>(path: string, declared: Declared<S, A>, handle: Handler<S, A>): Route =>
  ({ method, path, input: declared.input, access: declared.access, handle } as Route);

/** `get('/api/x', { access, input }, ({ app, actor, input }) => …)`. For a GET, `input` is the query string. */
export const get = declare('GET');

/**
 * A list: the handler returns the whole response, and the dispatcher hands back one page of the
 * array under `key`, with `nextCursor` when there is more. Its input is always `paged`.
 */
export const list = (path: string, declared: { readonly access: Gate | SignedIn; readonly key: string }, handle: Handler<typeof paged, Gate | SignedIn>): Route =>
  ({ method: 'GET', path, input: paged, access: declared.access, list: declared.key, handle } as Route);
/** `post('/api/x', { access, input }, ({ app, actor, input }) => …)`. For a POST, `input` is the JSON body. */
export const post = declare('POST');

// ── Lenient field types ──────────────────────────────────────────────────────────────────────────
// Decision D4: Zod at the HTTP boundary, and lenient on purpose. Every service below already reads
// its input defensively (`String(input.x ?? '')`) and answers a missing or wrong value with a
// shopkeeper's 422, so the boundary refuses only what no service could read: a body that is not an
// object, or a list or object where one value belongs. Fields are optional for the same reason.

/** One value the service turns into text or a number itself: `'10.5'` and `10.5` are both fine. */
export const text = z.union([z.string(), z.number(), z.bigint(), z.boolean(), z.null()]).optional();
/** A yes/no the service reads as `=== true` (or a value it ignores otherwise). */
export const flag = z.unknown();
/** A field whose shape the service decides (lines, column maps, a list or its JSON text). */
export const anything = z.unknown();

/** The body of a POST, or the query of a GET: an object carrying at least these fields. Extra fields pass. */
export const fields = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();
/** A route that reads nothing from its input. */
export const nothing = fields({});

// ── Pagination ───────────────────────────────────────────────────────────────────────────────────
export const PAGE_LIMIT_DEFAULT = 200;
export const PAGE_LIMIT_MAX = 500;

/** `cursor` and `limit` on every list. */
export const paged = fields({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).optional(),
});

const encodeCursor = (offset: number): string => Buffer.from(`o:${offset}`).toString('base64url');
const decodeCursor = (cursor: string | undefined): number => {
  if (cursor === undefined || cursor === '') return 0;
  const match = /^o:(\d{1,9})$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (match === null) throw new z.ZodError([{ code: 'custom', path: ['cursor'], message: 'is not a cursor this list gave out' }]);
  return Number(match[1]);
};

/**
 * One page of `items`, and the cursor for the next (absent on the last page).
 * ponytail: an offset over an in-memory array, because the lists still live in memory. Once they
 * come from Postgres (#340/#366) this becomes a keyset cursor; the wire format does not change.
 */
export const page = <T>(items: readonly T[], input: { readonly cursor?: string | undefined; readonly limit?: number | undefined }): { items: T[]; nextCursor?: string } => {
  const offset = decodeCursor(input.cursor);
  const limit = input.limit ?? PAGE_LIMIT_DEFAULT;
  const slice = items.slice(offset, offset + limit);
  return offset + limit < items.length ? { items: slice, nextCursor: encodeCursor(offset + limit) } : { items: slice };
};

/** A list response whose array sits under `key`, paged in place: `{ ...rest, [key]: page, nextCursor? }`. */
export const pageOf = (response: unknown, key: string, input: { readonly cursor?: string | undefined; readonly limit?: number | undefined }): Record<string, unknown> => {
  const items = response !== null && typeof response === 'object' ? (response as Record<string, unknown>)[key] : undefined;
  if (!Array.isArray(items)) throw new TypeError(`The list route's "${key}" is not an array.`);
  const { items: slice, nextCursor } = page(items, input);
  return { ...(response as Record<string, unknown>), [key]: slice, ...(nextCursor === undefined ? {} : { nextCursor }) };
};

# API conventions

Issue #344. How every route in `apps/api` is declared, what it accepts, and how it answers. Decision
D4 (ADR 0004): input is validated with Zod **at the HTTP boundary only**; `packages/*` stay free of it.

## Declaring a route

Every route lives in one of the group files under `apps/api/src/routes/` (`core`, `sales`, `gst`,
`purchasing`, `money`) and is collected into `ROUTES` in `routes/index.ts`. The server serves exactly
that table; nothing else answers. A route is declared with `get`, `post` or `list` from `routes/route.ts`,
which require all four of:

| Part | What it is |
| --- | --- |
| method | `GET` reads; `POST` does or previews something |
| path | `/api/<area>/<thing>[/<action>]`, with `:name` for an id taken from the path |
| `input` | a Zod schema for the POST body or the GET query |
| `access` | `need(what, ...permissions)`, `needAny(what, ...permissions)`, `signedIn(reason)` or `publicRoute(reason)` |

```ts
post('/api/sales/cancel', { access: need('cancel a bill', 'sales.cancel'), input: fields({ invoice: text, reason: text }) },
  ({ app, actor, input }) => app.cancelSale(actor, input)),
```

Handlers stay thin: they pass the validated input to an application service, and business rules
stay in `packages/*`. A handler returns the value to send as `200` JSON, or a `Reply`
(`replyJson(status, body)`, `replyPdf(fileName, bytes)`) for anything else.

### Access

- `need(what, ...all)`: every permission is required. `what` finishes the sentence "You cannot …"
  in the refusal, so write it for the shopkeeper.
- `needAny(what, ...any)`: one of them is enough; the service checks the exact one.
- `signedIn(reason)`: any member of the company. Today's rule for reads; #343 tightens them.
- `publicRoute(reason)`: no session. Only signing in, the status check and the signed government
  webhook are public. `apps/api/test/route-permissions.test.ts` fails on any other.

The order is fixed: match the route → sign the caller in → check the permission → validate the input
→ run the handler. The permission is checked **before** the input is read (#280), so a viewer
sending an empty or malformed body is told 403, not 400 or 422.

### Tenancy

The company, the user and their permissions come from the session (`RequestContext`, through
`runtime.authenticate`), never from the request. Apart from signing in, a company id in a body or query is ignored. An
id from another company in a path answers 404, the same as an id that does not exist.

## Input validation

The boundary is deliberately lenient. Every service already reads its input defensively and answers
a missing or wrong value with a shopkeeper's 422, so the boundary refuses only what no service could
read. The field types in `routes/route.ts` are:

- `fields({...})`: an object carrying at least these fields. Extra fields pass through.
- `text`: one value (string, number, boolean or null). `'10.5'` and `10.5` are both accepted.
- `anything` / `flag`: a field whose shape the service decides, such as `lines`, column maps, or
  `bills` sent either as a list or as its JSON text.
- Fields are optional unless the boundary is the only thing that could catch the problem.

A field is made stricter only after reading the handler and every caller (the web app, the tests).
Never guess stricter.

## Lists

Every list route is declared with `list(path, { access, key }, handler)`. The handler returns the
whole response, and the dispatcher returns one page of the array under `key`:

- `?limit=` is 1–500, default 200.
- `?cursor=` is the `nextCursor` from the previous page. It is opaque: do not build one.
- `nextCursor` is present only while there is more.

The cursor is currently an offset over in-memory arrays, marked `ponytail:`. Once the lists come from
Postgres (#340/#366) it becomes a keyset cursor, and the wire format stays the same.

## Replies and errors

Every reply carries an `x-request-id` header. A request id a proxy already set (8–64 of
`A-Z a-z 0-9 . _ : -`) is kept; otherwise a new one is made. Every failure has one shape:

```json
{ "state": "failed", "title": "Nothing was saved", "code": "INVALID_INPUT",
  "message": "Nothing was saved, because part of what was sent could not be read: reason should be a single value, not a list or a group.",
  "details": {}, "requestId": "6f1c…" }
```

`code` and `details` appear only when there is something to say. `details` carries the facts behind
a refusal (#262), never secrets.

| Status | When |
| --- | --- |
| 400 | The body is not JSON or not an object, a field has the wrong shape (`INVALID_INPUT`), or the product refused with a plain message meant for the screen (see below) |
| 401 | Not signed in, the session has ended, or a webhook signature is wrong |
| 403 | Signed in, but without the permission (`FORBIDDEN`) |
| 404 | No such route, or no such record in this company |
| 409 | Conflicts with the current state: already done, already cancelled, the month is filed |
| 422 | Understood but refused by a business rule (`DomainError`), for example a GST number that does not check out |
| 429 | Too many requests (reserved for #349's limits) |
| 500 | A fault on our side (`INTERNAL`) |

A **500** says only "Something went wrong on our side. Nothing was saved. Quote `<requestId>` if you
contact us." The error's name, message and stack go to the log under the same request id, and never
to the caller.

"Meant for the screen" means a `DomainError` or `PlatformError` (mapped by kind), one of the product's
own error classes listed in `server.ts` (`MasterDataError`, `UnitConversionError`, `InboxError`,
`ConnectorError`, `CurrencyMismatchError`, `UnitMismatchError`), or a plain `Error` with no `code`.
About 88 throw sites in `packages/*` still use a plain `Error` to speak to the shopkeeper, so it
keeps its 400 and its message. Moving them to `DomainError` is follow-up work. Anything else
(`TypeError`, `RangeError`, a file or database error) is a 500.

## Adding a route

1. Add it to the group file for its area, next to its neighbours, with the issue number in a comment.
2. Give it the narrowest `access` that fits. A new `signedIn` or public POST fails
   `route-permissions.test.ts` until it is added to that file's allow-list, with a reason.
3. Declare the fields the handler reads, typed as leniently as the service allows.
4. If it returns a list, use `list(...)`.
5. Test it through `handleApi(method, path, body, authorization)`, including a refusal for someone
   without the permission and a cross-company id if it takes one.

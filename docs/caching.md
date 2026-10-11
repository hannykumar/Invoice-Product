# Caching (issue #360)

One rule above all the others: **a cache must never show one company another company's figures.**
Caching is added only where a load test (#361) has measured a slow read. Until then the only cache
that is switched on is the one for static files, which hold no company data.

## The three rules

1. **Any cache that holds company data has `company_id` in its key**, taken from the signed-in
   session (`RequestContext`), never from the request body or URL.
2. **Nothing behind sign-in is cached at a shared layer** (CDN, reverse proxy, shared browser
   cache). Every `/api/*` response is `Cache-Control: no-store`; PDFs are `private, no-store`.
3. **Effective-dated compliance rules are cached by version, never as "latest".** The key is the
   rule-set id and version (e.g. `gst-rate@2025-09-22`). A new notification is a new version, so it
   is a new key; nothing is invalidated, and an old decision still replays against the version it
   recorded (`packages/rules-engine`).

## What is cached, where, for how long

| Kind | Where | TTL | Key | Invalidated by |
| --- | --- | --- | --- | --- |
| Scripts and styles (`app.js`, `styles.css`, …) | Browser and CDN | 1 year, `immutable` | Content hash in the file name, `/app.<sha256-12>.js` | A deploy: new content → new hash → new name. The old name is never reused. |
| The shell (`/`, `index.html`) and unhashed files (`done-screen.js`) | Browser, CDN may hold but must revalidate | `no-cache` (revalidate every load) | URL + `ETag` (content hash) | Content change → new `ETag` → `200` instead of `304` |
| Public pages (sign-in is inside the shell; terms and privacy once #55 adds them) | Same as the shell | `no-cache` | URL + `ETag` | Deploy |
| API responses (`/api/*`) | **Nowhere** | `no-store` | — | — |
| PDFs (bills, e-way bills) | **Nowhere** | `private, no-store` | — | — |
| Expensive queries (reports, GST return prepare, stock) | **Not cached yet.** If #361 proves one slow: in the app, in Postgres (D6) | Short, and dropped on every write | `company_id` + query + its inputs (period, filters) | Every write to that company's books drops that company's entries; nothing else |
| Third-party results: GSTIN status | App store `GstinCacheRepository` (`packages/purchasing`) | 60 min (`cacheMinutes`) | `company_id \| gstin` | TTL, or the user asks for a fresh check (`refresh`) |
| Third-party results: vehicle record | App store `VehicleRecordCacheRepository` (`packages/transport`) | Until replaced | `company_id \| normalised registration` | A new lookup, or `forget` |
| Compliance rules, HSN/SAC and rates | Not cached today; loaded by version. If cached, in process | Forever per version | `rule-set id @ version` | Never — a change is a new version |

Why GSTIN results are kept per company even though the GST portal's answer is public: the lookup
is billed and audited to the company that asked, and a shared key would let one company learn
which suppliers another one deals with.

## Headers, one example of each kind

Captured from `npm run web` on this branch.

A hashed script — kept for a year by the browser and any CDN:

```
GET /app.5c6d09e08f55.js
HTTP/1.1 200 OK
cache-control: public, max-age=31536000, immutable
etag: "5c6d09e08f55"
```

The shell — always asked again, usually answered with an empty `304`:

```
GET /
HTTP/1.1 200 OK
content-type: text/html; charset=utf-8
cache-control: no-cache
etag: "49ffeb1d1791"

GET /styles.css   (If-None-Match: <its etag>)
HTTP/1.1 304 Not Modified
```

A page from the previous deploy asking for a hash that no longer exists gets today's file with
`no-cache`, so a stale name is never pinned for a year.

An API response — never stored by anyone:

```
GET /api/session
HTTP/1.1 401 Unauthorized
cache-control: no-store
```

## CDN

When #356 puts Karobar behind a CDN, configure it to:

- respect origin `Cache-Control` (do not override it);
- cache only `GET` responses whose `Cache-Control` says `public`;
- **bypass the cache for `/api/*` and for any request carrying a session cookie or
  `Authorization` header**, as a second wall behind `no-store`.

## Application caching, when #361 asks for it

Not built until a measured bottleneck names a read. When it does:

- the cache lives in Postgres (decision D6), so two API instances see the same entries and a
  write on one instance invalidates for both;
- the key starts with the session's `company_id`; a helper that builds keys without one does not
  compile;
- every command that writes a company's books drops that company's entries in the same transaction;
- the test that ships with it signs in as two companies and asserts neither ever receives the
  other's cached answer, including after refreshes.

# D2 — Session transport: HttpOnly cookie

- **Status:** Accepted, 7 Oct 2026
- **Decision id:** D2 (tracking issue #362, recorded by #339)
- **Who chose:** Chosen by the agent on the recommendation; the owner did not evaluate it technically — revisit if a reason appears.
- **Product impact:** none. This changes how Karobar is built underneath, not what it does for the shopkeeper.

## Context

The web app keeps a bearer token in `localStorage["karobar.session"]` (`apps/web/app.js`). Any
script injected into the page can read it and take over the account.

## Decision

- The session is an **opaque random id** (our own session row, D1) in a cookie with
  `HttpOnly; Secure; SameSite=Lax; Path=/`. Name prefixed `__Host-`.
- Every state-changing request (non-GET) checks that `Origin` (or `Referer`) matches our host.
- The token is removed from `localStorage` and from the `authorization` header in `app.js`.
- Sessions expire after inactivity and absolutely (today 8 hours in `auth.ts`), and can be revoked
  server-side.

## Alternatives

- **Token in JavaScript memory with a refresh cookie.** More moving parts, and the token is still
  readable by injected script while the page is open.
- **Keep `localStorage`.** Fails the security gate.

## Consequences

- Injected script can no longer steal a session. CSRF is handled by `SameSite` plus the Origin
  check.
- Web and API must be served from the same site (they already are: `apps/web/server.ts` proxies
  `/api`).

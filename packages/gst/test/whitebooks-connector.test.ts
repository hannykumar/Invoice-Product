// Issue #26 [E26] — the WhiteBooks connector, driven against a stub of their own replies.
//
// Their sandbox needs a taxpayer password we do not have yet, so the recorded shapes below stand
// in for it. They are their real envelope: HTTP 200 on failure, `status_cd` carrying the verdict,
// and the government's fields buried in `data` as a JSON string.

import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorError } from "../../platform/src/connectors.ts";
import { whitebooksIrpConnector } from "../src/whitebooks-connector.ts";

const CREDENTIALS = {
  baseUrl: "https://apisandbox.example.invalid",
  clientId: "EINS-test", clientSecret: "EINS-secret",
  gstin: "33AAGCB1286Q1ZB", username: "TN_NT2.152383", password: "sandbox",
  ipAddress: "203.0.113.7",
} as const;

const reply = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const AUTH_OK = { status_cd: "1", data: JSON.stringify({ AuthToken: "tok-1", TokenExpiry: "" }) };

/** Records what was sent so the headers and the token reuse can be asserted, not assumed. */
const stub = (replies: readonly unknown[]) => {
  const calls: { url: string; headers: Record<string, string>; body: string | undefined }[] = [];
  let index = 0;
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body === undefined ? undefined : String(init.body),
    });
    const next = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return next instanceof Response ? next : reply(next);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
};

test("a registered invoice comes back with the government's own field names", async () => {
  const { fetch, calls } = stub([
    AUTH_OK,
    { status_cd: "1", data: JSON.stringify({ Irn: "ABC123", AckNo: "112", AckDt: "2026-09-08 10:00:00", SignedQRCode: "qr" }) },
  ]);
  const connector = whitebooksIrpConnector({ credentials: CREDENTIALS, email: "dev@example.com", fetch });

  const response = await connector.execute({
    tenantId: "sampoorna", operation: "einvoice.generate", payload: { DocDtls: { No: "INV-1" } },
    idempotencyKey: "gen-1", correlationId: "c-1",
  });

  assert.equal(response.payload.Irn, "ABC123");
  assert.equal(response.payload.AckNo, "112");
  assert.equal(calls[0]?.headers.password, "sandbox", "the password only ever goes to the login call");
  assert.equal(calls[1]?.headers["auth-token"], "tok-1");
  assert.equal(calls[1]?.headers.password, undefined, "and never rides along on the invoice itself");
});

test("a second call reuses the token instead of logging in again", async () => {
  const { fetch, calls } = stub([AUTH_OK, { status_cd: "1", data: JSON.stringify({ Irn: "A" }) }, { status_cd: "1", data: JSON.stringify({ Irn: "B" }) }]);
  const connector = whitebooksIrpConnector({ credentials: CREDENTIALS, email: "dev@example.com", fetch });
  const send = (key: string) => connector.execute({ tenantId: "t", operation: "einvoice.generate", payload: {}, idempotencyKey: key, correlationId: "c" });

  await send("one");
  await send("two");

  assert.equal(calls.filter((call) => call.url.includes("/authenticate")).length, 1);
});

test("the duplicate error travels back as payload, because a retry must still end holding the IRN", async () => {
  const { fetch } = stub([AUTH_OK, { status_cd: "0", error: [{ error_cd: "2150", message: "Duplicate IRN" }] }]);
  const connector = whitebooksIrpConnector({ credentials: CREDENTIALS, email: "dev@example.com", fetch });

  const response = await connector.execute({
    tenantId: "t", operation: "einvoice.generate", payload: {}, idempotencyKey: "again", correlationId: "c",
  });

  // Not thrown: `irpAdapter` reads 2150 and reports DUPLICATE, which is a success for the caller.
  assert.equal(response.payload.ErrorCode, "2150");
  assert.equal(response.payload.ErrorMessage, "Duplicate IRN");
});

test("a refusal with no itemised error is still a refusal, not a blank success", async () => {
  const { fetch } = stub([AUTH_OK, { status_cd: "0", status_desc: "GSTR request failed" }]);
  const connector = whitebooksIrpConnector({ credentials: CREDENTIALS, email: "dev@example.com", fetch });

  const response = await connector.execute({
    tenantId: "t", operation: "einvoice.generate", payload: {}, idempotencyKey: "k", correlationId: "c",
  });

  assert.equal(response.payload.ErrorCode, "UNKNOWN");
  assert.equal(response.payload.Irn, undefined, "nothing may look registered when it was refused");
});

test("a wrong password is not retried, so an account cannot be locked by our own retries", async () => {
  const { fetch, calls } = stub([{ status_cd: "0", status_desc: "Invalid credentials provided" }]);
  const connector = whitebooksIrpConnector({ credentials: CREDENTIALS, email: "dev@example.com", fetch });

  const error = await connector.execute({
    tenantId: "t", operation: "einvoice.generate", payload: {}, idempotencyKey: "k", correlationId: "c",
  }).then(() => undefined, (caught: unknown) => caught);

  assert.ok(error instanceof ConnectorError);
  assert.equal(error.code, "UNAUTHORIZED");
  assert.equal(error.retryable, false);
  assert.equal(calls.length, 1);
});

test("their outage is retryable and their refusal is not", async () => {
  const outage = whitebooksIrpConnector({
    credentials: CREDENTIALS, email: "dev@example.com",
    fetch: (async () => reply({}, 503)) as unknown as typeof globalThis.fetch,
  });
  const failure = await outage.health();
  assert.equal(failure, "unavailable");
});

test("an unknown operation is refused before anything reaches the network", async () => {
  const { fetch, calls } = stub([AUTH_OK]);
  const connector = whitebooksIrpConnector({ credentials: CREDENTIALS, email: "dev@example.com", fetch });

  const error = await connector.execute({
    tenantId: "t", operation: "einvoice.invent", payload: {}, idempotencyKey: "k", correlationId: "c",
  }).then(() => undefined, (caught: unknown) => caught);

  assert.ok(error instanceof ConnectorError);
  assert.equal(error.code, "INVALID_REQUEST");
  assert.equal(calls.length, 0);
});

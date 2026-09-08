// Issue #27 — WhiteBooks as the e-way bill portal, driven against recorded replies.
//
// The shapes below are theirs, taken from live sandbox calls on 9 September 2026.

import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorError } from "../../platform/src/connectors.ts";
import { whitebooksEwayConnector } from "../src/whitebooks-eway-connector.ts";

const CREDENTIALS = {
  baseUrl: "https://apisandbox.example.invalid",
  clientId: "EWBS-test", clientSecret: "EWBS-secret",
  gstin: "33AAGCB1286Q003", username: "BVMTN", password: "sandbox",
  ipAddress: "203.0.113.7",
} as const;

const stub = (replies: readonly unknown[]) => {
  const calls: { url: string; headers: Record<string, string>; body: string | undefined }[] = [];
  let index = 0;
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body === undefined ? undefined : String(init.body) });
    const next = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return new Response(JSON.stringify(next), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
};

const connectorWith = (replies: readonly unknown[]) => {
  const { fetch, calls } = stub(replies);
  return { connector: whitebooksEwayConnector({ credentials: CREDENTIALS, email: "dev@example.com", fetch }), calls };
};

test("a generated bill comes back with the portal's own field names, and the number survives as text", async () => {
  // ewayBillNo arrives as a number; the adapter above reads these as strings.
  const { connector, calls } = connectorWith([{
    irp: "NIC1", status_cd: "1", status_desc: "EWAYBILL request succeeds",
    data: { ewayBillNo: 501009126912, ewayBillDate: "09/09/2026 04:06:00 AM", validUpto: "15/09/2026 11:59:00 PM", alert: "" },
  }]);

  const response = await connector.execute({
    tenantId: "t", operation: "eway.generate", payload: { docNo: "EWB/1" }, idempotencyKey: "k", correlationId: "c",
  });

  assert.equal(response.payload.ewayBillNo, "501009126912");
  assert.equal(response.payload.validUpto, "15/09/2026 11:59:00 PM");
  assert.equal(calls.length, 1, "no login call: this lane wants no token");
  assert.equal(calls[0]?.headers.password, "sandbox", "the password rides on the call itself");
  assert.ok(!String(calls[0]?.body).includes("sandbox"), "and never reaches the body");
});

test("a refusal explains itself in words, because the readable part is not where the code is", async () => {
  // Live reply: errorMessage merely repeats the code, and the sentence is in `info`.
  const { connector } = connectorWith([{
    irp: "NIC1", status_cd: "0",
    error: [{ errorCode: "702", errorMessage: "702" }],
    info: ", The distance between the pincodes given is too high or low",
  }]);

  const response = await connector.execute({
    tenantId: "t", operation: "eway.generate", payload: {}, idempotencyKey: "k", correlationId: "c",
  });

  assert.equal(response.payload.ErrorCode, "702");
  assert.equal(response.payload.ErrorMessage, "The distance between the pincodes given is too high or low");
});

test("a refusal never looks like a bill that was raised", async () => {
  const { connector } = connectorWith([{ status_cd: "0", status_desc: "Missing mandatory parameters : ewbNo" }]);

  const response = await connector.execute({
    tenantId: "t", operation: "eway.generate", payload: {}, idempotencyKey: "k", correlationId: "c",
  });

  assert.equal(response.payload.ewayBillNo, undefined);
  assert.equal(response.payload.ErrorCode, "UNKNOWN");
});

test("a fetch puts the bill number in the query, not in a body", async () => {
  const { connector, calls } = connectorWith([{ status_cd: "1", data: { ewayBillNo: 501009126912 } }]);

  await connector.execute({ tenantId: "t", operation: "eway.fetch", payload: { ewbNo: "501009126912" }, idempotencyKey: "k", correlationId: "c" });

  assert.match(calls[0]?.url ?? "", /getewaybill\?ewbNo=501009126912/);
  assert.equal(calls[0]?.body, undefined);
});

test("every operation the adapter sends has a route, and an invented one never reaches the network", async () => {
  const operations = ["eway.generate", "eway.fetch", "eway.vehicle", "eway.transporter", "eway.extend", "eway.cancel", "eway.reject", "eway.consolidate"];
  const { connector, calls } = connectorWith([{ status_cd: "1", data: {} }]);

  for (const operation of operations) {
    await connector.execute({ tenantId: "t", operation, payload: {}, idempotencyKey: operation, correlationId: "c" });
  }
  assert.equal(calls.length, operations.length);
  // Lower case, which is the whole difference between a working route and WB_ERR_9404.
  assert.ok(calls.every((call) => !/[A-Z]/.test(new URL(call.url).pathname.split("/").pop() ?? "")));

  const error = await connector.execute({
    tenantId: "t", operation: "eway.invent", payload: {}, idempotencyKey: "k", correlationId: "c",
  }).then(() => undefined, (caught: unknown) => caught);

  assert.ok(error instanceof ConnectorError);
  assert.equal(error.code, "INVALID_REQUEST");
  assert.equal(calls.length, operations.length, "nothing was sent");
});

test("a fetch finds the bill, though the portal renames the number on the way back", async () => {
  // Live quirk: generation answers `ewayBillNo`, a fetch answers `ewbNo`. Untranslated, a bill that
  // exists reads as NOT_FOUND — and someone raises a second bill for goods already carrying one.
  const { connector } = connectorWith([{
    irp: "NIC1", status_cd: "1",
    data: { ewbNo: 571009126913, ewayBillDate: "09/09/2026 04:19:00 AM", validUpto: "15/09/2026 11:59:00 PM", status: "CNL" },
  }]);

  const response = await connector.execute({
    tenantId: "t", operation: "eway.fetch", payload: { ewbNo: "571009126913" }, idempotencyKey: "k", correlationId: "c",
  });

  assert.equal(response.payload.ewayBillNo, "571009126913", "under the name the adapter above reads");
  assert.equal(response.payload.status, "CNL");
});

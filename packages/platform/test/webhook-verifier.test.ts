/**
 * Issue #389 — a provider callback is authenticated by an HMAC over its raw bytes, inside a time
 * window, and must have the callback's shape. The publicly known `test-signature` verifier cannot
 * be constructed outside development and tests.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  ConnectorError,
  ConnectorGateway,
  HmacWebhookVerifier,
  MockConnector,
  NoWebhooksVerifier,
  StaticWebhookVerifier,
  WEBHOOK_TOLERANCE_SECONDS,
  isLocalEnvironment,
  parseConnectorWebhook,
  signWebhook,
  type WebhookSigningSecrets,
} from "../src/connectors.ts";

const NOW = new Date("2026-08-17T04:30:00.000Z");
const SECRET = "irp-signing-secret-for-tests";
const body = JSON.stringify({ eventId: "evt-1", providerRequestId: "p-1", occurredAt: "2026-08-17T04:29:00.000Z", payload: { Irn: "irn-1" } });
const secretsFor = (map: Partial<Record<string, readonly string[]>>): WebhookSigningSecrets => ({ async webhookSecrets(kind) { return map[kind] ?? []; } });
const verifier = (map: Partial<Record<string, readonly string[]>> = { irp: [SECRET] }) => new HmacWebhookVerifier(secretsFor(map), () => NOW);
const refused = (code: ConnectorError["code"]) => (error: unknown) => error instanceof ConnectorError && error.code === code;
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

test("a body signed with the provider's secret within the window is accepted and parsed", async () => {
  const webhook = await verifier().verify("irp", body, signWebhook(SECRET, body, NOW));
  assert.equal(webhook.eventId, "evt-1");
  assert.deepEqual(webhook.payload, { Irn: "irn-1" });
});

test("the literal test-signature, an empty header and garbage are refused", async () => {
  for (const header of ["test-signature", "", "t=1,v1=zz", "v1=" + "a".repeat(64), `t=${Math.floor(NOW.getTime() / 1000)}`]) {
    await assert.rejects(verifier().verify("irp", body, header), refused("UNAUTHORIZED"), header);
  }
});

test("a wrong secret, another provider's secret, or changed bytes do not verify", async () => {
  await assert.rejects(verifier().verify("irp", body, signWebhook("guess", body, NOW)), refused("UNAUTHORIZED"));
  // Signed correctly for the e-way bill provider, delivered to the IRP's door.
  const two = verifier({ irp: [SECRET], eway_bill: ["eway-secret"] });
  await assert.rejects(two.verify("irp", body, signWebhook("eway-secret", body, NOW)), refused("UNAUTHORIZED"));
  await assert.rejects(verifier().verify("irp", `${body} `, signWebhook(SECRET, body, NOW)), refused("UNAUTHORIZED"));
  // The timestamp is signed too: moving it into the window breaks the signature.
  const old = signWebhook(SECRET, body, at(-3600)).replace(/t=\d+/, `t=${Math.floor(NOW.getTime() / 1000)}`);
  await assert.rejects(verifier().verify("irp", body, old), refused("UNAUTHORIZED"));
});

test("a connector with no secret refuses everything", async () => {
  await assert.rejects(verifier({}).verify("irp", body, signWebhook(SECRET, body, NOW)), refused("UNAUTHORIZED"));
  await assert.rejects(verifier({ irp: [""] }).verify("irp", body, signWebhook("", body, NOW)), refused("UNAUTHORIZED"));
});

test("a timestamp outside the window either way is refused; at the edge it is accepted", async () => {
  await assert.rejects(verifier().verify("irp", body, signWebhook(SECRET, body, at(-WEBHOOK_TOLERANCE_SECONDS - 1))), refused("UNAUTHORIZED"));
  await assert.rejects(verifier().verify("irp", body, signWebhook(SECRET, body, at(WEBHOOK_TOLERANCE_SECONDS + 1))), refused("UNAUTHORIZED"));
  assert.equal((await verifier().verify("irp", body, signWebhook(SECRET, body, at(-WEBHOOK_TOLERANCE_SECONDS)))).eventId, "evt-1");
});

test("while a secret is rotated, either the old or the new one verifies", async () => {
  const rotating = verifier({ irp: ["old-secret", "new-secret"] });
  assert.equal((await rotating.verify("irp", body, signWebhook("old-secret", body, NOW))).eventId, "evt-1");
  assert.equal((await rotating.verify("irp", body, signWebhook("new-secret", body, NOW))).eventId, "evt-1");
});

test("a correctly signed body that is not a callback is refused before anything reads it", async () => {
  const shapes = [
    "not json",
    "[]",
    JSON.stringify({ providerRequestId: "p", occurredAt: "2026-08-17T00:00:00Z", payload: {} }),
    JSON.stringify({ eventId: "", providerRequestId: "p", occurredAt: "2026-08-17T00:00:00Z", payload: {} }),
    JSON.stringify({ eventId: "e".repeat(201), providerRequestId: "p", occurredAt: "2026-08-17T00:00:00Z", payload: {} }),
    JSON.stringify({ eventId: "e", providerRequestId: 7, occurredAt: "2026-08-17T00:00:00Z", payload: {} }),
    JSON.stringify({ eventId: "e", providerRequestId: "p", occurredAt: "yesterday", payload: {} }),
    JSON.stringify({ eventId: "e", providerRequestId: "p", occurredAt: "2026-08-17T00:00:00Z", payload: [] }),
  ];
  for (const shape of shapes) {
    await assert.rejects(verifier().verify("irp", shape, signWebhook(SECRET, shape, NOW)), refused("INVALID_REQUEST"), shape);
    assert.throws(() => parseConnectorWebhook(shape), refused("INVALID_REQUEST"));
  }
});

test("the gateway still reports a resend within this process as a duplicate", async () => {
  const gateway = new ConnectorGateway([new MockConnector("irp")], { async credentialReference() { return "vault://opaque"; } }, verifier());
  assert.equal((await gateway.receiveWebhook("irp", body, signWebhook(SECRET, body, NOW))).duplicate, false);
  assert.equal((await gateway.receiveWebhook("irp", body, signWebhook(SECRET, body, NOW))).duplicate, true);
});

test("a gateway that takes no callbacks refuses every one", async () => {
  await assert.rejects(new NoWebhooksVerifier().verify(), refused("UNAUTHORIZED"));
});

test("the test-signature verifier cannot be built outside development and tests", () => {
  const before = process.env.NODE_ENV;
  try {
    for (const environment of ["production", "Production", "staging", "prod"]) {
      process.env.NODE_ENV = environment;
      assert.equal(isLocalEnvironment(), false);
      assert.throws(() => new StaticWebhookVerifier(), /only for development and tests/);
    }
    for (const environment of ["test", "development", ""]) {
      process.env.NODE_ENV = environment;
      assert.ok(new StaticWebhookVerifier());
    }
  } finally {
    process.env.NODE_ENV = before;
  }
});

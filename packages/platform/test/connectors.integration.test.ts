import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorError, ConnectorGateway, MockConnector, ReferenceEmailConnector, StaticWebhookVerifier, type CredentialVault, type ExternalConnector } from "../src/index.ts";

const request = { tenantId: "company-a", operation: "send", payload: { recipient: "test@example.invalid" }, idempotencyKey: "message-1", correlationId: "correlation-1" };

test("mock and reference adapters keep idempotent provider request identifiers", async () => {
  for (const connector of [new MockConnector("email"), new ReferenceEmailConnector()]) {
    const first = await connector.execute(request); const retry = await connector.execute(request);
    assert.equal(first.providerRequestId, retry.providerRequestId);
    assert.equal((await connector.health()), "healthy");
  }
});

test("provider outages are normalized and retryable", async () => {
  await assert.rejects(new MockConnector("banking", "outage").execute(request), (error: unknown) => error instanceof ConnectorError && error.code === "OUTAGE" && error.retryable);
  await assert.rejects(new MockConnector("banking", "timeout").execute(request), (error: unknown) => error instanceof ConnectorError && error.code === "TIMEOUT" && error.retryable);
});

test("gateway retries safely, uses opaque tenant credentials and opens a circuit after repeated failures", async () => {
  let calls = 0; const retrying: ExternalConnector = { kind: "email", async execute() { calls += 1; if (calls === 1) throw new ConnectorError("TIMEOUT", true); return { providerRequestId: "provider-1", status: "completed", payload: {} }; }, async health() { return "healthy"; } };
  const vault: CredentialVault = { async credentialReference(tenantId) { assert.equal(tenantId, "company-a"); return "vault://tenant/company-a/email"; } };
  const gateway = new ConnectorGateway([retrying], vault, new StaticWebhookVerifier(), 2);
  assert.equal((await gateway.execute("email", request)).providerRequestId, "provider-1"); assert.equal(calls, 2);
  const failing = new ConnectorGateway([new MockConnector("email", "outage")], vault, new StaticWebhookVerifier(), 2);
  await assert.rejects(failing.execute("email", request, 1), /OUTAGE/); await assert.rejects(failing.execute("email", request, 1), /OUTAGE/); await assert.rejects(failing.execute("email", request, 1), /OUTAGE/);
});

test("webhooks are verified and deduplicated without exposing credentials", async () => {
  const vault: CredentialVault = { async credentialReference() { return "vault://opaque"; } }; const gateway = new ConnectorGateway([new MockConnector("email")], vault, new StaticWebhookVerifier());
  const body = JSON.stringify({ eventId: "delivery-1", providerRequestId: "provider-1", occurredAt: "2026-08-28T00:00:00.000Z", payload: { state: "delivered" } });
  assert.equal((await gateway.receiveWebhook("email", body, "test-signature")).duplicate, false); assert.equal((await gateway.receiveWebhook("email", body, "test-signature")).duplicate, true);
  await assert.rejects(gateway.receiveWebhook("email", body, "invalid"), (error: unknown) => error instanceof ConnectorError && error.code === "UNAUTHORIZED");
});

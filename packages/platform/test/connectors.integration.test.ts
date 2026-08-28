import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorError, MockConnector, ReferenceEmailConnector } from "../src/index.ts";

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


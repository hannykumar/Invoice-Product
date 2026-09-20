import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AuditLog, ConnectorError, ConnectorGateway, StaticWebhookVerifier, registerSecretValues, type ExternalConnector } from "../../../packages/platform/src/index.ts";
import { SecureLogger, type SafeLogEvent } from "../../../ops/security/src/logging.ts";
import { jsonResponse } from "../src/server.ts";

test("a registered secret cannot reach connector errors, audits, logs or HTTP JSON", async () => {
  const secret = randomUUID();
  registerSecretValues([secret]);

  const connector: ExternalConnector = {
    kind: "irp",
    async execute() { throw new Error(`provider repeated ${secret}`); },
    async health() { return "unavailable"; },
  };
  const vault = { async credentialReference() { return "vault://test/irp"; } };
  const gateway = new ConnectorGateway([connector], vault, new StaticWebhookVerifier());
  const error = await gateway.execute("irp", {
    tenantId: "company-a", operation: "test", payload: {}, idempotencyKey: "one", correlationId: "one",
  }, 1).then(() => undefined, (caught: unknown) => caught);
  assert.ok(error instanceof ConnectorError);
  assert.equal(JSON.stringify(error).includes(secret), false);

  const audit = new AuditLog();
  audit.append({ companyId: "company-a", actorId: "owner-a", action: "connector.failed", correlationId: "one", reason: `provider repeated ${secret}`, before: null, after: { detail: secret } });
  const events = audit.forCompany({ companyId: "company-a", branchId: "branch-a", actorId: "owner-a", sessionId: "session-a", permissions: new Set() });
  assert.equal(JSON.stringify(events).includes(secret), false);

  let logged: SafeLogEvent | undefined;
  new SecureLogger((event) => { logged = event; }).write("error", `provider repeated ${secret}`, { detail: secret });
  assert.equal(JSON.stringify(logged).includes(secret), false);

  assert.equal(jsonResponse(400, { message: `provider repeated ${secret}` }).body.includes(secret), false);
});

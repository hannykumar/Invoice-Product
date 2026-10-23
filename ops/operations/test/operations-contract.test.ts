/** Issue #366 — the operations contract suite on the in-memory store. */
import { AuditLog } from "../../../packages/platform/src/index.ts";
import { InMemoryOperationsStore } from "../src/store.ts";
import { operationsContract } from "./operations-contract.ts";

operationsContract("memory", () => {
  const audit = new AuditLog();
  return {
    store: new InMemoryOperationsStore(),
    audit,
    auditActions: async (companyId) => audit.forCompany({ companyId } as Parameters<AuditLog["forCompany"]>[0]).map((event) => event.action),
    company: async () => ({ companyId: crypto.randomUUID(), userId: crypto.randomUUID(), supportId: crypto.randomUUID() }),
    atomic: false,
  };
});

import { AuditLog } from "../../../packages/platform/src/index.ts";
import { InMemoryPrivacyStore, MemoryBackupRepository } from "../src/index.ts";
import { securityContract } from "./security-contract.ts";

securityContract("memory", () => {
  const audit = new AuditLog();
  return {
    privacy: new InMemoryPrivacyStore(),
    backups: new MemoryBackupRepository(),
    audit,
    auditActions: async (companyId) => audit.forCompany({ companyId } as Parameters<AuditLog["forCompany"]>[0]).map((event) => event.action),
    company: async () => ({ companyId: crypto.randomUUID(), actorId: crypto.randomUUID() }),
  };
});

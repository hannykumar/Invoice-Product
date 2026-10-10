/** Issue #364 — the platform contract, against the in-memory classes. */
import { AccessControl, AuditLog, AuthenticationService, ExceptionQueue, PlatformCommandService } from "../src/index.ts";
import { CONTRACT_POLICIES, platformContract } from "./platform-contract.ts";

const audit = new AuditLog();
const access = new AccessControl();
platformContract("memory", () => ({
  audit, access,
  commands: new PlatformCommandService(audit, CONTRACT_POLICIES),
  exceptions: new ExceptionQueue(audit),
  auth: (now) => new AuthenticationService(access, now),
  company: async () => ({ companyId: crypto.randomUUID(), branchId: crypto.randomUUID() }),
  user: async () => crypto.randomUUID(),
}));

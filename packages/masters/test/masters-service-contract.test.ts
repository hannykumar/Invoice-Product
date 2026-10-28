/** Issue #366 — the service contract on the in-memory stores, which need no database. */
import { AccessControl, AuditLog, PlatformCommandService } from "../../platform/src/index.ts";
import type { Permission } from "../../platform/src/types.ts";
import { MASTER_APPROVAL_POLICIES, MasterDataService } from "../src/masters.ts";
import { mastersServiceContract, type Shop } from "./masters-service-contract.ts";

const access = new AccessControl();
mastersServiceContract("memory", () => ({
  shared: false,
  service: () => {
    const audit = new AuditLog();
    return new MasterDataService(new PlatformCommandService(audit, MASTER_APPROVAL_POLICIES), audit);
  },
  shop: async (): Promise<Shop> => {
    const [companyId, branchId, userId] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    access.grant({ companyId, userId, branchIds: new Set([branchId]), active: true, permissions: new Set(["approval.decide", "access.review"]) });
    return {
      companyId,
      context: (permissions?: readonly Permission[]) => {
        const context = access.context(companyId, branchId, userId, `session-${userId}`);
        return permissions === undefined ? { ...context, permissions: new Set() } : { ...context, permissions: new Set(permissions) };
      },
    };
  },
}));

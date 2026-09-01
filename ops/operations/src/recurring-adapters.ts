import type { Permission, RequestContext } from "../../../packages/platform/src/index.ts";
import type { RecurringJobDefinition, RecurringJobResult } from "./recurring.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const RECURRING_JOB_KEYS = Object.freeze({
  complianceCalendar: "compliance-calendar-sweep",
  governmentReconciliation: "government-call-reconciliation",
  notificationDelivery: "notification-delivery",
  ewayExpiry: "eway-bill-expiry-watch",
  collectionReminders: "collection-reminders",
});

interface ServiceActor {
  readonly companyId: string;
  readonly branchId: string | null;
  readonly userId: string;
  readonly permissions: readonly string[];
}

interface StandardRecurringDeps {
  readonly complianceCalendar?: { run(actor: ServiceActor): Promise<{ readonly raised?: readonly unknown[] }> };
  readonly governmentReconciler?: { run(actor: ServiceActor): Promise<{ readonly checked?: number; readonly conflicts?: readonly unknown[] }> };
  readonly notifications?: { deliverDue(context: RequestContext): Promise<readonly unknown[]> };
  readonly ewayBills?: { expiringWithin(actor: ServiceActor, hours: number): Promise<readonly unknown[]> };
  readonly collections?: { sendPlanned(actor: ServiceActor, today: string): Promise<readonly unknown[]> };
}

const actorOf = (context: RequestContext): ServiceActor => ({
  companyId: context.companyId,
  branchId: context.branchId,
  userId: context.actorId,
  permissions: [...context.permissions],
});
const count = (what: string, value: number): RecurringJobResult => ({ summary: `${value} ${what}` });
const job = (
  key: string,
  name: string,
  everyMs: number,
  permission: Permission,
  run: RecurringJobDefinition["run"],
): RecurringJobDefinition => ({ key, name, everyMs, requiredPermissions: [permission], maxAttempts: 3, retryDelayMs: MINUTE, timeoutMs: 30_000, run });

/** Code registrations for every supplied periodic entry point named by issue #122. */
export const standardRecurringJobs = (deps: StandardRecurringDeps): readonly RecurringJobDefinition[] => {
  const jobs: RecurringJobDefinition[] = [];
  if (deps.complianceCalendar !== undefined) jobs.push(job(RECURRING_JOB_KEYS.complianceCalendar, "Compliance deadline morning sweep", DAY, "compliance.calendar.refresh", async (context) => {
    const report = await deps.complianceCalendar!.run(actorOf(context));
    return count("compliance alerts raised", report.raised?.length ?? 0);
  }));
  if (deps.governmentReconciler !== undefined) jobs.push(job(RECURRING_JOB_KEYS.governmentReconciliation, "Government call reconciliation", HOUR, "gsp.calls.reconcile", async (context) => {
    const report = await deps.governmentReconciler!.run(actorOf(context));
    return { summary: `${report.checked ?? 0} calls checked; ${report.conflicts?.length ?? 0} conflicts` };
  }));
  if (deps.notifications !== undefined) jobs.push(job(RECURRING_JOB_KEYS.notificationDelivery, "Due notification delivery", MINUTE, "notification.send", async (context) => {
    return count("notifications delivered or attempted", (await deps.notifications!.deliverDue(context)).length);
  }));
  if (deps.ewayBills !== undefined) jobs.push(job(RECURRING_JOB_KEYS.ewayExpiry, "E-way bill expiry watch", HOUR, "eway.view", async (context) => {
    return count("e-way bills expiring within eight hours", (await deps.ewayBills!.expiringWithin(actorOf(context), 8)).length);
  }));
  if (deps.collections !== undefined) jobs.push(job(RECURRING_JOB_KEYS.collectionReminders, "Daily collection reminders", DAY, "collections.reminders.send", async (context, scheduledFor) => {
    return count("collection reminders handled", (await deps.collections!.sendPlanned(actorOf(context), scheduledFor.toISOString().slice(0, 10))).length);
  }));
  return Object.freeze(jobs);
};

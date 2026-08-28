import { randomUUID } from "node:crypto";
import type { Id, RequestContext } from "./types.ts";
import { PlatformError } from "./types.ts";

export type NotificationChannel = "in_app" | "email" | "whatsapp" | "sms";
export type NotificationStatus = "scheduled" | "delivered" | "failed" | "suppressed";
export interface NotificationPreference { readonly companyId: Id; readonly recipientId: Id; readonly channel: NotificationChannel; readonly enabled: boolean; readonly quietFromHour?: number; readonly quietToHour?: number; }
export interface Notification { readonly id: Id; readonly companyId: Id; readonly recipientId: Id; readonly channel: NotificationChannel; readonly template: string; readonly locale: "en-IN" | "hi-IN"; readonly payload: Readonly<Record<string, unknown>>; readonly deduplicationKey: string; readonly scheduledAt: number; readonly status: NotificationStatus; readonly attempts: number; readonly lastError?: string; }
export interface NotificationTransport { send(notification: Notification): Promise<void>; }

const sensitive = /password|secret|token|pin|private.?key/i;
const redact = (payload: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => Object.freeze(Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, sensitive.test(key) ? "[REDACTED]" : value])));
const quiet = (preference: NotificationPreference | undefined, at: number): boolean => { if (preference && !preference.enabled) return true; if (preference?.quietFromHour === undefined || preference?.quietToHour === undefined) return false; const hour = new Date(at).getUTCHours(); return preference.quietFromHour <= preference.quietToHour ? hour >= preference.quietFromHour && hour < preference.quietToHour : hour >= preference.quietFromHour || hour < preference.quietToHour; };

export class NotificationService {
  #notifications = new Map<Id, Notification>(); #deduplicated = new Map<string, Id>(); #preferences = new Map<string, NotificationPreference>();
  private readonly transport: NotificationTransport; private readonly now: () => number;
  constructor(transport: NotificationTransport, now: () => number = Date.now) { this.transport = transport; this.now = now; }
  setPreference(context: RequestContext, preference: Omit<NotificationPreference, "companyId">): void { this.#preferences.set(`${context.companyId}:${preference.recipientId}:${preference.channel}`, Object.freeze({ ...preference, companyId: context.companyId })); }
  schedule(context: RequestContext, input: Omit<Notification, "id" | "companyId" | "status" | "attempts" | "payload"> & { payload: Record<string, unknown> }): Notification { const key = `${context.companyId}:${input.deduplicationKey}`; const existing = this.#deduplicated.get(key); if (existing) return this.#notifications.get(existing)!; const preference = this.#preferences.get(`${context.companyId}:${input.recipientId}:${input.channel}`); const status: NotificationStatus = quiet(preference, input.scheduledAt) ? "suppressed" : "scheduled"; const notification = Object.freeze({ ...input, id: randomUUID(), companyId: context.companyId, payload: redact(input.payload), status, attempts: 0 }); this.#notifications.set(notification.id, notification); this.#deduplicated.set(key, notification.id); return notification; }
  async deliverDue(context: RequestContext): Promise<readonly Notification[]> { const due = [...this.#notifications.values()].filter((item) => item.companyId === context.companyId && item.status === "scheduled" && item.scheduledAt <= this.now()); for (const item of due) try { await this.transport.send(item); this.#notifications.set(item.id, Object.freeze({ ...item, status: "delivered" as const, attempts: item.attempts + 1 })); } catch { this.#notifications.set(item.id, Object.freeze({ ...item, status: "failed" as const, attempts: item.attempts + 1, lastError: "Delivery could not be completed. Retry is available." })); } return due.map((item) => this.#notifications.get(item.id)!); }
  retry(context: RequestContext, id: Id): Notification { const item = this.get(context, id); if (item.status !== "failed") throw new PlatformError("INVALID_TRANSITION", "Only failed notifications can be retried."); const { lastError: _lastError, ...base } = item; const retry = Object.freeze({ ...base, status: "scheduled" as const, scheduledAt: this.now() }); this.#notifications.set(id, retry); return retry; }
  get(context: RequestContext, id: Id): Notification { const item = this.#notifications.get(id); if (!item) throw new PlatformError("NOT_FOUND", "Notification was not found."); if (item.companyId !== context.companyId) throw new PlatformError("TENANT_ISOLATION", "This notification belongs to another company."); return item; }
}

import { randomUUID } from "node:crypto";
import { PlatformError } from "./types.ts";
import type { Id, Permission, RequestContext } from "./types.ts";

export type NotificationChannel = "in_app" | "email" | "whatsapp" | "sms";
export type NotificationStatus = "scheduled" | "delivered" | "failed" | "suppressed";
export type NotificationLocale = "en-IN" | "hi-IN";
export type NotificationSensitivity = "public" | "internal" | "restricted";
export type NotificationRecipientRole = "owner" | "accountant" | "staff" | "customer";

export interface NotificationPreference {
  readonly companyId: Id;
  readonly recipientId: Id;
  readonly channel: NotificationChannel;
  readonly enabled: boolean;
  readonly quietFromHour?: number;
  readonly quietToHour?: number;
  readonly timeZone?: string;
}

export interface Notification {
  readonly id: Id;
  readonly companyId: Id;
  readonly recipientId: Id;
  readonly recipientRole: NotificationRecipientRole;
  readonly channel: NotificationChannel;
  readonly template: string;
  readonly locale: NotificationLocale;
  readonly sensitivity: NotificationSensitivity;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly deduplicationKey: string;
  readonly scheduledAt: number;
  readonly status: NotificationStatus;
  readonly attempts: number;
  readonly lastError?: string;
}

export interface NotificationDeliveryEvent {
  readonly id: Id;
  readonly notificationId: Id;
  readonly companyId: Id;
  readonly actorId: Id;
  readonly type: "scheduled" | "suppressed" | "delivered" | "failed" | "opened";
  readonly occurredAt: number;
  readonly detail?: string;
}

export interface NotificationTransport { send(notification: Notification): Promise<void>; }
export interface EmailProvider { send(message: { to: Id; subject: string; body: string }): Promise<void>; }
export interface RenderedNotification { readonly subject: string; readonly body: string; }

export class NotificationTemplateRegistry {
  #templates = new Map<string, (payload: Readonly<Record<string, unknown>>) => RenderedNotification>();

  register(template: string, locale: NotificationLocale, render: (payload: Readonly<Record<string, unknown>>) => RenderedNotification): void {
    this.#templates.set(`${template}:${locale}`, render);
  }

  render(notification: Notification): RenderedNotification {
    const render = this.#templates.get(`${notification.template}:${notification.locale}`);
    if (!render) throw new Error(`Notification template '${notification.template}' is unavailable for ${notification.locale}.`);
    return Object.freeze(render(notification.payload));
  }
}

export class InAppNotificationAdapter implements NotificationTransport {
  #inbox = new Map<string, Notification[]>();

  async send(notification: Notification): Promise<void> {
    const key = `${notification.companyId}:${notification.recipientId}`;
    this.#inbox.set(key, [...(this.#inbox.get(key) ?? []), notification]);
  }

  forRecipient(context: RequestContext, recipientId: Id): readonly Notification[] {
    return Object.freeze([...(this.#inbox.get(`${context.companyId}:${recipientId}`) ?? [])]);
  }
}

export class EmailNotificationAdapter implements NotificationTransport {
  private readonly provider: EmailProvider;
  private readonly templates: NotificationTemplateRegistry;

  constructor(provider: EmailProvider, templates: NotificationTemplateRegistry) { this.provider = provider; this.templates = templates; }

  async send(notification: Notification): Promise<void> {
    const rendered = this.templates.render(notification);
    await this.provider.send({ to: notification.recipientId, subject: rendered.subject, body: rendered.body });
  }
}

export class DeferredChannelAdapter implements NotificationTransport {
  private readonly channel: "sms" | "whatsapp";
  constructor(channel: "sms" | "whatsapp") { this.channel = channel; }
  async send(): Promise<void> { throw new Error(`${this.channel} provider is not configured.`); }
}

export class ChannelNotificationTransport implements NotificationTransport {
  private readonly adapters: Readonly<Partial<Record<NotificationChannel, NotificationTransport>>>;
  constructor(adapters: Readonly<Partial<Record<NotificationChannel, NotificationTransport>>>) { this.adapters = adapters; }

  async send(notification: Notification): Promise<void> {
    const adapter = this.adapters[notification.channel];
    if (!adapter) throw new Error(`${notification.channel} provider is not configured.`);
    await adapter.send(notification);
  }
}

const sensitive = /password|secret|token|pin|private.?key/i;
const redactValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sensitive.test(key) ? "[REDACTED]" : redactValue(item)]));
  return value;
};
const redact = (payload: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => Object.freeze(redactValue(payload) as Record<string, unknown>);
const requiredPermission = (sensitivity: NotificationSensitivity): Permission => sensitivity === "restricted" ? "notification.sensitive.send" : "notification.send";
const allowedChannels: Readonly<Record<NotificationSensitivity, readonly NotificationChannel[]>> = {
  public: ["in_app", "email", "whatsapp", "sms"],
  internal: ["in_app", "email"],
  restricted: ["in_app"],
};
const allowedRoles: Readonly<Record<NotificationSensitivity, readonly NotificationRecipientRole[]>> = {
  public: ["owner", "accountant", "staff", "customer"],
  internal: ["owner", "accountant", "staff"],
  restricted: ["owner", "accountant"],
};
const hourInTimeZone = (at: number, timeZone: string): number => Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone }).format(new Date(at)));
const quiet = (preference: NotificationPreference | undefined, at: number): boolean => {
  if (preference && !preference.enabled) return true;
  if (preference?.quietFromHour === undefined || preference.quietToHour === undefined) return false;
  let hour: number;
  try { hour = hourInTimeZone(at, preference.timeZone ?? "UTC"); } catch { throw new Error("Notification preference contains an invalid time zone."); }
  return preference.quietFromHour <= preference.quietToHour
    ? hour >= preference.quietFromHour && hour < preference.quietToHour
    : hour >= preference.quietFromHour || hour < preference.quietToHour;
};

type ScheduleInput = Omit<Notification, "id" | "companyId" | "status" | "attempts" | "payload"> & { payload: Record<string, unknown> };

export class NotificationService {
  #notifications = new Map<Id, Notification>();
  #deduplicated = new Map<string, Id>();
  #preferences = new Map<string, NotificationPreference>();
  #events: NotificationDeliveryEvent[] = [];
  #attemptTimes = new Map<string, number[]>();
  private readonly transport: NotificationTransport;
  private readonly now: () => number;
  private readonly limits: { maxPerWindow: number; windowMs: number };

  constructor(
    transport: NotificationTransport,
    now: () => number = Date.now,
    limits: { maxPerWindow: number; windowMs: number } = { maxPerWindow: 10, windowMs: 60_000 },
  ) { this.transport = transport; this.now = now; this.limits = limits; }

  setPreference(context: RequestContext, preference: Omit<NotificationPreference, "companyId">): void {
    this.require(context, "notification.send");
    if ((preference.quietFromHour !== undefined && (preference.quietFromHour < 0 || preference.quietFromHour > 23)) || (preference.quietToHour !== undefined && (preference.quietToHour < 0 || preference.quietToHour > 23))) throw new Error("Quiet hours must be between 0 and 23.");
    if (preference.timeZone) hourInTimeZone(this.now(), preference.timeZone);
    this.#preferences.set(`${context.companyId}:${preference.recipientId}:${preference.channel}`, Object.freeze({ ...preference, companyId: context.companyId }));
  }

  schedule(context: RequestContext, input: ScheduleInput): Notification {
    this.require(context, requiredPermission(input.sensitivity));
    if (!allowedChannels[input.sensitivity].includes(input.channel) || !allowedRoles[input.sensitivity].includes(input.recipientRole)) throw new PlatformError("FORBIDDEN", "This notification contains information that cannot be sent to that role or channel.");
    const key = `${context.companyId}:${input.deduplicationKey}`;
    const existing = this.#deduplicated.get(key);
    if (existing) return this.#notifications.get(existing)!;
    const preference = this.#preferences.get(`${context.companyId}:${input.recipientId}:${input.channel}`);
    const status: NotificationStatus = quiet(preference, input.scheduledAt) ? "suppressed" : "scheduled";
    const notification = Object.freeze({ ...input, id: randomUUID(), companyId: context.companyId, payload: redact(input.payload), status, attempts: 0 });
    this.#notifications.set(notification.id, notification);
    this.#deduplicated.set(key, notification.id);
    this.record(context.actorId, notification, status === "suppressed" ? "suppressed" : "scheduled");
    return notification;
  }

  async deliverDue(context: RequestContext): Promise<readonly Notification[]> {
    this.require(context, "notification.send");
    const processed: Notification[] = [];
    const due = [...this.#notifications.values()].filter((item) => item.companyId === context.companyId && item.status === "scheduled" && item.scheduledAt <= this.now());
    for (const item of due) {
      if (!this.reserveRateLimit(item)) continue;
      try {
        await this.transport.send(item);
        const delivered = Object.freeze({ ...item, status: "delivered" as const, attempts: item.attempts + 1 });
        this.#notifications.set(item.id, delivered);
        this.record(context.actorId, delivered, "delivered");
        processed.push(delivered);
      } catch {
        const failed = Object.freeze({ ...item, status: "failed" as const, attempts: item.attempts + 1, lastError: "Delivery could not be completed. Retry is available." });
        this.#notifications.set(item.id, failed);
        this.record(context.actorId, failed, "failed", failed.lastError);
        processed.push(failed);
      }
    }
    return processed;
  }

  retry(context: RequestContext, id: Id): Notification {
    this.require(context, "notification.send");
    const item = this.get(context, id);
    if (item.status !== "failed") throw new PlatformError("INVALID_TRANSITION", "Only failed notifications can be retried.");
    const { lastError: _lastError, ...base } = item;
    const retry = Object.freeze({ ...base, status: "scheduled" as const, scheduledAt: this.now() });
    this.#notifications.set(id, retry);
    this.record(context.actorId, retry, "scheduled", "Manual retry requested.");
    return retry;
  }

  markOpened(context: RequestContext, id: Id): NotificationDeliveryEvent {
    const item = this.get(context, id);
    if (context.actorId !== item.recipientId && !context.permissions.has("notification.send")) throw new PlatformError("FORBIDDEN", "Only the recipient or a notification manager can mark this notification opened.");
    if (item.status !== "delivered") throw new PlatformError("INVALID_TRANSITION", "Only delivered notifications can be marked opened.");
    return this.record(context.actorId, item, "opened");
  }

  eventsFor(context: RequestContext, id: Id): readonly NotificationDeliveryEvent[] {
    this.require(context, "notification.send");
    this.get(context, id);
    return Object.freeze(this.#events.filter((event) => event.companyId === context.companyId && event.notificationId === id));
  }

  get(context: RequestContext, id: Id): Notification {
    const item = this.#notifications.get(id);
    if (!item) throw new PlatformError("NOT_FOUND", "Notification was not found.");
    if (item.companyId !== context.companyId) throw new PlatformError("TENANT_ISOLATION", "This notification belongs to another company.");
    return item;
  }

  private require(context: RequestContext, permission: Permission): void {
    if (!context.permissions.has(permission)) throw new PlatformError("FORBIDDEN", "You do not have permission to manage notifications.");
  }

  private record(actorId: Id, notification: Notification, type: NotificationDeliveryEvent["type"], detail?: string): NotificationDeliveryEvent {
    const event = Object.freeze({ id: randomUUID(), notificationId: notification.id, companyId: notification.companyId, actorId, type, occurredAt: this.now(), ...(detail ? { detail } : {}) });
    this.#events.push(event);
    return event;
  }

  private reserveRateLimit(notification: Notification): boolean {
    const key = `${notification.companyId}:${notification.channel}`;
    const threshold = this.now() - this.limits.windowMs;
    const recent = (this.#attemptTimes.get(key) ?? []).filter((time) => time > threshold);
    if (recent.length >= this.limits.maxPerWindow) { this.#attemptTimes.set(key, recent); return false; }
    recent.push(this.now());
    this.#attemptTimes.set(key, recent);
    return true;
  }
}

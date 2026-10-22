import { randomUUID } from "node:crypto";
import { PlatformError } from "./types.ts";
import type { Id, Permission, RequestContext } from "./types.ts";
import { reportUnexpected } from "./error-reporting.ts";

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

/** Issue #366 — one page of a list. `after` is the id of the last row of the previous page. Omitted, a list returns everything. */
export interface NotificationPage { readonly limit: number; readonly after?: Id; }

/**
 * Issue #366 — where `NotificationService` keeps its records: `InMemoryNotificationStore` (the
 * default) or `PostgresNotificationStore` (postgres-notifications.ts). Both pass one contract suite
 * (test/notification-store-contract.ts).
 *
 * Every read names the company and never returns another company's row. `insert` refuses a second
 * notification with the same id or the same deduplication key (`IDEMPOTENCY_CONFLICT`); `update`
 * refuses one that was never inserted (`NOT_FOUND`); so does `appendEvent` for an event whose
 * notification is not this company's. Lists keep the order rows were first written in.
 */
export interface NotificationStore {
  insert(notification: Notification): Promise<void>;
  update(notification: Notification): Promise<void>;
  find(companyId: Id, id: Id): Promise<Notification | null>;
  findByDeduplicationKey(companyId: Id, key: string): Promise<Notification | null>;
  /** Scheduled notifications whose time has come at `at`, in the order they were first scheduled. */
  due(companyId: Id, at: number, page?: NotificationPage): Promise<readonly Notification[]>;
  appendEvent(event: NotificationDeliveryEvent): Promise<void>;
  events(companyId: Id, notificationId: Id, page?: NotificationPage): Promise<readonly NotificationDeliveryEvent[]>;
  savePreference(preference: NotificationPreference): Promise<void>;
  preference(companyId: Id, recipientId: Id, channel: NotificationChannel): Promise<NotificationPreference | null>;
}

export const notificationDuplicate = (): PlatformError => new PlatformError("IDEMPOTENCY_CONFLICT", "This notification has already been recorded.");
export const notificationNotFound = (): PlatformError => new PlatformError("NOT_FOUND", "Notification was not found.");

export class InMemoryNotificationStore implements NotificationStore {
  #notifications = new Map<Id, Notification>();
  #order = new Map<Id, number>();
  #events: NotificationDeliveryEvent[] = [];
  #preferences = new Map<string, NotificationPreference>();

  async insert(notification: Notification): Promise<void> {
    if (this.#notifications.has(notification.id) || await this.findByDeduplicationKey(notification.companyId, notification.deduplicationKey)) throw notificationDuplicate();
    this.#notifications.set(notification.id, notification);
    this.#order.set(notification.id, this.#order.size);
  }

  async update(notification: Notification): Promise<void> {
    if (!await this.find(notification.companyId, notification.id)) throw notificationNotFound();
    const clash = await this.findByDeduplicationKey(notification.companyId, notification.deduplicationKey);
    if (clash && clash.id !== notification.id) throw notificationDuplicate();
    this.#notifications.set(notification.id, notification);
  }

  async find(companyId: Id, id: Id): Promise<Notification | null> {
    const item = this.#notifications.get(id);
    return item && item.companyId === companyId ? item : null;
  }

  async findByDeduplicationKey(companyId: Id, key: string): Promise<Notification | null> {
    return [...this.#notifications.values()].find((item) => item.companyId === companyId && item.deduplicationKey === key) ?? null;
  }

  async due(companyId: Id, at: number, page?: NotificationPage): Promise<readonly Notification[]> {
    // The cursor is a place in the order of writing, so a row whose status changed since still marks it.
    const from = page?.after === undefined ? -1 : (await this.find(companyId, page.after)) ? this.#order.get(page.after)! : Infinity;
    const due = [...this.#notifications.values()].filter((item) => item.companyId === companyId && item.status === "scheduled" && item.scheduledAt <= at && this.#order.get(item.id)! > from);
    return page ? due.slice(0, page.limit) : due;
  }

  async appendEvent(event: NotificationDeliveryEvent): Promise<void> {
    if (this.#events.some((item) => item.id === event.id)) throw notificationDuplicate();
    if (!await this.find(event.companyId, event.notificationId)) throw notificationNotFound();
    this.#events.push(event);
  }

  async events(companyId: Id, notificationId: Id, page?: NotificationPage): Promise<readonly NotificationDeliveryEvent[]> {
    const events = this.#events.filter((event) => event.companyId === companyId && event.notificationId === notificationId);
    if (!page) return events;
    const start = page.after === undefined ? 0 : events.findIndex((event) => event.id === page.after) + 1;
    return page.after !== undefined && start === 0 ? [] : events.slice(start, start + page.limit);
  }

  async savePreference(preference: NotificationPreference): Promise<void> {
    this.#preferences.set(`${preference.companyId}:${preference.recipientId}:${preference.channel}`, preference);
  }

  async preference(companyId: Id, recipientId: Id, channel: NotificationChannel): Promise<NotificationPreference | null> {
    return this.#preferences.get(`${companyId}:${recipientId}:${channel}`) ?? null;
  }
}

/** How many due notifications one delivery pass reads at a time. */
const DUE_PAGE = 100;

/**
 * Issue #366 — the records live in a `NotificationStore`, in memory unless one is passed. On
 * PostgreSQL every write joins the caller's unit of work, so `setPreference`, `schedule`,
 * `deliverDue`, `retry` and `markOpened` are actions #340 must wrap in `db.unitOfWork`.
 * `deliverDue` calls the provider between its reads and writes: #340/#345 must move that call out
 * of the transaction.
 */
export class NotificationService {
  // ponytail: the rate-limit window lives in this process; count recent delivery events in the store once more than one server sends.
  #attemptTimes = new Map<string, number[]>();
  private readonly transport: NotificationTransport;
  private readonly now: () => number;
  private readonly limits: { maxPerWindow: number; windowMs: number };
  private readonly store: NotificationStore;

  constructor(
    transport: NotificationTransport,
    now: () => number = Date.now,
    limits: { maxPerWindow: number; windowMs: number } = { maxPerWindow: 10, windowMs: 60_000 },
    store: NotificationStore = new InMemoryNotificationStore(),
  ) { this.transport = transport; this.now = now; this.limits = limits; this.store = store; }

  async setPreference(context: RequestContext, preference: Omit<NotificationPreference, "companyId">): Promise<void> {
    this.require(context, "notification.send");
    if ((preference.quietFromHour !== undefined && (preference.quietFromHour < 0 || preference.quietFromHour > 23)) || (preference.quietToHour !== undefined && (preference.quietToHour < 0 || preference.quietToHour > 23))) throw new Error("Quiet hours must be between 0 and 23.");
    if (preference.timeZone) hourInTimeZone(this.now(), preference.timeZone);
    await this.store.savePreference(Object.freeze({ ...preference, companyId: context.companyId }));
  }

  async schedule(context: RequestContext, input: ScheduleInput): Promise<Notification> {
    this.require(context, requiredPermission(input.sensitivity));
    if (!allowedChannels[input.sensitivity].includes(input.channel) || !allowedRoles[input.sensitivity].includes(input.recipientRole)) throw new PlatformError("FORBIDDEN", "This notification contains information that cannot be sent to that role or channel.");
    const existing = await this.store.findByDeduplicationKey(context.companyId, input.deduplicationKey);
    if (existing) return existing;
    const preference = await this.store.preference(context.companyId, input.recipientId, input.channel);
    const status: NotificationStatus = quiet(preference ?? undefined, input.scheduledAt) ? "suppressed" : "scheduled";
    const notification = Object.freeze({ ...input, id: randomUUID(), companyId: context.companyId, payload: redact(input.payload), status, attempts: 0 });
    await this.store.insert(notification);
    await this.record(context.actorId, notification, status === "suppressed" ? "suppressed" : "scheduled");
    return notification;
  }

  async deliverDue(context: RequestContext): Promise<readonly Notification[]> {
    this.require(context, "notification.send");
    const processed: Notification[] = [];
    const at = this.now();
    for (let page = await this.store.due(context.companyId, at, { limit: DUE_PAGE }); page.length > 0; page = await this.store.due(context.companyId, at, { limit: DUE_PAGE, after: page.at(-1)!.id })) {
      for (const item of page) {
        if (!this.reserveRateLimit(item)) continue;
        try {
          await this.transport.send(item);
          const delivered = Object.freeze({ ...item, status: "delivered" as const, attempts: item.attempts + 1 });
          await this.store.update(delivered);
          await this.record(context.actorId, delivered, "delivered");
          processed.push(delivered);
        } catch (error) {
          // The notification is marked failed and can be retried; why it failed goes to the error report.
          reportUnexpected("notifications.deliver", error, { notification_id: item.id });
          const failed = Object.freeze({ ...item, status: "failed" as const, attempts: item.attempts + 1, lastError: "Delivery could not be completed. Retry is available." });
          await this.store.update(failed);
          await this.record(context.actorId, failed, "failed", failed.lastError);
          processed.push(failed);
        }
      }
    }
    return processed;
  }

  async retry(context: RequestContext, id: Id): Promise<Notification> {
    this.require(context, "notification.send");
    const item = await this.get(context, id);
    if (item.status !== "failed") throw new PlatformError("INVALID_TRANSITION", "Only failed notifications can be retried.");
    const { lastError: _lastError, ...base } = item;
    const retry = Object.freeze({ ...base, status: "scheduled" as const, scheduledAt: this.now() });
    await this.store.update(retry);
    await this.record(context.actorId, retry, "scheduled", "Manual retry requested.");
    return retry;
  }

  async markOpened(context: RequestContext, id: Id): Promise<NotificationDeliveryEvent> {
    const item = await this.get(context, id);
    if (context.actorId !== item.recipientId && !context.permissions.has("notification.send")) throw new PlatformError("FORBIDDEN", "Only the recipient or a notification manager can mark this notification opened.");
    if (item.status !== "delivered") throw new PlatformError("INVALID_TRANSITION", "Only delivered notifications can be marked opened.");
    return this.record(context.actorId, item, "opened");
  }

  async eventsFor(context: RequestContext, id: Id): Promise<readonly NotificationDeliveryEvent[]> {
    this.require(context, "notification.send");
    await this.get(context, id);
    return Object.freeze(await this.store.events(context.companyId, id));
  }

  /**
   * Another company's notification is NOT_FOUND, as a missing one is. Under row-level security the
   * database cannot tell the two apart, and saying "another company's" would confirm the id exists.
   */
  async get(context: RequestContext, id: Id): Promise<Notification> {
    const item = await this.store.find(context.companyId, id);
    if (!item) throw notificationNotFound();
    return item;
  }

  private require(context: RequestContext, permission: Permission): void {
    if (!context.permissions.has(permission)) throw new PlatformError("FORBIDDEN", "You do not have permission to manage notifications.");
  }

  private async record(actorId: Id, notification: Notification, type: NotificationDeliveryEvent["type"], detail?: string): Promise<NotificationDeliveryEvent> {
    const event = Object.freeze({ id: randomUUID(), notificationId: notification.id, companyId: notification.companyId, actorId, type, occurredAt: this.now(), ...(detail ? { detail } : {}) });
    await this.store.appendEvent(event);
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

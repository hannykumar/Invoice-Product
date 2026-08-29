import { createHash, randomUUID } from 'node:crypto';

export type DeliveryChannel = 'email' | 'whatsapp' | 'sms';
export type DeliveryStatus = 'queued' | 'sent' | 'delivered' | 'bounced' | 'failed';

export interface DeliveryContext {
  readonly companyId: string;
  readonly actorId: string;
  readonly permissions: ReadonlySet<string>;
}

export interface RecipientPreference {
  readonly recipientId: string;
  readonly channel: DeliveryChannel;
  readonly enabled: boolean;
}

export interface InvoiceDelivery {
  readonly id: string;
  readonly companyId: string;
  readonly invoiceId: string;
  readonly recipientId: string;
  readonly channel: DeliveryChannel;
  readonly status: DeliveryStatus;
  readonly idempotencyKey: string;
  readonly attempts: number;
  readonly providerMessageId: string | null;
  readonly lastError: string | null;
  readonly createdAt: number;
}

export interface DeliveryEvent {
  readonly id: string;
  readonly deliveryId: string;
  readonly companyId: string;
  readonly actorId: string;
  readonly type: 'queued' | 'sent' | 'delivered' | 'bounced' | 'failed' | 'retry_queued';
  readonly occurredAt: number;
  readonly detail: string | null;
}

export interface DocumentLink {
  readonly token: string;
  readonly invoiceId: string;
  readonly expiresAt: number;
}

export interface DeliveryProvider {
  send(input: Readonly<{ channel: DeliveryChannel; recipientId: string; invoiceId: string; documentUrl: string; idempotencyKey: string }>): Promise<{ providerMessageId: string }>;
}

const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');
const deliveryKey = (companyId: string, key: string): string => `${companyId}:${key}`;
const isTerminal = (status: DeliveryStatus): boolean => status === 'delivered' || status === 'bounced';

/**
 * Keeps the delivery concern separate from sales finalisation: it only accepts an immutable
 * invoice id, and provider errors only affect this evidence trail.
 */
export class InvoiceDeliveryService {
  #deliveries = new Map<string, InvoiceDelivery>();
  #deduplicated = new Map<string, string>();
  #preferences = new Map<string, RecipientPreference>();
  #events: DeliveryEvent[] = [];
  #links = new Map<string, DocumentLink>();
  private readonly provider: DeliveryProvider;
  private readonly now: () => number;

  constructor(provider: DeliveryProvider, now: () => number = Date.now) {
    this.provider = provider;
    this.now = now;
  }

  setPreference(context: DeliveryContext, preference: RecipientPreference): void {
    this.require(context);
    this.#preferences.set(`${context.companyId}:${preference.recipientId}:${preference.channel}`, Object.freeze({ ...preference }));
  }

  createDocumentLink(context: DeliveryContext, invoiceId: string, expiresInMs: number): string {
    this.require(context);
    if (!invoiceId || expiresInMs <= 0) throw new Error('An invoice and a positive link expiry are required.');
    const token = randomUUID();
    this.#links.set(tokenHash(token), Object.freeze({ token: tokenHash(token), invoiceId, expiresAt: this.now() + expiresInMs }));
    return token;
  }

  resolveDocumentLink(token: string): string | null {
    const link = this.#links.get(tokenHash(token));
    return link && link.expiresAt > this.now() ? link.invoiceId : null;
  }

  queue(context: DeliveryContext, input: Readonly<{ invoiceId: string; recipientId: string; channel: DeliveryChannel; idempotencyKey: string }>): InvoiceDelivery {
    this.require(context);
    if (!input.invoiceId || !input.recipientId.trim() || !input.idempotencyKey) throw new Error('Invoice, recipient and idempotency key are required.');
    const key = deliveryKey(context.companyId, input.idempotencyKey);
    const prior = this.#deduplicated.get(key);
    if (prior) return this.#deliveries.get(prior)!;
    const preference = this.#preferences.get(`${context.companyId}:${input.recipientId}:${input.channel}`);
    if (preference?.enabled === false) throw new Error('This recipient has disabled this delivery channel.');
    const delivery: InvoiceDelivery = Object.freeze({ id: randomUUID(), companyId: context.companyId, ...input, status: 'queued', attempts: 0, providerMessageId: null, lastError: null, createdAt: this.now() });
    this.#deliveries.set(delivery.id, delivery);
    this.#deduplicated.set(key, delivery.id);
    this.record(context.actorId, delivery, 'queued');
    return delivery;
  }

  async send(context: DeliveryContext, id: string, documentUrl: string): Promise<InvoiceDelivery> {
    this.require(context);
    const delivery = this.get(context, id);
    if (isTerminal(delivery.status)) return delivery;
    try {
      const outcome = await this.provider.send({ channel: delivery.channel, recipientId: delivery.recipientId, invoiceId: delivery.invoiceId, documentUrl, idempotencyKey: delivery.idempotencyKey });
      const sent = Object.freeze({ ...delivery, status: 'sent' as const, attempts: delivery.attempts + 1, providerMessageId: outcome.providerMessageId, lastError: null });
      this.#deliveries.set(id, sent);
      this.record(context.actorId, sent, 'sent', outcome.providerMessageId);
      return sent;
    } catch {
      const failed = Object.freeze({ ...delivery, status: 'failed' as const, attempts: delivery.attempts + 1, lastError: 'Delivery could not be completed. Retry is available.' });
      this.#deliveries.set(id, failed);
      this.record(context.actorId, failed, 'failed', failed.lastError);
      return failed;
    }
  }

  retry(context: DeliveryContext, id: string): InvoiceDelivery {
    this.require(context);
    const delivery = this.get(context, id);
    if (delivery.status !== 'failed') throw new Error('Only failed deliveries can be retried.');
    const retry = Object.freeze({ ...delivery, status: 'queued' as const, lastError: null });
    this.#deliveries.set(id, retry);
    this.record(context.actorId, retry, 'retry_queued');
    return retry;
  }

  receiveProviderEvent(context: DeliveryContext, id: string, status: 'delivered' | 'bounced', detail?: string): InvoiceDelivery {
    this.require(context);
    const delivery = this.get(context, id);
    if (delivery.status !== 'sent') throw new Error('Provider events are only accepted after a send.');
    const updated = Object.freeze({ ...delivery, status });
    this.#deliveries.set(id, updated);
    this.record(context.actorId, updated, status, detail ?? null);
    return updated;
  }

  get(context: DeliveryContext, id: string): InvoiceDelivery {
    const delivery = this.#deliveries.get(id);
    if (!delivery || delivery.companyId !== context.companyId) throw new Error('Delivery was not found.');
    return delivery;
  }

  eventsFor(context: DeliveryContext, id: string): readonly DeliveryEvent[] {
    this.get(context, id);
    return Object.freeze(this.#events.filter((event) => event.deliveryId === id));
  }

  private require(context: DeliveryContext): void {
    if (!context.permissions.has('invoice.delivery.manage')) throw new Error('Invoice delivery permission is required.');
  }

  private record(actorId: string, delivery: InvoiceDelivery, type: DeliveryEvent['type'], detail: string | null = null): void {
    this.#events.push(Object.freeze({ id: randomUUID(), deliveryId: delivery.id, companyId: delivery.companyId, actorId, type, occurredAt: this.now(), detail }));
  }
}

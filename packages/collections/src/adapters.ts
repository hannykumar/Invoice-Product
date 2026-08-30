/**
 * Issue #23 [E23] — the joins to the modules that already exist.
 *
 * Both adapters are deliberately thin. Nothing here decides anything: receivables (#20) decides
 * what is owed and the notification service (#39) decides how a message reaches somebody. This
 * module's only contribution is the decision to send.
 */
import type { CompanyId, IsoDate, PartyId } from '@invoice/kernel';
import type { ActorContext } from '@invoice/ledger';
import type { DocumentLedgerPort, ReceivablesService } from '@invoice/receivables';
import type {
  NotificationService,
  NotificationTemplateRegistry,
  RequestContext,
} from '../../platform/src/index.ts';
import type { CustomerAccount, ReceivablesPositionPort, ReminderTransport } from './ports.ts';

/**
 * Reads positions from the real receivables service.
 *
 * `customers()` asks for a fresh position per party on every call. That is more work than caching
 * would be, and it is the point: a cached balance is exactly the bug that sends a reminder for a
 * bill somebody paid this morning.
 */
export const receivablesPositions = (
  service: ReceivablesService,
  documents: DocumentLedgerPort,
): ReceivablesPositionPort => ({
  async customers(actor: ActorContext, today: IsoDate): Promise<readonly CustomerAccount[]> {
    const parties = await documents.parties(actor.companyId);
    const accounts: CustomerAccount[] = [];
    for (const partyId of parties) {
      const position = await service.position(actor, partyId, today);
      if (!position.documents.some((d) => d.document.side === 'RECEIVABLE')) continue;
      accounts.push({ partyId, partyName: await documents.nameOf(actor.companyId, partyId), position });
    }
    return accounts;
  },
  async customer(actor: ActorContext, partyId: PartyId, today: IsoDate): Promise<CustomerAccount> {
    return {
      partyId,
      partyName: await documents.nameOf(actor.companyId, partyId),
      position: await service.position(actor, partyId, today),
    };
  },
});

export const REMINDER_TEMPLATE = 'payment_reminder';
export const ESCALATION_TEMPLATE = 'payment_reminder_escalation';

/**
 * Registers this module's two templates with GPT 2's registry.
 *
 * The message text is already written by `wording.ts` in both languages and travels in the
 * payload, so the template chooses a language rather than composing a sentence. Wording that is
 * assembled in two places drifts apart, and one of the copies is always the impolite one.
 */
export const registerReminderTemplates = (templates: NotificationTemplateRegistry): void => {
  for (const template of [REMINDER_TEMPLATE, ESCALATION_TEMPLATE]) {
    for (const locale of ['en-IN', 'hi-IN'] as const) {
      templates.register(template, locale, (payload) => ({
        subject: String(payload[`subject_${locale}`] ?? payload.subject_en ?? 'Payment reminder'),
        body: String(payload[`body_${locale}`] ?? ''),
      }));
    }
  }
};

/**
 * Sends through the real notification service.
 *
 * Customer reminders go out as `public` to the `customer` role, which is the only combination #39
 * permits on WhatsApp and SMS. Owner escalations go as `internal` to the `owner` role, which #39
 * keeps to in-app and email. This module accepts that table; it does not widen it.
 */
export const notificationReminderTransport = (
  notifications: NotificationService,
  contextFor: (actor: ActorContext) => RequestContext,
  now: () => number = Date.now,
): ReminderTransport => ({
  async send(actor, message) {
    const context = contextFor(actor);
    const owner = message.audience === 'OWNER';
    const notification = notifications.schedule(context, {
      recipientId: message.recipientId,
      recipientRole: owner ? 'owner' : 'customer',
      channel: message.channel,
      template: owner ? ESCALATION_TEMPLATE : REMINDER_TEMPLATE,
      locale: 'en-IN',
      sensitivity: owner ? 'internal' : 'public',
      payload: {
        ...message.payload,
        subject_en: owner ? 'A bill needs your decision' : `Reminder about bill ${message.payload.bill ?? ''}`,
        'subject_en-IN': owner ? 'A bill needs your decision' : `Reminder about bill ${message.payload.bill ?? ''}`,
        'subject_hi-IN': owner ? 'Ek bill par aapka faisla chahiye' : `Bill ${message.payload.bill ?? ''} ke bare mein yaad-dilava`,
        'body_en-IN': message.text['en-IN'],
        'body_hi-IN': message.text['hi-IN'],
      },
      deduplicationKey: message.deduplicationKey,
      scheduledAt: now(),
    });
    if (notification.status === 'suppressed') return { notificationId: notification.id, state: 'SUPPRESSED' };
    // The deduplication key means a retry finds the same notification, still marked failed from
    // last time. Reviving it is what keeps a retry one message rather than two.
    if (notification.status === 'failed') notifications.retry(context, notification.id);
    if (notification.status === 'delivered') return { notificationId: notification.id, state: 'SENT' };

    const processed = await notifications.deliverDue(context);
    const delivered = processed.find((item) => item.id === notification.id);
    if (delivered === undefined) {
      // Rate-limited: still scheduled, nothing lost, and the owner is told rather than guessing.
      throw new Error('Too many messages have gone out just now. This one is still queued — try again shortly.');
    }
    if (delivered.status === 'failed') {
      throw new Error('The message provider could not deliver this. You can try again.');
    }
    return { notificationId: delivered.id, state: 'SENT' };
  },
});

/** Convenience for a host that keeps one contact record per party. */
export const contactsFromMap = (
  entries: ReadonlyMap<string, { recipientId: string; channels: readonly ('in_app' | 'email' | 'whatsapp' | 'sms')[] }>,
  ownerContact: { recipientId: string; channels: readonly ('in_app' | 'email')[] },
) => ({
  async contact(_companyId: CompanyId, partyId: PartyId) {
    return entries.get(partyId) ?? null;
  },
  async owner(_companyId: CompanyId) {
    return ownerContact;
  },
});

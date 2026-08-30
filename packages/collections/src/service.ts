import { invalid, notAllowed, notFound, toDecimalString, type Clock, type IsoDate, type Money, type PartyId } from '@invoice/kernel';
import type { ActorContext } from '@invoice/ledger';
import {
  COLLECTION_PERMISSIONS,
  DEFAULT_COLLECTION_POLICY,
  type BalanceSnapshot,
  type CollectionChannel,
  type CollectionCommunication,
  type CollectionDispute,
  type CollectionLocale,
  type CollectionPolicy,
  type CollectionPreference,
  type PaymentPromise,
  type ReminderStatus,
  type ScheduledReminder,
} from './model.ts';
import type {
  CollectionAuditPort,
  CollectionPartyPort,
  CollectionPermissionPort,
  CollectionReceivablesPort,
  CollectionRepository,
  ReminderNotificationPort,
} from './ports.ts';

export interface CollectionsServiceDeps {
  readonly receivables: CollectionReceivablesPort;
  readonly parties: CollectionPartyPort;
  readonly repository: CollectionRepository;
  readonly notifications: ReminderNotificationPort;
  readonly permissions: CollectionPermissionPort;
  readonly audit: CollectionAuditPort;
  readonly clock: Clock;
  readonly policy?: CollectionPolicy;
  readonly idFactory?: () => string;
}

export interface ScheduleReminderCommand {
  readonly partyId: PartyId;
  readonly asOf: IsoDate;
  readonly scheduledAt?: string;
  readonly channel?: CollectionChannel;
  readonly idempotencyKey?: string;
}

const atStartOfDay = (date: IsoDate): number => Date.parse(`${date}T00:00:00.000Z`);
const snapshotOf = (asOf: IsoDate, documents: Awaited<ReturnType<CollectionReceivablesPort['position']>>['documents']): BalanceSnapshot => {
  const receivables = documents.filter((item) => item.document.side === 'RECEIVABLE' && item.outstanding.minor > 0n && item.daysOverdue > 0);
  return Object.freeze({
    asOf,
    totalOutstanding: Object.freeze({ currency: 'INR' as const, minor: receivables.reduce((sum, item) => sum + item.outstanding.minor, 0n) }),
    oldestDaysOverdue: receivables.reduce((oldest, item) => Math.max(oldest, item.daysOverdue), 0),
    documents: Object.freeze(receivables.map((item) => Object.freeze({
      id: item.document.documentId,
      number: item.document.number,
      outstanding: item.outstanding,
      daysOverdue: item.daysOverdue,
    }))),
  });
};

const copyPreference = (preference: CollectionPreference): CollectionPreference => Object.freeze({ ...preference, disabledChannels: Object.freeze([...preference.disabledChannels]) });

const words = (locale: CollectionLocale, template: ScheduledReminder['template'], name: string, balance: Money, documents: readonly string[]) => {
  const amount = `₹${toDecimalString(balance)}`;
  const invoices = documents.join(', ');
  if (locale === 'hi-IN') {
    const lead = template === 'gentle' ? 'नमस्ते' : template === 'firm' ? 'कृपया ध्यान दें' : 'अंतिम अनुस्मारक';
    return { subject: `${amount} का भुगतान बाकी है`, message: `${lead} ${name}, ${invoices} पर ${amount} बाकी है। यदि भुगतान हो चुका है या कोई विवाद है, तो कृपया हमें बताएं।` };
  }
  const lead = template === 'gentle' ? 'A friendly reminder' : template === 'firm' ? 'Payment follow-up' : 'Important payment reminder';
  return { subject: `${lead}: ${amount} remains due`, message: `Hello ${name}, ${amount} remains due on ${invoices}. If you have paid already or dispute any amount, please let us know so we can update our records.` };
};

export class CollectionsService {
  readonly #receivables: CollectionReceivablesPort;
  readonly #parties: CollectionPartyPort;
  readonly #repo: CollectionRepository;
  readonly #notifications: ReminderNotificationPort;
  readonly #permissions: CollectionPermissionPort;
  readonly #audit: CollectionAuditPort;
  readonly #clock: Clock;
  readonly #policy: CollectionPolicy;
  readonly #newId: () => string;

  constructor(deps: CollectionsServiceDeps) {
    this.#receivables = deps.receivables;
    this.#parties = deps.parties;
    this.#repo = deps.repository;
    this.#notifications = deps.notifications;
    this.#permissions = deps.permissions;
    this.#audit = deps.audit;
    this.#clock = deps.clock;
    this.#policy = deps.policy ?? DEFAULT_COLLECTION_POLICY;
    this.#newId = deps.idFactory ?? (() => crypto.randomUUID());
    if (this.#policy.steps.length === 0) throw new Error('A collection policy needs at least one reminder step.');
  }

  async setPreference(actor: ActorContext, input: { partyId: PartyId; optedOut: boolean; disabledChannels?: readonly CollectionChannel[]; locale?: CollectionLocale }): Promise<CollectionPreference> {
    this.#permissions.require(actor, COLLECTION_PERMISSIONS.manage, 'manage customer reminder preferences');
    const current = await this.#repo.preference(actor.companyId, input.partyId);
    const now = this.#clock.now().toISOString();
    const preference = copyPreference({
      companyId: actor.companyId,
      partyId: input.partyId,
      optedOut: input.optedOut,
      disabledChannels: input.disabledChannels ?? current?.disabledChannels ?? [],
      locale: input.locale ?? current?.locale ?? 'en-IN',
      updatedAt: now,
      updatedBy: actor.userId,
    });
    await this.#repo.savePreference(preference);
    await this.#recordAudit(actor, 'collections.preference.changed', input.partyId, input.optedOut ? 'Customer reminders were stopped.' : 'Customer reminder preferences were updated.', { optedOut: String(input.optedOut), disabledChannels: preference.disabledChannels.join(',') });
    return preference;
  }

  async schedule(actor: ActorContext, command: ScheduleReminderCommand): Promise<ScheduledReminder> {
    this.#permissions.require(actor, COLLECTION_PERMISSIONS.manage, 'schedule a payment reminder');
    const position = await this.#receivables.position(actor, command.partyId, command.asOf);
    const snapshot = snapshotOf(command.asOf, position.documents);
    const eligible = snapshot.documents.filter((item) => item.daysOverdue > 0);
    if (eligible.length === 0 || snapshot.totalOutstanding.minor <= 0n) throw notAllowed('COLLECTION_NOT_OVERDUE', 'This customer has no overdue amount to remind them about.');
    const oldest = Math.max(...eligible.map((item) => item.daysOverdue));
    const ordered = [...this.#policy.steps].sort((left, right) => left.afterDaysOverdue - right.afterDaysOverdue);
    const stepIndex = ordered.reduce((selected, step, index) => oldest >= step.afterDaysOverdue ? index : selected, -1);
    if (stepIndex < 0) throw notAllowed('COLLECTION_NOT_DUE', 'The first reminder date has not arrived yet.');
    const step = ordered[stepIndex]!;
    const preference = await this.#repo.preference(actor.companyId, command.partyId);
    const channel = command.channel ?? step.channel;
    const stage = stepIndex + 1;
    const key = command.idempotencyKey ?? `collection:${command.partyId}:${stage}:${command.asOf}:${channel}`;
    const existing = await this.#repo.reminderByKey(actor.companyId, key);
    if (existing !== null) return existing;
    const partyName = await this.#parties.nameOf(actor.companyId, command.partyId);
    const locale = preference?.locale ?? 'en-IN';
    const rendered = words(locale, step.template, partyName, snapshot.totalOutstanding, eligible.map((item) => item.number));
    const now = this.#clock.now().toISOString();
    const reminder: ScheduledReminder = Object.freeze({
      id: this.#newId(), companyId: actor.companyId, partyId: command.partyId, partyName,
      channel, locale, template: step.template, stage,
      scheduledAt: command.scheduledAt ?? now, status: 'SCHEDULED', subject: rendered.subject, message: rendered.message,
      snapshot, deduplicationKey: key, notificationId: null, statusReason: null,
      createdAt: now, createdBy: actor.userId, updatedAt: now,
    });
    await this.#repo.insertReminder(reminder);
    await this.#recordAudit(actor, 'collections.reminder.scheduled', reminder.id, `${reminder.channel} reminder scheduled for ${partyName}.`, { balance: toDecimalString(snapshot.totalOutstanding), stage: String(stage), scheduledAt: reminder.scheduledAt });
    return reminder;
  }

  async scheduleDue(actor: ActorContext, asOf: IsoDate): Promise<readonly ScheduledReminder[]> {
    this.#permissions.require(actor, COLLECTION_PERMISSIONS.manage, 'schedule payment reminders');
    const result: ScheduledReminder[] = [];
    for (const partyId of await this.#parties.parties(actor.companyId)) {
      try { result.push(await this.schedule(actor, { partyId, asOf })); }
      catch (error) {
        if (error instanceof Error && (error.message.includes('no overdue amount') || error.message.includes('first reminder date'))) continue;
        throw error;
      }
    }
    return Object.freeze(result);
  }

  async review(actor: ActorContext): Promise<readonly ScheduledReminder[]> {
    this.#permissions.require(actor, COLLECTION_PERMISSIONS.manage, 'review scheduled payment reminders');
    return Object.freeze([...(await this.#repo.reminders(actor.companyId))].sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt)));
  }

  async deliverDue(actor: ActorContext, asOf: IsoDate): Promise<readonly ScheduledReminder[]> {
    this.#permissions.require(actor, COLLECTION_PERMISSIONS.send, 'send payment reminders');
    const due = (await this.#repo.reminders(actor.companyId)).filter((item) => (item.status === 'SCHEDULED' || item.status === 'FAILED') && Date.parse(item.scheduledAt) <= this.#clock.now().getTime());
    const processed: ScheduledReminder[] = [];
    for (const reminder of due) {
      const position = await this.#receivables.position(actor, reminder.partyId, asOf);
      const current = snapshotOf(asOf, position.documents);
      const currentIds = new Set(current.documents.map((item) => item.id));
      const disputes = (await this.#repo.disputes(actor.companyId, reminder.partyId)).filter((item) => item.status === 'OPEN' && currentIds.has(item.documentId));
      const preference = await this.#repo.preference(actor.companyId, reminder.partyId);
      const openPromises = await this.#refreshPromises(actor, reminder.partyId, current, asOf);

      let blocked: { status: 'CANCELLED' | 'SUPPRESSED'; reason: string } | null = null;
      if (current.totalOutstanding.minor <= 0n) blocked = { status: 'CANCELLED', reason: 'The balance was settled before delivery.' };
      else if (this.#policy.stopForOpenDispute && disputes.length > 0) blocked = { status: 'CANCELLED', reason: 'An invoice in this reminder is disputed.' };
      else if (preference?.optedOut === true || preference?.disabledChannels.includes(reminder.channel) === true) blocked = { status: 'SUPPRESSED', reason: 'The customer opted out of this reminder channel.' };
      else if (this.#policy.pauseForPromiseToPay && openPromises.some((promise) => promise.promisedOn >= asOf)) {
        const held = Object.freeze({ ...reminder, statusReason: `Paused until the customer's promise date ${openPromises[0]!.promisedOn}.`, updatedAt: this.#clock.now().toISOString() });
        await this.#repo.updateReminder(held);
        processed.push(held);
        continue;
      }

      if (blocked !== null) {
        processed.push(await this.#finish(actor, reminder, blocked.status, current, null, blocked.reason));
        continue;
      }

      // A partial payment between review and delivery must change the amount the customer sees.
      // The original review snapshot stays in the audit trail; the communication gets this fresh one.
      const currentWords = words(reminder.locale, reminder.template, reminder.partyName, current.totalOutstanding, current.documents.map((item) => item.number));
      const fresh: ScheduledReminder = Object.freeze({ ...reminder, subject: currentWords.subject, message: currentWords.message, snapshot: current, statusReason: null, updatedAt: this.#clock.now().toISOString() });
      await this.#repo.updateReminder(fresh);
      const result = await this.#notifications.deliver(actor, {
        reminderId: fresh.id, recipientId: fresh.partyId, channel: fresh.channel, locale: fresh.locale,
        subject: fresh.subject, message: fresh.message, deduplicationKey: fresh.deduplicationKey,
      });
      if (result.status === 'scheduled') {
        const waiting = Object.freeze({ ...fresh, statusReason: 'Rate limiting left this reminder scheduled for a later delivery run.', updatedAt: this.#clock.now().toISOString() });
        await this.#repo.updateReminder(waiting);
        processed.push(waiting);
        continue;
      }
      const status: ReminderStatus = result.status === 'delivered' ? 'DELIVERED' : result.status === 'suppressed' ? 'SUPPRESSED' : 'FAILED';
      processed.push(await this.#finish(actor, fresh, status, current, result.notificationId, result.detail));
    }
    return Object.freeze(processed);
  }

  async recordPromise(actor: ActorContext, input: { partyId: PartyId; amount: Money; promisedOn: IsoDate; asOf: IsoDate; note?: string | null }): Promise<PaymentPromise> {
    this.#permissions.require(actor, COLLECTION_PERMISSIONS.manage, 'record a promise to pay');
    if (input.amount.minor <= 0n) throw invalid('COLLECTION_PROMISE_AMOUNT_INVALID', 'Enter the amount the customer promised to pay.');
    if (input.promisedOn < input.asOf) throw invalid('COLLECTION_PROMISE_DATE_INVALID', 'The promise date cannot be before today.');
    const position = await this.#receivables.position(actor, input.partyId, input.asOf);
    const snapshot = snapshotOf(input.asOf, position.documents);
    if (snapshot.totalOutstanding.minor <= 0n) throw notAllowed('COLLECTION_ALREADY_SETTLED', 'There is no outstanding balance to promise against.');
    if (input.amount.minor > snapshot.totalOutstanding.minor) throw invalid('COLLECTION_PROMISE_EXCEEDS_BALANCE', 'The promised amount is more than the outstanding balance.');
    const now = this.#clock.now().toISOString();
    const promise: PaymentPromise = Object.freeze({ id: this.#newId(), companyId: actor.companyId, partyId: input.partyId, amount: input.amount, promisedOn: input.promisedOn, note: input.note?.trim() || null, status: 'OPEN', balanceAtPromise: snapshot.totalOutstanding, createdAt: now, createdBy: actor.userId, closedAt: null });
    await this.#repo.insertPromise(promise);
    await this.#recordAudit(actor, 'collections.promise.recorded', promise.id, `Promise to pay ${toDecimalString(promise.amount)} by ${promise.promisedOn} recorded.`, { partyId: input.partyId, balance: toDecimalString(snapshot.totalOutstanding) });
    return promise;
  }

  async openDispute(actor: ActorContext, input: { partyId: PartyId; documentId: string; asOf: IsoDate; reason: string }): Promise<CollectionDispute> {
    this.#permissions.require(actor, COLLECTION_PERMISSIONS.manage, 'record a customer dispute');
    if (input.reason.trim() === '') throw invalid('COLLECTION_DISPUTE_REASON_REQUIRED', 'Explain what the customer disputes.');
    const position = await this.#receivables.position(actor, input.partyId, input.asOf);
    const document = position.documents.find((item) => item.document.documentId === input.documentId && item.document.side === 'RECEIVABLE');
    if (document === undefined) throw notFound('COLLECTION_DOCUMENT_NOT_FOUND', 'That customer invoice was not found.');
    const duplicate = (await this.#repo.disputes(actor.companyId, input.partyId)).find((item) => item.documentId === input.documentId && item.status === 'OPEN');
    if (duplicate !== undefined) return duplicate;
    const now = this.#clock.now().toISOString();
    const dispute: CollectionDispute = Object.freeze({ id: this.#newId(), companyId: actor.companyId, partyId: input.partyId, documentId: input.documentId, documentNumber: document.document.number, reason: input.reason.trim(), status: 'OPEN', openedAt: now, openedBy: actor.userId, resolvedAt: null, resolution: null });
    await this.#repo.insertDispute(dispute);
    await this.#recordAudit(actor, 'collections.dispute.opened', dispute.id, `Reminder activity stopped for disputed invoice ${dispute.documentNumber}.`, { reason: dispute.reason });
    return dispute;
  }

  async resolveDispute(actor: ActorContext, disputeId: string, resolution: string): Promise<CollectionDispute> {
    this.#permissions.require(actor, COLLECTION_PERMISSIONS.manage, 'resolve a customer dispute');
    if (resolution.trim() === '') throw invalid('COLLECTION_DISPUTE_RESOLUTION_REQUIRED', 'Record how the dispute was resolved.');
    const dispute = await this.#findDispute(actor, disputeId);
    if (dispute.status === 'RESOLVED') return dispute;
    const next: CollectionDispute = Object.freeze({ ...dispute, status: 'RESOLVED', resolvedAt: this.#clock.now().toISOString(), resolution: resolution.trim() });
    await this.#repo.updateDispute(next);
    await this.#recordAudit(actor, 'collections.dispute.resolved', next.id, `Dispute on ${next.documentNumber} was resolved.`, { resolution: next.resolution ?? '' });
    return next;
  }

  async communications(actor: ActorContext, partyId?: PartyId): Promise<readonly CollectionCommunication[]> {
    this.#permissions.require(actor, COLLECTION_PERMISSIONS.manage, 'review collection communication history');
    return this.#repo.communications(actor.companyId, partyId);
  }

  async #refreshPromises(actor: ActorContext, partyId: PartyId, snapshot: BalanceSnapshot, asOf: IsoDate): Promise<readonly PaymentPromise[]> {
    const result: PaymentPromise[] = [];
    for (const promise of await this.#repo.promises(actor.companyId, partyId)) {
      if (promise.status !== 'OPEN') continue;
      const paid = promise.balanceAtPromise.minor - snapshot.totalOutstanding.minor;
      if (paid >= promise.amount.minor) {
        const kept: PaymentPromise = Object.freeze({ ...promise, status: 'KEPT', closedAt: this.#clock.now().toISOString() });
        await this.#repo.updatePromise(kept);
        continue;
      }
      if (promise.promisedOn < asOf) {
        const broken: PaymentPromise = Object.freeze({ ...promise, status: 'BROKEN', closedAt: this.#clock.now().toISOString() });
        await this.#repo.updatePromise(broken);
        continue;
      }
      result.push(promise);
    }
    return result;
  }

  async #finish(actor: ActorContext, reminder: ScheduledReminder, status: Exclude<ReminderStatus, 'SCHEDULED'>, snapshot: BalanceSnapshot, notificationId: string | null, detail: string | null): Promise<ScheduledReminder> {
    const now = this.#clock.now().toISOString();
    const next: ScheduledReminder = Object.freeze({ ...reminder, status, snapshot, notificationId, statusReason: detail, updatedAt: now });
    await this.#repo.updateReminder(next);
    const communication: CollectionCommunication = Object.freeze({ id: this.#newId(), companyId: actor.companyId, reminderId: reminder.id, partyId: reminder.partyId, channel: reminder.channel, outcome: status, subject: reminder.subject, message: reminder.message, snapshot, providerReference: notificationId, detail, occurredAt: now, actorId: actor.userId });
    await this.#repo.insertCommunication(communication);
    await this.#recordAudit(actor, `collections.reminder.${status.toLowerCase()}`, reminder.id, `${reminder.channel} reminder for ${reminder.partyName}: ${status.toLowerCase()}.`, { balance: toDecimalString(snapshot.totalOutstanding), detail: detail ?? '' });
    return next;
  }

  async #findDispute(actor: ActorContext, id: string): Promise<CollectionDispute> {
    for (const partyId of await this.#parties.parties(actor.companyId)) {
      const dispute = (await this.#repo.disputes(actor.companyId, partyId)).find((item) => item.id === id);
      if (dispute !== undefined) return dispute;
    }
    throw notFound('COLLECTION_DISPUTE_NOT_FOUND', 'That dispute was not found.');
  }

  async #recordAudit(actor: ActorContext, action: string, subjectId: string, summary: string, details: Readonly<Record<string, string>>): Promise<void> {
    await this.#audit.record({ companyId: actor.companyId, actorId: actor.userId, at: this.#clock.now().toISOString(), action, subjectType: 'collection', subjectId, summary, details });
  }
}

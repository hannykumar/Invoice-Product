/**
 * Issue #23 [E23] — the collections service.
 *
 * What it will not do:
 *
 *  1. **Send a reminder for a bill that stopped needing one.** Every send re-plans from receivables
 *     first. A payment that landed a second earlier cancels the message.
 *  2. **Send the same reminder twice.** The key is derived from the bill and the rung, and both
 *     this store and the notification service refuse a repeat of it.
 *  3. **Decide that a customer is a bad payer.** It records what was promised, what was disputed
 *     and what was sent. Judging the customer is the owner's job, and the product hands it over
 *     rather than escalating on its own.
 */
import {
  formatINR,
  invalid,
  notAllowed,
  notFound,
  type Clock,
  type IsoDate,
  type PartyId,
} from '@invoice/kernel';
import type { ActorContext, AuditPort, PermissionPort } from '@invoice/ledger';
import {
  COLLECTIONS_PERMISSIONS,
  type ContactPreference,
  type Dispute,
  type OptOut,
  type PromiseOutcome,
  type PromiseToPay,
  type Reminder,
  type ReminderCandidate,
  type ReminderChannel,
  type ReminderPlan,
  type ReminderPolicy,
} from './model.ts';
import { buildPlan, type PlanFacts } from './plan.ts';
import { DEFAULT_REMINDER_POLICY, daysBetween, policyOn } from './policy.ts';
import type {
  PartyContact,
  PartyContactPort,
  ReceivablesPositionPort,
  ReminderRepository,
  ReminderTransport,
} from './ports.ts';

export interface CollectionsServiceDeps {
  readonly businessName: string;
  readonly receivables: ReceivablesPositionPort;
  readonly contacts: PartyContactPort;
  readonly transport: ReminderTransport;
  readonly repository: ReminderRepository;
  readonly permissions: PermissionPort;
  readonly audit: AuditPort;
  readonly clock: Clock;
  readonly policies?: readonly ReminderPolicy[];
  readonly idFactory?: () => string;
}

export interface PromiseView {
  readonly promise: PromiseToPay;
  readonly outcome: PromiseOutcome;
  readonly explanation: { readonly 'en-IN': string; readonly 'hi-IN': string };
}

export class CollectionsService {
  readonly #businessName: string;
  readonly #receivables: ReceivablesPositionPort;
  readonly #contacts: PartyContactPort;
  readonly #transport: ReminderTransport;
  readonly #repo: ReminderRepository;
  readonly #permissions: PermissionPort;
  readonly #audit: AuditPort;
  readonly #clock: Clock;
  readonly #policies: readonly ReminderPolicy[];
  readonly #newId: () => string;

  constructor(deps: CollectionsServiceDeps) {
    this.#businessName = deps.businessName;
    this.#receivables = deps.receivables;
    this.#contacts = deps.contacts;
    this.#transport = deps.transport;
    this.#repo = deps.repository;
    this.#permissions = deps.permissions;
    this.#audit = deps.audit;
    this.#clock = deps.clock;
    this.#policies = deps.policies ?? [DEFAULT_REMINDER_POLICY];
    this.#newId = deps.idFactory ?? (() => crypto.randomUUID());
  }

  policyFor(today: IsoDate): ReminderPolicy {
    return policyOn(this.#policies, today);
  }

  /**
   * What would go out today, and what would deliberately not.
   *
   * Nothing is stored and nothing is sent. This is the screen the owner reads before agreeing.
   */
  async plan(actor: ActorContext, today: IsoDate): Promise<ReminderPlan> {
    this.#permissions.require(actor, COLLECTIONS_PERMISSIONS.view, 'see which customers would be reminded');
    return buildPlan(await this.#facts(actor, today));
  }

  /**
   * Sends one reminder.
   *
   * The plan is rebuilt here rather than trusted from the preview, so a bill paid, disputed or
   * promised in between is caught. That is the whole of "no reminder is sent for a settled or
   * disputed invoice" — it is checked at the last possible moment, not the first.
   */
  async send(actor: ActorContext, input: { documentId: string; today: IsoDate }): Promise<Reminder> {
    this.#permissions.require(actor, COLLECTIONS_PERMISSIONS.send, 'send a payment reminder');
    const plan = buildPlan(await this.#facts(actor, input.today));
    const candidate = plan.candidates.find((c) => c.documentId === input.documentId);
    if (candidate === undefined) {
      throw notFound('REMINDER_DOCUMENT_NOT_FOUND', 'That bill is not among this business’s open bills.');
    }
    if (candidate.decision === 'SKIP') {
      // Asking twice is a retry, not a second message: hand back the one that already went.
      if (candidate.reminderKey !== null) {
        const existing = await this.#repo.findByKey(actor.companyId, candidate.reminderKey);
        if (existing !== null) return existing;
      }
      throw notAllowed('REMINDER_NOT_APPLICABLE', candidate.explanation['en-IN'], {
        details: { reason: candidate.reason ?? 'SKIP', documentId: input.documentId },
      });
    }
    return this.#dispatch(actor, candidate);
  }

  /** Sends everything the plan agreed to, and reports each one, including the ones that failed. */
  async sendPlanned(actor: ActorContext, today: IsoDate): Promise<readonly Reminder[]> {
    this.#permissions.require(actor, COLLECTIONS_PERMISSIONS.send, 'send payment reminders');
    const plan = buildPlan(await this.#facts(actor, today));
    const sent: Reminder[] = [];
    for (const candidate of plan.candidates) {
      if (candidate.decision === 'SKIP') continue;
      sent.push(await this.#dispatch(actor, candidate));
    }
    return sent;
  }

  /** Retries a message the provider could not deliver. The bill is re-checked first, as ever. */
  async retry(actor: ActorContext, reminderId: string, today: IsoDate): Promise<Reminder> {
    this.#permissions.require(actor, COLLECTIONS_PERMISSIONS.send, 'retry a payment reminder');
    const reminder = await this.#require(actor, reminderId);
    if (reminder.state !== 'FAILED') {
      throw notAllowed('REMINDER_NOT_FAILED', 'Only a reminder that could not be delivered can be retried.');
    }
    const plan = buildPlan(await this.#facts(actor, today));
    const candidate = plan.candidates.find((c) => c.documentId === reminder.documentId);
    if (candidate === undefined || candidate.decision === 'SKIP') {
      const why = candidate?.explanation['en-IN'] ?? 'That bill is no longer open.';
      throw notAllowed('REMINDER_NOT_APPLICABLE', why, { details: { documentId: reminder.documentId } });
    }
    return this.#dispatch(actor, candidate, reminder);
  }

  /** The owner's record of every message about money: what was sent, skipped, failed and why. */
  async history(actor: ActorContext, partyId?: PartyId): Promise<readonly Reminder[]> {
    this.#permissions.require(actor, COLLECTIONS_PERMISSIONS.view, 'see the reminders that were sent');
    const all = await this.#repo.list(actor.companyId);
    return partyId === undefined ? all : all.filter((r) => r.partyId === partyId);
  }

  // --------------------------------------------------------------- promises to pay and disputes

  async recordPromise(
    actor: ActorContext,
    input: { partyId: PartyId; documentId: string; amount: PromiseToPay['amount']; promisedOn: IsoDate; note?: string | null },
  ): Promise<PromiseToPay> {
    this.#permissions.require(actor, COLLECTIONS_PERMISSIONS.promise, 'record a promise to pay');
    if (input.amount.minor <= 0n) {
      throw invalid('PROMISE_AMOUNT_NOT_POSITIVE', 'A promise to pay needs an amount greater than zero.');
    }
    const at = this.#clock.now().toISOString();
    const promise: PromiseToPay = {
      id: this.#newId(),
      companyId: actor.companyId,
      partyId: input.partyId,
      documentId: input.documentId,
      amount: input.amount,
      promisedOn: input.promisedOn,
      note: input.note ?? null,
      state: 'OPEN',
      recordedBy: actor.userId,
      recordedAt: at,
    };
    await this.#repo.savePromise(promise);
    await this.#audit.record({
      companyId: actor.companyId, actorId: actor.userId, at,
      action: 'collections.promise_recorded', subjectType: 'party', subjectId: input.partyId,
      summary: `${formatINR(input.amount)} promised by ${input.promisedOn} against ${input.documentId}.`,
      details: { documentId: input.documentId, promisedOn: input.promisedOn, amount: formatINR(input.amount) },
    });
    return promise;
  }

  async cancelPromise(actor: ActorContext, promiseId: string, reason: string): Promise<PromiseToPay> {
    this.#permissions.require(actor, COLLECTIONS_PERMISSIONS.promise, 'cancel a promise to pay');
    const promises = await this.#repo.promises(actor.companyId);
    const promise = promises.find((p) => p.id === promiseId);
    if (promise === undefined) throw notFound('PROMISE_NOT_FOUND', 'That promise is not recorded in this business.');
    const cancelled: PromiseToPay = { ...promise, state: 'CANCELLED' };
    await this.#repo.savePromise(cancelled);
    await this.#audit.record({
      companyId: actor.companyId, actorId: actor.userId, at: this.#clock.now().toISOString(),
      action: 'collections.promise_cancelled', subjectType: 'party', subjectId: promise.partyId,
      summary: `The promise against ${promise.documentId} was cancelled.`,
      details: { promiseId }, overrideReason: reason,
    });
    return cancelled;
  }

  /**
   * Whether each promise was kept.
   *
   * Derived by asking receivables what is still owed, never from a flag somebody remembered to
   * set. A promise is kept when the bill it was made about is settled by the promised date.
   */
  async promises(actor: ActorContext, today: IsoDate): Promise<readonly PromiseView[]> {
    this.#permissions.require(actor, COLLECTIONS_PERMISSIONS.view, 'see what customers promised');
    const policy = this.policyFor(today);
    const accounts = await this.#receivables.customers(actor, today);
    const outstandingOf = new Map<string, bigint>();
    for (const account of accounts) {
      for (const position of account.position.documents) {
        outstandingOf.set(position.document.documentId, position.outstanding.minor);
      }
    }
    return (await this.#repo.promises(actor.companyId)).map((promise) => {
      const outstanding = outstandingOf.get(promise.documentId) ?? 0n;
      const pastDue = daysBetween(today, promise.promisedOn) > policy.promiseGraceDays;
      const outcome: PromiseOutcome =
        promise.state === 'CANCELLED' ? 'CANCELLED' : outstanding <= 0n ? 'KEPT' : pastDue ? 'BROKEN' : 'AWAITED';
      return { promise, outcome, explanation: promiseWords(outcome, promise) };
    });
  }

  async raiseDispute(
    actor: ActorContext,
    input: { partyId: PartyId; documentId: string | null; reason: string },
  ): Promise<Dispute> {
    this.#permissions.require(actor, COLLECTIONS_PERMISSIONS.dispute, 'record a dispute about a bill');
    if (input.reason.trim() === '') {
      throw invalid('DISPUTE_REASON_REQUIRED', 'Please write what the customer says is wrong with the bill.', {
        messageId: 'override.reason_required',
      });
    }
    const at = this.#clock.now().toISOString();
    const dispute: Dispute = {
      id: this.#newId(),
      companyId: actor.companyId,
      partyId: input.partyId,
      documentId: input.documentId,
      reason: input.reason,
      state: 'OPEN',
      resolution: null,
      raisedBy: actor.userId,
      raisedAt: at,
      resolvedBy: null,
      resolvedAt: null,
    };
    await this.#repo.saveDispute(dispute);
    await this.#audit.record({
      companyId: actor.companyId, actorId: actor.userId, at,
      action: 'collections.dispute_raised', subjectType: 'party', subjectId: input.partyId,
      summary: `A dispute was recorded against ${input.documentId ?? 'the whole account'}.`,
      details: { documentId: input.documentId ?? 'ALL' }, overrideReason: input.reason,
    });
    return dispute;
  }

  async resolveDispute(actor: ActorContext, disputeId: string, resolution: string): Promise<Dispute> {
    this.#permissions.require(actor, COLLECTIONS_PERMISSIONS.dispute, 'close a dispute');
    const disputes = await this.#repo.disputes(actor.companyId);
    const dispute = disputes.find((d) => d.id === disputeId);
    if (dispute === undefined) throw notFound('DISPUTE_NOT_FOUND', 'That dispute is not recorded in this business.');
    if (dispute.state === 'RESOLVED') return dispute;
    const at = this.#clock.now().toISOString();
    const resolved: Dispute = { ...dispute, state: 'RESOLVED', resolution, resolvedBy: actor.userId, resolvedAt: at };
    await this.#repo.saveDispute(resolved);
    await this.#audit.record({
      companyId: actor.companyId, actorId: actor.userId, at,
      action: 'collections.dispute_resolved', subjectType: 'party', subjectId: dispute.partyId,
      summary: `The dispute against ${dispute.documentId ?? 'the whole account'} was closed.`,
      details: { disputeId }, overrideReason: resolution,
    });
    return resolved;
  }

  async disputes(actor: ActorContext): Promise<readonly Dispute[]> {
    this.#permissions.require(actor, COLLECTIONS_PERMISSIONS.view, 'see disputed bills');
    return this.#repo.disputes(actor.companyId);
  }

  // ------------------------------------------------------------------ what the customer allows

  /** Turns one channel off for one customer. "Do not WhatsApp me, email is fine." */
  async setChannelPreference(
    actor: ActorContext,
    input: { partyId: PartyId; channel: ReminderChannel; enabled: boolean; reason?: string | null },
  ): Promise<ContactPreference> {
    this.#permissions.require(actor, COLLECTIONS_PERMISSIONS.send, 'change how a customer is contacted');
    const preference: ContactPreference = {
      companyId: actor.companyId,
      partyId: input.partyId,
      channel: input.channel,
      state: input.enabled ? 'ENABLED' : 'DISABLED',
      reason: input.reason ?? null,
      recordedBy: actor.userId,
      recordedAt: this.#clock.now().toISOString(),
    };
    await this.#repo.savePreference(preference);
    await this.#audit.record({
      companyId: actor.companyId, actorId: actor.userId, at: preference.recordedAt,
      action: 'collections.channel_preference', subjectType: 'party', subjectId: input.partyId,
      summary: `${input.channel} reminders were turned ${input.enabled ? 'on' : 'off'} for this customer.`,
      details: { channel: input.channel, enabled: String(input.enabled) },
    });
    return preference;
  }

  /** A customer asking to be left alone entirely. Honoured until they ask to be reminded again. */
  async optOut(actor: ActorContext, partyId: PartyId, reason: string): Promise<OptOut> {
    this.#permissions.require(actor, COLLECTIONS_PERMISSIONS.send, 'stop reminders for a customer');
    if (reason.trim() === '') {
      throw invalid('OPT_OUT_REASON_REQUIRED', 'Please write why this customer should not be reminded.', {
        messageId: 'override.reason_required',
      });
    }
    const optOut: OptOut = {
      companyId: actor.companyId,
      partyId,
      reason,
      recordedBy: actor.userId,
      recordedAt: this.#clock.now().toISOString(),
    };
    await this.#repo.saveOptOut(optOut);
    await this.#audit.record({
      companyId: actor.companyId, actorId: actor.userId, at: optOut.recordedAt,
      action: 'collections.opted_out', subjectType: 'party', subjectId: partyId,
      summary: 'This customer will not receive automatic reminders.',
      details: {}, overrideReason: reason,
    });
    return optOut;
  }

  async resumeReminders(actor: ActorContext, partyId: PartyId): Promise<void> {
    this.#permissions.require(actor, COLLECTIONS_PERMISSIONS.send, 'start reminders again for a customer');
    await this.#repo.removeOptOut(actor.companyId, partyId);
    await this.#audit.record({
      companyId: actor.companyId, actorId: actor.userId, at: this.#clock.now().toISOString(),
      action: 'collections.opt_out_removed', subjectType: 'party', subjectId: partyId,
      summary: 'This customer will receive automatic reminders again.', details: {},
    });
  }

  // ------------------------------------------------------------------------------- the internals

  async #facts(actor: ActorContext, today: IsoDate): Promise<PlanFacts> {
    const accounts = await this.#receivables.customers(actor, today);
    const contacts = new Map<PartyId, PartyContact | null>();
    const preferences: ContactPreference[] = [];
    for (const account of accounts) {
      contacts.set(account.partyId, await this.#contacts.contact(actor.companyId, account.partyId));
      preferences.push(...(await this.#repo.preferences(actor.companyId, account.partyId)));
    }
    const optOuts = (
      await Promise.all(accounts.map((a) => this.#repo.optOut(actor.companyId, a.partyId)))
    ).filter((o): o is OptOut => o !== null);
    return {
      businessName: this.#businessName,
      policy: this.policyFor(today),
      today,
      at: this.#clock.now(),
      accounts,
      contacts,
      preferences,
      optOuts,
      promises: await this.#repo.promises(actor.companyId),
      disputes: await this.#repo.disputes(actor.companyId),
      history: await this.#repo.list(actor.companyId),
    };
  }

  /**
   * Turns an agreed candidate into a message.
   *
   * The reminder is written down before the provider is called, so a send that crashes halfway
   * leaves visible evidence rather than a silence nobody can explain.
   */
  async #dispatch(actor: ActorContext, candidate: ReminderCandidate, retrying?: Reminder): Promise<Reminder> {
    const key = candidate.reminderKey as string;
    const existing = retrying ?? (await this.#repo.findByKey(actor.companyId, key));
    if (existing !== undefined && existing !== null && existing.state !== 'FAILED') return existing;

    const owner = candidate.decision === 'ESCALATE';
    if (candidate.level === 'ESCALATE' && !owner) {
      // The escalation wording talks *about* the customer. Sending it *to* them would be the worst
      // bug this module could have, so it is impossible rather than merely avoided.
      throw notAllowed('REMINDER_WRONG_AUDIENCE', 'An escalation is written for the owner and is never sent to the customer.');
    }
    const contact = owner
      ? await this.#contacts.owner(actor.companyId)
      : await this.#contacts.contact(actor.companyId, candidate.partyId);
    if (contact === null) {
      throw notAllowed('REMINDER_NO_CHANNEL', `There is no saved way to reach ${candidate.partyName}.`);
    }

    const at = this.#clock.now().toISOString();
    const scheduled: Reminder = {
      id: existing?.id ?? this.#newId(),
      companyId: actor.companyId,
      branchId: actor.branchId,
      partyId: candidate.partyId,
      documentId: candidate.documentId,
      reminderKey: key,
      stepCode: candidate.step?.code ?? 'UNKNOWN',
      level: candidate.level ?? 'GENTLE',
      channel: candidate.channel ?? 'in_app',
      audience: owner ? 'OWNER' : 'CUSTOMER',
      message: candidate.explanation,
      snapshot: candidate.snapshot,
      state: 'SCHEDULED',
      failureReason: null,
      notificationId: null,
      scheduledBy: actor.userId,
      scheduledAt: at,
      sentAt: null,
    };
    await (existing === undefined || existing === null ? this.#repo.insert(scheduled) : this.#repo.update(scheduled));

    let settled: Reminder;
    try {
      const outcome = await this.#transport.send(actor, {
        companyId: actor.companyId,
        recipientId: contact.recipientId,
        audience: scheduled.audience,
        channel: scheduled.channel,
        level: scheduled.level,
        text: scheduled.message,
        deduplicationKey: key,
        payload: {
          bill: candidate.snapshot.documentNumber,
          outstanding: formatINR(candidate.snapshot.outstanding),
          daysOverdue: String(candidate.snapshot.daysOverdue),
        },
      });
      settled = {
        ...scheduled,
        state: outcome.state,
        notificationId: outcome.notificationId,
        sentAt: outcome.state === 'SENT' ? this.#clock.now().toISOString() : null,
      };
    } catch (error) {
      settled = {
        ...scheduled,
        state: 'FAILED',
        failureReason:
          error instanceof Error && error.message !== ''
            ? error.message
            : 'The message could not be delivered. You can try again.',
      };
    }
    await this.#repo.update(settled);

    await this.#audit.record({
      companyId: actor.companyId, actorId: actor.userId, at,
      action: settled.state === 'SENT' ? 'collections.reminder_sent' : `collections.reminder_${settled.state.toLowerCase()}`,
      subjectType: 'party', subjectId: candidate.partyId,
      summary: `${settled.level} reminder about ${candidate.snapshot.documentNumber} for ${formatINR(candidate.snapshot.outstanding)}, ${settled.state.toLowerCase()}.`,
      details: {
        documentId: candidate.documentId,
        step: settled.stepCode,
        channel: settled.channel,
        audience: settled.audience,
        outstanding: formatINR(candidate.snapshot.outstanding),
        daysOverdue: String(candidate.snapshot.daysOverdue),
      },
    });
    return settled;
  }

  async #require(actor: ActorContext, id: string): Promise<Reminder> {
    const reminder = await this.#repo.findById(actor.companyId, id);
    if (reminder === null) throw notFound('REMINDER_NOT_FOUND', 'That reminder does not exist in this business.');
    return reminder;
  }
}

const promiseWords = (outcome: PromiseOutcome, promise: PromiseToPay) => {
  const amount = formatINR(promise.amount);
  switch (outcome) {
    case 'KEPT':
      return {
        'en-IN': `Promised ${amount} by ${promise.promisedOn}, and the bill is paid.`,
        'hi-IN': `${promise.promisedOn} tak ${amount} dene ka vaada tha, aur bill chuk gaya.`,
      };
    case 'BROKEN':
      return {
        'en-IN': `Promised ${amount} by ${promise.promisedOn}. That date has passed and the bill is still open.`,
        'hi-IN': `${promise.promisedOn} tak ${amount} dene ka vaada tha. Woh tarikh nikal gayi aur bill abhi baaki hai.`,
      };
    case 'CANCELLED':
      return {
        'en-IN': `This promise of ${amount} was cancelled.`,
        'hi-IN': `${amount} ka yeh vaada radd kar diya gaya tha.`,
      };
    case 'AWAITED':
      return {
        'en-IN': `Promised ${amount} by ${promise.promisedOn}. Reminders are paused until then.`,
        'hi-IN': `${promise.promisedOn} tak ${amount} dene ka vaada hai. Tab tak reminder ruke rahenge.`,
      };
  }
};

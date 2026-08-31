/**
 * Issue #42 [E42] — the subscription service.
 *
 * The three things it will not do:
 *
 *  1. **Withhold a safeguard.** `check()` returns ALLOWED for anything essential before it looks at
 *     the plan, the state or the counters, and `definePlan()` refuses to build a plan that tries.
 *  2. **Delete or degrade a record.** There is no delete here. A plan that lapses stops writing;
 *     reading, exporting and every warning carry on, and the books are untouched.
 *  3. **Count the same thing twice.** Every usage event carries a key, and the counter is read and
 *     written without yielding, so a retry counts once and two tills at the same instant count two.
 */
import {
  forbidden,
  invalid,
  money,
  mulDiv,
  notFound,
  subtract,
  type Clock,
  type IsoDate,
  type Money,
} from '@invoice/kernel';
import type { ActorContext, AuditPort, PermissionPort } from '@invoice/ledger';
import { decide } from './entitlements.ts';
import { addDays, stateOn, STATE_WORDS, writingStopsOn } from './lifecycle.ts';
import {
  METER_LABELS,
  SERVICE_GST_BASIS_POINTS,
  SUBSCRIPTION_PERMISSIONS,
  periodOf,
  type Bilingual,
  type Capability,
  type Entitlement,
  type MeterId,
  type Plan,
  type ServiceInvoice,
  type Subscription,
  type SubscriptionState,
  type UsageTotal,
} from './model.ts';
import { SHIPPED_CAPABILITIES, SHIPPED_PLANS, capabilityByName, limitFor, planById } from './plans.ts';
import type {
  PaymentProviderPort,
  PaymentWebhook,
  ServiceInvoiceRepository,
  SubscriptionRepository,
  UsageRepository,
} from './ports.ts';

export interface SubscriptionServiceDeps {
  readonly subscriptions: SubscriptionRepository;
  readonly usage: UsageRepository;
  readonly invoices: ServiceInvoiceRepository;
  readonly payments: PaymentProviderPort;
  readonly permissions: PermissionPort;
  readonly audit: AuditPort;
  readonly clock: Clock;
  readonly plans?: readonly Plan[];
  readonly capabilities?: readonly Capability[];
  readonly idFactory?: () => string;
}

export interface AccountView {
  readonly subscription: Subscription;
  readonly plan: Plan;
  readonly state: SubscriptionState;
  readonly stateWords: Bilingual;
  readonly writingStopsOn: IsoDate | null;
  readonly usage: readonly UsageTotal[];
  readonly invoices: readonly ServiceInvoice[];
  /** Said on every plan, in every state. The promise the pricing is built around. */
  readonly promise: Bilingual;
}

export const PRICING_PROMISE: Bilingual = {
  'en-IN': 'Every plan gets every warning, every check and your data whenever you want it. Plans differ in how much you do, never in how carefully it is done.',
  'hi-IN': 'Har plan mein har chetavni, har jaanch, aur jab chahein apna data milta hai. Plan sirf itne mein alag hain ki aap kitna kaam karte hain — kaam kitni savdhani se hota hai, usme nahin.',
};

export class SubscriptionService {
  readonly #subscriptions: SubscriptionRepository;
  readonly #usage: UsageRepository;
  readonly #invoices: ServiceInvoiceRepository;
  readonly #payments: PaymentProviderPort;
  readonly #permissions: PermissionPort;
  readonly #audit: AuditPort;
  readonly #clock: Clock;
  readonly #plans: readonly Plan[];
  readonly #capabilities: readonly Capability[];
  readonly #newId: () => string;
  readonly #paymentEvents = new Map<string, Promise<ServiceInvoice>>();
  readonly #invoiceIssues = new Map<string, Promise<ServiceInvoice>>();

  constructor(deps: SubscriptionServiceDeps) {
    this.#subscriptions = deps.subscriptions;
    this.#usage = deps.usage;
    this.#invoices = deps.invoices;
    this.#payments = deps.payments;
    this.#permissions = deps.permissions;
    this.#audit = deps.audit;
    this.#clock = deps.clock;
    this.#plans = deps.plans ?? SHIPPED_PLANS;
    this.#capabilities = deps.capabilities ?? SHIPPED_CAPABILITIES;
    this.#newId = deps.idFactory ?? (() => crypto.randomUUID());
  }

  plans(): readonly Plan[] {
    return this.#plans;
  }

  /** Starts a trial, or puts a company on the free plan. Idempotent: asking twice changes nothing. */
  async start(actor: ActorContext, input: { planId: string; on: IsoDate }): Promise<Subscription> {
    this.#permissions.require(actor, SUBSCRIPTION_PERMISSIONS.manage, 'choose a plan');
    const existing = await this.#subscriptions.find(actor.companyId);
    if (existing !== null) return existing;
    const plan = this.#planOrThrow(input.planId);
    const at = this.#clock.now().toISOString();
    const subscription: Subscription = {
      id: this.#newId(),
      companyId: actor.companyId,
      planId: plan.id,
      startedOn: input.on,
      trialEndsOn: addDays(input.on, plan.trialDays),
      paidThrough: null,
      cancelledOn: null,
      cancellationReason: null,
      history: [{ planId: plan.id, from: input.on, reason: 'Signed up' }],
      updatedAt: at,
      updatedBy: actor.userId,
    };
    await this.#subscriptions.save(subscription);
    await this.#record(actor, 'subscription.started', plan.id, `Started on the ${plan.name['en-IN']} plan.`, {
      planId: plan.id, trialEndsOn: subscription.trialEndsOn,
    });
    return subscription;
  }

  /**
   * Moves to another plan.
   *
   * The change takes effect now, in both directions. A downgrade never deletes anything: the
   * company keeps every record it made on the larger plan, and simply cannot add more this month
   * than the smaller one allows. Every plan it has ever been on stays in the history.
   */
  async changePlan(actor: ActorContext, input: { planId: string; on: IsoDate; reason: string }): Promise<Subscription> {
    this.#permissions.require(actor, SUBSCRIPTION_PERMISSIONS.manage, 'change the plan');
    const plan = this.#planOrThrow(input.planId);
    const subscription = await this.#require(actor);
    if (subscription.planId === plan.id) return subscription;
    if (input.reason.trim() === '') {
      throw invalid('SUBSCRIPTION_REASON_REQUIRED', 'Please say why the plan is changing, so the history explains itself.');
    }
    const next: Subscription = {
      ...subscription,
      planId: plan.id,
      history: [...subscription.history, { planId: plan.id, from: input.on, reason: input.reason }],
      updatedAt: this.#clock.now().toISOString(),
      updatedBy: actor.userId,
    };
    await this.#subscriptions.save(next);
    await this.#record(actor, 'subscription.plan_changed', plan.id, `Moved from ${subscription.planId} to ${plan.id}.`, {
      from: subscription.planId, to: plan.id, reason: input.reason,
    });
    return next;
  }

  /** Stops the subscription. The books stay, and stay readable and downloadable. */
  async cancel(actor: ActorContext, input: { on: IsoDate; reason: string }): Promise<Subscription> {
    this.#permissions.require(actor, SUBSCRIPTION_PERMISSIONS.manage, 'cancel the subscription');
    if (input.reason.trim() === '') {
      throw invalid('SUBSCRIPTION_REASON_REQUIRED', 'Please say why this is being cancelled.');
    }
    const subscription = await this.#require(actor);
    const next: Subscription = {
      ...subscription,
      cancelledOn: input.on,
      cancellationReason: input.reason,
      updatedAt: this.#clock.now().toISOString(),
      updatedBy: actor.userId,
    };
    await this.#subscriptions.save(next);
    await this.#record(actor, 'subscription.cancelled', subscription.planId, 'The subscription was cancelled. No record was removed.', {
      on: input.on, reason: input.reason,
    });
    return next;
  }

  // ------------------------------------------------------------------------------- entitlements

  /**
   * May this company do this, today?
   *
   * Everything is read at the moment of asking. `wants` is how much this one action would spend, so
   * the answer is about the action in front of the person rather than about the meter in general.
   */
  async check(actor: ActorContext, capabilityName: string, today: IsoDate, wants = 1n): Promise<Entitlement> {
    const capability = capabilityByName(this.#capabilities, capabilityName);
    if (capability === null) {
      throw notFound('ENTITLEMENT_UNKNOWN_CAPABILITY', `"${capabilityName}" is not something this product measures.`);
    }
    const subscription = await this.#subscriptions.find(actor.companyId);
    if (subscription === null) {
      // No subscription on file is not a licence to stop the product: it is a fact we do not have.
      // The free plan is assumed, and the account screen says so.
      const free = this.#planOrThrow('free');
      return decide({
        capability, plan: free, today, wants,
        subscription: this.#impliedFree(actor.companyId, today),
        used: capability.meter === null ? 0n : await this.#usage.total(actor.companyId, capability.meter, periodOf(today)),
        nextPlan: this.#nextPlanFor(free, capability.meter),
      });
    }
    const plan = this.#planOrThrow(subscription.planId);
    const used = capability.meter === null ? 0n : await this.#usage.total(actor.companyId, capability.meter, periodOf(today));
    return decide({ capability, plan, subscription, today, used, wants, nextPlan: this.#nextPlanFor(plan, capability.meter) });
  }

  /** The same question, phrased as a gate. Throws a typed, readable refusal. */
  async require(actor: ActorContext, capabilityName: string, today: IsoDate, wants = 1n): Promise<Entitlement> {
    const entitlement = await this.check(actor, capabilityName, today, wants);
    if (entitlement.outcome === 'BLOCKED_READ_ONLY') {
      throw forbidden('ENTITLEMENT_READ_ONLY', entitlement.reason['en-IN'], {
        details: { capability: capabilityName, state: entitlement.state },
      });
    }
    if (entitlement.outcome === 'BLOCKED_LIMIT') {
      throw forbidden('ENTITLEMENT_LIMIT_REACHED', entitlement.reason['en-IN'], {
        details: { capability: capabilityName, meter: entitlement.meter ?? '', limit: String(entitlement.limit ?? '') },
      });
    }
    return entitlement;
  }

  /**
   * Counts something that has been done.
   *
   * Called **after** the work succeeded, never before: a bill that failed to post is not a bill,
   * and charging somebody's allowance for it would be the product billing them for its own error.
   */
  async recordUsage(
    actor: ActorContext,
    input: { meter: MeterId; quantity?: bigint; idempotencyKey: string; note: string; on: IsoDate },
  ): Promise<{ counted: boolean; total: bigint }> {
    if (input.idempotencyKey.trim() === '') {
      throw invalid('USAGE_KEY_REQUIRED', 'Every usage event needs a key, so a retry cannot be counted twice.');
    }
    const quantity = input.quantity ?? 1n;
    if (quantity <= 0n) throw invalid('USAGE_QUANTITY_NOT_POSITIVE', 'Usage is counted upwards only.');
    return this.#usage.record({
      id: this.#newId(),
      companyId: actor.companyId,
      meter: input.meter,
      quantity,
      period: periodOf(input.on),
      idempotencyKey: input.idempotencyKey,
      at: this.#clock.now().toISOString(),
      by: actor.userId,
      note: input.note,
    });
  }

  /** What has been used this month, against what the plan allows. */
  async usage(actor: ActorContext, today: IsoDate): Promise<readonly UsageTotal[]> {
    this.#permissions.require(actor, SUBSCRIPTION_PERMISSIONS.view, 'see what your plan covers');
    const subscription = await this.#subscriptions.find(actor.companyId);
    const plan = this.#planOrThrow(subscription?.planId ?? 'free');
    const period = periodOf(today);
    const meters: MeterId[] = ['invoices', 'companies', 'storage_mb', 'ai_requests', 'external_api_calls'];
    return Promise.all(meters.map(async (meter) => {
      const used = await this.#usage.total(actor.companyId, meter, period);
      const limit = limitFor(plan, meter);
      return {
        meter, period, used, limit,
        remaining: limit === null ? null : (limit - used > 0n ? limit - used : 0n),
        label: METER_LABELS[meter],
      };
    }));
  }

  async account(actor: ActorContext, today: IsoDate): Promise<AccountView> {
    this.#permissions.require(actor, SUBSCRIPTION_PERMISSIONS.view, 'see your plan');
    const subscription = (await this.#subscriptions.find(actor.companyId)) ?? this.#impliedFree(actor.companyId, today);
    const plan = this.#planOrThrow(subscription.planId);
    const state = stateOn(subscription, plan, today);
    return {
      subscription,
      plan,
      state,
      stateWords: STATE_WORDS[state],
      writingStopsOn: writingStopsOn(subscription, plan),
      usage: await this.usage(actor, today),
      invoices: await this.#invoices.list(actor.companyId),
      promise: PRICING_PROMISE,
    };
  }

  // ------------------------------------------------------------------- our own invoices and money

  /**
   * Our invoice to the customer for a month of the service.
   *
   * Idempotent per period: asking twice for August returns August's invoice rather than making a
   * second one. GST is 1800 basis points of the net, in paise, with no float anywhere near it.
   */
  async issueServiceInvoice(actor: ActorContext, input: { period: string; on: IsoDate }): Promise<ServiceInvoice> {
    this.#permissions.require(actor, SUBSCRIPTION_PERMISSIONS.manage, 'issue the subscription invoice');
    const key = `${actor.companyId}:${input.period}`;
    const pending = this.#invoiceIssues.get(key);
    if (pending !== undefined) return pending;
    const issue = (async () => {
      const existing = await this.#invoices.findForPeriod(actor.companyId, input.period);
      if (existing !== null) return existing;
      const subscription = await this.#require(actor);
      const plan = this.#planOrThrow(subscription.planId);
      const net = plan.monthlyPrice;
      const gst = mulDiv(net, SERVICE_GST_BASIS_POINTS, 10_000n);
      const invoice: ServiceInvoice = {
        id: this.#newId(),
        companyId: actor.companyId,
        planId: plan.id,
        period: input.period,
        net,
        gst,
        total: money(net.minor + gst.minor),
        state: net.minor === 0n ? 'PAID' : 'ISSUED',
        issuedOn: input.on,
        dueOn: addDays(input.on, 7),
        paidOn: net.minor === 0n ? input.on : null,
        providerReference: null,
        failureReason: null,
      };
      await this.#invoices.save(invoice);
      await this.#record(actor, 'subscription.invoice_issued', invoice.id, `Invoice for ${input.period} on the ${plan.name['en-IN']} plan.`, {
        period: input.period, total: invoice.total.minor.toString(),
      });
      return invoice;
    })();
    this.#invoiceIssues.set(key, issue);
    try { return await issue; }
    finally { this.#invoiceIssues.delete(key); }
  }

  /** Asks the provider for the money. A refusal is recorded and changes no business record. */
  async chargeServiceInvoice(actor: ActorContext, invoiceId: string, on: IsoDate): Promise<ServiceInvoice> {
    this.#permissions.require(actor, SUBSCRIPTION_PERMISSIONS.manage, 'pay the subscription');
    const invoice = await this.#invoiceOrThrow(actor, invoiceId);
    if (invoice.state === 'PAID') return invoice;
    const outcome = await this.#payments.charge({
      companyId: actor.companyId,
      invoiceId: invoice.id,
      amountPaise: invoice.total.minor,
      idempotencyKey: `service-invoice:${invoice.id}`,
      correlationId: `subscription:${actor.companyId}:${invoice.period}`,
    });
    return outcome.state === 'PAID'
      ? this.#settle(actor, invoice, on, outcome.providerReference)
      : this.#fail(actor, invoice, outcome.failureReason ?? 'The payment could not be taken.');
  }

  /**
   * A provider telling us what happened.
   *
   * Deduplicated by the provider's own event id here as well as at #8's gateway, so a provider that
   * sends the same event twice — which they do — pays the invoice once.
   */
  async receivePaymentEvent(actor: ActorContext, webhook: PaymentWebhook): Promise<ServiceInvoice> {
    const key = `${actor.companyId}:${webhook.eventId}`;
    const handled = this.#paymentEvents.get(key);
    if (handled !== undefined) return handled;
    const processing = (async () => {
      const invoice = await this.#invoiceOrThrow(actor, webhook.invoiceId);
      return webhook.outcome === 'PAID'
        ? this.#settle(actor, invoice, webhook.occurredOn, webhook.providerReference)
        : this.#fail(actor, invoice, webhook.failureReason ?? 'The provider declined the payment.');
    })();
    this.#paymentEvents.set(key, processing);
    try { return await processing; }
    catch (error) { this.#paymentEvents.delete(key); throw error; }
  }

  async #settle(actor: ActorContext, invoice: ServiceInvoice, on: IsoDate, providerReference: string): Promise<ServiceInvoice> {
    if (invoice.state === 'PAID') return invoice;
    const paid: ServiceInvoice = { ...invoice, state: 'PAID', paidOn: on, providerReference, failureReason: null };
    await this.#invoices.save(paid);
    const subscription = await this.#require(actor);
    // Paid for the month the invoice was for, counted from the later of today and what was covered.
    const from = subscription.paidThrough !== null && subscription.paidThrough > on ? subscription.paidThrough : on;
    await this.#subscriptions.save({
      ...subscription,
      paidThrough: addDays(from, 30),
      updatedAt: this.#clock.now().toISOString(),
      updatedBy: actor.userId,
    });
    await this.#record(actor, 'subscription.invoice_paid', invoice.id, `Payment received for ${invoice.period}.`, {
      period: invoice.period, reference: providerReference,
    });
    return paid;
  }

  async #fail(actor: ActorContext, invoice: ServiceInvoice, reason: string): Promise<ServiceInvoice> {
    const failed: ServiceInvoice = { ...invoice, state: 'FAILED', failureReason: reason };
    await this.#invoices.save(failed);
    await this.#record(actor, 'subscription.payment_failed', invoice.id, 'A payment did not go through. Nothing in the books changed.', {
      period: invoice.period, why: reason,
    });
    return failed;
  }

  // ------------------------------------------------------------------------------- the internals

  #impliedFree(companyId: string, today: IsoDate): Subscription {
    return {
      id: `implied:${companyId}`,
      companyId,
      planId: 'free',
      startedOn: today,
      trialEndsOn: today,
      paidThrough: null,
      cancelledOn: null,
      cancellationReason: null,
      history: [{ planId: 'free', from: today, reason: 'No plan chosen yet, so the free plan applies.' }],
      updatedAt: this.#clock.now().toISOString(),
      updatedBy: 'system',
    };
  }

  /**
   * The cheapest plan that would actually help with this meter.
   *
   * "Actually" is the word doing the work: a plan that costs more but has the same limit is not an
   * answer to somebody who has run out, and offering it would be selling rather than helping.
   */
  #nextPlanFor(current: Plan, meter: MeterId | null): Plan | null {
    if (meter === null) return null;
    const currentLimit = limitFor(current, meter);
    if (currentLimit === null) return null;
    return this.#plans
      .filter((candidate) => candidate.id !== current.id)
      .filter((candidate) => {
        const limit = limitFor(candidate, meter);
        return limit === null || limit > currentLimit;
      })
      .sort((a, b) => Number(a.monthlyPrice.minor - b.monthlyPrice.minor))[0] ?? null;
  }

  #planOrThrow(id: string): Plan {
    const plan = planById(this.#plans, id);
    if (plan === null) throw notFound('SUBSCRIPTION_PLAN_UNKNOWN', `There is no "${id}" plan.`);
    return plan;
  }

  async #require(actor: ActorContext): Promise<Subscription> {
    const subscription = await this.#subscriptions.find(actor.companyId);
    if (subscription === null) {
      throw notFound('SUBSCRIPTION_NOT_FOUND', 'This business has not chosen a plan yet.');
    }
    return subscription;
  }

  async #invoiceOrThrow(actor: ActorContext, id: string): Promise<ServiceInvoice> {
    const invoice = await this.#invoices.find(actor.companyId, id);
    if (invoice === null) throw notFound('SERVICE_INVOICE_NOT_FOUND', 'That subscription invoice does not exist for this business.');
    return invoice;
  }

  async #record(actor: ActorContext, action: string, subjectId: string, summary: string, details: Readonly<Record<string, string>>): Promise<void> {
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at: this.#clock.now().toISOString(),
      action,
      subjectType: 'subscription',
      subjectId,
      summary,
      details,
    });
  }
}

/** How much of a limit is left, for a screen that wants to warn before it bites. */
export const remainingOf = (total: UsageTotal): Money | null =>
  total.limit === null ? null : subtract(money(total.limit), money(total.used));

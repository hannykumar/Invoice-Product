/**
 * Issue #42 [E42] — the tests that matter.
 *
 * Three of them are the acceptance criteria and are worth reading first: nothing is deleted when a
 * plan expires, usage is counted exactly once under concurrency, and no plan in any state can
 * withhold a compliance safeguard.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { DomainError, isoDate, rupees } from '@invoice/kernel';
import {
  ESSENTIAL_CAPABILITIES,
  SHIPPED_PLANS,
  WithheldSafeguardError,
  definePlan,
  stateOn,
} from '../src/index.ts';
import { EVERY_PERMISSION, TODAY, makeSubscriptionDesk } from './harness.ts';

const on = (value: string) => isoDate(value);

describe('a plan may limit how much, never how carefully', () => {
  it('refuses to build a plan that withholds a safeguard', () => {
    for (const essential of ESSENTIAL_CAPABILITIES) {
      assert.throws(
        () => definePlan({
          id: 'nasty', name: { 'en-IN': 'Nasty', 'hi-IN': 'Nasty' },
          description: { 'en-IN': 'x', 'hi-IN': 'x' },
          monthlyPrice: rupees(0), trialDays: 0, graceDays: 0, limits: [],
          withholds: [essential],
        }),
        (error: unknown) => error instanceof WithheldSafeguardError && error.capability === essential,
      );
    }
  });

  it('allows every safeguard on the smallest plan, and on an expired one', async () => {
    const desk = await makeSubscriptionDesk();
    await desk.service.start(desk.actor, { planId: 'free', on: on('2026-01-01') });

    for (const essential of ESSENTIAL_CAPABILITIES) {
      const free = await desk.service.check(desk.actor, essential, TODAY);
      assert.equal(free.outcome, 'ALLOWED', `${essential} on the free plan`);
      assert.ok(free.essential);
    }

    // Now let it lapse completely: a paid plan, never paid, long past its grace.
    await desk.service.changePlan(desk.actor, { planId: 'starter', on: on('2026-01-01'), reason: 'Upgraded' });
    const lapsed = await desk.service.account(desk.actor, on('2026-06-01'));
    assert.equal(lapsed.state, 'READ_ONLY');
    for (const essential of ESSENTIAL_CAPABILITIES) {
      const still = await desk.service.check(desk.actor, essential, on('2026-06-01'));
      assert.equal(still.outcome, 'ALLOWED', `${essential} on an expired plan`);
    }
    // Including getting the data out, which is what makes "nothing is deleted" mean anything.
    assert.equal((await desk.service.check(desk.actor, 'data.export', on('2026-06-01'))).outcome, 'ALLOWED');
  });

  it('every shipped plan carries every safeguard', async () => {
    const desk = await makeSubscriptionDesk();
    for (const plan of SHIPPED_PLANS) {
      assert.ok(!plan.limits.some((limit) => (ESSENTIAL_CAPABILITIES as readonly string[]).includes(limit.meter)));
    }
    await desk.service.start(desk.actor, { planId: 'free', on: TODAY });
    assert.match((await desk.service.account(desk.actor, TODAY)).promise['en-IN'], /every warning, every check/);
  });
});

describe('nothing is deleted when a plan expires', () => {
  it('stops writing and leaves the books exactly as they were', async () => {
    const desk = await makeSubscriptionDesk();
    await desk.service.start(desk.actor, { planId: 'starter', on: on('2026-01-01') });

    // What the books say before the plan lapses, read from the real report service.
    const before = await desk.business.reports.trialBalance(desk.actor, { from: on('2026-04-01'), to: on('2026-06-01') });

    const account = await desk.service.account(desk.actor, on('2026-06-01'));
    assert.equal(account.state, 'READ_ONLY');

    // Writing stops...
    await assert.rejects(
      () => desk.service.require(desk.actor, 'sales.issue_invoice', on('2026-06-01')),
      (error: unknown) => error instanceof DomainError && error.code === 'ENTITLEMENT_READ_ONLY',
    );
    // ...reading does not.
    assert.equal((await desk.service.check(desk.actor, 'reports.view.financial', on('2026-06-01'))).outcome, 'ALLOWED');

    const after = await desk.business.reports.trialBalance(desk.actor, { from: on('2026-04-01'), to: on('2026-06-01') });
    assert.deepEqual(after.body, before.body, 'the books are untouched by anything this module did');
    assert.match(account.stateWords['en-IN'], /Nothing has been deleted/);
  });

  it('brings everything back the moment it is paid', async () => {
    const desk = await makeSubscriptionDesk();
    await desk.service.start(desk.actor, { planId: 'starter', on: on('2026-01-01') });
    assert.equal((await desk.service.account(desk.actor, on('2026-06-01'))).state, 'READ_ONLY');

    const invoice = await desk.service.issueServiceInvoice(desk.actor, { period: '2026-06', on: on('2026-06-01') });
    await desk.service.chargeServiceInvoice(desk.actor, invoice.id, on('2026-06-01'));

    const account = await desk.service.account(desk.actor, on('2026-06-01'));
    assert.equal(account.state, 'ACTIVE');
    assert.equal((await desk.service.check(desk.actor, 'sales.issue_invoice', on('2026-06-01'))).outcome, 'ALLOWED');
  });

  it('a downgrade keeps everything already recorded', async () => {
    const desk = await makeSubscriptionDesk();
    await desk.service.start(desk.actor, { planId: 'growth', on: on('2026-06-01') });
    for (let i = 0; i < 60; i += 1) {
      await desk.service.recordUsage(desk.actor, { meter: 'invoices', idempotencyKey: `bill-${i}`, note: 'bill issued', on: TODAY });
    }
    const before = await desk.service.usage(desk.actor, TODAY);
    await desk.service.changePlan(desk.actor, { planId: 'free', on: TODAY, reason: 'Business is quieter this year' });
    const after = await desk.service.usage(desk.actor, TODAY);

    const used = (totals: typeof before) => totals.find((total) => total.meter === 'invoices')?.used;
    assert.equal(used(after), used(before), 'what was done is still what was done');
    assert.equal(used(after), 60n);

    // The free plan allows 50 a month and 60 are already recorded: the 61st is refused, and the 60
    // are untouched. A smaller plan is a smaller allowance, never an erasure.
    const entitlement = await desk.service.check(desk.actor, 'sales.issue_invoice', TODAY);
    assert.equal(entitlement.outcome, 'BLOCKED_LIMIT');
    assert.match(entitlement.reason['en-IN'], /already recorded is safe and unchanged/);
    // The way out named is a plan that would actually help, not merely a dearer one.
    assert.match(entitlement.reason['en-IN'], /Moving to Starter \(₹499\.00 a month\)/);

    const subscription = (await desk.service.account(desk.actor, TODAY)).subscription;
    assert.equal(subscription.history.length, 2, 'and every plan it has been on is still on the record');
  });
});

describe('usage is counted once, and exactly once', () => {
  it('counts fifty simultaneous events as fifty', async () => {
    const desk = await makeSubscriptionDesk();
    await desk.service.start(desk.actor, { planId: 'growth', on: TODAY });
    await Promise.all(
      Array.from({ length: 50 }, (_value, index) =>
        desk.service.recordUsage(desk.actor, { meter: 'invoices', idempotencyKey: `till-${index}`, note: 'bill issued', on: TODAY }),
      ),
    );
    const totals = await desk.service.usage(desk.actor, TODAY);
    assert.equal(totals.find((total) => total.meter === 'invoices')?.used, 50n);
  });

  it('counts fifty simultaneous retries of one event as one', async () => {
    const desk = await makeSubscriptionDesk();
    await desk.service.start(desk.actor, { planId: 'growth', on: TODAY });
    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () =>
        desk.service.recordUsage(desk.actor, { meter: 'invoices', idempotencyKey: 'the-same-bill', note: 'bill issued', on: TODAY }),
      ),
    );
    assert.equal(outcomes.filter((outcome) => outcome.counted).length, 1, 'one of them counted');
    const totals = await desk.service.usage(desk.actor, TODAY);
    assert.equal(totals.find((total) => total.meter === 'invoices')?.used, 1n);
  });

  it('needs a key, and will not count backwards', async () => {
    const desk = await makeSubscriptionDesk();
    await desk.service.start(desk.actor, { planId: 'growth', on: TODAY });
    await assert.rejects(
      () => desk.service.recordUsage(desk.actor, { meter: 'invoices', idempotencyKey: '  ', note: 'x', on: TODAY }),
      (error: unknown) => error instanceof DomainError && error.code === 'USAGE_KEY_REQUIRED',
    );
    await assert.rejects(
      () => desk.service.recordUsage(desk.actor, { meter: 'invoices', quantity: -5n, idempotencyKey: 'k', note: 'x', on: TODAY }),
      (error: unknown) => error instanceof DomainError && error.code === 'USAGE_QUANTITY_NOT_POSITIVE',
    );
  });

  it('counts each month on its own', async () => {
    const desk = await makeSubscriptionDesk();
    await desk.service.start(desk.actor, { planId: 'free', on: on('2026-05-01') });
    await desk.service.recordUsage(desk.actor, { meter: 'invoices', idempotencyKey: 'may', note: 'x', on: on('2026-05-20') });
    await desk.service.recordUsage(desk.actor, { meter: 'invoices', idempotencyKey: 'june', note: 'x', on: on('2026-06-02') });
    const june = await desk.service.usage(desk.actor, on('2026-06-02'));
    assert.equal(june.find((total) => total.meter === 'invoices')?.used, 1n, 'a new month starts at nothing');
  });

  it('says how much is left, in words a shopkeeper reads', async () => {
    const desk = await makeSubscriptionDesk();
    await desk.service.start(desk.actor, { planId: 'free', on: TODAY });
    for (let i = 0; i < 48; i += 1) {
      await desk.service.recordUsage(desk.actor, { meter: 'invoices', idempotencyKey: `b${i}`, note: 'x', on: TODAY });
    }
    const entitlement = await desk.service.check(desk.actor, 'sales.issue_invoice', TODAY);
    assert.equal(entitlement.outcome, 'ALLOWED');
    assert.match(entitlement.reason['en-IN'], /2 of 50 bills left this month/);
    assert.match(entitlement.reason['hi-IN'], /baaki hain/);
  });
});

describe('the trial, the grace and the day it stops', () => {
  it('walks a starter trial through every state as the days pass', async () => {
    const desk = await makeSubscriptionDesk();
    const subscription = await desk.service.start(desk.actor, { planId: 'starter', on: on('2026-06-01') });
    const plan = SHIPPED_PLANS.find((candidate) => candidate.id === 'starter');
    assert.ok(plan);

    assert.equal(stateOn(subscription, plan, on('2026-06-05')), 'TRIALING');
    assert.equal(stateOn(subscription, plan, on('2026-06-15')), 'TRIALING', 'fourteen days of trial');
    assert.equal(stateOn(subscription, plan, on('2026-06-16')), 'PAST_DUE');
    assert.equal(stateOn(subscription, plan, on('2026-06-20')), 'GRACE');
    assert.equal(stateOn(subscription, plan, on('2026-06-30')), 'GRACE', 'fifteen days of grace');
    assert.equal(stateOn(subscription, plan, on('2026-07-01')), 'READ_ONLY');
  });

  it('keeps writing through past-due and grace, and warns before it stops', async () => {
    const desk = await makeSubscriptionDesk();
    await desk.service.start(desk.actor, { planId: 'starter', on: on('2026-06-01') });
    const grace = await desk.service.check(desk.actor, 'sales.issue_invoice', on('2026-06-20'));
    assert.equal(grace.outcome, 'ALLOWED');
    assert.equal(grace.state, 'GRACE');

    const account = await desk.service.account(desk.actor, on('2026-06-20'));
    assert.equal(account.writingStopsOn, '2026-06-30');
    assert.match(account.stateWords['en-IN'], /told before anything stops/);
  });

  it('a free plan never lapses, because nothing is owed', async () => {
    const desk = await makeSubscriptionDesk();
    await desk.service.start(desk.actor, { planId: 'free', on: on('2026-01-01') });
    assert.equal((await desk.service.account(desk.actor, on('2030-01-01'))).state, 'ACTIVE');
  });

  it('a cancelled subscription still hands over the books', async () => {
    const desk = await makeSubscriptionDesk();
    await desk.service.start(desk.actor, { planId: 'starter', on: on('2026-06-01') });
    await desk.service.cancel(desk.actor, { on: on('2026-06-10'), reason: 'Closing the shop' });
    const account = await desk.service.account(desk.actor, on('2026-06-11'));
    assert.equal(account.state, 'CANCELLED');
    assert.equal((await desk.service.check(desk.actor, 'data.export', on('2026-06-11'))).outcome, 'ALLOWED');
    assert.match(account.stateWords['en-IN'], /still yours to download/);
  });

  it('a company with no plan on file is treated as free, not as stopped', async () => {
    const desk = await makeSubscriptionDesk();
    const entitlement = await desk.service.check(desk.actor, 'sales.issue_invoice', TODAY);
    assert.equal(entitlement.outcome, 'ALLOWED');
    assert.equal(entitlement.state, 'ACTIVE');
  });
});

describe('upgrades and downgrades', () => {
  it('an upgrade lifts the limit at once', async () => {
    const desk = await makeSubscriptionDesk();
    await desk.service.start(desk.actor, { planId: 'free', on: TODAY });
    for (let i = 0; i < 50; i += 1) {
      await desk.service.recordUsage(desk.actor, { meter: 'invoices', idempotencyKey: `b${i}`, note: 'x', on: TODAY });
    }
    assert.equal((await desk.service.check(desk.actor, 'sales.issue_invoice', TODAY)).outcome, 'BLOCKED_LIMIT');

    await desk.service.changePlan(desk.actor, { planId: 'growth', on: TODAY, reason: 'Busy season' });
    const after = await desk.service.check(desk.actor, 'sales.issue_invoice', TODAY);
    assert.equal(after.outcome, 'ALLOWED');
    assert.match(after.reason['en-IN'], /no limit/);
  });

  it('a plan change needs a reason, and staying put changes nothing', async () => {
    const desk = await makeSubscriptionDesk();
    await desk.service.start(desk.actor, { planId: 'free', on: TODAY });
    await assert.rejects(
      () => desk.service.changePlan(desk.actor, { planId: 'growth', on: TODAY, reason: '  ' }),
      (error: unknown) => error instanceof DomainError && error.code === 'SUBSCRIPTION_REASON_REQUIRED',
    );
    const same = await desk.service.changePlan(desk.actor, { planId: 'free', on: TODAY, reason: 'no change' });
    assert.equal(same.history.length, 1);
  });
});

describe('our own invoice, and the money', () => {
  it('issues one invoice a month, with GST worked out in paise', async () => {
    const desk = await makeSubscriptionDesk();
    await desk.service.start(desk.actor, { planId: 'starter', on: TODAY });
    const invoice = await desk.service.issueServiceInvoice(desk.actor, { period: '2026-06', on: TODAY });
    assert.equal(invoice.net.minor, 49_900n);
    assert.equal(invoice.gst.minor, 8_982n, '18% of ₹499, exactly, in paise');
    assert.equal(invoice.total.minor, 58_882n);

    const again = await desk.service.issueServiceInvoice(desk.actor, { period: '2026-06', on: TODAY });
    assert.equal(again.id, invoice.id, 'asking twice does not raise a second invoice');
  });

  it('a declined payment changes the invoice and nothing else', async () => {
    const desk = await makeSubscriptionDesk();
    await desk.service.start(desk.actor, { planId: 'starter', on: on('2026-06-01') });
    const before = await desk.business.reports.trialBalance(desk.actor, { from: on('2026-04-01'), to: on('2026-06-01') });

    const invoice = await desk.service.issueServiceInvoice(desk.actor, { period: '2026-06', on: on('2026-06-16') });
    desk.payments.declineNext = true;
    const failed = await desk.service.chargeServiceInvoice(desk.actor, invoice.id, on('2026-06-16'));
    assert.equal(failed.state, 'FAILED');
    assert.match(failed.failureReason ?? '', /declined/);

    const after = await desk.business.reports.trialBalance(desk.actor, { from: on('2026-04-01'), to: on('2026-06-01') });
    assert.deepEqual(after.body, before.body);
    // And the customer is not cut off the moment a card fails.
    assert.equal((await desk.service.check(desk.actor, 'sales.issue_invoice', on('2026-06-16'))).outcome, 'ALLOWED');
  });

  it('pays once however many times the provider says so', async () => {
    const desk = await makeSubscriptionDesk();
    await desk.service.start(desk.actor, { planId: 'starter', on: on('2026-06-01') });
    const invoice = await desk.service.issueServiceInvoice(desk.actor, { period: '2026-06', on: on('2026-06-16') });

    const event = {
      eventId: 'evt_1', invoiceId: invoice.id, outcome: 'PAID' as const,
      providerReference: 'pay_1', occurredOn: on('2026-06-16'),
    };
    const first = await desk.service.receivePaymentEvent(desk.actor, event);
    const second = await desk.service.receivePaymentEvent(desk.actor, event);
    assert.equal(first.state, 'PAID');
    assert.deepEqual(second, first);

    // Paid through thirty days from the payment, once — not sixty from two identical events.
    const account = await desk.service.account(desk.actor, on('2026-06-16'));
    assert.equal(account.subscription.paidThrough, '2026-07-16');
  });

  it('charging an already-paid invoice asks the provider for nothing', async () => {
    const desk = await makeSubscriptionDesk();
    await desk.service.start(desk.actor, { planId: 'starter', on: on('2026-06-01') });
    const invoice = await desk.service.issueServiceInvoice(desk.actor, { period: '2026-06', on: on('2026-06-16') });
    await desk.service.chargeServiceInvoice(desk.actor, invoice.id, on('2026-06-16'));
    const calls = desk.payments.seen.length;
    await desk.service.chargeServiceInvoice(desk.actor, invoice.id, on('2026-06-16'));
    assert.equal(desk.payments.seen.length, calls);
  });

  it('a free plan is invoiced at nothing, and is already paid', async () => {
    const desk = await makeSubscriptionDesk();
    await desk.service.start(desk.actor, { planId: 'free', on: TODAY });
    const invoice = await desk.service.issueServiceInvoice(desk.actor, { period: '2026-06', on: TODAY });
    assert.equal(invoice.total.minor, 0n);
    assert.equal(invoice.state, 'PAID');
    assert.equal(desk.payments.seen.length, 0);
  });
});

describe('the ordinary guarantees', () => {
  it('needs permission to see or change a plan', async () => {
    const desk = await makeSubscriptionDesk({ permissions: EVERY_PERMISSION.filter((p) => p !== 'subscription.manage') });
    await assert.rejects(
      () => desk.service.start(desk.actor, { planId: 'free', on: TODAY }),
      (error: unknown) => error instanceof DomainError && error.kind === 'FORBIDDEN',
    );
    const viewerOnly = { ...desk.actor, permissions: ['subscription.view'] };
    await desk.service.usage(viewerOnly, TODAY);
  });

  it("one company's plan and usage never reach another", async () => {
    const desk = await makeSubscriptionDesk();
    await desk.service.start(desk.actor, { planId: 'growth', on: TODAY });
    await desk.service.recordUsage(desk.actor, { meter: 'invoices', idempotencyKey: 'k', note: 'x', on: TODAY });

    const other = { ...desk.actor, companyId: isoDate('2026-01-01') as unknown as typeof desk.actor.companyId };
    const totals = await desk.service.usage(other, TODAY);
    assert.equal(totals.find((total) => total.meter === 'invoices')?.used, 0n);
    // And with no plan of their own they get the free plan's limits, not this company's.
    assert.equal(totals.find((total) => total.meter === 'invoices')?.limit, 50n);
  });

  it('records what it did in the audit trail, without a figure from the books', async () => {
    const desk = await makeSubscriptionDesk();
    await desk.service.start(desk.actor, { planId: 'starter', on: TODAY });
    await desk.service.changePlan(desk.actor, { planId: 'growth', on: TODAY, reason: 'Busy season' });
    const actions = desk.business.audit.events.map((event) => event.action);
    assert.ok(actions.includes('subscription.started'));
    assert.ok(actions.includes('subscription.plan_changed'));
  });

  it('refuses to answer about a capability it does not measure', async () => {
    const desk = await makeSubscriptionDesk();
    await assert.rejects(
      () => desk.service.check(desk.actor, 'something.invented', TODAY),
      (error: unknown) => error instanceof DomainError && error.code === 'ENTITLEMENT_UNKNOWN_CAPABILITY',
    );
  });
});

/**
 * Issue #36 [E36] acceptance criteria, enforced automatically.
 *
 *  - "Onboarding can be resumed safely"
 *  - "Opening debit/credit balances validate"
 *  - "Business-type suggestions never invent legal facts"
 *
 * plus the required bakery/wholesaler/service examples, incomplete-and-resumed tests, and opening
 * balance reconciliation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, asId, fixedClock, isoDate, rupees, toDecimalString, type CompanyId } from '@invoice/kernel';
import {
  buildDefaultChart,
  defaultChartIdFactory,
  InMemoryAuditPort,
  InMemoryLedgerStore,
  LedgerService,
  partyBalance,
  permissionPortFromActor,
  trialBalance,
  type ActorContext,
} from '@invoice/ledger';
import { InMemoryDeclaredRates } from '@invoice/gst-calc';
import { lintUserFacingText } from '../../ux-vocabulary/src/lint.ts';
import { InMemoryOnboardingRepository } from '../src/repository.ts';
import { OnboardingService } from '../src/service.ts';
import { checklistFor, renderChecklist } from '../src/checklist.ts';
import { BUSINESS_TYPE_PROFILES, NEVER_SUGGESTED, profileFor } from '../src/business-types.ts';
import { checkOpeningBalances, withAcceptedDifference } from '../src/opening-balances.ts';
import { validateStep } from '../src/validate.ts';
import { emptyAnswers, type OnboardingAnswers, type OnboardingSession } from '../src/model.ts';

const COMPANY: CompanyId = asId<'Company'>('test-co');
const OTHER: CompanyId = asId<'Company'>('other-co');
const USER = asId<'User'>('test-user');
const PERMISSIONS = ['ledger.setup', 'ledger.post.opening_balance', 'onboarding.run', 'onboarding.finish'];

const actorWith = (permissions: readonly string[], companyId: CompanyId = COMPANY): ActorContext => ({
  companyId,
  branchId: asId<'Branch'>('main'),
  userId: USER,
  permissions,
});

let counter = 0;

const setup = async (companyId: CompanyId = COMPANY) => {
  const store = new InMemoryLedgerStore();
  const repository = new InMemoryOnboardingRepository();
  store.join(repository);
  const audit = new InMemoryAuditPort();
  const clock = fixedClock('2026-08-29T09:00:00.000Z');
  counter += 1;
  let n = 0;
  const idFactory = (): string => `t${counter}-${String((n += 1)).padStart(6, '0')}`;
  const ledger = new LedgerService({ store, permissions: permissionPortFromActor, audit, clock, idFactory });
  await ledger.initialiseCompany(actorWith(PERMISSIONS, companyId), {
    booksStartDate: isoDate('2026-04-01'),
    accounts: buildDefaultChart(companyId, defaultChartIdFactory(companyId)),
  });
  const declaredRates = new InMemoryDeclaredRates();
  const service = new OnboardingService({
    store, ledger, repository, permissions: permissionPortFromActor, audit, clock, declaredRates, idFactory,
  });
  return { store, service, ledger, audit, declaredRates, actor: actorWith(PERMISSIONS, companyId) };
};

const goodBusiness = { legalName: 'Meera Bakers', businessType: 'BAKERY' as const, stateCode: '08' };
const goodTax = { registration: 'REGULAR' as const, gstin: '08AAAAA0000A1Z2', filingFrequency: 'QUARTERLY' as const, booksStartDate: isoDate('2026-04-01') };

const runThroughToOpening = async (): Promise<{ ctx: Awaited<ReturnType<typeof setup>>; session: OnboardingSession }> => {
  const ctx = await setup();
  let session = await ctx.service.start(ctx.actor, { idempotencyKey: 'k' });
  session = await ctx.service.saveStep(ctx.actor, session.id, 'business', { business: goodBusiness }, session.version);
  session = await ctx.service.saveStep(ctx.actor, session.id, 'tax_profile', { taxProfile: goodTax }, session.version);
  session = await ctx.service.saveStep(ctx.actor, session.id, 'branding', { branding: { templateId: 'bakery-warm' } }, session.version);
  session = await ctx.service.saveStep(
    ctx.actor, session.id, 'items',
    { items: [{ itemId: 'CAKE', name: 'Chocolate cake', kind: 'GOODS', baseUnit: 'PCS', hsnOrSac: '1905' }] },
    session.version,
  );
  session = await ctx.service.saveStep(
    ctx.actor, session.id, 'rates',
    { rates: [{ code: '1905', kind: 'GOODS', ratePercentTimes100: 500n, basis: 'What my accountant uses' }] },
    session.version,
  );
  return { ctx, session };
};

test('setup can be left halfway and picked up exactly where it was', async () => {
  const ctx = await setup();
  const started = await ctx.service.start(ctx.actor, { idempotencyKey: 'k' });
  const afterOne = await ctx.service.saveStep(ctx.actor, started.id, 'business', { business: goodBusiness }, started.version);

  // The person closes the app. Nothing is submitted, nothing is lost.
  const resumed = await ctx.service.resume(ctx.actor);
  assert.ok(resumed !== null);
  assert.equal(resumed.id, started.id);
  assert.equal(resumed.steps.business.state, 'DONE');
  assert.equal(resumed.answers.business.legalName, 'Meera Bakers');
  assert.equal(resumed.version, afterOne.version);
  assert.equal(checklistFor(resumed, 'en-IN').nextStep, 'tax_profile');
});

test('starting setup twice never creates a second one', async () => {
  const ctx = await setup();
  const first = await ctx.service.start(ctx.actor, { idempotencyKey: 'k' });
  const again = await ctx.service.start(ctx.actor, { idempotencyKey: 'k' });
  const differentKey = await ctx.service.start(ctx.actor, { idempotencyKey: 'other' });
  assert.equal(again.id, first.id);
  assert.equal(differentKey.id, first.id, 'an open setup is handed back whatever key is used');
});

test('a wrong answer is kept, not thrown away', async () => {
  const ctx = await setup();
  const session = await ctx.service.start(ctx.actor, { idempotencyKey: 'k' });
  const saved = await ctx.service.saveStep(
    ctx.actor, session.id, 'tax_profile',
    { taxProfile: { registration: 'REGULAR', gstin: '08AAAAA0000A1Z9', filingFrequency: 'MONTHLY', booksStartDate: isoDate('2026-04-01') } },
    session.version,
  );
  assert.equal(saved.steps.tax_profile.state, 'NEEDS_ATTENTION');
  assert.equal(saved.answers.taxProfile.gstin, '08AAAAA0000A1Z9', 'what they typed is still there');
  assert.match(saved.steps.tax_profile.problems[0]?.message['en-IN'] ?? '', /does not match the rest of it/);

  const fixed = await ctx.service.saveStep(ctx.actor, session.id, 'tax_profile', { taxProfile: { gstin: '08AAAAA0000A1Z2' } }, saved.version);
  assert.equal(fixed.steps.tax_profile.state, 'DONE');
  assert.equal(fixed.answers.taxProfile.filingFrequency, 'MONTHLY', 'the rest of the step survived the correction');
});

test('two people editing one setup do not overwrite each other', async () => {
  const ctx = await setup();
  const session = await ctx.service.start(ctx.actor, { idempotencyKey: 'k' });
  await ctx.service.saveStep(ctx.actor, session.id, 'business', { business: goodBusiness }, session.version);
  await assert.rejects(
    () => ctx.service.saveStep(ctx.actor, session.id, 'business', { business: { legalName: 'Something else' } }, session.version),
    (e: unknown) => e instanceof DomainError && e.code === 'ONBOARDING_CONCURRENT_EDIT',
  );
});

test('opening balances must add up, and say by how much when they do not', () => {
  const unbalanced = checkOpeningBalances([
    { accountCode: '1110', label: 'Cash', debit: rupees(8000), credit: rupees(0) },
    { accountCode: '2100', label: 'Owed to supplier', debit: rupees(0), credit: rupees(6200) },
  ]);
  assert.equal(unbalanced.balanced, false);
  assert.equal(toDecimalString(unbalanced.difference), '1800.00');
  assert.match(unbalanced.problems[0]?.message['en-IN'] ?? '', /₹1,800\.00 more than/);

  const balanced = checkOpeningBalances([
    { accountCode: '1110', label: 'Cash', debit: rupees(8000), credit: rupees(0) },
    { accountCode: '3100', label: 'My own money', debit: rupees(0), credit: rupees(8000) },
  ]);
  assert.equal(balanced.balanced, true);
  assert.deepEqual(balanced.problems, []);

  // A brand-new business genuinely starts with nothing, and that is not an error.
  const empty = checkOpeningBalances([]);
  assert.equal(empty.balanced, true);
  assert.deepEqual(empty.problems, []);
});

test('a malformed opening row is refused with a row a person can find', () => {
  const check = checkOpeningBalances([
    { accountCode: '1110', label: 'Cash', debit: rupees(100), credit: rupees(50) },
    { accountCode: '1120', label: 'Bank', debit: rupees(0), credit: rupees(0) },
    { accountCode: '1130', label: 'Cheques', debit: rupees(-5), credit: rupees(0) },
    { label: 'Something', debit: rupees(10), credit: rupees(0) },
  ]);
  const codes = check.problems.map((p) => p.code);
  assert.ok(codes.includes('OPENING_BOTH_SIDES'));
  assert.ok(codes.includes('OPENING_EMPTY'));
  assert.ok(codes.includes('OPENING_NEGATIVE'));
  assert.ok(codes.includes('OPENING_NO_TARGET'));
  assert.match(check.problems[0]?.message['en-IN'] ?? '', /Cash/);
});

test('a difference is never absorbed silently; a person accepts it and says why', async () => {
  const { ctx, session } = await runThroughToOpening();
  const entries = [
    { accountCode: '1110', label: 'Cash in the till', debit: rupees(8000), credit: rupees(0) },
    { label: 'Owed to the flour mill', debit: rupees(0), credit: rupees(6200), party: { partyId: 'mill', name: 'Jaipur Flour Mill', kind: 'SUPPLIER' as const } },
  ];

  const stuck = await ctx.service.saveStep(ctx.actor, session.id, 'opening_balances', { openingBalances: entries }, session.version);
  assert.equal(stuck.steps.opening_balances.state, 'NEEDS_ATTENTION');
  await assert.rejects(
    () => ctx.service.finish(ctx.actor, session.id, { idempotencyKey: 'f' }),
    (e: unknown) => e instanceof DomainError && e.code === 'ONBOARDING_INCOMPLETE',
  );

  const accepted = await ctx.service.saveStep(
    ctx.actor, session.id, 'opening_balances',
    { openingBalances: entries, openingDifferenceAccepted: { reason: 'Old cash box, cannot trace it', acceptedBy: USER } },
    stuck.version,
  );
  assert.equal(accepted.steps.opening_balances.state, 'DONE');

  const finished = await ctx.service.finish(ctx.actor, session.id, { idempotencyKey: 'f' });
  assert.ok(finished.openingVoucherId !== null);
  const voucher = await ctx.ledger.getVoucher(ctx.actor, finished.openingVoucherId);
  const difference = voucher?.lines.find((l) => l.narration?.includes('Opening balance difference'));
  assert.ok(difference !== undefined, 'the difference is a visible line, not a silent adjustment');
  assert.match(difference.narration ?? '', /Old cash box, cannot trace it/);
  assert.ok((await trialBalance(ctx.store.read(), COMPANY)).balanced);
});

test('a heading account is refused, and the message points at the party path instead', async () => {
  const { ctx, session } = await runThroughToOpening();
  const ready = await ctx.service.saveStep(
    ctx.actor, session.id, 'opening_balances',
    {
      openingBalances: [
        { accountCode: '1110', label: 'Cash', debit: rupees(6200), credit: rupees(0) },
        { accountCode: '2100', label: 'Owed to supplier', debit: rupees(0), credit: rupees(6200) },
      ],
    },
    session.version,
  );
  await assert.rejects(
    () => ctx.service.finish(ctx.actor, ready.id, { idempotencyKey: 'f' }),
    (e: unknown) =>
      e instanceof DomainError &&
      e.code === 'ONBOARDING_OPENING_ACCOUNT_IS_HEADING' &&
      /name them instead and we will open their account/.test(e.message),
  );
});

test('the whole bakery example runs, and the books balance afterwards', async () => {
  const { ctx, session } = await runThroughToOpening();
  const withOpening = await ctx.service.saveStep(
    ctx.actor, session.id, 'opening_balances',
    {
      openingBalances: [
        { accountCode: '1110', label: 'Cash in the till', debit: rupees(8000), credit: rupees(0) },
        { label: 'Hotel Rajmahal owes me', debit: rupees(4500), credit: rupees(0), party: { partyId: 'rajmahal', name: 'Hotel Rajmahal', kind: 'CUSTOMER' } },
        { label: 'I owe the flour mill', debit: rupees(0), credit: rupees(6200), party: { partyId: 'mill', name: 'Jaipur Flour Mill', kind: 'SUPPLIER' } },
        { accountCode: '3100', label: 'My own money', debit: rupees(0), credit: rupees(6300) },
      ],
    },
    session.version,
  );
  const finished = await ctx.service.finish(ctx.actor, withOpening.id, { idempotencyKey: 'f' });

  assert.equal(finished.session.state, 'COMPLETED');
  assert.equal(finished.ratesDeclared, 1);
  assert.equal(ctx.declaredRates.list(COMPANY).length, 1);
  assert.equal(ctx.declaredRates.list(COMPANY)[0]?.basis, 'What my accountant uses');

  const tb = await trialBalance(ctx.store.read(), COMPANY);
  assert.ok(tb.balanced);
  assert.equal(toDecimalString(tb.totalDebit), '12500.00');

  // A customer who owed money on day one has a real account, so their balance folds from lines.
  const customer = await partyBalance(ctx.store.read(), COMPANY, asId<'Party'>('rajmahal'));
  assert.equal(toDecimalString(customer.balance), '4500.00');
  const supplier = await partyBalance(ctx.store.read(), COMPANY, asId<'Party'>('mill'));
  assert.equal(toDecimalString(supplier.balance), '-6200.00');
});

test('finishing twice posts one opening entry', async () => {
  const { ctx, session } = await runThroughToOpening();
  const ready = await ctx.service.saveStep(
    ctx.actor, session.id, 'opening_balances',
    {
      openingBalances: [
        { accountCode: '1110', label: 'Cash', debit: rupees(5000), credit: rupees(0) },
        { accountCode: '3100', label: 'My own money', debit: rupees(0), credit: rupees(5000) },
      ],
    },
    session.version,
  );
  const first = await ctx.service.finish(ctx.actor, ready.id, { idempotencyKey: 'f' });
  const again = await ctx.service.finish(ctx.actor, ready.id, { idempotencyKey: 'f' });
  assert.equal(again.openingVoucherId, first.openingVoucherId);
  const vouchers = await ctx.store.read().vouchers.list(COMPANY, {});
  assert.equal(vouchers.length, 1);
});

test('a business with nothing to carry in finishes without posting anything', async () => {
  const { ctx, session } = await runThroughToOpening();
  const skipped = await ctx.service.skipStep(ctx.actor, session.id, 'opening_balances', 'Brand new shop, nothing to carry in');
  const finished = await ctx.service.finish(ctx.actor, skipped.id, { idempotencyKey: 'f' });
  assert.equal(finished.openingVoucherId, null);
  assert.equal(finished.session.state, 'COMPLETED');
  assert.equal((await ctx.store.read().vouchers.list(COMPANY, {})).length, 0);
});

test('the steps a bill depends on cannot be skipped', async () => {
  const ctx = await setup();
  const session = await ctx.service.start(ctx.actor, { idempotencyKey: 'k' });
  for (const step of ['business', 'tax_profile', 'items'] as const) {
    await assert.rejects(
      () => ctx.service.skipStep(ctx.actor, session.id, step, 'later'),
      (e: unknown) => e instanceof DomainError && e.code === 'ONBOARDING_STEP_NOT_SKIPPABLE',
    );
  }
  await assert.rejects(
    () => ctx.service.skipStep(ctx.actor, session.id, 'branding', '   '),
    (e: unknown) => e instanceof DomainError && e.code === 'ONBOARDING_SKIP_REASON_REQUIRED',
  );
});

test('a business type never suggests a legal fact', () => {
  for (const profile of BUSINESS_TYPE_PROFILES) {
    const everythingSuggested = JSON.stringify(profile).toLowerCase();
    for (const forbiddenThing of NEVER_SUGGESTED) {
      assert.ok(
        !everythingSuggested.includes(forbiddenThing),
        `${profile.type} must not suggest "${forbiddenThing}" — the product does not know it about this business`,
      );
    }
    // And no digit that could be read as a rate or a code.
    assert.ok(!/\d+\s*%/.test(everythingSuggested), `${profile.type} must not suggest a percentage`);
    assert.ok(profile.suggestedTemplateId.length > 0);
    assert.ok(profile.commonUnits.length > 0);
  }
});

test('the three worked examples each get a fitting setup', () => {
  const bakery = profileFor('BAKERY');
  assert.equal(bakery.suggestedTemplateId, 'bakery-warm');
  assert.ok(bakery.keepsStock);
  assert.ok(bakery.commonUnits.includes('DOZEN'));

  const wholesaler = profileFor('WHOLESALE');
  assert.equal(wholesaler.suggestedTemplateId, 'wholesale-classic');
  assert.ok(wholesaler.suggestedOptionalFields.includes('line.batch'));

  const services = profileFor('SERVICES');
  assert.equal(services.keepsStock, false, 'a service business is never asked for opening stock');
  assert.ok(services.commonUnits.includes('HOUR'));
});

test('a service business is not asked to add stock items', () => {
  const answers: OnboardingAnswers = { ...emptyAnswers(), business: { businessType: 'SERVICES' }, items: [] };
  assert.deepEqual(validateStep('items', answers), []);

  const bakeryAnswers: OnboardingAnswers = { ...emptyAnswers(), business: { businessType: 'BAKERY' }, items: [] };
  assert.equal(validateStep('items', bakeryAnswers)[0]?.code, 'ITEMS_NONE');
});

test('a declared rate must say where it came from', () => {
  const answers: OnboardingAnswers = {
    ...emptyAnswers(),
    rates: [{ code: '1905', kind: 'GOODS', ratePercentTimes100: 500n, basis: '   ' }],
  };
  assert.equal(validateStep('rates', answers)[0]?.code, 'RATE_BASIS_MISSING');
});

test('a GST number from another state is refused rather than resolved by preference', () => {
  const answers: OnboardingAnswers = {
    ...emptyAnswers(),
    business: { ...goodBusiness },
    taxProfile: { ...goodTax, gstin: '27AAAAA0000A1Z8' },
  };
  const codes = validateStep('tax_profile', answers).map((p) => p.code);
  assert.ok(codes.includes('TAX_GSTIN_STATE_MISMATCH') || codes.includes('TAX_GSTIN_INVALID'));
});

test('one business cannot see or change another business’s setup', async () => {
  const ctx = await setup();
  const session = await ctx.service.start(ctx.actor, { idempotencyKey: 'k' });
  const outsider = actorWith(PERMISSIONS, OTHER);
  assert.equal(await ctx.service.resume(outsider, session.id), null);
  await assert.rejects(
    () => ctx.service.saveStep(outsider, session.id, 'business', { business: goodBusiness }, session.version),
    (e: unknown) => e instanceof DomainError && e.code === 'ONBOARDING_NOT_FOUND',
  );
});

test('permission is checked for running setup and for finishing it', async () => {
  const ctx = await setup();
  await assert.rejects(
    () => ctx.service.start(actorWith(['onboarding.finish']), { idempotencyKey: 'k' }),
    (e: unknown) => e instanceof DomainError && e.kind === 'FORBIDDEN',
  );
  const { ctx: ctx2, session } = await runThroughToOpening();
  const skipped = await ctx2.service.skipStep(ctx2.actor, session.id, 'opening_balances', 'nothing to carry in');
  await assert.rejects(
    () => ctx2.service.finish(actorWith(['onboarding.run']), skipped.id, { idempotencyKey: 'f' }),
    (e: unknown) => e instanceof DomainError && e.kind === 'FORBIDDEN',
  );
});

test('the checklist reads plainly, in both languages', async () => {
  const { ctx, session } = await runThroughToOpening();
  for (const locale of ['en-IN', 'hi-IN'] as const) {
    const view = checklistFor(session, locale);
    assert.equal(view.totalCount, 6);
    assert.equal(view.doneCount, 5);
    assert.equal(view.nextStep, 'opening_balances');
    assert.equal(view.canFinish, false);
    const problems: string[] = [];
    for (const item of view.items) {
      for (const text of [item.title, item.why, item.stateLabel, ...item.problems]) {
        for (const issue of lintUserFacingText(text, { locale, allow: ['gst'] })) {
          problems.push(`${item.step} (${locale}): ${issue.rule} — ${issue.detail}`);
        }
      }
    }
    assert.deepEqual(problems, [], problems.join('\n'));
  }
  void ctx;
});

test('the checklist screen renders, escapes what was typed, and shows the rate warning', async () => {
  const { ctx, session } = await runThroughToOpening();
  const nasty = await ctx.service.saveStep(
    ctx.actor, session.id, 'business', { business: { ...goodBusiness, tradeName: '<script>alert(1)</script>' } }, session.version,
  );
  const html = renderChecklist(nasty, 'en-IN');
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('The GST you charge'));
  assert.ok(html.includes('We have not checked them against a government notification'));
  assert.ok(html.includes('lang="en"'));

  const hindi = renderChecklist(nasty, 'hi-IN');
  assert.ok(hindi.includes('lang="hi"'));
  assert.ok(hindi.includes('Aap jo GST lagate hain'));
});

test('accepting a difference adds one visible, named line', () => {
  const entries = [{ accountCode: '1110', label: 'Cash', debit: rupees(100), credit: rupees(0) }];
  const withLine = withAcceptedDifference(entries, rupees(100), 'could not trace');
  assert.equal(withLine.length, 2);
  assert.equal(withLine[1]?.accountCode, '3900');
  assert.match(withLine[1]?.label ?? '', /could not trace/);
  assert.equal(toDecimalString(withLine[1]?.credit ?? rupees(0)), '100.00');
  assert.equal(checkOpeningBalances(withLine).balanced, true);

  assert.deepEqual(withAcceptedDifference(entries, rupees(0), 'nothing'), entries);
});

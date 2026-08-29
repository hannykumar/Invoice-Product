/**
 * Issue #36 [E36] — setting up a real bakery, stopping halfway, and coming back.
 *
 *   npm run demo:onboarding
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { asId, fixedClock, isoDate, rupees, type CompanyId } from '@invoice/kernel';
import {
  buildDefaultChart,
  defaultChartIdFactory,
  InMemoryAuditPort,
  InMemoryLedgerStore,
  LedgerService,
  permissionPortFromActor,
  trialBalance,
  type ActorContext,
} from '@invoice/ledger';
import { InMemoryDeclaredRates } from '@invoice/gst-calc';
import { InMemoryOnboardingRepository } from './repository.ts';
import { OnboardingService } from './service.ts';
import { checklistFor, renderChecklist } from './checklist.ts';
import { profileFor } from './business-types.ts';

const COMPANY: CompanyId = asId<'Company'>('demo-bakery');
const OWNER = asId<'User'>('demo-meera');
const actor: ActorContext = {
  companyId: COMPANY,
  branchId: asId<'Branch'>('main'),
  userId: OWNER,
  permissions: ['ledger.setup', 'ledger.post.opening_balance', 'onboarding.run', 'onboarding.finish'],
};

const main = async (): Promise<void> => {
  const store = new InMemoryLedgerStore();
  const repository = new InMemoryOnboardingRepository();
  store.join(repository);
  const audit = new InMemoryAuditPort();
  const clock = fixedClock('2026-08-29T09:00:00.000Z');
  let n = 0;
  const idFactory = (): string => `onb-${String((n += 1)).padStart(6, '0')}`;

  const ledger = new LedgerService({ store, permissions: permissionPortFromActor, audit, clock, idFactory });
  await ledger.initialiseCompany(actor, {
    booksStartDate: isoDate('2026-04-01'),
    accounts: buildDefaultChart(COMPANY, defaultChartIdFactory(COMPANY)),
  });

  const declaredRates = new InMemoryDeclaredRates();
  const service = new OnboardingService({
    store, ledger, repository,
    permissions: permissionPortFromActor,
    audit, clock, declaredRates, idFactory,
  });

  const outDir = join(process.cwd(), 'tmp', 'onboarding');
  mkdirSync(outDir, { recursive: true });
  const write = (name: string, session: Parameters<typeof renderChecklist>[0], locale: 'en-IN' | 'hi-IN'): string => {
    const file = join(outDir, `${name}.html`);
    writeFileSync(file, renderChecklist(session, locale), 'utf8');
    return file;
  };

  console.log('Meera runs a small bakery in Jaipur and has never used accounting software.\n');

  let session = await service.start(actor, { idempotencyKey: 'demo-onboarding' });
  console.log(`1. She opens setup. ${checklistFor(session, 'en-IN').summary}`);

  session = await service.saveStep(actor, session.id, 'business', {
    business: {
      legalName: 'Meera Bakers',
      tradeName: 'Meera Bakers',
      businessType: 'BAKERY',
      stateCode: '08',
      addressLines: ['14, Nehru Bazar', 'Jaipur 302003'],
      phone: '98290 11223',
    },
  }, session.version);
  const profile = profileFor('BAKERY');
  console.log(`2. She picks "${profile.name['en-IN']}". We suggest the ${profile.suggestedTemplateId} design`);
  console.log(`   and units ${profile.commonUnits.join(', ')}. We suggest no GST rate and no HSN code,`);
  console.log('   because we do not know those about her bakery.');

  // A wrong GST number, which is the common case.
  session = await service.saveStep(actor, session.id, 'tax_profile', {
    taxProfile: { registration: 'REGULAR', gstin: '08AAAAA0000A1Z9', filingFrequency: 'QUARTERLY', booksStartDate: isoDate('2026-04-01') },
  }, session.version);
  console.log(`3. She mistypes her GST number. ${session.steps.tax_profile.problems[0]?.message['en-IN'] ?? ''}`);
  const halfway = write('01-halfway', session, 'en-IN');

  console.log('4. A customer walks in. She closes the app.\n');
  const resumed = await service.resume(actor);
  if (resumed === null) throw new Error('setup should have been waiting');
  console.log(`5. She comes back. Setup is exactly where she left it: ${checklistFor(resumed, 'en-IN').summary}`);
  console.log(`   Next: ${checklistFor(resumed, 'en-IN').nextStep}`);

  session = await service.saveStep(actor, resumed.id, 'tax_profile', {
    taxProfile: { gstin: '08AAAAA0000A1Z2' },
  }, resumed.version);
  session = await service.saveStep(actor, session.id, 'branding', {
    branding: { templateId: 'bakery-warm', invoicePrefix: 'MB', branchCode: 'JPR' },
  }, session.version);
  session = await service.saveStep(actor, session.id, 'items', {
    items: [
      { itemId: 'CAKE-500', name: 'Chocolate cake, 500 g', kind: 'GOODS', baseUnit: 'PCS', hsnOrSac: '1905', openingQuantity: '12', openingValue: rupees(3600) },
      { itemId: 'BREAD', name: 'Bread loaf', kind: 'GOODS', baseUnit: 'PCS', hsnOrSac: '1905', openingQuantity: '40', openingValue: rupees(1200) },
      { itemId: 'DELIVERY', name: 'Home delivery', kind: 'SERVICES', baseUnit: 'JOB', hsnOrSac: null },
    ],
  }, session.version);
  session = await service.saveStep(actor, session.id, 'rates', {
    rates: [{ code: '1905', kind: 'GOODS', ratePercentTimes100: 500n, basis: 'The rate my accountant has always used for bakery items' }],
  }, session.version);
  console.log('6. She tells us the GST she charges. We record it as hers, and say so on the bill.');

  // Opening balances that do not balance, which is the normal first attempt.
  session = await service.saveStep(actor, session.id, 'opening_balances', {
    openingBalances: [
      { accountCode: '1110', label: 'Cash in the till', debit: rupees(8000), credit: rupees(0) },
      { label: 'Hotel Rajmahal owes me', debit: rupees(4500), credit: rupees(0), party: { partyId: 'rajmahal', name: 'Hotel Rajmahal', kind: 'CUSTOMER' } },
      { label: 'I owe the flour supplier', debit: rupees(0), credit: rupees(6200), party: { partyId: 'flour-mill', name: 'Jaipur Flour Mill', kind: 'SUPPLIER' } },
    ],
  }, session.version);
  console.log(`7. Her opening figures do not add up yet:`);
  console.log(`   ${session.steps.opening_balances.problems[0]?.message['en-IN'] ?? ''}`);
  const unbalanced = write('02-opening-unbalanced', session, 'en-IN');

  session = await service.saveStep(actor, session.id, 'opening_balances', {
    openingBalances: [
      { accountCode: '1110', label: 'Cash in the till', debit: rupees(8000), credit: rupees(0) },
      { label: 'Hotel Rajmahal owes me', debit: rupees(4500), credit: rupees(0), party: { partyId: 'rajmahal', name: 'Hotel Rajmahal', kind: 'CUSTOMER' } },
      { accountCode: '1300', label: 'Stock in the shop', debit: rupees(4800), credit: rupees(0) },
      { label: 'I owe the flour supplier', debit: rupees(0), credit: rupees(6200), party: { partyId: 'flour-mill', name: 'Jaipur Flour Mill', kind: 'SUPPLIER' } },
      { accountCode: '3100', label: 'My own money in the business', debit: rupees(0), credit: rupees(11100) },
    ],
  }, session.version);
  console.log('8. She adds her stock and her own money. Both sides match.');

  const finished = await service.finish(actor, session.id, { idempotencyKey: 'demo-finish' });
  const tb = await trialBalance(store.read(), COMPANY);
  console.log(`9. Setup finished. Opening entry ${finished.openingVoucherId ?? 'none'}, ${finished.ratesDeclared} rate declared.`);
  console.log(`   The books balance: ${tb.balanced ? 'yes' : 'no'}, total ${tb.totalDebit.minor / 100n} on each side.`);
  console.log(`   Rates now on file for billing: ${declaredRates.list(COMPANY).length}\n`);

  const done = write('03-finished', finished.session, 'en-IN');
  const hindi = write('04-finished-hindi', finished.session, 'hi-IN');

  console.log('Open these to see the checklist as she would:');
  for (const f of [halfway, unbalanced, done, hindi]) console.log(`  ${f}`);
};

await main();

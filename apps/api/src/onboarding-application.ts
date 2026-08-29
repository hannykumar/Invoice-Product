/**
 * Issue #36 [E36] wired into the running app — real business setup, not a static screen.
 *
 * Every call here drives the actual `OnboardingService` and `LedgerService`: it starts a session,
 * saves each step (keeping what the person typed even when a field is wrong), and on finish posts a
 * real opening-balance voucher and records the rates the business declared. The proof it worked is
 * the new company's own trial balance, read straight back from the ledger and returned — a balanced
 * set of books that did not exist a moment ago.
 *
 * Each setup builds its own fresh company, so one person's half-finished setup never touches
 * another's, exactly as tenancy requires.
 */
import { asId, isoDate, rupees, type CompanyId } from '@invoice/kernel';
import {
  buildDefaultChart,
  defaultChartIdFactory,
  InMemoryAuditPort,
  InMemoryLedgerStore,
  LedgerService,
  permissionPortFromActor,
  trialBalance as ledgerTrialBalance,
  type ActorContext,
} from '@invoice/ledger';
import { InMemoryDeclaredRates } from '@invoice/gst-calc';
import {
  InMemoryOnboardingRepository,
  OnboardingService,
  checklistFor,
  type BusinessType,
  type OnboardingAnswers,
  type Registration,
  type StepId,
} from '@invoice/onboarding';

const ONBOARDING_PERMISSIONS = ['ledger.setup', 'ledger.post.opening_balance', 'onboarding.run', 'onboarding.finish'];

const BUSINESS_TYPES: readonly BusinessType[] = ['RETAIL', 'WHOLESALE', 'BAKERY', 'SERVICES', 'TRANSPORT', 'MANUFACTURING'];
const REGISTRATIONS: readonly Registration[] = ['REGULAR', 'COMPOSITION', 'UNREGISTERED'];

const str = (value: unknown): string => String(value ?? '').trim();

/** Rupees from a "1,234.50" string, as paise. Returns null when nothing usable was typed. */
const rupeeMoney = (value: unknown) => {
  const normalized = str(value).replace(/,/g, '');
  if (normalized === '') return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw new Error('Enter a valid amount, for example 8000 or 8000.50.');
  const [whole = '0', fraction = ''] = normalized.split('.');
  return rupees(BigInt(whole), BigInt((fraction + '00').slice(0, 2)));
};

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined => {
  const candidate = str(value) as T;
  return allowed.includes(candidate) ? candidate : undefined;
};

interface SetupCompany {
  readonly service: OnboardingService;
  readonly store: InMemoryLedgerStore;
  readonly declaredRates: InMemoryDeclaredRates;
  readonly actor: ActorContext;
  readonly companyId: CompanyId;
}

let counter = 0;

/** A brand-new company with an initialised chart of accounts, ready to be set up. */
const freshCompany = async (): Promise<SetupCompany> => {
  counter += 1;
  const companyId = asId<'Company'>(`setup-${counter}-${Date.now()}`);
  const store = new InMemoryLedgerStore();
  const repository = new InMemoryOnboardingRepository();
  store.join(repository);
  const audit = new InMemoryAuditPort();
  const clock = { now: () => new Date() };
  let n = 0;
  const idFactory = () => `setup-${counter}-${String((n += 1)).padStart(5, '0')}`;

  const ledger = new LedgerService({ store, permissions: permissionPortFromActor, audit, clock, idFactory });
  await ledger.initialiseCompany(
    { companyId, branchId: asId<'Branch'>('main'), userId: asId<'User'>('setup-owner'), permissions: ONBOARDING_PERMISSIONS },
    { booksStartDate: isoDate('2017-07-01'), accounts: buildDefaultChart(companyId, defaultChartIdFactory(companyId)) },
  );

  const declaredRates = new InMemoryDeclaredRates();
  const service = new OnboardingService({ store, ledger, repository, permissions: permissionPortFromActor, audit, clock, declaredRates, idFactory });
  const actor: ActorContext = { companyId, branchId: asId<'Branch'>('main'), userId: asId<'User'>('setup-owner'), permissions: ONBOARDING_PERMISSIONS };
  return { service, store, declaredRates, actor, companyId };
};

/** Turns the flat form into the step patches, so the service sees real, typed answers. */
const answersFrom = (input: Record<string, unknown>): { patches: Partial<Record<StepId, Partial<OnboardingAnswers>>>; openingProvided: boolean; rateProvided: boolean } => {
  const businessType = oneOf(input.businessType, BUSINESS_TYPES);
  const registration = oneOf(input.registration, REGISTRATIONS);
  const booksStartDate = str(input.booksStartDate) === '' ? isoDate('2026-04-01') : isoDate(str(input.booksStartDate));

  const filingFrequency = oneOf(input.filingFrequency, ['MONTHLY', 'QUARTERLY'] as const);
  const business: Partial<OnboardingAnswers> = {
    business: {
      legalName: str(input.legalName),
      tradeName: str(input.tradeName) || str(input.legalName),
      ...(businessType === undefined ? {} : { businessType }),
      stateCode: str(input.stateCode),
      ...(str(input.phone) === '' ? {} : { phone: str(input.phone) }),
    },
  };

  const taxProfile: Partial<OnboardingAnswers> = {
    taxProfile: {
      ...(registration === undefined ? {} : { registration }),
      gstin: str(input.gstin) === '' ? null : str(input.gstin),
      ...(registration === 'UNREGISTERED' || filingFrequency === undefined ? {} : { filingFrequency }),
      booksStartDate,
    },
  };

  const openingQuantity = str(input.itemOpeningQuantity);
  const openingValue = rupeeMoney(input.itemOpeningValue);
  const items: Partial<OnboardingAnswers> = {
    items: [
      {
        itemId: str(input.itemName).toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 20) || 'ITEM-1',
        name: str(input.itemName),
        kind: oneOf(input.itemKind, ['GOODS', 'SERVICES'] as const) ?? 'GOODS',
        baseUnit: str(input.itemUnit) || 'PCS',
        hsnOrSac: str(input.itemHsn) === '' ? null : str(input.itemHsn),
        ...(openingQuantity === '' ? {} : { openingQuantity }),
        ...(openingValue === null ? {} : { openingValue }),
      },
    ],
  };

  const ratePercent = str(input.ratePercent);
  const rateProvided = ratePercent !== '' && str(input.rateCode) !== '';
  const rates: Partial<OnboardingAnswers> = rateProvided
    ? { rates: [{ code: str(input.rateCode), kind: oneOf(input.itemKind, ['GOODS', 'SERVICES'] as const) ?? 'GOODS', ratePercentTimes100: BigInt(Math.round(Number(ratePercent) * 100)), basis: str(input.rateBasis) }] }
    : { rates: [] };

  // The owner's money on day one is the cash they started with. Debit cash, credit capital: it
  // balances by construction, which is the honest thing to offer a first-time user rather than a
  // ledger form. Anything more complex is a real accountant's job and #36 keeps it optional.
  const openingCash = rupeeMoney(input.openingCash);
  const openingProvided = openingCash !== null;
  const openingBalances: Partial<OnboardingAnswers> = openingProvided
    ? {
        openingBalances: [
          { accountCode: '1110', label: 'Cash in hand on day one', debit: openingCash, credit: rupees(0) },
          { accountCode: '3100', label: "The owner's own money in the business", debit: rupees(0), credit: openingCash },
        ],
      }
    : { openingBalances: [] };

  return { patches: { business, tax_profile: taxProfile, items, rates, opening_balances: openingBalances }, openingProvided, rateProvided };
};

interface RunResult {
  ok: boolean;
  problems: { step: StepId; field: string | null; message: string }[];
  summary: {
    businessName: string;
    businessType: string | null;
    registration: string | null;
    booksStartDate: string;
    itemName: string;
    declaredRate: string | null;
    openingCash: number | null;
    nextStep: string;
  };
  result?: {
    companyName: string;
    openingVoucherId: string | null;
    ratesDeclared: number;
    trialBalance: { balanced: boolean; totalDebits: number; totalCredits: number; rows: { name: string; debit: number; credit: number }[] };
    sentence: string;
  };
}

const runSetup = async (input: Record<string, unknown>, finish: boolean): Promise<RunResult> => {
  const { patches, openingProvided, rateProvided } = answersFrom(input);
  const company = await freshCompany();
  const { service, actor } = company;

  let session = await service.start(actor, { idempotencyKey: `web-setup-${Date.now()}-${counter}` });
  const ordered: StepId[] = ['business', 'tax_profile', 'items'];
  for (const step of ordered) {
    session = await service.saveStep(actor, session.id, step, patches[step] as Partial<OnboardingAnswers>, session.version);
  }
  // Optional steps: save when the person supplied something, otherwise skip with a plain reason.
  if (rateProvided) session = await service.saveStep(actor, session.id, 'rates', patches.rates as Partial<OnboardingAnswers>, session.version);
  else session = await service.skipStep(actor, session.id, 'rates', 'The business will add GST rates when it knows them.');
  session = await service.skipStep(actor, session.id, 'branding', 'The bill design can be chosen later.');
  if (openingProvided) session = await service.saveStep(actor, session.id, 'opening_balances', patches.opening_balances as Partial<OnboardingAnswers>, session.version);
  else session = await service.skipStep(actor, session.id, 'opening_balances', 'The business will add opening balances later.');

  const problems = (Object.keys(session.steps) as StepId[]).flatMap((step) =>
    session.steps[step].problems.map((problem) => ({ step, field: problem.field ?? null, message: problem.message['en-IN'] })),
  );

  const checklist = checklistFor(session, 'en-IN');
  const openingCash = rupeeMoney(input.openingCash);
  const summary: RunResult['summary'] = {
    businessName: session.answers.business.legalName ?? '',
    businessType: session.answers.business.businessType ?? null,
    registration: session.answers.taxProfile.registration ?? null,
    booksStartDate: session.answers.taxProfile.booksStartDate ?? '',
    itemName: session.answers.items[0]?.name ?? '',
    declaredRate: rateProvided ? `${Number(session.answers.rates[0]?.ratePercentTimes100 ?? 0n) / 100}% on ${session.answers.rates[0]?.code ?? ''}` : null,
    openingCash: openingCash === null ? null : Number(openingCash.minor) / 100,
    nextStep: checklist.nextStep ?? '',
  };

  if (problems.length > 0) return { ok: false, problems, summary };
  if (!finish) return { ok: true, problems: [], summary };

  const finished = await service.finish(actor, session.id, { idempotencyKey: `web-setup-finish-${session.id}` });
  const tb = await ledgerTrialBalance(company.store.read(), company.companyId);
  const rows = tb.rows.map((row) => ({
    name: row.account.name,
    debit: row.side === 'DEBIT' ? Number(row.balance.minor) / 100 : 0,
    credit: row.side === 'CREDIT' ? Number(row.balance.minor) / 100 : 0,
  }));

  return {
    ok: true,
    problems: [],
    summary,
    result: {
      companyName: summary.businessName,
      openingVoucherId: finished.openingVoucherId,
      ratesDeclared: finished.ratesDeclared,
      trialBalance: {
        balanced: tb.balanced,
        totalDebits: Number(tb.totalDebit.minor) / 100,
        totalCredits: Number(tb.totalCredit.minor) / 100,
        rows,
      },
      sentence:
        finished.openingVoucherId === null
          ? `${summary.businessName} is set up. Its books are open and empty, ready for the first bill.`
          : `${summary.businessName} is set up. Its opening balances are recorded and the books balance.`,
    },
  };
};

export const previewOnboarding = (input: Record<string, unknown>): Promise<RunResult> => runSetup(input, false);
export const finishOnboarding = (input: Record<string, unknown>): Promise<RunResult> => runSetup(input, true);

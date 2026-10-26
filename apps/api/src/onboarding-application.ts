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
 *
 * Issue #366 (lane: GPT 2, #49) — on PostgreSQL a finished setup is kept: the books, the setup and
 * its audit trail go to the database, like the rest of the app (#427's `pick`). The new company has
 * no id in the session, so its writes run in a unit of work opened for the new company's own id,
 * outside the request's one for the session's company: `app.company_id` is the new id, which is
 * what every row-level policy checks. No policy is bypassed. A preview saves nothing anywhere.
 */
import { randomUUID } from 'node:crypto';
import { asId, isoDate, rupees, type CompanyId } from '@invoice/kernel';
import { appClock, currentFinancialYear } from './app-clock.ts';
import {
  buildDefaultChart,
  defaultChartIdFactory,
  InMemoryAuditPort,
  InMemoryLedgerStore,
  LedgerService,
  PostgresLedgerStore,
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
import { PostgresOnboardingRepository } from '../../../packages/onboarding/src/postgres-repository.ts';
import { PostgresAuditLog } from '../../../packages/platform/src/postgres-audit.ts';
import { outsideUnitOfWork, type TransactionalExecutor } from '../../../packages/platform/src/database.ts';
import { recordTurnoverAnswer, rememberBusinessPrefill } from './business-details-application.ts';
import { say } from './language.ts';
import { durableDatabase } from './durable.ts';
import { stableUuid } from './persistence.ts';

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
  readonly store: InMemoryLedgerStore | PostgresLedgerStore;
  readonly declaredRates: InMemoryDeclaredRates;
  readonly actor: ActorContext;
  readonly companyId: CompanyId;
}

let counter = 0;

/**
 * A brand-new company with an initialised chart of accounts, ready to be set up. In memory with
 * `db` null; on PostgreSQL inside the unit of work already open for `companyId`.
 */
const freshCompany = async (db: TransactionalExecutor | null, companyId: CompanyId, userId: string, legalName: string): Promise<SetupCompany> => {
  const pick = <M, P>(memory: () => M, postgres: (db: TransactionalExecutor) => P): M | P => db === null ? memory() : postgres(db);
  const store = pick(() => new InMemoryLedgerStore(), (db) => new PostgresLedgerStore(db));
  const repository = pick(() => new InMemoryOnboardingRepository(), (db) => new PostgresOnboardingRepository(db));
  if (store instanceof InMemoryLedgerStore) store.join(repository as InMemoryOnboardingRepository);
  const audit = pick(() => new InMemoryAuditPort(), (db) => new PostgresAuditLog(db));
  const clock = appClock;
  let n = 0;
  const idFactory = db === null ? () => `setup-${counter}-${String((n += 1)).padStart(5, '0')}` : () => randomUUID();
  const accountIds = db === null ? defaultChartIdFactory(companyId) : (code: string) => asId<'Account'>(stableUuid(companyId, 'account', code));
  // The company's own row, which its audit trail and setup refer to. `companies` holds no books and
  // has no row-level policy; the application role may add a row and change only its name (#368).
  if (db !== null) await db.requireUnitOfWork(companyId).sql.query('INSERT INTO companies (id, legal_name) VALUES ($1, $2)', [companyId, legalName]);
  const actor: ActorContext = { companyId, branchId: asId<'Branch'>('main'), userId: asId<'User'>(userId), permissions: ONBOARDING_PERMISSIONS };

  const ledger = new LedgerService({ store, permissions: permissionPortFromActor, audit, clock, idFactory });
  await ledger.initialiseCompany(actor, { booksStartDate: isoDate('2017-07-01'), accounts: buildDefaultChart(companyId, accountIds) });

  // ponytail: declared rates stay in memory — `@invoice/gst-calc` (GPT 1) has no table for them yet.
  const declaredRates = new InMemoryDeclaredRates();
  const service = new OnboardingService({ store, ledger, repository, permissions: permissionPortFromActor, audit, clock, declaredRates, idFactory });
  return { service, store, declaredRates, actor, companyId };
};

/** Carries a setup with problems out of its unit of work, so nothing of it is saved. */
class NotSaved {
  readonly result: RunResult;
  constructor(result: RunResult) { this.result = result; }
}

/** Turns the flat form into the step patches, so the service sees real, typed answers. */
const answersFrom = (input: Record<string, unknown>): { patches: Partial<Record<StepId, Partial<OnboardingAnswers>>>; openingProvided: boolean; rateProvided: boolean } => {
  const businessType = oneOf(input.businessType, BUSINESS_TYPES);
  const registration = oneOf(input.registration, REGISTRATIONS);
  const booksStartDate = str(input.booksStartDate) === '' ? currentFinancialYear().from : isoDate(str(input.booksStartDate));

  const filingFrequency = oneOf(input.filingFrequency, ['MONTHLY', 'QUARTERLY'] as const);
  // Issue #180 — the address is asked once, here, so the Business details screen opens with it
  // already filled in rather than asking the same person for the same street a second time.
  const addressLines = [str(input.address1), str(input.address2)].filter((line) => line !== '');
  const business: Partial<OnboardingAnswers> = {
    business: {
      legalName: str(input.legalName),
      tradeName: str(input.tradeName) || str(input.legalName),
      ...(businessType === undefined ? {} : { businessType }),
      stateCode: str(input.stateCode),
      ...(addressLines.length === 0 ? {} : { addressLines }),
      ...(str(input.city) === '' ? {} : { city: str(input.city) }),
      ...(str(input.pincode) === '' ? {} : { pincode: str(input.pincode) }),
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

const runSetup = async (input: Record<string, unknown>, finish: boolean, companyId?: string, actorId?: string): Promise<RunResult> => {
  // Issue #180 — whatever was typed here is offered back on the Business details screen. It is a
  // suggestion, not a saved record: nothing prints until somebody saves it there.
  if (companyId !== undefined && str(input.legalName) !== '') {
    rememberBusinessPrefill(companyId, {
      legalName: str(input.legalName),
      tradeName: str(input.tradeName),
      stateCode: str(input.stateCode),
      phone: str(input.phone),
      address1: str(input.address1),
      address2: str(input.address2),
      city: str(input.city),
      pincode: str(input.pincode),
    });
  }
  counter += 1;
  // A preview saves nothing, wherever the app keeps its books.
  const db = finish ? durableDatabase() : null;
  const newCompanyId = asId<'Company'>(db === null ? `setup-${counter}-${Date.now()}` : randomUUID());
  let result: RunResult;
  if (db === null) result = await setUp(null, newCompanyId, input, finish, actorId);
  else {
    try {
      result = await outsideUnitOfWork(() => db.unitOfWork(newCompanyId, async () => {
        const done = await setUp(db, newCompanyId, input, finish, actorId);
        if (!done.ok) throw new NotSaved(done);
        return done;
      }));
    } catch (error) {
      if (!(error instanceof NotSaved)) throw error;
      result = error.result;
    }
  }
  // Issue #187 — the turnover question is asked here, in the tax step, and kept for this year once
  // the setup is actually finished. A preview saves nothing. It belongs to the session's company,
  // so it is written in the request's own unit of work, not the new company's.
  if (finish && result.result !== undefined && companyId !== undefined) recordTurnoverAnswer(companyId, { band: input.turnoverBand, above5Crore: input.turnoverAbove5Crore });
  return result;
};

const setUp = async (
  db: TransactionalExecutor | null, newCompanyId: CompanyId, input: Record<string, unknown>, finish: boolean, actorId?: string,
): Promise<RunResult> => {
  const { patches, openingProvided, rateProvided } = answersFrom(input);
  const company = await freshCompany(db, newCompanyId, actorId ?? 'setup-owner', str(input.legalName));
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
    session.steps[step].problems.map((problem) => ({ step, field: problem.field ?? null, message: say(problem.message) })),
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

export const previewOnboarding = (input: Record<string, unknown>, companyId?: string, actorId?: string): Promise<RunResult> => runSetup(input, false, companyId, actorId);
export const finishOnboarding = (input: Record<string, unknown>, companyId?: string, actorId?: string): Promise<RunResult> => runSetup(input, true, companyId, actorId);

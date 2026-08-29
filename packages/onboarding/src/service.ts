/**
 * Issue #36 [E36] — the guided setup.
 *
 * Every save is a whole step, validated and stored immediately. Nothing waits for a "submit" at
 * the end, because there is no end for a person who has to serve a customer halfway through.
 */
import {
  conflict,
  formatINR,
  forbidden,
  invalid,
  isoDate,
  notAllowed,
  notFound,
  subtract,
  toDecimalString,
  zero,
  type Clock,
  type CompanyId,
  type Money,
  type VoucherId,
} from '@invoice/kernel';
import type { ActorContext, AuditPort, LedgerService, LedgerStore, PermissionPort } from '@invoice/ledger';
import { checkOpeningBalances, withAcceptedDifference } from './opening-balances.ts';
import { validateStep } from './validate.ts';
import { profileFor } from './business-types.ts';
import {
  ONBOARDING_PERMISSIONS,
  STEP_ORDER,
  emptyAnswers,
  emptySteps,
  type OnboardingAnswers,
  type OnboardingSession,
  type StepId,
  type StepStatus,
} from './model.ts';
import type { OnboardingRepository } from './repository.ts';

/** Where declared rates go when setup finishes. Implemented by `@invoice/gst-calc`. */
export interface DeclaredRateWriter {
  declare(rate: {
    companyId: string;
    code: string;
    kind: 'GOODS' | 'SERVICES';
    ratePercentTimes100: bigint;
    effectiveFrom: string;
    effectiveTo: string | null;
    declaredBy: string;
    declaredOn: string;
    basis: string;
  }): unknown;
}

/** Opening stock belongs to issue #12. This is the narrow slice setup needs. */
export interface OpeningStockPort {
  recordOpeningStock(
    companyId: CompanyId,
    entries: readonly { itemId: string; quantity: string; unit: string; value: Money }[],
  ): Promise<void>;
}

export const noOpeningStock: OpeningStockPort = {
  async recordOpeningStock() {},
};

export interface OnboardingServiceDeps {
  readonly store: LedgerStore;
  readonly ledger: LedgerService;
  readonly repository: OnboardingRepository;
  readonly permissions: PermissionPort;
  readonly audit: AuditPort;
  readonly clock: Clock;
  readonly declaredRates?: DeclaredRateWriter;
  readonly openingStock?: OpeningStockPort;
  readonly idFactory?: () => string;
}

export interface FinishResult {
  readonly session: OnboardingSession;
  readonly openingVoucherId: VoucherId | null;
  readonly ratesDeclared: number;
}

export class OnboardingService {
  readonly #store: LedgerStore;
  readonly #ledger: LedgerService;
  readonly #repo: OnboardingRepository;
  readonly #permissions: PermissionPort;
  readonly #audit: AuditPort;
  readonly #clock: Clock;
  readonly #declaredRates: DeclaredRateWriter | undefined;
  readonly #openingStock: OpeningStockPort;
  readonly #newId: () => string;

  constructor(deps: OnboardingServiceDeps) {
    this.#store = deps.store;
    this.#ledger = deps.ledger;
    this.#repo = deps.repository;
    this.#permissions = deps.permissions;
    this.#audit = deps.audit;
    this.#clock = deps.clock;
    this.#declaredRates = deps.declaredRates;
    this.#openingStock = deps.openingStock ?? noOpeningStock;
    this.#newId = deps.idFactory ?? (() => crypto.randomUUID());
  }

  /** Starts setup, or hands back the one already in progress. Starting twice is not an error. */
  async start(actor: ActorContext, command: { idempotencyKey: string }): Promise<OnboardingSession> {
    this.#permissions.require(actor, ONBOARDING_PERMISSIONS.run, 'set up this business');

    const byKey = await this.#repo.findByIdempotencyKey(actor.companyId, command.idempotencyKey);
    if (byKey !== null) return byKey;
    const open = await this.#repo.findOpenForCompany(actor.companyId);
    if (open !== null) return open;

    const at = this.#clock.now().toISOString();
    const session: OnboardingSession = {
      id: this.#newId(),
      companyId: actor.companyId,
      state: 'IN_PROGRESS',
      steps: emptySteps(),
      answers: emptyAnswers(),
      createdBy: actor.userId,
      createdAt: at,
      updatedAt: at,
      openingVoucherId: null,
      version: 1,
    };
    await this.#store.transaction(actor.companyId, async () => {
      await this.#repo.insert(session, command.idempotencyKey);
    });
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at,
      action: 'onboarding.started',
      subjectType: 'onboarding',
      subjectId: session.id,
      summary: 'Setup started.',
      details: {},
    });
    return session;
  }

  /** Picks up exactly where the person left off. */
  async resume(actor: ActorContext, sessionId?: string): Promise<OnboardingSession | null> {
    this.#permissions.require(actor, ONBOARDING_PERMISSIONS.run, 'set up this business');
    return sessionId === undefined
      ? this.#repo.findOpenForCompany(actor.companyId)
      : this.#repo.findById(actor.companyId, sessionId);
  }

  /**
   * Saves one step's answers.
   *
   * The answers are kept whether or not they pass. Throwing away what someone typed because one
   * field is wrong is how a setup gets abandoned; the step is marked as needing attention instead,
   * with the problems attached.
   */
  async saveStep(
    actor: ActorContext,
    sessionId: string,
    step: StepId,
    patch: Partial<OnboardingAnswers>,
    expectedVersion: number,
  ): Promise<OnboardingSession> {
    this.#permissions.require(actor, ONBOARDING_PERMISSIONS.run, 'change this setup');
    const session = await this.#require(actor, sessionId);
    if (session.state === 'COMPLETED') {
      throw notAllowed(
        'ONBOARDING_ALREADY_DONE',
        'Setup is finished. Change these details in settings instead.',
      );
    }

    const answers: OnboardingAnswers = {
      ...session.answers,
      ...patch,
      business: { ...session.answers.business, ...(patch.business ?? {}) },
      taxProfile: { ...session.answers.taxProfile, ...(patch.taxProfile ?? {}) },
      branding: { ...session.answers.branding, ...(patch.branding ?? {}) },
    };

    const problems = validateStep(step, answers);
    const at = this.#clock.now().toISOString();
    const status: StepStatus = {
      state: problems.length === 0 ? 'DONE' : 'NEEDS_ATTENTION',
      problems,
      completedAt: problems.length === 0 ? at : null,
    };

    const next: OnboardingSession = {
      ...session,
      answers,
      steps: { ...session.steps, [step]: status },
      updatedAt: at,
      version: session.version + 1,
    };
    await this.#store.transaction(actor.companyId, async () => {
      await this.#repo.update(next, expectedVersion);
    });
    return next;
  }

  /** Marks a step deliberately skipped. Only steps that are genuinely optional may be skipped. */
  async skipStep(actor: ActorContext, sessionId: string, step: StepId, reason: string): Promise<OnboardingSession> {
    this.#permissions.require(actor, ONBOARDING_PERMISSIONS.run, 'skip a setup step');
    if (reason.trim() === '') {
      throw invalid('ONBOARDING_SKIP_REASON_REQUIRED', 'Please say why you are skipping this for now.');
    }
    const skippable: StepId[] = ['branding', 'rates', 'opening_balances'];
    if (!skippable.includes(step)) {
      throw notAllowed(
        'ONBOARDING_STEP_NOT_SKIPPABLE',
        'This part is needed before any bill can be made, so it cannot be skipped.',
      );
    }
    const session = await this.#require(actor, sessionId);
    const at = this.#clock.now().toISOString();
    const next: OnboardingSession = {
      ...session,
      steps: { ...session.steps, [step]: { state: 'SKIPPED', problems: [], completedAt: at } },
      updatedAt: at,
      version: session.version + 1,
    };
    await this.#store.transaction(actor.companyId, async () => {
      await this.#repo.update(next, session.version);
    });
    return next;
  }

  /**
   * Finishes setup: posts the opening balances, records the rates the business declared, and
   * hands the books over.
   *
   * Idempotent. Running it twice posts one opening entry, because the voucher id is stored on the
   * session and the ledger's own key would catch it anyway.
   */
  async finish(actor: ActorContext, sessionId: string, command: { idempotencyKey: string }): Promise<FinishResult> {
    this.#permissions.require(actor, ONBOARDING_PERMISSIONS.finish, 'finish setting up this business');
    const session = await this.#require(actor, sessionId);

    if (session.state === 'COMPLETED') {
      return {
        session,
        openingVoucherId: session.openingVoucherId as VoucherId | null,
        ratesDeclared: session.answers.rates.length,
      };
    }

    const unfinished = STEP_ORDER.filter(
      (id) => id !== 'ready' && session.steps[id].state !== 'DONE' && session.steps[id].state !== 'SKIPPED',
    );
    if (unfinished.length > 0) {
      throw notAllowed(
        'ONBOARDING_INCOMPLETE',
        `Setup is not finished yet. Still to do: ${unfinished.join(', ')}.`,
        { details: { remaining: unfinished.join(',') } },
      );
    }

    const answers = session.answers;
    const booksStart = answers.taxProfile.booksStartDate ?? isoDate(this.#clock.now().toISOString().slice(0, 10));

    let openingVoucherId: VoucherId | null = null;
    if (answers.openingBalances.length > 0) {
      const check = checkOpeningBalances(answers.openingBalances);
      const accepted = answers.openingDifferenceAccepted ?? null;
      if (!check.balanced && accepted === null) {
        throw notAllowed(
          'ONBOARDING_OPENING_UNBALANCED',
          `The opening figures are out by ${formatINR(check.difference)}. Find the missing entry, or record the difference and say why.`,
        );
      }
      const entries = check.balanced
        ? answers.openingBalances
        : withAcceptedDifference(answers.openingBalances, check.difference, (accepted as { reason: string }).reason);

      // Resolve every line to a real, postable account. A customer or supplier who owed money on
      // day one gets their account opened here, because a shopkeeper should not have to
      // understand a chart of accounts to say "Hotel Rajmahal owes me four thousand five hundred".
      const resolved: { accountId: string; partyId: string | null; entry: (typeof entries)[number] }[] = [];
      const uow = this.#store.read();
      for (const entry of entries) {
        if (entry.party !== undefined) {
          const account = await this.#ledger.openPartyAccount(actor, {
            partyId: entry.party.partyId,
            name: entry.party.name,
            kind: entry.party.kind,
          });
          resolved.push({ accountId: account.id, partyId: entry.party.partyId, entry });
          continue;
        }
        const account = await uow.accounts.findByCode(actor.companyId, entry.accountCode as string);
        if (account === null) {
          throw invalid(
            'ONBOARDING_OPENING_ACCOUNT_UNKNOWN',
            `There is no account "${entry.accountCode}" in your books, so "${entry.label}" cannot be recorded.`,
          );
        }
        if (account.isGroup) {
          throw invalid(
            'ONBOARDING_OPENING_ACCOUNT_IS_HEADING',
            `"${account.name}" is a heading that holds other accounts. If "${entry.label}" is a customer or a supplier, name them instead and we will open their account.`,
          );
        }
        resolved.push({ accountId: account.id, partyId: null, entry });
      }

      const posted = await this.#ledger.postVoucher(actor, {
        idempotencyKey: `onboarding:opening:${session.id}`,
        type: 'OPENING_BALANCE',
        date: booksStart,
        narration: `What the business already had on ${booksStart}`,
        source: { kind: 'onboarding', id: session.id, number: null },
        lines: resolved.map((r) => ({
          accountId: r.accountId as never,
          partyId: r.partyId,
          debit: r.entry.debit,
          credit: r.entry.credit,
          narration: r.entry.label,
        })),
      });
      openingVoucherId = posted.voucher.id;
    }

    if (answers.items.some((i) => i.openingQuantity !== undefined)) {
      await this.#openingStock.recordOpeningStock(
        actor.companyId,
        answers.items
          .filter((i) => i.openingQuantity !== undefined)
          .map((i) => ({
            itemId: i.itemId,
            quantity: i.openingQuantity as string,
            unit: i.baseUnit,
            value: i.openingValue ?? zero('INR'),
          })),
      );
    }

    let ratesDeclared = 0;
    if (this.#declaredRates !== undefined) {
      const declaredOn = this.#clock.now().toISOString().slice(0, 10);
      for (const rate of answers.rates) {
        this.#declaredRates.declare({
          companyId: actor.companyId,
          code: rate.code,
          kind: rate.kind,
          ratePercentTimes100: rate.ratePercentTimes100,
          effectiveFrom: booksStart,
          effectiveTo: null,
          declaredBy: actor.userId,
          declaredOn,
          basis: rate.basis,
        });
        ratesDeclared += 1;
      }
    }

    const at = this.#clock.now().toISOString();
    const completed: OnboardingSession = {
      ...session,
      state: 'COMPLETED',
      steps: { ...session.steps, ready: { state: 'DONE', problems: [], completedAt: at } },
      openingVoucherId,
      updatedAt: at,
      version: session.version + 1,
    };
    await this.#store.transaction(actor.companyId, async () => {
      await this.#repo.update(completed, session.version);
    });

    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at,
      action: 'onboarding.finished',
      subjectType: 'onboarding',
      subjectId: session.id,
      summary: `Setup finished. ${openingVoucherId === null ? 'No opening balances.' : 'Opening balances recorded.'} ${ratesDeclared} rate${ratesDeclared === 1 ? '' : 's'} declared by the business.`,
      details: {
        businessType: answers.business.businessType ?? '',
        registration: answers.taxProfile.registration ?? '',
        booksStartDate: booksStart,
        openingVoucherId: openingVoucherId ?? '',
        ratesDeclared: String(ratesDeclared),
      },
    });

    return { session: completed, openingVoucherId, ratesDeclared };
  }

  /** What the person still has to do, and what setting up this trade will involve. */
  suggestionsFor(session: OnboardingSession): ReturnType<typeof profileFor> | null {
    const type = session.answers.business.businessType;
    return type === undefined ? null : profileFor(type);
  }

  async #require(actor: ActorContext, id: string): Promise<OnboardingSession> {
    const session = await this.#repo.findById(actor.companyId, id);
    if (session === null) throw notFound('ONBOARDING_NOT_FOUND', 'That setup does not exist for this business.');
    if (session.companyId !== actor.companyId) {
      throw forbidden('ONBOARDING_WRONG_COMPANY', 'That setup belongs to a different business.');
    }
    return session;
  }
}

export const differenceOf = (debit: Money, credit: Money): Money => subtract(debit, credit);
export { conflict };

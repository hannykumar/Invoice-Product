/**
 * Issue #4 [E04] — the ledger service.
 *
 * This is the only way anything reaches the books. It enforces, in order:
 *   1. the caller is acting inside their own company (tenant isolation, GPT 2 issue #3);
 *   2. the caller holds the permission for this kind of entry;
 *   3. the same idempotency key never produces a second entry;
 *   4. the date falls in a period that accepts postings;
 *   5. the entry balances and every line is well formed;
 *   6. everything is written in one unit of work, or nothing is;
 *   7. the action is recorded in the audit trail.
 */
import {
  compareDates,
  conflict,
  forbidden,
  invalid,
  isoDate,
  notAllowed,
  notFound,
  newId,
  toDecimalString,
  type Clock,
  type CompanyId,
  type IsoDate,
  type Money,
  type VoucherId,
  type JournalLineId,
  type AccountId,
} from '@invoice/kernel';
import type { Account } from './domain/account.ts';
import { periodKeyOf, decidePeriod, refuseHardLocked, refuseSoftLockedWithoutOverride, type PeriodState } from './domain/period.ts';
import { mirrorLines, validatePosting, type PostingLine } from './domain/posting.ts';
import {
  POST_PERMISSION,
  type JournalLine,
  type SourceDocument,
  type Voucher,
  type VoucherType,
} from './domain/voucher.ts';
import type { ActorContext, AuditPort, LedgerStore, PermissionPort, UnitOfWork } from './ports.ts';

export interface PostLineInput {
  readonly accountId: AccountId;
  readonly partyId?: string | null;
  readonly debit: Money;
  readonly credit: Money;
  readonly narration?: string | null;
}

export interface PostVoucherCommand {
  /** Required. Two attempts with the same key produce one entry, whatever the network did. */
  readonly idempotencyKey: string;
  readonly type: Exclude<VoucherType, 'REVERSAL'>;
  readonly date: IsoDate;
  readonly narration?: string | null;
  readonly source?: SourceDocument | null;
  readonly lines: readonly PostLineInput[];
  /** Only for a soft-locked month, and only with the permission and a written reason. */
  readonly periodOverride?: { readonly reason: string };
}

export interface PostResult {
  readonly voucher: Voucher;
  /** True when this call matched an earlier one and nothing new was written. */
  readonly deduplicated: boolean;
}

export interface ReverseVoucherCommand {
  readonly idempotencyKey: string;
  readonly voucherId: VoucherId;
  /** The date the correction is made. Defaults to the original date when it is still open. */
  readonly date: IsoDate;
  readonly reason: string;
  readonly periodOverride?: { readonly reason: string };
}

export interface AmendVoucherCommand {
  readonly idempotencyKey: string;
  readonly voucherId: VoucherId;
  readonly reason: string;
  readonly date: IsoDate;
  readonly replacement: {
    readonly date: IsoDate;
    readonly narration?: string | null;
    readonly source?: SourceDocument | null;
    readonly lines: readonly PostLineInput[];
  };
  readonly periodOverride?: { readonly reason: string };
}

export interface AmendResult {
  readonly reversal: Voucher;
  readonly replacement: Voucher;
  readonly deduplicated: boolean;
}

export const PERIOD_OVERRIDE_PERMISSION = 'ledger.post.locked_period';
export const PERIOD_LOCK_PERMISSION = 'periods.lock';
export const PERIOD_REOPEN_PERMISSION = 'periods.reopen';
export const PERIOD_HARD_LOCK_PERMISSION = 'periods.hard_lock';
export const REVERSE_PERMISSION = 'ledger.reverse';
export const SETUP_PERMISSION = 'ledger.setup';

export interface LedgerServiceDeps {
  readonly store: LedgerStore;
  readonly permissions: PermissionPort;
  readonly audit: AuditPort;
  readonly clock: Clock;
  readonly idFactory?: () => string;
}

const padSequence = (n: number): string => String(n).padStart(6, '0');

export class LedgerService {
  readonly #store: LedgerStore;
  readonly #permissions: PermissionPort;
  readonly #audit: AuditPort;
  readonly #clock: Clock;
  readonly #newId: () => string;

  constructor(deps: LedgerServiceDeps) {
    this.#store = deps.store;
    this.#permissions = deps.permissions;
    this.#audit = deps.audit;
    this.#clock = deps.clock;
    this.#newId = deps.idFactory ?? (() => newId<'Generic'>());
  }

  /** Refuses any attempt to act on a company other than the caller's own. */
  #sameCompany(actor: ActorContext, companyId: CompanyId): void {
    if (actor.companyId !== companyId) {
      throw forbidden('LEDGER_WRONG_COMPANY', 'This record belongs to a different business.');
    }
  }

  async #ensurePeriod(uow: UnitOfWork, companyId: CompanyId, date: IsoDate): Promise<PeriodState> {
    const { monthKey, financialYear } = periodKeyOf(date);
    const existing = await uow.periods.find(companyId, monthKey);
    if (existing !== null) return existing.state;
    // A month nobody has closed is open. Creating the row lazily keeps setup out of the way.
    await uow.periods.upsertState(companyId, monthKey, financialYear, 'OPEN', null, null, null);
    return 'OPEN';
  }

  async #checkDatePostable(
    uow: UnitOfWork,
    actor: ActorContext,
    date: IsoDate,
    override: { reason: string } | undefined,
  ): Promise<{ overridden: boolean; state: PeriodState }> {
    const settings = await uow.settings.get(actor.companyId);
    if (settings !== null && compareDates(date, settings.booksStartDate) < 0) {
      throw notAllowed(
        'LEDGER_BEFORE_BOOKS_START',
        `This business started keeping books here on ${settings.booksStartDate}, so nothing can be dated before that. Use the opening balances instead.`,
        { details: { booksStartDate: settings.booksStartDate, documentDate: date } },
      );
    }
    const state = await this.#ensurePeriod(uow, actor.companyId, date);
    const { monthKey } = periodKeyOf(date);
    const decision = decidePeriod(state);
    if (!decision.allowed) throw refuseHardLocked(monthKey);
    if (decision.requiresOverride) {
      if (override === undefined) throw refuseSoftLockedWithoutOverride(monthKey, date);
      if (override.reason.trim().length === 0) {
        throw invalid('LEDGER_OVERRIDE_REASON_REQUIRED', 'Please write why you are going ahead.', {
          messageId: 'override.reason_required',
        });
      }
      this.#permissions.require(actor, PERIOD_OVERRIDE_PERMISSION, `post an entry into closed ${monthKey}`);
      return { overridden: true, state };
    }
    return { overridden: false, state };
  }

  async #loadAccounts(uow: UnitOfWork, companyId: CompanyId, lines: readonly PostLineInput[]): Promise<Map<string, Account>> {
    const ids = [...new Set(lines.map((l) => l.accountId))];
    const accounts = await uow.accounts.findManyByIds(companyId, ids);
    return new Map(accounts.map((a) => [a.id as string, a]));
  }

  async #buildVoucher(
    uow: UnitOfWork,
    actor: ActorContext,
    type: VoucherType,
    date: IsoDate,
    lines: readonly PostingLine[],
    extras: {
      narration?: string | null;
      source?: SourceDocument | null;
      idempotencyKey: string;
      reversesVoucherId?: VoucherId | null;
      amendsVoucherId?: VoucherId | null;
      reason?: string | null;
    },
  ): Promise<Voucher> {
    const { financialYear } = periodKeyOf(date);
    const sequence = await uow.sequences.next(actor.companyId, `${type}:${financialYear}`);
    const voucherId = this.#newId() as VoucherId;
    const journalLines: JournalLine[] = lines.map((l, index) => ({
      id: this.#newId() as JournalLineId,
      voucherId,
      lineNo: index + 1,
      accountId: l.accountId as AccountId,
      partyId: (l.partyId ?? null) as JournalLine['partyId'],
      debit: l.debit,
      credit: l.credit,
      narration: l.narration ?? null,
    }));
    return {
      id: voucherId,
      companyId: actor.companyId,
      branchId: actor.branchId,
      type,
      number: `${type}/${financialYear}/${padSequence(sequence)}`,
      date,
      state: 'FINAL',
      narration: extras.narration ?? null,
      source: extras.source ?? null,
      lines: journalLines,
      idempotencyKey: extras.idempotencyKey,
      createdBy: actor.userId,
      createdAt: this.#clock.now().toISOString(),
      reversedByVoucherId: null,
      reversesVoucherId: extras.reversesVoucherId ?? null,
      amendsVoucherId: extras.amendsVoucherId ?? null,
      reason: extras.reason ?? null,
    };
  }

  /** Seeds a company's chart of accounts and its books start date. Runs once per company. */
  async initialiseCompany(
    actor: ActorContext,
    input: { booksStartDate: IsoDate; accounts: readonly Account[] },
  ): Promise<void> {
    this.#permissions.require(actor, SETUP_PERMISSION, 'set up the books');
    await this.#store.transaction(actor.companyId, async (uow) => {
      const existing = await uow.accounts.listAll(actor.companyId);
      if (existing.length > 0) {
        throw conflict('LEDGER_ALREADY_SET_UP', 'The books for this business have already been set up.');
      }
      for (const account of input.accounts) this.#sameCompany(actor, account.companyId);
      await uow.accounts.insertMany(input.accounts);
      await uow.settings.put({ companyId: actor.companyId, booksStartDate: input.booksStartDate });
    });
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at: this.#clock.now().toISOString(),
      action: 'ledger.company_initialised',
      subjectType: 'company',
      subjectId: actor.companyId,
      summary: `Books opened from ${input.booksStartDate} with ${input.accounts.length} accounts.`,
      details: { booksStartDate: input.booksStartDate, accountCount: String(input.accounts.length) },
    });
  }

  /**
   * Opens the account that belongs to one customer or supplier.
   *
   * Party balances fold from journal lines, so a party needs an account of its own before anything
   * can be posted against it. Idempotent: asking twice returns the account that already exists,
   * because a shopkeeper adding the same customer twice is ordinary, not an error.
   */
  async openPartyAccount(
    actor: ActorContext,
    input: { partyId: string; name: string; kind: 'CUSTOMER' | 'SUPPLIER' },
  ): Promise<Account> {
    this.#permissions.require(actor, SETUP_PERMISSION, 'add a customer or supplier to the books');
    return this.#store.transaction(actor.companyId, async (uow) => {
      const existing = await uow.accounts.findByPartyId(actor.companyId, input.partyId);
      if (existing !== null) return existing;

      const groupRole = input.kind === 'CUSTOMER' ? 'TRADE_RECEIVABLES' : 'TRADE_PAYABLES';
      const group = await uow.accounts.findBySystemRole(actor.companyId, groupRole);
      if (group === null) {
        throw invalid(
          'LEDGER_PARTY_GROUP_MISSING',
          'The books have no place to put customers and suppliers yet. Set up the chart of accounts first.',
        );
      }
      const sequence = await uow.sequences.next(actor.companyId, `party-account:${input.kind}`);
      const account: Account = {
        id: this.#newId() as AccountId,
        companyId: actor.companyId,
        code: `${group.code}-${String(sequence).padStart(4, '0')}`,
        name: input.name,
        type: input.kind === 'CUSTOMER' ? 'ASSET' : 'LIABILITY',
        parentId: group.id,
        isGroup: false,
        active: true,
        partyId: input.partyId as Account['partyId'],
        systemRole: null,
      };
      await uow.accounts.insertMany([account]);
      return account;
    });
  }

  /** Posts a balanced, final entry. This is the only write path into the books. */
  async postVoucher(actor: ActorContext, command: PostVoucherCommand): Promise<PostResult> {
    const outcome = await this.#store.transaction(actor.companyId, (uow) => this.#post(uow, actor, command));
    if (!outcome.deduplicated) {
      await this.#recordPosted(actor, outcome.voucher, command.periodOverride?.reason);
    }
    return outcome;
  }

  /**
   * Posts inside a transaction the caller already opened.
   *
   * A module that owns a document — sales (#9), purchases (#17), returns (#45) — must allocate its
   * document number, write its own record and post to the ledger **as one unit of work**, or a
   * crash between the steps leaves a numbered invoice with no entry in the books. Those modules
   * call this; everyone else calls `postVoucher`.
   *
   * The audit event is the caller's responsibility here, via `recordPosted`, because only the
   * caller knows whether its own transaction actually committed.
   */
  async postVoucherIn(uow: UnitOfWork, actor: ActorContext, command: PostVoucherCommand): Promise<PostResult> {
    return this.#post(uow, actor, command);
  }

  /** Writes the audit event for a posting whose transaction has committed. */
  async recordPosted(actor: ActorContext, voucher: Voucher, overrideReason?: string): Promise<void> {
    await this.#recordPosted(actor, voucher, overrideReason);
  }

  async #post(uow: UnitOfWork, actor: ActorContext, command: PostVoucherCommand): Promise<PostResult> {
    if (command.idempotencyKey.trim().length === 0) {
      throw invalid('LEDGER_IDEMPOTENCY_KEY_REQUIRED', 'Every entry needs a key so a retry cannot create a second one.');
    }
    this.#permissions.require(actor, POST_PERMISSION[command.type], 'record this entry');

    const run = async (): Promise<PostResult> => {
      const alreadyDone = await uow.idempotency.lookup(actor.companyId, command.idempotencyKey);
      if (alreadyDone !== null) {
        const existing = await uow.vouchers.findById(actor.companyId, alreadyDone as VoucherId);
        if (existing === null) {
          throw conflict('LEDGER_IDEMPOTENCY_DANGLING', 'This entry was being saved a moment ago. Please try again.');
        }
        return { voucher: existing, deduplicated: true };
      }

      const { overridden } = await this.#checkDatePostable(uow, actor, command.date, command.periodOverride);
      const accounts = await this.#loadAccounts(uow, actor.companyId, command.lines);
      const lines: PostingLine[] = command.lines.map((l) => ({
        accountId: l.accountId as string,
        partyId: l.partyId ?? null,
        debit: l.debit,
        credit: l.credit,
        narration: l.narration ?? null,
      }));
      validatePosting(command.type, lines, accounts, actor.companyId);

      const voucher = await this.#buildVoucher(uow, actor, command.type, command.date, lines, {
        narration: command.narration ?? null,
        source: command.source ?? null,
        idempotencyKey: command.idempotencyKey,
        reason: overridden ? (command.periodOverride?.reason ?? null) : null,
      });
      await uow.vouchers.insert(voucher);
      await uow.idempotency.remember(actor.companyId, command.idempotencyKey, voucher.id);
      return { voucher, deduplicated: false };
    };
    return run();
  }

  async #recordPosted(actor: ActorContext, voucher: Voucher, overrideReason?: string): Promise<void> {
    const total = voucher.lines.reduce((acc, l) => acc + l.debit.minor, 0n);
    await this.#audit.record({
      companyId: voucher.companyId,
      actorId: actor.userId,
      at: this.#clock.now().toISOString(),
      action: 'ledger.voucher_posted',
      subjectType: 'voucher',
      subjectId: voucher.id,
      summary: `${voucher.type} ${voucher.number} dated ${voucher.date} for ${toDecimalString({ currency: 'INR', minor: total })}.`,
      details: {
        type: voucher.type,
        number: voucher.number,
        date: voucher.date,
        lines: String(voucher.lines.length),
        sourceKind: voucher.source?.kind ?? '',
        sourceNumber: voucher.source?.number ?? '',
      },
      ...(overrideReason === undefined ? {} : { overrideReason }),
    });
  }

  /**
   * Undoes a final entry by posting its mirror. Nothing is deleted and nothing is edited: both
   * entries stay visible forever, which is what makes the books auditable.
   */
  async reverseVoucher(actor: ActorContext, command: ReverseVoucherCommand): Promise<PostResult> {
    if (command.reason.trim().length === 0) {
      throw invalid('LEDGER_REASON_REQUIRED', 'Please write why this entry is being undone.', {
        messageId: 'override.reason_required',
      });
    }
    this.#permissions.require(actor, REVERSE_PERMISSION, 'undo an entry');

    const outcome = await this.#store.transaction(actor.companyId, (uow) => this.reverseVoucherIn(uow, actor, command));

    if (!outcome.deduplicated) {
      await this.#audit.record({
        companyId: actor.companyId,
        actorId: actor.userId,
        at: this.#clock.now().toISOString(),
        action: 'ledger.voucher_reversed',
        subjectType: 'voucher',
        subjectId: command.voucherId,
        summary: `${command.voucherId} undone by ${outcome.voucher.number}.`,
        details: { reversalId: outcome.voucher.id, reversalNumber: outcome.voucher.number, date: command.date },
        overrideReason: command.reason,
      });
    }
    return outcome;
  }

  /**
   * Undoes an entry inside a transaction the caller already opened.
   *
   * A module that owns a document undoes its own record, its stock and the entry as one unit of
   * work — purchase posting (#17) reverses a bill, puts the goods back and closes what was owed,
   * or does none of them. The audit event is the caller's, via `recordReversed`, because only the
   * caller knows whether its transaction committed.
   */
  async reverseVoucherIn(uow: UnitOfWork, actor: ActorContext, command: ReverseVoucherCommand): Promise<PostResult> {
    if (command.reason.trim().length === 0) {
      throw invalid('LEDGER_REASON_REQUIRED', 'Please write why this entry is being undone.', {
        messageId: 'override.reason_required',
      });
    }
    this.#permissions.require(actor, REVERSE_PERMISSION, 'undo an entry');
    const alreadyDone = await uow.idempotency.lookup(actor.companyId, command.idempotencyKey);
    if (alreadyDone !== null) {
      const existing = await uow.vouchers.findById(actor.companyId, alreadyDone as VoucherId);
      if (existing === null) {
        throw conflict('LEDGER_IDEMPOTENCY_DANGLING', 'This correction was being saved a moment ago. Please try again.');
      }
      return { voucher: existing, deduplicated: true };
    }

    const original = await uow.vouchers.findById(actor.companyId, command.voucherId);
    if (original === null) throw notFound('LEDGER_VOUCHER_NOT_FOUND', 'That entry does not exist in this business.');
    this.#sameCompany(actor, original.companyId);
    if (original.state === 'DRAFT') {
      throw notAllowed('LEDGER_REVERSE_DRAFT', 'An unfinished entry is deleted, not undone.');
    }
    if (original.state === 'REVERSED' || original.reversedByVoucherId !== null) {
      throw notAllowed(
        'LEDGER_ALREADY_REVERSED',
        `${original.number} has already been undone. Look at the correction that was made instead.`,
      );
    }

    await this.#checkDatePostable(uow, actor, command.date, command.periodOverride);
    const mirrored = mirrorLines(original.lines.map((l) => ({
      accountId: l.accountId as string,
      partyId: l.partyId,
      debit: l.debit,
      credit: l.credit,
      narration: l.narration,
    })));

    const reversal = await this.#buildVoucher(uow, actor, 'REVERSAL', command.date, mirrored, {
      narration: `Undoes ${original.number}`,
      source: original.source,
      idempotencyKey: command.idempotencyKey,
      reversesVoucherId: original.id,
      reason: command.reason,
    });
    await uow.vouchers.insert(reversal);
    await uow.vouchers.markReversed(actor.companyId, original.id, reversal.id, command.reason);
    await uow.idempotency.remember(actor.companyId, command.idempotencyKey, reversal.id);
    return { voucher: reversal, deduplicated: false };
  }

  /** Writes the audit event for a reversal whose transaction has committed. */
  async recordReversed(actor: ActorContext, originalVoucherId: VoucherId, reversal: Voucher, reason: string): Promise<void> {
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at: this.#clock.now().toISOString(),
      action: 'ledger.voucher_reversed',
      subjectType: 'voucher',
      subjectId: originalVoucherId,
      summary: `${originalVoucherId} undone by ${reversal.number}.`,
      details: { reversalId: reversal.id, reversalNumber: reversal.number },
      overrideReason: reason,
    });
  }

  /**
   * Corrects a final entry: undoes it and posts the corrected one, with both linked to each other.
   * This is the only supported correction; there is no edit.
   */
  async amendVoucher(actor: ActorContext, command: AmendVoucherCommand): Promise<AmendResult> {
    const reversal = await this.reverseVoucher(actor, {
      idempotencyKey: `${command.idempotencyKey}:reversal`,
      voucherId: command.voucherId,
      date: command.date,
      reason: command.reason,
      ...(command.periodOverride === undefined ? {} : { periodOverride: command.periodOverride }),
    });
    const original = await this.getVoucher(actor, command.voucherId);
    if (original === null) throw notFound('LEDGER_VOUCHER_NOT_FOUND', 'That entry does not exist in this business.');

    const replacement = await this.postVoucher(actor, {
      idempotencyKey: `${command.idempotencyKey}:replacement`,
      type: original.type === 'REVERSAL' ? 'JOURNAL' : (original.type as Exclude<VoucherType, 'REVERSAL'>),
      date: command.replacement.date,
      narration: command.replacement.narration ?? `Corrects ${original.number}`,
      source: command.replacement.source ?? original.source,
      lines: command.replacement.lines,
      ...(command.periodOverride === undefined ? {} : { periodOverride: command.periodOverride }),
    });

    return {
      reversal: reversal.voucher,
      replacement: replacement.voucher,
      deduplicated: reversal.deduplicated && replacement.deduplicated,
    };
  }

  async getVoucher(actor: ActorContext, id: VoucherId): Promise<Voucher | null> {
    return this.#store.read().vouchers.findById(actor.companyId, id);
  }

  async setPeriodState(
    actor: ActorContext,
    input: { monthKey: string; state: PeriodState; reason?: string },
  ): Promise<void> {
    const current = await this.#store.read().periods.find(actor.companyId, input.monthKey);
    const currentState: PeriodState = current?.state ?? 'OPEN';
    if (currentState === 'HARD_LOCKED') throw refuseHardLocked(input.monthKey);

    const permission =
      input.state === 'HARD_LOCKED'
        ? PERIOD_HARD_LOCK_PERMISSION
        : input.state === 'OPEN'
          ? PERIOD_REOPEN_PERMISSION
          : PERIOD_LOCK_PERMISSION;
    this.#permissions.require(actor, permission, `change the state of ${input.monthKey}`);

    if (input.state !== 'SOFT_LOCKED' && (input.reason ?? '').trim().length === 0) {
      throw invalid('LEDGER_REASON_REQUIRED', 'Please write why this month is being changed.', {
        messageId: 'override.reason_required',
      });
    }

    const financialYear = periodKeyOf(isoDate(`${input.monthKey}-01`)).financialYear;
    const at = this.#clock.now().toISOString();
    await this.#store.transaction(actor.companyId, async (uow) => {
      await uow.periods.upsertState(
        actor.companyId,
        input.monthKey,
        financialYear,
        input.state,
        input.state === 'OPEN' ? null : actor.userId,
        input.state === 'OPEN' ? null : at,
        input.reason ?? null,
      );
    });
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at,
      action: 'ledger.period_state_changed',
      subjectType: 'fiscal_period',
      subjectId: input.monthKey,
      summary: `${input.monthKey} changed from ${currentState} to ${input.state}.`,
      details: { from: currentState, to: input.state },
      ...(input.reason === undefined ? {} : { overrideReason: input.reason }),
    });
  }
}

/**
 * Issue #20 [E20] — the receivables and payables service.
 *
 * The three things it will not do:
 *
 *  1. **Mark a bill paid on a partial payment.** Outstanding is derived from the document less
 *     accepted allocations, every time.
 *  2. **Treat a cheque as money.** It sits in "cheques received, not yet cleared" until it clears,
 *     and a bounce reverses the receipt rather than editing it away.
 *  3. **Decide which bill a payment settles.** It suggests the oldest, and a person confirms. What
 *     is left over stays visibly on account.
 */
import {
  forbidden,
  invalid,
  isZero,
  notAllowed,
  notFound,
  subtract,
  sum,
  toDecimalString,
  zero,
  type Clock,
  type IsoDate,
  type Money,
  type PartyId,
  type VoucherId,
} from '@invoice/kernel';
import type { ActorContext, AuditPort, LedgerService, LedgerStore, PermissionPort } from '@invoice/ledger';
import { onAccountOf, positionOf, suggestAllocation, validateAllocation } from './allocation.ts';
import {
  buildChequeClearingPosting,
  buildPaymentPosting,
  buildWriteOffPosting,
  resolveAccounts,
} from './posting.ts';
import {
  RECEIVABLES_PERMISSIONS,
  currentChequeState,
  type Allocation,
  type ChequeEvent,
  type ChequeState,
  type Direction,
  type PartyPosition,
  type Payment,
  type PaymentMode,
} from './model.ts';
import type { DocumentLedgerPort, PaymentRepository } from './ports.ts';

const nil = (): Money => zero('INR');

export interface ReceivablesServiceDeps {
  readonly store: LedgerStore;
  readonly ledger: LedgerService;
  readonly repository: PaymentRepository;
  readonly documents: DocumentLedgerPort;
  readonly permissions: PermissionPort;
  readonly audit: AuditPort;
  readonly clock: Clock;
  readonly idFactory?: () => string;
}

export interface RecordPaymentCommand {
  readonly idempotencyKey: string;
  readonly direction: Direction;
  readonly partyId: PartyId;
  readonly mode: PaymentMode;
  readonly amount: Money;
  readonly date: IsoDate;
  readonly reference?: string | null;
  readonly bankAccountCode?: string | null;
  readonly cheque?: { number: string; chequeDate: IsoDate; bankName?: string | null };
  /** Omit to leave the money on account. Nothing is applied without being asked for. */
  readonly allocations?: readonly Allocation[];
  readonly narration?: string | null;
}

export class ReceivablesService {
  readonly #store: LedgerStore;
  readonly #ledger: LedgerService;
  readonly #repo: PaymentRepository;
  readonly #documents: DocumentLedgerPort;
  readonly #permissions: PermissionPort;
  readonly #audit: AuditPort;
  readonly #clock: Clock;
  readonly #newId: () => string;

  constructor(deps: ReceivablesServiceDeps) {
    this.#store = deps.store;
    this.#ledger = deps.ledger;
    this.#repo = deps.repository;
    this.#documents = deps.documents;
    this.#permissions = deps.permissions;
    this.#audit = deps.audit;
    this.#clock = deps.clock;
    this.#newId = deps.idFactory ?? (() => crypto.randomUUID());
  }

  /** What one customer or supplier owes, bill by bill, with anything unapplied shown separately. */
  async position(actor: ActorContext, partyId: PartyId, today: IsoDate): Promise<PartyPosition> {
    const documents = await this.#documents.openDocuments(actor.companyId, partyId);
    const payments = await this.#repo.listForParty(actor.companyId, partyId);
    const positions = documents.map((d) => positionOf(d, payments, today));
    const chequesNotCleared = sum(
      payments
        .filter((p) => p.state === 'RECORDED' && p.cheque !== null)
        .filter((p) => {
          const state = currentChequeState(p.cheque as NonNullable<typeof p.cheque>);
          return state === 'PENDING' || state === 'DEPOSITED';
        })
        .map((p) => p.amount),
    );
    return {
      partyId,
      documents: positions,
      totalOutstanding: sum(positions.map((p) => p.outstanding)),
      onAccount: onAccountOf(payments),
      chequesNotCleared,
    };
  }

  /** The split the product would suggest. A suggestion, which the caller confirms. */
  async suggest(actor: ActorContext, partyId: PartyId, amount: Money, today: IsoDate) {
    const position = await this.position(actor, partyId, today);
    return suggestAllocation(amount, position.documents);
  }

  /**
   * Records money in or out and posts it.
   *
   * The customer's balance falls the moment the money arrives, whether or not anyone has decided
   * which bill it belongs to. Deciding that is `allocate`.
   */
  async recordPayment(actor: ActorContext, command: RecordPaymentCommand): Promise<Payment> {
    this.#permissions.require(actor, RECEIVABLES_PERMISSIONS.record, 'record money received or paid');
    if (command.idempotencyKey.trim() === '') {
      throw invalid('PAYMENT_IDEMPOTENCY_KEY_REQUIRED', 'Every payment needs a key so a retry cannot record it twice.');
    }
    if (command.mode === 'CHEQUE' && command.cheque === undefined) {
      throw invalid('PAYMENT_CHEQUE_DETAILS_REQUIRED', 'Please enter the cheque number and its date.');
    }

    const existing = await this.#repo.findByIdempotencyKey(actor.companyId, command.idempotencyKey);
    if (existing !== null) return existing;

    const today = command.date;
    const position = await this.position(actor, command.partyId, today);
    const allocations = command.allocations ?? [];
    if (allocations.length > 0) {
      this.#permissions.require(actor, RECEIVABLES_PERMISSIONS.allocate, 'choose which bills this settles');
      validateAllocation(command.amount, allocations, position.documents);
    }

    const at = this.#clock.now().toISOString();
    const narration =
      command.narration ??
      (command.direction === 'RECEIPT' ? 'Money received' : 'Money paid') +
        (command.mode === 'CHEQUE' ? ` by cheque ${command.cheque?.number ?? ''}` : '');

    const outcome = await this.#store.transaction(actor.companyId, async (uow) => {
      const accounts = await resolveAccounts(
        uow.accounts,
        actor.companyId,
        command.partyId,
        command.mode,
        command.bankAccountCode ?? null,
      );
      const lines = buildPaymentPosting(
        command.direction,
        accounts.settlement,
        accounts.party,
        command.partyId,
        command.amount,
        narration,
      );
      const posted = await this.#ledger.postVoucherIn(uow, actor, {
        idempotencyKey: `payment:${command.idempotencyKey}`,
        type: command.direction,
        date: command.date,
        narration,
        source: { kind: 'payment', id: command.idempotencyKey, number: command.reference ?? null },
        lines,
      });

      const payment: Payment = {
        id: this.#newId(),
        companyId: actor.companyId,
        branchId: actor.branchId,
        direction: command.direction,
        partyId: command.partyId,
        mode: command.mode,
        amount: command.amount,
        date: command.date,
        reference: command.reference ?? null,
        bankAccountCode: command.bankAccountCode ?? null,
        cheque:
          command.cheque === undefined
            ? null
            : {
                number: command.cheque.number,
                chequeDate: command.cheque.chequeDate,
                bankName: command.cheque.bankName ?? null,
                history: [{ state: 'PENDING', on: command.date, by: actor.userId, at, note: null }],
              },
        allocations,
        state: 'RECORDED',
        voucherId: posted.voucher.id,
        reversalVoucherId: null,
        reversalReason: null,
        narration,
        recordedBy: actor.userId,
        recordedAt: at,
        idempotencyKey: command.idempotencyKey,
        version: 1,
      };
      await this.#repo.insert(payment);
      return { payment, voucher: posted.voucher };
    });

    await this.#ledger.recordPosted(actor, outcome.voucher);
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at,
      action: command.direction === 'RECEIPT' ? 'payments.received' : 'payments.paid',
      subjectType: 'payment',
      subjectId: outcome.payment.id,
      summary: `${toDecimalString(command.amount)} ${command.direction === 'RECEIPT' ? 'received from' : 'paid to'} ${command.partyId} by ${command.mode.toLowerCase().replace(/_/g, ' ')}.`,
      details: {
        amount: toDecimalString(command.amount),
        mode: command.mode,
        allocated: toDecimalString(sum(allocations.map((a) => a.amount))),
        reference: command.reference ?? '',
      },
    });
    return outcome.payment;
  }

  /**
   * Decides which bills a payment settles, or changes that decision.
   *
   * Allocation is a link, not a posting: the money already moved when it was received. Re-deciding
   * which bill it belongs to does not move it again, and the audit trail keeps every version.
   */
  async allocate(
    actor: ActorContext,
    paymentId: string,
    allocations: readonly Allocation[],
    expectedVersion: number,
  ): Promise<Payment> {
    this.#permissions.require(actor, RECEIVABLES_PERMISSIONS.allocate, 'choose which bills this settles');
    const payment = await this.#require(actor, paymentId);
    if (payment.state === 'REVERSED') {
      throw notAllowed('PAYMENT_REVERSED', 'This payment was undone, so it cannot be applied to a bill.');
    }

    // The document positions must exclude this payment's own current allocations, or re-applying
    // the same money to the same bill would look like an over-payment.
    const documents = await this.#documents.openDocuments(actor.companyId, payment.partyId);
    const others = (await this.#repo.listForParty(actor.companyId, payment.partyId)).filter((p) => p.id !== payment.id);
    const positions = documents.map((d) => positionOf(d, others, payment.date));
    validateAllocation(payment.amount, allocations, positions);

    const at = this.#clock.now().toISOString();
    const next: Payment = { ...payment, allocations, version: payment.version + 1 };
    await this.#store.transaction(actor.companyId, async () => {
      await this.#repo.update(next, expectedVersion);
    });
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at,
      action: 'payments.allocated',
      subjectType: 'payment',
      subjectId: payment.id,
      summary: `${toDecimalString(payment.amount)} applied to ${allocations.length} bill${allocations.length === 1 ? '' : 's'}.`,
      details: Object.fromEntries(allocations.map((a) => [a.documentNumber, toDecimalString(a.amount)])),
    });
    return next;
  }

  /** Moves a cheque along its life. Every step is kept; nothing is overwritten. */
  async recordChequeEvent(
    actor: ActorContext,
    paymentId: string,
    to: Exclude<ChequeState, 'PENDING'>,
    input: { on: IsoDate; note?: string | null; bankAccountCode?: string },
    expectedVersion: number,
  ): Promise<Payment> {
    this.#permissions.require(actor, RECEIVABLES_PERMISSIONS.record, 'update a cheque');
    const payment = await this.#require(actor, paymentId);
    if (payment.cheque === null) throw invalid('PAYMENT_NOT_A_CHEQUE', 'This payment was not made by cheque.');
    const from = currentChequeState(payment.cheque);

    const allowed: Record<ChequeState, ChequeState[]> = {
      PENDING: ['DEPOSITED', 'BOUNCED', 'CANCELLED'],
      DEPOSITED: ['CLEARED', 'BOUNCED'],
      CLEARED: [],
      BOUNCED: [],
      CANCELLED: [],
    };
    if (!allowed[from].includes(to)) {
      throw notAllowed(
        'CHEQUE_INVALID_STEP',
        `A cheque that is "${from.toLowerCase()}" cannot become "${to.toLowerCase()}".`,
        { details: { from, to } },
      );
    }
    if ((to === 'BOUNCED' || to === 'CANCELLED') && (input.note ?? '').trim() === '') {
      throw invalid('CHEQUE_REASON_REQUIRED', 'Please write what the bank said, so the history explains itself.', {
        messageId: 'override.reason_required',
      });
    }

    const at = this.#clock.now().toISOString();
    const event: ChequeEvent = { state: to, on: input.on, by: actor.userId, at, note: input.note ?? null };
    let reversalVoucherId: VoucherId | null = payment.reversalVoucherId;
    let state = payment.state;

    if (to === 'CLEARED') {
      // The money becomes bank balance now, and not a moment earlier.
      const code = input.bankAccountCode ?? payment.bankAccountCode;
      if (code === null || code === undefined) {
        throw invalid('CHEQUE_BANK_ACCOUNT_REQUIRED', 'Please say which bank account the cheque cleared into.');
      }
      const cleared = await this.#store.transaction(actor.companyId, async (uow) => {
        const bank = await uow.accounts.findByCode(actor.companyId, code);
        const chequesInHand = await uow.accounts.findBySystemRole(actor.companyId, 'CHEQUES_IN_HAND');
        if (bank === null) throw invalid('PAYMENT_BANK_ACCOUNT_UNKNOWN', `There is no account "${code}" in your books.`);
        if (chequesInHand === null) throw invalid('PAYMENT_ACCOUNT_MISSING', 'Your books have nowhere to hold uncleared cheques.');
        return this.#ledger.postVoucherIn(uow, actor, {
          idempotencyKey: `cheque:cleared:${payment.id}`,
          type: 'JOURNAL',
          date: input.on,
          narration: `Cheque ${payment.cheque?.number ?? ''} cleared`,
          source: { kind: 'payment', id: payment.id, number: payment.cheque?.number ?? null },
          lines: buildChequeClearingPosting(bank.id, chequesInHand.id, payment.amount, payment.cheque?.number ?? ''),
        });
      });
      await this.#ledger.recordPosted(actor, cleared.voucher);
    }

    if (to === 'BOUNCED') {
      // Undo the receipt. The customer owes it again, and both entries stay visible.
      const reversed = await this.#ledger.reverseVoucher(actor, {
        idempotencyKey: `cheque:bounced:${payment.id}`,
        voucherId: payment.voucherId as VoucherId,
        date: input.on,
        reason: input.note as string,
      });
      reversalVoucherId = reversed.voucher.id;
      state = 'REVERSED';
    }

    const next: Payment = {
      ...payment,
      cheque: { ...payment.cheque, history: [...payment.cheque.history, event] },
      state,
      reversalVoucherId,
      reversalReason: to === 'BOUNCED' ? (input.note ?? null) : payment.reversalReason,
      // A bounced cheque settles nothing, so its allocations fall away — but the history says why.
      allocations: to === 'BOUNCED' ? [] : payment.allocations,
      version: payment.version + 1,
    };
    await this.#store.transaction(actor.companyId, async () => {
      await this.#repo.update(next, expectedVersion);
    });

    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at,
      action: `payments.cheque_${to.toLowerCase()}`,
      subjectType: 'payment',
      subjectId: payment.id,
      summary: `Cheque ${payment.cheque.number} moved from ${from.toLowerCase()} to ${to.toLowerCase()}.`,
      details: { from, to, on: input.on, amount: toDecimalString(payment.amount) },
      ...(input.note == null ? {} : { overrideReason: input.note }),
    });
    return next;
  }

  /** Undoes a payment that should not have been recorded. Reversal, never deletion. */
  async reversePayment(actor: ActorContext, paymentId: string, input: { on: IsoDate; reason: string }): Promise<Payment> {
    this.#permissions.require(actor, RECEIVABLES_PERMISSIONS.reverse, 'undo a payment');
    if (input.reason.trim() === '') {
      throw invalid('PAYMENT_REASON_REQUIRED', 'Please write why this payment is being undone.', {
        messageId: 'override.reason_required',
      });
    }
    const payment = await this.#require(actor, paymentId);
    if (payment.state === 'REVERSED') return payment;

    const reversed = await this.#ledger.reverseVoucher(actor, {
      idempotencyKey: `payment:reversed:${payment.id}`,
      voucherId: payment.voucherId as VoucherId,
      date: input.on,
      reason: input.reason,
    });
    const next: Payment = {
      ...payment,
      state: 'REVERSED',
      reversalVoucherId: reversed.voucher.id,
      reversalReason: input.reason,
      allocations: [],
      version: payment.version + 1,
    };
    await this.#store.transaction(actor.companyId, async () => {
      await this.#repo.update(next, payment.version);
    });
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at: this.#clock.now().toISOString(),
      action: 'payments.reversed',
      subjectType: 'payment',
      subjectId: payment.id,
      summary: `${toDecimalString(payment.amount)} undone.`,
      details: { reversalVoucherId: reversed.voucher.id },
      overrideReason: input.reason,
    });
    return next;
  }

  /**
   * Writes off money a customer will not pay.
   *
   * It is an expense the business bore, not a disappearance, so it needs its own permission and a
   * written reason and it lands in a visible account.
   */
  async writeOff(
    actor: ActorContext,
    input: { idempotencyKey: string; partyId: PartyId; amount: Money; on: IsoDate; reason: string },
  ): Promise<VoucherId> {
    this.#permissions.require(actor, RECEIVABLES_PERMISSIONS.writeOff, 'write off money owed');
    if (input.reason.trim() === '') {
      throw invalid('WRITE_OFF_REASON_REQUIRED', 'Please write why this money is being given up.', {
        messageId: 'override.reason_required',
      });
    }
    if (isZero(input.amount) || input.amount.minor < 0n) {
      throw invalid('WRITE_OFF_AMOUNT_NOT_POSITIVE', 'A write-off needs an amount greater than zero.');
    }
    const position = await this.position(actor, input.partyId, input.on);
    if (input.amount.minor > position.totalOutstanding.minor) {
      throw invalid(
        'WRITE_OFF_EXCEEDS_OUTSTANDING',
        `This customer owes ${toDecimalString(position.totalOutstanding)}, so ${toDecimalString(input.amount)} cannot be written off.`,
      );
    }

    const posted = await this.#store.transaction(actor.companyId, async (uow) => {
      const badDebts = await uow.accounts.findBySystemRole(actor.companyId, 'BAD_DEBTS');
      const partyAccount = await uow.accounts.findByPartyId(actor.companyId, input.partyId);
      if (badDebts === null) throw invalid('PAYMENT_ACCOUNT_MISSING', 'Your books have nowhere to record money you could not collect.');
      if (partyAccount === null) throw invalid('PAYMENT_PARTY_ACCOUNT_MISSING', 'This customer does not have an account in your books.');
      return this.#ledger.postVoucherIn(uow, actor, {
        idempotencyKey: `write-off:${input.idempotencyKey}`,
        type: 'JOURNAL',
        date: input.on,
        narration: `Written off: ${input.reason}`,
        source: { kind: 'write_off', id: input.idempotencyKey, number: null },
        lines: buildWriteOffPosting(badDebts.id, partyAccount.id, input.partyId, input.amount, input.reason),
      });
    });
    await this.#ledger.recordPosted(actor, posted.voucher);
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at: this.#clock.now().toISOString(),
      action: 'payments.written_off',
      subjectType: 'party',
      subjectId: input.partyId,
      summary: `${toDecimalString(input.amount)} written off.`,
      details: { amount: toDecimalString(input.amount), voucherId: posted.voucher.id },
      overrideReason: input.reason,
    });
    return posted.voucher.id;
  }

  async payment(actor: ActorContext, id: string): Promise<Payment | null> {
    return this.#repo.findById(actor.companyId, id);
  }

  async paymentsFor(actor: ActorContext, partyId: PartyId): Promise<Payment[]> {
    return this.#repo.listForParty(actor.companyId, partyId);
  }

  async #require(actor: ActorContext, id: string): Promise<Payment> {
    const payment = await this.#repo.findById(actor.companyId, id);
    if (payment === null) throw notFound('PAYMENT_NOT_FOUND', 'That payment does not exist in this business.');
    if (payment.companyId !== actor.companyId) {
      throw forbidden('PAYMENT_WRONG_COMPANY', 'That payment belongs to a different business.');
    }
    return payment;
  }
}

/** What of a payment no bill has claimed. Shown to the person, never quietly attached. */
export const unallocated = (payment: Payment): Money =>
  subtract(payment.amount, sum(payment.allocations.map((a) => a.amount)));

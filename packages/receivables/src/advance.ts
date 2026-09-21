/**
 * Issue #165 — money received against a proforma invoice, before the bill.
 *
 * What the law asks for, and what this file does about each:
 *
 *  - **A receipt voucher** (CGST Rule 50) for every advance, in its own series (`RV/26-27/00001`),
 *    carrying the customer, a description, the amount, the rate and the tax where tax applies, the
 *    place of supply and whether reverse charge applies.
 *  - **GST on an advance for services** (CGST section 13): due when the money arrives. The advance
 *    is treated as including the tax, at the rates the proforma was priced at. For **goods** no GST
 *    is due on an advance (Notification 66/2017-Central Tax), and the voucher says so.
 *  - **No tax twice.** The bill charges its whole tax again, so the tax paid on the advance is held
 *    in its own account and set off against the output tax when the bill is linked to the proforma
 *    — only for the part of the advance the bill actually used.
 *  - **A refund voucher** (Rule 51) when no bill follows, or when the bill used less than was paid.
 *    It pays back what is unused and takes back the tax that was paid on it.
 *
 * The money itself is recorded by the receivables service like any other receipt: the customer's
 * balance falls the moment it arrives, and it sits on account until the bill takes it.
 */
import {
  allocateByWeight,
  compareDates,
  financialYearOf,
  formatINR,
  invalid,
  mulDiv,
  notAllowed,
  notFound,
  conflict,
  subtract,
  sum,
  zero,
  type AccountId,
  type BranchId,
  type Clock,
  type CompanyId,
  type IsoDate,
  type Money,
  type PartyId,
  type UserId,
  type VoucherId,
} from '@invoice/kernel';
import type { ActorContext, AuditPort, LedgerService, LedgerStore, PermissionPort, SystemAccountRole, TransactionParticipant, UnitOfWork } from '@invoice/ledger';
import type { PreSaleDocument, PreSaleRepository } from '@invoice/sales';
import { RECEIVABLES_PERMISSIONS, type PaymentMode } from './model.ts';
import type { PostingLineOut } from './posting.ts';
import type { ReceivablesService } from './service.ts';

const nil = (): Money => zero('INR');

export interface TaxHeads {
  readonly cgst: Money;
  readonly sgst: Money;
  readonly utgst: Money;
  readonly igst: Money;
  readonly cess: Money;
}

/** One rate's share of an advance. Rule 50(g) and (h): the rate, and the tax charged at it. */
export interface AdvanceTaxLine extends TaxHeads {
  /** 18% is 1800n. `null` where the proforma line carried no rate, such as an exempt service. */
  readonly ratePercentTimes100: bigint | null;
  readonly reverseCharge: boolean;
  readonly taxableValue: Money;
}

export interface AdvanceTax extends TaxHeads {
  readonly lines: readonly AdvanceTaxLine[];
  readonly taxableValue: Money;
  readonly totalTax: Money;
}

const HEADS = ['cgst', 'sgst', 'utgst', 'igst', 'cess'] as const;
const headsTotal = (heads: TaxHeads): Money => sum(HEADS.map((h) => heads[h]));
const noHeads = (): TaxHeads => ({ cgst: nil(), sgst: nil(), utgst: nil(), igst: nil(), cess: nil() });
const scaleHeads = (heads: TaxHeads, part: Money, whole: Money): TaxHeads =>
  Object.fromEntries(HEADS.map((h) => [h, whole.minor === 0n ? nil() : mulDiv(heads[h], part.minor, whole.minor)])) as unknown as TaxHeads;
const minusHeads = (a: TaxHeads, b: TaxHeads): TaxHeads =>
  Object.fromEntries(HEADS.map((h) => [h, subtract(a[h], b[h])])) as unknown as TaxHeads;

/**
 * The GST inside an advance for services, or `null` for goods, where none is due.
 *
 * The advance is split across the proforma's rates in proportion to what each rate's lines came to,
 * and each share is treated as including its tax — so ₹11,800 against an 18% service is ₹10,000
 * and ₹1,800 of tax. The split between CGST, SGST and IGST is the proforma's own, which already
 * followed the place of supply. A reverse-charge line carries no tax here, because the customer pays it.
 */
export const taxOnAdvance = (proforma: Pick<PreSaleDocument, 'supplyKind' | 'pricing'>, amount: Money): AdvanceTax | null => {
  if (proforma.supplyKind === 'GOODS') return null;
  const groups = new Map<string, { rate: bigint | null; reverseCharge: boolean; total: Money; heads: TaxHeads }>();
  for (const line of proforma.pricing.lines) {
    const key = `${line.ratePercentTimes100 ?? 'none'}:${line.reverseCharge}`;
    const group = groups.get(key) ?? { rate: line.ratePercentTimes100, reverseCharge: line.reverseCharge, total: nil(), heads: noHeads() };
    const heads: TaxHeads = line.reverseCharge ? noHeads() : line;
    groups.set(key, {
      ...group,
      total: sum([group.total, line.lineTotal]),
      heads: Object.fromEntries(HEADS.map((h) => [h, sum([group.heads[h], heads[h]])])) as unknown as TaxHeads,
    });
  }
  const list = [...groups.values()];
  const shares = list.length === 0 ? [] : allocateByWeight(amount, list.map((g) => (g.total.minor > 0n ? g.total.minor : 0n)));
  const lines: AdvanceTaxLine[] = list.map((group, i) => {
    const share = shares[i] as Money;
    const heads = scaleHeads(group.heads, share, group.total);
    return { ratePercentTimes100: group.rate, reverseCharge: group.reverseCharge, taxableValue: subtract(share, headsTotal(heads)), ...heads };
  });
  const totals = Object.fromEntries(HEADS.map((h) => [h, sum(lines.map((l) => l[h]))])) as unknown as TaxHeads;
  return { lines, taxableValue: sum(lines.map((l) => l.taxableValue)), ...totals, totalTax: headsTotal(totals) };
};

// ----------------------------------------------------------------------------------- the record

/** The bill that used the advance, and the tax set off against it. */
export interface AdvanceApplication {
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly invoiceDate: IsoDate;
  /** How much of the advance the bill took. Anything left stays on account, to be refunded. */
  readonly amount: Money;
  /** The tax paid on that part of the advance, now set off against the bill's own tax. */
  readonly taxSetOff: TaxHeads;
  readonly voucherId: VoucherId | null;
  readonly by: UserId;
  readonly at: string;
}

/** CGST Rule 51: the paper that pays an unused advance back. */
export interface RefundVoucher {
  readonly number: string;
  readonly date: IsoDate;
  readonly amount: Money;
  /** The tax paid on the refunded part, taken back from what is owed to the government. */
  readonly taxRefunded: TaxHeads;
  readonly paymentId: string;
  readonly voucherId: VoucherId | null;
  readonly reason: string;
  readonly by: UserId;
  readonly at: string;
}

/** CGST Rule 50: the receipt voucher for one advance. */
export interface AdvanceReceipt {
  readonly id: string;
  readonly companyId: CompanyId;
  readonly branchId: BranchId | null;
  readonly number: string;
  readonly financialYear: string;
  readonly date: IsoDate;
  readonly proformaId: string;
  readonly proformaNumber: string;
  readonly partyId: PartyId;
  readonly supplyKind: 'GOODS' | 'SERVICES';
  readonly placeOfSupplyStateCode: string;
  /** Rule 50(e): what the advance is for, from the proforma's own lines. */
  readonly description: string;
  readonly amount: Money;
  /** `null` for goods: no GST is due on the advance. */
  readonly tax: AdvanceTax | null;
  readonly paymentId: string;
  readonly taxVoucherId: VoucherId | null;
  readonly application: AdvanceApplication | null;
  readonly refund: RefundVoucher | null;
  readonly recordedBy: UserId;
  readonly recordedAt: string;
  readonly idempotencyKey: string;
  readonly version: number;
}

/** Printed on a goods voucher where the rate and tax would go. */
export const GOODS_ADVANCE_NO_TAX = {
  'en-IN': 'No GST is due on an advance for goods (Notification 66/2017-Central Tax). The tax is charged on the invoice.',
  'hi-IN': 'Saaman ke advance par GST nahin lagta (Notification 66/2017-Central Tax). Tax invoice par lagta hai.',
} as const;

export const RECEIPT_VOUCHER_PREFIX = 'RV';
export const REFUND_VOUCHER_PREFIX = 'RFV';

const voucherNumber = (prefix: string, date: IsoDate, sequence: number): string =>
  `${prefix}/${financialYearOf(date).slice(2)}/${String(sequence).padStart(5, '0')}`;

/** What is left of an advance that no bill used and nobody refunded. */
export const unusedOf = (advance: AdvanceReceipt): Money =>
  subtract(subtract(advance.amount, advance.application?.amount ?? nil()), advance.refund?.amount ?? nil());

// ------------------------------------------------------------------------------------ storage

export class InMemoryAdvanceRepository implements TransactionParticipant {
  #advances: AdvanceReceipt[] = [];

  snapshot(): unknown {
    return [...this.#advances];
  }

  restore(taken: unknown): void {
    this.#advances = taken as AdvanceReceipt[];
  }

  async findById(companyId: CompanyId, id: string): Promise<AdvanceReceipt | null> {
    return this.#advances.find((a) => a.companyId === companyId && a.id === id) ?? null;
  }

  async findByIdempotencyKey(companyId: CompanyId, key: string): Promise<AdvanceReceipt | null> {
    return this.#advances.find((a) => a.companyId === companyId && a.idempotencyKey === key) ?? null;
  }

  async insert(advance: AdvanceReceipt): Promise<void> {
    if (this.#advances.some((a) => a.companyId === advance.companyId && (a.id === advance.id || a.idempotencyKey === advance.idempotencyKey || a.number === advance.number))) {
      throw conflict('ADVANCE_DUPLICATE', 'This advance was already recorded.');
    }
    this.#advances = [...this.#advances, advance];
  }

  async update(advance: AdvanceReceipt, expectedVersion: number): Promise<void> {
    const index = this.#advances.findIndex((a) => a.companyId === advance.companyId && a.id === advance.id);
    if (index === -1) throw notFound('ADVANCE_NOT_FOUND', 'That advance does not exist in this business.');
    if ((this.#advances[index] as AdvanceReceipt).version !== expectedVersion) {
      throw conflict('ADVANCE_CONCURRENT_EDIT', 'Someone else changed this advance while you were working on it. Open it again to see their change.');
    }
    const next = [...this.#advances];
    next[index] = advance;
    this.#advances = next;
  }

  async list(companyId: CompanyId, filter: { proformaId?: string } = {}): Promise<AdvanceReceipt[]> {
    return this.#advances.filter((a) => a.companyId === companyId && (filter.proformaId === undefined || a.proformaId === filter.proformaId));
  }
}

// ------------------------------------------------------------------------------------ posting

const outputRole = { cgst: 'OUTPUT_CGST', sgst: 'OUTPUT_SGST', utgst: 'OUTPUT_SGST', igst: 'OUTPUT_IGST', cess: 'OUTPUT_CESS' } as const;

/**
 * `CHARGE` owes the tax on an advance: the government is owed it now, and it is held as paid ahead
 * of the bill. `SET_OFF` undoes exactly that, when the bill charges the tax itself or the advance
 * is refunded.
 */
const taxPosting = async (uow: UnitOfWork, companyId: CompanyId, heads: TaxHeads, way: 'CHARGE' | 'SET_OFF', narration: string): Promise<PostingLineOut[]> => {
  const find = async (role: SystemAccountRole): Promise<AccountId> => {
    const account = await uow.accounts.findBySystemRole(companyId, role);
    if (account === null) throw invalid('ADVANCE_ACCOUNT_MISSING', 'Your books have nowhere to record GST on an advance yet.', { details: { role } });
    return account.id;
  };
  const lines: PostingLineOut[] = [];
  for (const head of HEADS) {
    if (heads[head].minor === 0n) continue;
    const account = await find(outputRole[head]);
    lines.push(way === 'CHARGE'
      ? { accountId: account, partyId: null, debit: nil(), credit: heads[head], narration }
      : { accountId: account, partyId: null, debit: heads[head], credit: nil(), narration });
  }
  const total = headsTotal(heads);
  const held = await find('GST_ON_ADVANCES');
  lines.push(way === 'CHARGE'
    ? { accountId: held, partyId: null, debit: total, credit: nil(), narration }
    : { accountId: held, partyId: null, debit: nil(), credit: total, narration });
  return lines;
};

// ------------------------------------------------------------------------------------ service

export interface AdvanceServiceDeps {
  readonly store: LedgerStore;
  readonly ledger: LedgerService;
  readonly receivables: ReceivablesService;
  readonly proformas: Pick<PreSaleRepository, 'findById'>;
  readonly repository: InMemoryAdvanceRepository;
  readonly permissions: PermissionPort;
  readonly audit: AuditPort;
  readonly clock: Clock;
  readonly idFactory?: () => string;
}

export interface MoneyMovement {
  readonly idempotencyKey: string;
  readonly date: IsoDate;
  readonly mode: PaymentMode;
  readonly bankAccountCode?: string | null;
  readonly reference?: string | null;
}

export interface RecordAdvanceCommand extends MoneyMovement {
  readonly proformaId: string;
  readonly amount: Money;
}

export interface RefundAdvanceCommand extends MoneyMovement {
  readonly advanceId: string;
  readonly reason: string;
}

export class AdvanceService {
  readonly #store: LedgerStore;
  readonly #ledger: LedgerService;
  readonly #receivables: ReceivablesService;
  readonly #proformas: Pick<PreSaleRepository, 'findById'>;
  readonly #repo: InMemoryAdvanceRepository;
  readonly #permissions: PermissionPort;
  readonly #audit: AuditPort;
  readonly #clock: Clock;
  readonly #newId: () => string;

  constructor(deps: AdvanceServiceDeps) {
    this.#store = deps.store;
    this.#ledger = deps.ledger;
    this.#receivables = deps.receivables;
    this.#proformas = deps.proformas;
    this.#repo = deps.repository;
    this.#permissions = deps.permissions;
    this.#audit = deps.audit;
    this.#clock = deps.clock;
    this.#newId = deps.idFactory ?? (() => crypto.randomUUID());
  }

  async forProforma(actor: ActorContext, proformaId: string): Promise<AdvanceReceipt[]> {
    return this.#repo.list(actor.companyId, { proformaId });
  }

  /**
   * Records money received against a proforma and issues its receipt voucher.
   *
   * Idempotent on the key. The money is recorded first, through the receivables service, then the
   * voucher is numbered and any tax posted together; a retry after a failure in between finds the
   * money already recorded and finishes the voucher, so neither happens twice.
   */
  async record(actor: ActorContext, command: RecordAdvanceCommand): Promise<AdvanceReceipt> {
    this.#permissions.require(actor, RECEIVABLES_PERMISSIONS.record, 'record money received');
    if (command.idempotencyKey.trim() === '') throw invalid('ADVANCE_IDEMPOTENCY_KEY_REQUIRED', 'Every advance needs a key so a retry cannot record it twice.');
    const existing = await this.#repo.findByIdempotencyKey(actor.companyId, command.idempotencyKey);
    if (existing !== null) return existing;

    const proforma = await this.#proformas.findById(actor.companyId, command.proformaId);
    if (proforma === null) throw notFound('ADVANCE_PROFORMA_NOT_FOUND', 'That proforma invoice does not exist in this business.');
    if (proforma.kind !== 'PROFORMA') throw notAllowed('ADVANCE_NOT_A_PROFORMA', `${proforma.number} is a quotation. An advance is taken against a proforma invoice.`);
    if (proforma.state === 'CANCELLED') throw notAllowed('ADVANCE_PROFORMA_CANCELLED', `Proforma ${proforma.number} was cancelled, so no advance can be taken against it.`);
    if (proforma.state === 'INVOICED') {
      throw notAllowed('ADVANCE_PROFORMA_INVOICED', `Proforma ${proforma.number} is already billed on invoice ${proforma.invoice?.invoiceNumber}. Record this money against that invoice instead.`);
    }
    if (command.amount.minor <= 0n) throw invalid('ADVANCE_AMOUNT_NOT_POSITIVE', 'An advance needs an amount greater than zero.');
    if (compareDates(command.date, proforma.documentDate) < 0) {
      throw invalid('ADVANCE_BEFORE_PROFORMA', `This money is dated before proforma ${proforma.number}. Check the date.`);
    }
    const taken = sum((await this.#repo.list(actor.companyId, { proformaId: proforma.id })).map((a) => a.amount));
    const asked = proforma.pricing.totals.invoiceValue;
    if (sum([taken, command.amount]).minor > asked.minor) {
      throw invalid(
        'ADVANCE_MORE_THAN_PROFORMA',
        `Proforma ${proforma.number} asked for ${formatINR(asked)} and ${formatINR(taken)} has already been received against it, so ${formatINR(command.amount)} more would be more than it asked for.`,
      );
    }

    const tax = taxOnAdvance(proforma, command.amount);
    const payment = await this.#receivables.recordPayment(actor, {
      idempotencyKey: `advance:${command.idempotencyKey}`,
      direction: 'RECEIPT',
      partyId: proforma.partyId,
      mode: command.mode,
      amount: command.amount,
      date: command.date,
      reference: command.reference ?? null,
      bankAccountCode: command.bankAccountCode ?? null,
      narration: `Advance against proforma ${proforma.number}`,
      ...(command.mode === 'CHEQUE' ? { cheque: { number: command.reference ?? '', chequeDate: command.date } } : {}),
    });

    const id = this.#newId();
    const at = this.#clock.now().toISOString();
    const outcome = await this.#store.transaction(actor.companyId, async (uow) => {
      const sequence = await uow.sequences.next(actor.companyId, `receipt-voucher:${RECEIPT_VOUCHER_PREFIX}:${financialYearOf(command.date)}`);
      const number = voucherNumber(RECEIPT_VOUCHER_PREFIX, command.date, sequence);
      const posted = tax === null || tax.totalTax.minor === 0n
        ? null
        : await this.#ledger.postVoucherIn(uow, actor, {
            idempotencyKey: `advance-tax:${command.idempotencyKey}`,
            type: 'JOURNAL',
            date: command.date,
            narration: `GST on advance ${number} against proforma ${proforma.number}`,
            source: { kind: 'receipt_voucher', id, number },
            lines: await taxPosting(uow, actor.companyId, tax, 'CHARGE', `GST on advance ${number}`),
          });
      const advance: AdvanceReceipt = {
        id,
        companyId: actor.companyId,
        branchId: actor.branchId,
        number,
        financialYear: financialYearOf(command.date),
        date: command.date,
        proformaId: proforma.id,
        proformaNumber: proforma.number,
        partyId: proforma.partyId,
        supplyKind: proforma.supplyKind,
        placeOfSupplyStateCode: proforma.pricing.placeOfSupplyStateCode,
        description: describe(proforma),
        amount: command.amount,
        tax,
        paymentId: payment.id,
        taxVoucherId: posted?.voucher.id ?? null,
        application: null,
        refund: null,
        recordedBy: actor.userId,
        recordedAt: at,
        idempotencyKey: command.idempotencyKey,
        version: 1,
      };
      await this.#repo.insert(advance);
      return { advance, voucher: posted?.voucher ?? null };
    });
    if (outcome.voucher !== null) await this.#ledger.recordPosted(actor, outcome.voucher);

    const advance = outcome.advance;
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at,
      action: 'advance.received',
      subjectType: 'receipt_voucher',
      subjectId: advance.id,
      summary: `Receipt voucher ${advance.number}: ${formatINR(advance.amount)} received against proforma ${proforma.number}. ${
        tax === null ? 'No GST is due on an advance for goods.' : `GST of ${formatINR(tax.totalTax)} is due on it now.`
      }`,
      details: { number: advance.number, proforma: proforma.number, amount: String(advance.amount.minor), tax: String(tax?.totalTax.minor ?? 0n) },
    });
    return advance;
  }

  /**
   * Applies every advance on a proforma to the invoice it was billed on, and sets off the tax
   * already paid on each against the invoice's own tax. Called when the invoice is linked; safe to
   * call again, because an advance already applied is left alone.
   *
   * The invoice takes no more than it still owes. What it does not take stays on account, with its
   * tax, until it is refunded.
   */
  async applyToInvoice(actor: ActorContext, proforma: PreSaleDocument): Promise<void> {
    const link = proforma.invoice;
    if (link === null) return;
    for (const advance of await this.#repo.list(actor.companyId, { proformaId: proforma.id })) {
      if (advance.application !== null || advance.refund !== null) continue;
      let payment = await this.#receivables.payment(actor, advance.paymentId);
      if (payment === null || payment.state !== 'RECORDED') continue;

      let applied = payment.allocations.find((a) => a.documentId === link.invoiceId)?.amount ?? null;
      if (applied === null) {
        const position = await this.#receivables.position(actor, advance.partyId, link.invoiceDate);
        const owed = position.documents.find((d) => d.document.documentId === link.invoiceId)?.outstanding ?? nil();
        const free = subtract(payment.amount, sum(payment.allocations.map((a) => a.amount)));
        applied = owed.minor < free.minor ? owed : free;
        if (applied.minor > 0n) {
          payment = await this.#receivables.allocate(
            actor,
            payment.id,
            [...payment.allocations, { documentId: link.invoiceId, documentNumber: link.invoiceNumber, amount: applied }],
            payment.version,
          );
        }
      }
      const taxSetOff = advance.tax === null ? noHeads() : scaleHeads(advance.tax, applied, advance.amount);
      const at = this.#clock.now().toISOString();
      const outcome = await this.#store.transaction(actor.companyId, async (uow) => {
        const posted = headsTotal(taxSetOff).minor === 0n
          ? null
          : await this.#ledger.postVoucherIn(uow, actor, {
              idempotencyKey: `advance-set-off:${advance.id}`,
              type: 'JOURNAL',
              date: link.invoiceDate,
              narration: `GST paid on advance ${advance.number} set off against invoice ${link.invoiceNumber}`,
              source: { kind: 'receipt_voucher', id: advance.id, number: advance.number },
              lines: await taxPosting(uow, actor.companyId, taxSetOff, 'SET_OFF', `Advance ${advance.number} set off against ${link.invoiceNumber}`),
            });
        const next: AdvanceReceipt = {
          ...advance,
          application: {
            invoiceId: link.invoiceId,
            invoiceNumber: link.invoiceNumber,
            invoiceDate: link.invoiceDate,
            amount: applied,
            taxSetOff,
            voucherId: posted?.voucher.id ?? null,
            by: actor.userId,
            at,
          },
          version: advance.version + 1,
        };
        await this.#repo.update(next, advance.version);
        return { next, voucher: posted?.voucher ?? null };
      });
      if (outcome.voucher !== null) await this.#ledger.recordPosted(actor, outcome.voucher);
      await this.#audit.record({
        companyId: actor.companyId,
        actorId: actor.userId,
        at,
        action: 'advance.applied',
        subjectType: 'receipt_voucher',
        subjectId: advance.id,
        summary: `${formatINR(applied)} of advance ${advance.number} applied to invoice ${link.invoiceNumber}.${
          headsTotal(taxSetOff).minor === 0n ? '' : ` GST of ${formatINR(headsTotal(taxSetOff))} already paid on it was set off, so it is not charged twice.`
        }`,
        details: { number: advance.number, invoice: link.invoiceNumber, applied: String(applied.minor), taxSetOff: String(headsTotal(taxSetOff).minor) },
      });
    }
  }

  /**
   * Pays back what is unused of an advance and issues the refund voucher (Rule 51) — when no bill
   * followed, or the bill used less than was paid. The tax paid on the refunded part is taken back.
   */
  async refund(actor: ActorContext, command: RefundAdvanceCommand): Promise<AdvanceReceipt> {
    this.#permissions.require(actor, RECEIVABLES_PERMISSIONS.record, 'pay an advance back');
    if (command.reason.trim() === '') {
      throw invalid('ADVANCE_REFUND_REASON_REQUIRED', 'Please write why this advance is being paid back.', { messageId: 'override.reason_required' });
    }
    const advance = await this.#repo.findById(actor.companyId, command.advanceId);
    if (advance === null) throw notFound('ADVANCE_NOT_FOUND', 'That advance does not exist in this business.');
    if (advance.refund !== null) return advance;
    const proforma = await this.#proformas.findById(actor.companyId, advance.proformaId);
    if (proforma?.state === 'INVOICED' && advance.application === null) {
      throw notAllowed('ADVANCE_NOT_YET_APPLIED', `Proforma ${advance.proformaNumber} is billed, but advance ${advance.number} has not been applied to the bill yet. Link the invoice again first.`);
    }
    const amount = unusedOf(advance);
    if (amount.minor <= 0n) {
      throw notAllowed('ADVANCE_NOTHING_TO_REFUND', `Invoice ${advance.application?.invoiceNumber} used all of advance ${advance.number}, so there is nothing to pay back.`);
    }
    if (compareDates(command.date, advance.date) < 0) throw invalid('ADVANCE_REFUND_BEFORE_RECEIPT', `A refund cannot be dated before advance ${advance.number} was received.`);

    const payment = await this.#receivables.recordPayment(actor, {
      idempotencyKey: `advance-refund:${command.idempotencyKey}`,
      direction: 'PAYMENT',
      partyId: advance.partyId,
      mode: command.mode,
      amount,
      date: command.date,
      reference: command.reference ?? null,
      bankAccountCode: command.bankAccountCode ?? null,
      narration: `Refund of advance ${advance.number}`,
      refundOf: advance.paymentId,
      ...(command.mode === 'CHEQUE' ? { cheque: { number: command.reference ?? '', chequeDate: command.date } } : {}),
    });

    const taxRefunded = advance.tax === null ? noHeads() : minusHeads(advance.tax, advance.application?.taxSetOff ?? noHeads());
    const at = this.#clock.now().toISOString();
    const outcome = await this.#store.transaction(actor.companyId, async (uow) => {
      const sequence = await uow.sequences.next(actor.companyId, `refund-voucher:${REFUND_VOUCHER_PREFIX}:${financialYearOf(command.date)}`);
      const number = voucherNumber(REFUND_VOUCHER_PREFIX, command.date, sequence);
      const posted = headsTotal(taxRefunded).minor === 0n
        ? null
        : await this.#ledger.postVoucherIn(uow, actor, {
            idempotencyKey: `advance-refund-tax:${advance.id}`,
            type: 'JOURNAL',
            date: command.date,
            narration: `GST on advance ${advance.number} taken back by refund voucher ${number}`,
            source: { kind: 'refund_voucher', id: advance.id, number },
            lines: await taxPosting(uow, actor.companyId, taxRefunded, 'SET_OFF', `Refund voucher ${number}`),
          });
      const next: AdvanceReceipt = {
        ...advance,
        refund: { number, date: command.date, amount, taxRefunded, paymentId: payment.id, voucherId: posted?.voucher.id ?? null, reason: command.reason.trim(), by: actor.userId, at },
        version: advance.version + 1,
      };
      await this.#repo.update(next, advance.version);
      return { next, voucher: posted?.voucher ?? null };
    });
    if (outcome.voucher !== null) await this.#ledger.recordPosted(actor, outcome.voucher);
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at,
      action: 'advance.refunded',
      subjectType: 'refund_voucher',
      subjectId: advance.id,
      summary: `Refund voucher ${outcome.next.refund?.number}: ${formatINR(amount)} of advance ${advance.number} paid back.`,
      details: { number: outcome.next.refund?.number ?? '', advance: advance.number, amount: String(amount.minor), taxRefunded: String(headsTotal(taxRefunded).minor) },
      overrideReason: command.reason.trim(),
    });
    return outcome.next;
  }
}

/** Rule 50(e): the goods or services the advance is for, as the proforma listed them. */
const describe = (proforma: PreSaleDocument): string =>
  `${proforma.pricing.lines
    .filter((l) => l.kind !== 'CHARGE')
    .map((l) => `${l.itemName}${l.hsnOrSac === null ? '' : ` (${proforma.supplyKind === 'SERVICES' ? 'SAC' : 'HSN'} ${l.hsnOrSac})`}`)
    .join('; ')} — advance against proforma ${proforma.number}`;

/**
 * Issue #294 — money that is not a bill: expenses, journal and contra entries, and the owner's own
 * money in and out.
 *
 * Before this the only entries were bills, payments against bills and notes, so "What you earned
 * and what you spent" was sales less purchases: rent and wages paid from the drawer showed as
 * profit, and the cash book never matched the drawer.
 *
 * Every entry here is checked first and saved second: `preview` says exactly what will be written
 * and gives a `check`; `record` saves only that same entry (the check is recomputed, so anything
 * changed in between is refused), once per `requestId`. A saved entry is never edited: `undo`
 * reverses it in full, with a reason, through the ledger's own reversal.
 */
import { createHash } from 'node:crypto';
import { conflict, invalid, isoDate, money, notFound, type CompanyId, type IsoDate } from '@invoice/kernel';
import type { Account, ActorContext, LedgerService, LedgerStore, Voucher, VoucherType } from '@invoice/ledger';
import { appToday } from './app-clock.ts';

const CASH = '1110';
const BANK_GROUP = '1120';
const CURRENT_ACCOUNT = '1121';
const CAPITAL = '3100';
const DRAWINGS = '3150';
const SOURCE_PREFIX = 'books.';

/**
 * Accounts a journal may not touch because a document backs every amount in them, and the screen
 * that makes that document. GST credit needs the supplier's tax invoice and its place in GSTR-2B
 * (CGST Act s.16(2)(a), (aa)); tax collected and sales need a tax invoice or a note (s.31, s.34)
 * so they reach GSTR-1; reverse-charge tax comes with the self-invoice (s.9(3), s.31(3)(f)); TCS
 * with its sale (s.52); advances are set off bill by bill (packages/receivables).
 * A lawful GST adjustment journal (e.g. an ITC reversal under CGST Rules r.42/r.43) is not
 * offered here: it would also have to reach GSTR-3B, which this screen does not do.
 */
const GST_CREDIT = 'comes only from a supplier\'s bill on Purchases, so it is checked against your GSTR-2B and reaches your GSTR-3B.';
const GST_COLLECTED = 'comes only from a sale bill or a credit/debit note, so it reaches your GSTR-1 and GSTR-3B.';
const PURCHASE_SIDE = 'comes only from a supplier\'s bill or a return to the supplier on Purchases.';
const DOCUMENT_BACKED: Readonly<Partial<Record<NonNullable<Account['systemRole']>, string>>> = {
  INPUT_CGST: GST_CREDIT, INPUT_SGST: GST_CREDIT, INPUT_IGST: GST_CREDIT, INPUT_CESS: GST_CREDIT,
  GST_ON_ADVANCES: 'comes only from an advance receipt and is set off when its bill is made.',
  ADVANCES_TO_SUPPLIERS: 'is set off bill by bill; pay an advance from Payments.',
  OUTPUT_CGST: GST_COLLECTED, OUTPUT_SGST: GST_COLLECTED, OUTPUT_IGST: GST_COLLECTED, OUTPUT_CESS: GST_COLLECTED,
  REVERSE_CHARGE_PAYABLE: 'comes only from a supplier\'s bill on Purchases, with its self-invoice.',
  TCS_PAYABLE: 'comes only from the sale on which the tax was collected.',
  SALES_GOODS: GST_COLLECTED, SALES_SERVICES: GST_COLLECTED,
  SALES_RETURNS: 'comes only from a credit note against the sale bill.',
  PURCHASES_GOODS: PURCHASE_SIDE, PURCHASES_SERVICES: PURCHASE_SIDE, PURCHASE_RETURNS: PURCHASE_SIDE,
  STOCK_CHANGE: 'moves with the goods themselves, not by a journal.',
};

export interface ExpenseHead {
  readonly id: string;
  readonly code: string;
  readonly label: string;
  readonly hindi: string;
  /** Why GST is never charged on this head, when it is not. */
  readonly noGst: string | null;
}

/**
 * The heads the issue names. Wages: services by an employee to the employer in the course of
 * employment are neither goods nor services — CGST Act s.7(2)(a) with Schedule III para 1 (in force
 * 01.07.2017). Electricity: electrical energy (heading 2716) is exempt — Notification 2/2017-Central
 * Tax (Rate), 28.06.2017, S.No. 104. Neither citation was re-read online for this change.
 */
export const EXPENSE_HEADS: readonly ExpenseHead[] = [
  { id: 'rent', code: '5610', label: 'Rent', hindi: 'किराया', noGst: null },
  { id: 'wages', code: '5620', label: 'Wages and salaries', hindi: 'मज़दूरी और तनख़्वाह', noGst: 'Wages paid to your own staff carry no GST (CGST Act Schedule III, para 1).' },
  { id: 'electricity', code: '5630', label: 'Electricity', hindi: 'बिजली', noGst: 'An electricity bill carries no GST: electricity is exempt (Notification 2/2017-Central Tax (Rate), S.No. 104).' },
  { id: 'transport', code: '5640', label: 'Transport and travel', hindi: 'भाड़ा और आना-जाना', noGst: null },
  { id: 'repairs', code: '5650', label: 'Repairs and upkeep', hindi: 'मरम्मत', noGst: null },
  { id: 'bank_charges', code: '5660', label: 'Bank charges', hindi: 'बैंक शुल्क', noGst: null },
  { id: 'telephone', code: '5670', label: 'Telephone and internet', hindi: 'फ़ोन और इंटरनेट', noGst: null },
  { id: 'other', code: '5900', label: 'Other business costs', hindi: 'दूसरे ख़र्च', noGst: null },
];

/** The accounts this file adds to the chart; company-shop adds any missing to existing books. */
export const BOOKS_ENTRY_CODES: readonly string[] = [DRAWINGS, ...EXPENSE_HEADS.map((head) => head.code).filter((code) => code !== '5900')];

type Kind = 'expense' | 'journal' | 'contra' | 'owner';
type Input = Record<string, unknown>;

interface PlannedLine { readonly code: string; readonly debit: bigint; readonly credit: bigint; readonly note: string | null }
interface Plan {
  readonly kind: Kind;
  readonly type: Exclude<VoucherType, 'REVERSAL'>;
  readonly date: IsoDate;
  readonly narration: string;
  readonly lines: readonly PlannedLine[];
  readonly effects: readonly string[];
  /** Money leaving the cash drawer, checked against what is in it. */
  readonly cashOut: bigint;
}

const said = (value: unknown): string => String(value ?? '').trim();
const jsonAmount = (minor: bigint): number => Number(minor) / 100;
const rupees = (minor: bigint): string => `₹${(minor / 100n).toLocaleString('en-IN')}.${String(minor % 100n).padStart(2, '0')}`;

const amountOf = (value: unknown, what: string, optional = false): bigint => {
  const text = said(value).replace(/,/g, '');
  if (text === '' && optional) return 0n;
  if (!/^\d{1,11}(\.\d{1,2})?$/.test(text)) throw invalid('BOOKS_AMOUNT', `Please write the ${what} in rupees and paise, like 1250 or 1250.50.`);
  const [whole = '0', fraction = ''] = text.split('.');
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (minor === 0n && !optional) throw invalid('BOOKS_AMOUNT', `The ${what} cannot be zero.`);
  return minor;
};

const dateOf = (value: unknown): IsoDate => {
  const text = said(value);
  const date = text === '' ? appToday() : (() => {
    try { return isoDate(text); } catch { throw invalid('BOOKS_DATE', `"${text}" is not a date. Please write it like 2026-09-27.`); }
  })();
  if (date > appToday()) throw invalid('BOOKS_DATE_AHEAD', 'This date has not come yet. Money is recorded on the day it moved.');
  return date;
};

type Paid = 'cash' | 'bank';
/** Where the money came from or went to. UPI and card land in the bank account. */
const paidFromOf = (value: unknown, allowSupplier: boolean): Paid => {
  const way = said(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (way === 'cash' || way === '') return 'cash';
  if (way === 'bank' || way === 'upi' || way === 'bank_transfer' || way === 'card' || way === 'cheque') return 'bank';
  if (allowSupplier && (way === 'supplier' || way === 'owed' || way === 'credit')) {
    // Money owed to a supplier is followed bill by bill (payables and the payment screen read bills),
    // so a cost not yet paid is entered as that supplier's bill, never as a bare line here.
    throw invalid('BOOKS_EXPENSE_OWED', 'Not paid yet? Enter it as the supplier\'s bill on the Purchases screen, then pay it from Payments; that way it shows in what you owe.');
  }
  throw invalid('BOOKS_PAID_FROM', 'Please choose how it was paid: cash, bank or UPI.');
};
const moneyAccount = (way: Paid): string => (way === 'cash' ? CASH : CURRENT_ACCOUNT);

const fingerprint = (plan: Plan): string =>
  createHash('sha256').update(JSON.stringify({
    kind: plan.kind, type: plan.type, date: plan.date, narration: plan.narration,
    lines: plan.lines.map((line) => [line.code, String(line.debit), String(line.credit), line.note]),
  })).digest('hex').slice(0, 32);

const debit = (code: string, amount: bigint, note: string | null = null): PlannedLine => ({ code, debit: amount, credit: 0n, note });
const credit = (code: string, amount: bigint, note: string | null = null): PlannedLine => ({ code, debit: 0n, credit: amount, note });

const TO_PURCHASES = 'Please enter it on the Purchases screen as that seller\'s bill, with a service item such as "Shop rent", then pay it from Payments.';

/**
 * What this screen may take: a cost whose bill carries no GST and on which no GST is owed by the
 * shop itself. Everything else goes through a purchase bill, because that is where the law is
 * applied and where the returns read from:
 *  - GST on a bill is credit only once the bill shows in GSTR-2B (CGST Act s.16(2)(aa)); credit the
 *    law blocks (s.17(5)) is still reported in GSTR-3B Table 4. The 2B check (#31) and GSTR-3B's
 *    credit both read posted purchase bills, so a GST bill entered here would never reach either.
 *  - Reverse charge: the registered shop pays the GST itself and issues a self-invoice (s.9(3),
 *    s.31(3)(f)). The purchase bill applies Notification 13/2017-CT(R) through
 *    packages/purchasing/src/reverse-charge-notified.ts (S.No. 1 GTA, 5AA, 5AB and the rest).
 */
const reverseChargeCheck = (head: ExpenseHead, input: Input): string[] => {
  if (head.id === 'rent') {
    // Rent with no GST on the bill: a shop, godown or office let by an unregistered owner is S.No. 5AB
    // (inserted by 09/2024-CT(R), from 10.10.2024; amended by 07/2025-CT(R) so that a composition
    // recipient is outside it); a house let to a registered person is S.No. 5AA (05/2022-CT(R), from 18.07.2022).
    throw invalid('BOOKS_EXPENSE_RENT_REVERSE_CHARGE', `Rent with no GST on the bill: as a GST-registered tenant you usually pay that GST yourself (reverse charge), for a shop, godown or office let by an owner with no GST number, and for a house. ${TO_PURCHASES} It works out whether that applies and makes the self-invoice.`);
  }
  if (head.id === 'transport') {
    // S.No. 1 and its Explanation: a transporter that issues a consignment note is a GTA, and its
    // freight is taxed on the registered recipient unless the GTA opted to pay it.
    const note = said(input.consignmentNote).toLowerCase();
    if (note === 'yes') throw invalid('BOOKS_EXPENSE_GTA', `A transporter who gave a consignment note (bilty / LR) is a goods transport agency; GST on its freight is usually paid by you yourself (reverse charge). ${TO_PURCHASES}`);
    if (note !== 'no') throw invalid('BOOKS_EXPENSE_CONSIGNMENT_NOTE', 'Did the transporter give a consignment note (bilty / LR)? Please answer yes or no. A bus, train, taxi or auto fare is "no".');
    return [];
  }
  if (head.id === 'other') {
    return ['If this was an advocate\'s fee, a security agency, a director\'s fee or another service on which you pay the GST yourself (reverse charge), undo it and enter it on Purchases instead, so the GST you owe on it is worked out.'];
  }
  return [];
};

const planExpense = (input: Input): Plan => {
  const head = EXPENSE_HEADS.find((h) => h.id === said(input.head).toLowerCase() || h.code === said(input.head));
  if (head === undefined) throw invalid('BOOKS_EXPENSE_HEAD', `Please choose what it was for: ${EXPENSE_HEADS.map((h) => h.label).join(', ')}.`);
  const date = dateOf(input.date);
  const paid = paidFromOf(input.paidFrom, true);
  const amount = amountOf(input.amount, 'amount before GST');
  const gst = amountOf(input.gst, 'GST', true);
  if (gst > 0n) {
    if (head.noGst !== null) throw invalid('BOOKS_EXPENSE_NO_GST', head.noGst);
    throw invalid('BOOKS_EXPENSE_GST_PURCHASES', `This bill shows GST. ${TO_PURCHASES} That way its GST is checked against your GSTR-2B and reaches your GSTR-3B.`);
  }
  const warnings = reverseChargeCheck(head, input);
  const total = amount;
  const bill = said(input.billNumber);
  const note = said(input.narration);
  const narration = [`${head.label} paid${bill === '' ? '' : `, bill ${bill}`}`, note].filter((part) => part !== '').join(': ');
  return {
    kind: 'expense', type: 'PAYMENT', date, narration,
    lines: [debit(head.code, amount), credit(moneyAccount(paid), total)],
    effects: [`${rupees(amount)} is a cost under "${head.label}" in what you spent.`, `${rupees(total)} goes out of ${paid === 'cash' ? 'the cash drawer' : 'the bank account'}.`, ...warnings],
    cashOut: paid === 'cash' ? total : 0n,
  };
};

const planContra = (input: Input): Plan => {
  const direction = said(input.direction).toLowerCase();
  if (direction !== 'deposit' && direction !== 'withdraw') throw invalid('BOOKS_CONTRA_DIRECTION', 'Please say whether cash was put into the bank, or taken out of it.');
  const date = dateOf(input.date);
  const amount = amountOf(input.amount, 'amount');
  const deposit = direction === 'deposit';
  return {
    kind: 'contra', type: 'JOURNAL', date,
    narration: [deposit ? 'Cash put into the bank' : 'Cash taken out of the bank', said(input.narration)].filter((part) => part !== '').join(': '),
    lines: deposit ? [debit(CURRENT_ACCOUNT, amount), credit(CASH, amount)] : [debit(CASH, amount), credit(CURRENT_ACCOUNT, amount)],
    effects: [deposit ? `${rupees(amount)} leaves the cash drawer and arrives in the bank. Profit does not change.` : `${rupees(amount)} leaves the bank and arrives in the cash drawer. Profit does not change.`],
    cashOut: deposit ? amount : 0n,
  };
};

const planOwner = (input: Input): Plan => {
  const direction = said(input.direction).toLowerCase();
  if (direction !== 'capital' && direction !== 'drawings') throw invalid('BOOKS_OWNER_DIRECTION', 'Please say whether the owner put money in, or took money out for home.');
  const date = dateOf(input.date);
  const way = paidFromOf(input.paidFrom, false);
  const amount = amountOf(input.amount, 'amount');
  const where = way === 'cash' ? 'the cash drawer' : 'the bank account';
  if (direction === 'capital') {
    return {
      kind: 'owner', type: 'RECEIPT', date,
      narration: ['The owner put money into the business', said(input.narration)].filter((part) => part !== '').join(': '),
      lines: [debit(moneyAccount(way), amount), credit(CAPITAL, amount)],
      effects: [`${rupees(amount)} comes into ${where} as the owner's capital. It is not a sale and not profit.`],
      cashOut: 0n,
    };
  }
  return {
    kind: 'owner', type: 'PAYMENT', date,
    narration: ['The owner took money out for home', said(input.narration)].filter((part) => part !== '').join(': '),
    lines: [debit(DRAWINGS, amount), credit(moneyAccount(way), amount)],
    effects: [`${rupees(amount)} goes out of ${where} as the owner's drawings. It lowers the owner's capital, not the profit.`],
    cashOut: way === 'cash' ? amount : 0n,
  };
};

const MAX_JOURNAL_LINES = 20;

export interface BooksDeskConfig {
  readonly ledger: LedgerService;
  readonly store: LedgerStore;
  readonly companyId: CompanyId;
  readonly gstin: string;
}

/** One company's expense, journal, contra and owner entries, and its cash and bank books. */
export class BooksDesk {
  readonly #config: BooksDeskConfig;
  constructor(config: BooksDeskConfig) { this.#config = config; }

  heads() {
    return {
      heads: EXPENSE_HEADS.map((head) => ({ id: head.id, label: head.label, hindi: head.hindi, gstAllowed: head.noGst === null, noGst: head.noGst })),
    };
  }

  async journalAccounts() {
    const accounts = await this.#accounts();
    return { accounts: accounts.filter((account) => this.#journalRefusal(account, accounts) === null).map((account) => ({ code: account.code, name: account.name, type: account.type })) };
  }

  async preview(actor: ActorContext, kind: Kind, input: Input) {
    const plan = await this.#plan(actor, kind, input);
    return this.#describe(plan);
  }

  async record(actor: ActorContext, kind: Kind, input: Input) {
    const requestId = said(input.requestId);
    if (requestId === '') throw invalid('BOOKS_REQUEST_ID', 'This entry needs a request id, so pressing Save twice records it once.');
    const plan = await this.#plan(actor, kind, input, false);
    const check = fingerprint(plan);
    const given = said(input.check);
    if (given === '') throw invalid('BOOKS_NOT_CHECKED', 'Please check the entry first, then save it.');
    if (given !== check) throw conflict('BOOKS_CHANGED_SINCE_CHECK', 'The entry changed after you checked it. Please check it again before saving.');
    const accounts = await this.#accounts();
    const key = `${SOURCE_PREFIX}${kind}:${requestId}`;
    // A retry of a saved entry is answered from it, before the cash check that entry itself changed.
    const earlier = await this.#config.store.read().idempotency.lookup(actor.companyId, key);
    const done = earlier === null ? null : await this.#config.store.read().vouchers.findById(actor.companyId, earlier as Voucher['id']);
    if (done === null) await this.#checkCash(actor, plan);
    const idOf = (code: string) => {
      const account = accounts.find((a) => a.code === code);
      if (account === undefined) throw notFound('BOOKS_ACCOUNT_MISSING', `The account ${code} is not in these books.`);
      return account.id;
    };
    const result = await this.#config.ledger.postVoucher(actor, {
      idempotencyKey: key,
      type: plan.type, date: plan.date, narration: plan.narration,
      source: { kind: `${SOURCE_PREFIX}${kind}`, id: check, number: null },
      lines: plan.lines.map((line) => ({ accountId: idOf(line.code), debit: money(line.debit), credit: money(line.credit), narration: line.note })),
    });
    if (result.deduplicated && result.voucher.source?.id !== check) {
      throw conflict('BOOKS_REQUEST_REUSED', 'This request id was already used for a different entry. Please start a new entry.');
    }
    return { ...this.#describe(plan), entry: this.#entry(result.voucher, accounts), duplicate: result.deduplicated };
  }

  /** A saved entry is never changed: it is undone in full, with a reason, and entered again. */
  async undo(actor: ActorContext, input: Input) {
    const requestId = said(input.requestId);
    if (requestId === '') throw invalid('BOOKS_REQUEST_ID', 'This needs a request id, so pressing Undo twice undoes it once.');
    const reason = said(input.reason);
    if (reason === '') throw invalid('BOOKS_UNDO_REASON', 'Please write why this entry is being undone.');
    const voucher = await this.#config.store.read().vouchers.findById(actor.companyId, said(input.entryId) as Voucher['id']);
    if (voucher === null || !voucher.source?.kind.startsWith(SOURCE_PREFIX)) {
      throw notFound('BOOKS_ENTRY_NOT_FOUND', 'There is no such expense, journal, contra or owner entry in this business.');
    }
    const today = appToday();
    if (voucher.state === 'FINAL') {
      // Undoing cash that came in takes it back out of the drawer, which cannot go below nothing.
      const cash = (await this.#accounts()).find((a) => a.code === CASH);
      const cashBack = voucher.lines.filter((l) => l.accountId === cash?.id).reduce((sum, l) => sum + l.debit.minor - l.credit.minor, 0n);
      const inDrawer = cashBack > 0n ? await this.#cashOn(actor.companyId, today) : 0n;
      if (cashBack > 0n && inDrawer < cashBack) {
        throw invalid('BOOKS_CASH_SHORT', `Undoing this takes ${rupees(cashBack)} back out of the cash drawer, but the books show only ${rupees(inDrawer < 0n ? 0n : inDrawer)} in it today. Record the cash that went out first.`);
      }
    }
    const result = await this.#config.ledger.reverseVoucher(actor, { idempotencyKey: `${SOURCE_PREFIX}undo:${requestId}`, voucherId: voucher.id, date: today, reason });
    return { undone: this.#entry(voucher, await this.#accounts()), reversal: { id: result.voucher.id, number: result.voucher.number, date: result.voucher.date }, duplicate: result.deduplicated };
  }

  async entries(actor: ActorContext) {
    const accounts = await this.#accounts();
    const vouchers = await this.#config.store.read().vouchers.list(actor.companyId, {});
    return vouchers
      .filter((voucher) => voucher.source?.kind.startsWith(SOURCE_PREFIX) === true)
      .sort((a, b) => (a.date === b.date ? a.number.localeCompare(b.number) : a.date < b.date ? -1 : 1))
      .map((voucher) => this.#entry(voucher, accounts));
  }

  /**
   * The cash book or the bank book: every movement of the drawer or the bank, from every kind of
   * entry, with the balance after each. Read only.
   */
  async book(actor: ActorContext, input: Input) {
    const which = said(input.book).toLowerCase() || 'cash';
    if (which !== 'cash' && which !== 'bank') throw invalid('BOOKS_BOOK', 'Please choose the cash book or the bank book.');
    const from = said(input.from) === '' ? null : dateOf(input.from);
    const to = said(input.to) === '' ? appToday() : dateOf(input.to);
    const accounts = await this.#accounts();
    const bankGroup = accounts.find((a) => a.code === BANK_GROUP);
    const inBook = accounts.filter((a) => (which === 'cash' ? a.code === CASH : a.parentId === bankGroup?.id && !a.isGroup));
    const ids = new Set<string>(inBook.map((a) => a.id));
    const name = (id: string) => accounts.find((a) => a.id === id)?.name ?? '';
    const vouchers = (await this.#config.store.read().vouchers.list(actor.companyId, { to }))
      .filter((v) => v.state !== 'DRAFT' && v.lines.some((l) => ids.has(l.accountId)))
      .sort((a, b) => (a.date === b.date ? a.createdAt.localeCompare(b.createdAt) : a.date < b.date ? -1 : 1));
    let opening = 0n;
    let balance = 0n;
    const rows = [];
    for (const voucher of vouchers) {
      const mine = voucher.lines.filter((l) => ids.has(l.accountId));
      const moneyIn = mine.reduce((sum, l) => sum + l.debit.minor, 0n);
      const moneyOut = mine.reduce((sum, l) => sum + l.credit.minor, 0n);
      if (from !== null && voucher.date < from) { opening += moneyIn - moneyOut; continue; }
      if (rows.length === 0) balance = opening;
      balance += moneyIn - moneyOut;
      const other = [...new Set(voucher.lines.filter((l) => !ids.has(l.accountId)).map((l) => name(l.accountId)))];
      rows.push({ date: voucher.date, number: voucher.number, type: voucher.type, against: other.join(', '), narration: voucher.narration ?? '', moneyIn: jsonAmount(moneyIn), moneyOut: jsonAmount(moneyOut), balance: jsonAmount(balance) });
    }
    if (rows.length === 0) balance = opening;
    return { book: which, from, to, accounts: inBook.map((a) => a.name), opening: jsonAmount(opening), closing: jsonAmount(balance), rows };
  }

  async #plan(actor: ActorContext, kind: Kind, input: Input, checkCash = true): Promise<Plan> {
    const plan = kind === 'expense' ? planExpense(input)
      : kind === 'contra' ? planContra(input)
        : kind === 'owner' ? planOwner(input)
          : await this.#planJournal(input);
    if (checkCash) await this.#checkCash(actor, plan);
    return plan;
  }

  async #checkCash(actor: ActorContext, plan: Plan): Promise<void> {
    if (plan.cashOut > 0n) {
      // The drawer cannot hand over money it does not have; a missing cash sale or receipt comes first.
      const inDrawer = await this.#cashOn(actor.companyId, plan.date);
      if (inDrawer < plan.cashOut) {
        throw invalid('BOOKS_CASH_SHORT', `The books show only ${rupees(inDrawer < 0n ? 0n : inDrawer)} in the cash drawer on ${plan.date}, less than ${rupees(plan.cashOut)}. Record the cash that came in first, or choose bank.`);
      }
    }
  }

  async #planJournal(input: Input): Promise<Plan> {
    const date = dateOf(input.date);
    const narration = said(input.narration);
    if (narration === '') throw invalid('BOOKS_JOURNAL_NARRATION', 'Please write what this journal entry is for, so anyone reading the books later knows why.');
    const raw = Array.isArray(input.lines) ? input.lines as unknown[] : [];
    if (raw.length < 2) throw invalid('BOOKS_JOURNAL_LINES', 'A journal entry needs at least two lines: one account given, one account taken from.');
    if (raw.length > MAX_JOURNAL_LINES) throw invalid('BOOKS_JOURNAL_LINES', `A journal entry can have at most ${MAX_JOURNAL_LINES} lines.`);
    const accounts = await this.#accounts();
    const lines = raw.map((entry, index) => {
      const line = (typeof entry === 'object' && entry !== null ? entry : {}) as Input;
      const at = `Line ${index + 1}`;
      const account = accounts.find((a) => a.code === said(line.account));
      if (account === undefined) throw invalid('BOOKS_JOURNAL_ACCOUNT', `${at}: there is no account "${said(line.account)}" in these books.`);
      const refusal = this.#journalRefusal(account, accounts);
      if (refusal !== null) throw invalid('BOOKS_JOURNAL_ACCOUNT_NOT_ALLOWED', `${at}: ${refusal}`);
      const dr = amountOf(line.debit, 'amount', true);
      const cr = amountOf(line.credit, 'amount', true);
      if ((dr === 0n) === (cr === 0n)) throw invalid('BOOKS_JOURNAL_LINE_SIDE', `${at}: write the amount on one side only, debit or credit.`);
      return { code: account.code, debit: dr, credit: cr, note: said(line.note) || null };
    });
    const debits = lines.reduce((sum, l) => sum + l.debit, 0n);
    const credits = lines.reduce((sum, l) => sum + l.credit, 0n);
    if (debits !== credits) throw invalid('BOOKS_JOURNAL_UNBALANCED', `The two sides do not match: debits ${rupees(debits)}, credits ${rupees(credits)}. They must be equal.`);
    const nameOf = (code: string) => accounts.find((a) => a.code === code)?.name ?? code;
    return {
      kind: 'journal', type: 'JOURNAL', date, narration, lines,
      effects: lines.map((l) => (l.debit > 0n ? `${nameOf(l.code)}: debit ${rupees(l.debit)}` : `${nameOf(l.code)}: credit ${rupees(l.credit)}`)),
      cashOut: 0n,
    };
  }

  /**
   * Why a journal may not touch an account, or null. Cash and bank move through contra, expense and
   * owner entries so the cash book always says why; a customer's or supplier's balance moves through
   * bills, payments and notes so what is owed stays bill by bill; stock moves with the goods.
   */
  #journalRefusal(account: Account, accounts: readonly Account[]): string | null {
    if (account.isGroup) return `"${account.name}" is a heading; choose one of the accounts under it.`;
    if (!account.active) return `"${account.name}" is closed.`;
    if (account.partyId !== null) return `"${account.name}" is a customer's or supplier's account; use a bill, a payment or a note for it.`;
    const bankGroup = accounts.find((a) => a.code === BANK_GROUP);
    if (account.code === CASH || account.parentId === bankGroup?.id || account.systemRole === 'CHEQUES_IN_HAND') return 'cash and bank move through a contra, expense or owner\'s entry, so the cash book says why.';
    if (account.systemRole === 'STOCK_IN_HAND') return 'stock in hand moves with the goods themselves, not by a journal.';
    const screen = account.systemRole === null ? undefined : DOCUMENT_BACKED[account.systemRole];
    if (screen !== undefined) return `"${account.name}" ${screen}`;
    return null;
  }

  async #cashOn(companyId: CompanyId, date: IsoDate): Promise<bigint> {
    const accounts = await this.#accounts();
    const cash = accounts.find((a) => a.code === CASH);
    if (cash === undefined) return 0n;
    const vouchers = await this.#config.store.read().vouchers.list(companyId, { to: date, accountId: cash.id });
    return vouchers.filter((v) => v.state !== 'DRAFT').flatMap((v) => v.lines).filter((l) => l.accountId === cash.id)
      .reduce((sum, l) => sum + l.debit.minor - l.credit.minor, 0n);
  }

  async #accounts(): Promise<Account[]> {
    return this.#config.store.read().accounts.listAll(this.#config.companyId);
  }

  #describe(plan: Plan) {
    const total = plan.lines.reduce((sum, l) => sum + l.debit, 0n);
    return {
      kind: plan.kind, date: plan.date, narration: plan.narration, total: jsonAmount(total), effects: plan.effects,
      lines: plan.lines.map((l) => ({ account: l.code, debit: jsonAmount(l.debit), credit: jsonAmount(l.credit), note: l.note })),
      check: fingerprint(plan),
    };
  }

  #entry(voucher: Voucher, accounts: readonly Account[]) {
    const name = (id: string) => accounts.find((a) => a.id === id)?.name ?? '';
    return {
      id: voucher.id, number: voucher.number, date: voucher.date, kind: voucher.source?.kind.slice(SOURCE_PREFIX.length) ?? '',
      state: voucher.state, narration: voucher.narration ?? '',
      total: jsonAmount(voucher.lines.reduce((sum, l) => sum + l.debit.minor, 0n)),
      lines: voucher.lines.map((l) => ({ account: name(l.accountId), debit: jsonAmount(l.debit.minor), credit: jsonAmount(l.credit.minor), note: l.narration })),
    };
  }
}

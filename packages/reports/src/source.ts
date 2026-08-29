/**
 * Issue #35 [E35] — reading the books, once, with the branch filter applied.
 *
 * The date and state rules live in `@invoice/ledger`'s `linesOf`: a draft never counts, and a
 * reversed entry keeps its own lines because its reversal's lines cancel them. Those rules are not
 * repeated here — repeating them is how two parts of a product come to disagree about what a
 * balance is. What this file adds is the branch filter and the turn from a journal line into a
 * `Contribution` a person can read.
 */
import { money, type BranchId, type CompanyId, type IsoDate, type Money } from '@invoice/kernel';
import { linesOf, type JournalLine, type UnitOfWork, type Voucher, type Account, type Side } from '@invoice/ledger';
import type { Contribution, ReportFilter } from './model.ts';

export interface LedgerEntry {
  readonly voucher: Voucher;
  readonly line: JournalLine;
}

/**
 * `undefined` is every branch; `null` is only the entries that belong to no branch. Asking for one
 * shop must not quietly include the accountant's own entries, so the two are separate answers.
 */
export const matchesBranch = (voucher: Voucher, branchId: BranchId | null | undefined): boolean =>
  branchId === undefined ? true : voucher.branchId === branchId;

const dayBefore = (date: IsoDate): IsoDate => {
  const at = new Date(`${date}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() - 1);
  return at.toISOString().slice(0, 10) as IsoDate;
};

export interface LoadedBooks {
  readonly accounts: readonly Account[];
  /** Everything posted before the period started. What the period opened with. */
  readonly opening: readonly LedgerEntry[];
  /** What happened during the period. */
  readonly movement: readonly LedgerEntry[];
  /** Opening plus movement: where things stood on the closing date. */
  readonly closing: readonly LedgerEntry[];
}

/**
 * One read of the books for one filter.
 *
 * Every financial report in this package is built from this, so a pack of reports asked for the
 * same period cannot be built from two different reads of the ledger.
 */
export const loadBooks = async (
  uow: UnitOfWork,
  companyId: CompanyId,
  filter: ReportFilter,
): Promise<LoadedBooks> => {
  const accounts = await uow.accounts.listAll(companyId);
  const vouchers = (await uow.vouchers.list(companyId, {})).filter((v) => matchesBranch(v, filter.branchId));
  const opening = linesOf(vouchers, { to: dayBefore(filter.from) });
  const movement = linesOf(vouchers, { from: filter.from, to: filter.to });
  const closing = linesOf(vouchers, { to: filter.to });
  return { accounts, opening, movement, closing };
};

/** What this line did to an account carrying its balance on `side`. */
export const signedAmount = (line: JournalLine, side: Side): Money =>
  money(side === 'DEBIT' ? line.debit.minor - line.credit.minor : line.credit.minor - line.debit.minor);

/**
 * What this line was, in words. The date and the document number are fields of their own, so
 * repeating them here would only crowd the row a person is trying to read.
 */
const describe = (entry: LedgerEntry): string =>
  entry.line.narration ?? entry.voucher.narration ?? entry.voucher.type.toLowerCase().replace(/_/g, ' ');

/** A journal line as a drill-down row, signed towards the side the reader is looking at. */
export const contributionOf = (entry: LedgerEntry, side: Side): Contribution => ({
  sourceKind: entry.voucher.source?.kind ?? 'voucher',
  sourceId: entry.voucher.source?.id ?? entry.voucher.id,
  sourceNumber: entry.voucher.source?.number ?? entry.voucher.number,
  date: entry.voucher.date,
  branchId: entry.voucher.branchId,
  partyId: entry.line.partyId,
  description: describe(entry),
  amount: signedAmount(entry.line, side),
});

export const entriesForAccount = (entries: readonly LedgerEntry[], accountId: string): LedgerEntry[] =>
  entries.filter((e) => e.line.accountId === accountId);

export const contributionsForAccount = (
  entries: readonly LedgerEntry[],
  account: Account,
  side: Side,
): Contribution[] => entriesForAccount(entries, account.id).map((e) => contributionOf(e, side));

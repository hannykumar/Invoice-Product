/**
 * Issue #4 [E04] — balances are derived, never stored.
 *
 * "Account and party balances reproduce from journal lines" is an acceptance criterion, so there
 * is no balance column anywhere. Every figure in this file is a fold over journal lines, which is
 * what makes a report drillable down to the entries that produced it (issue #35).
 */
import { compareDates, money, subtract, sum, type IsoDate, type Money } from '@invoice/kernel';
import type { AccountId, CompanyId, PartyId } from '@invoice/kernel';
import { normalSide, type Account, type Side } from './domain/account.ts';
import type { Voucher } from './domain/voucher.ts';
import type { UnitOfWork } from './ports.ts';

export interface DateRange {
  readonly from?: IsoDate;
  readonly to?: IsoDate;
}

export interface Balance {
  readonly totalDebit: Money;
  readonly totalCredit: Money;
  /** Positive on the account's normal side, so a report never shows a negative for normal state. */
  readonly balance: Money;
  readonly side: Side;
}

const inRange = (date: IsoDate, range: DateRange): boolean =>
  (range.from === undefined || compareDates(date, range.from) >= 0) &&
  (range.to === undefined || compareDates(date, range.to) <= 0);

/**
 * Entries that count towards a balance.
 *
 * A reversed entry's own lines are kept, and its reversal's lines cancel them. Dropping the
 * original would count the reversal twice; this is a mistake that is easy to make and hard to
 * see, so it is stated here once.
 */
const counts = (v: Voucher): boolean => v.state !== 'DRAFT';

export const linesOf = (vouchers: readonly Voucher[], range: DateRange) =>
  vouchers.filter((v) => counts(v) && inRange(v.date, range)).flatMap((v) => v.lines.map((l) => ({ voucher: v, line: l })));

const foldBalance = (
  entries: readonly { line: { debit: Money; credit: Money } }[],
  side: Side,
): Balance => {
  const totalDebit = sum(entries.map((e) => e.line.debit));
  const totalCredit = sum(entries.map((e) => e.line.credit));
  const signed = side === 'DEBIT' ? subtract(totalDebit, totalCredit) : subtract(totalCredit, totalDebit);
  return { totalDebit, totalCredit, balance: signed, side };
};

export const accountBalance = async (
  uow: UnitOfWork,
  companyId: CompanyId,
  accountId: AccountId,
  range: DateRange = {},
): Promise<Balance> => {
  const account = await uow.accounts.findById(companyId, accountId);
  if (account === null) return { totalDebit: money(0n), totalCredit: money(0n), balance: money(0n), side: 'DEBIT' };
  const vouchers = await uow.vouchers.list(companyId, {});
  const entries = linesOf(vouchers, range).filter((e) => e.line.accountId === accountId);
  return foldBalance(entries, normalSide(account.type));
};

/** What one customer owes you, or what you owe one supplier, straight from the lines. */
export const partyBalance = async (
  uow: UnitOfWork,
  companyId: CompanyId,
  partyId: PartyId,
  range: DateRange = {},
): Promise<Balance> => {
  const vouchers = await uow.vouchers.list(companyId, {});
  const entries = linesOf(vouchers, range).filter((e) => e.line.partyId === partyId);
  // A party account is an asset when they owe you; the debit side is the natural side to show.
  return foldBalance(entries, 'DEBIT');
};

export interface TrialBalanceRow {
  readonly account: Account;
  readonly totalDebit: Money;
  readonly totalCredit: Money;
  readonly balance: Money;
  readonly side: Side;
}

export interface TrialBalance {
  readonly range: DateRange;
  readonly rows: readonly TrialBalanceRow[];
  readonly totalDebit: Money;
  readonly totalCredit: Money;
  /** The whole point of the report: this must be zero, always. */
  readonly difference: Money;
  readonly balanced: boolean;
}

/**
 * The check that both sides of the books match.
 *
 * If this is ever unbalanced, something has written to storage without going through
 * `LedgerService`. Issue #48 makes that a release-blocking invariant.
 */
export const trialBalance = async (
  uow: UnitOfWork,
  companyId: CompanyId,
  range: DateRange = {},
): Promise<TrialBalance> => {
  const accounts = await uow.accounts.listAll(companyId);
  const vouchers = await uow.vouchers.list(companyId, {});
  const entries = linesOf(vouchers, range);
  const rows: TrialBalanceRow[] = [];
  for (const account of accounts) {
    if (account.isGroup) continue;
    const mine = entries.filter((e) => e.line.accountId === account.id);
    if (mine.length === 0) continue;
    const b = foldBalance(mine, normalSide(account.type));
    rows.push({ account, totalDebit: b.totalDebit, totalCredit: b.totalCredit, balance: b.balance, side: b.side });
  }
  const totalDebit = sum(rows.map((r) => r.totalDebit));
  const totalCredit = sum(rows.map((r) => r.totalCredit));
  const difference = subtract(totalDebit, totalCredit);
  return { range, rows, totalDebit, totalCredit, difference, balanced: difference.minor === 0n };
};

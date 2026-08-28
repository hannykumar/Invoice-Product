/**
 * Issue #4 [E04] — the posting rules.
 *
 * "Every posted voucher balances to zero" is the first acceptance criterion of this issue and the
 * first non-negotiable rule of the product. It is checked here, in one place, before anything is
 * written, and it is checked again by the database constraint in the migration.
 */
import {
  add,
  invalid,
  isNegative,
  isZero,
  sum,
  toDecimalString,
  zero,
  type Money,
} from '@invoice/kernel';
import type { Account } from './account.ts';
import type { VoucherType } from './voucher.ts';

export interface PostingLine {
  readonly accountId: string;
  readonly partyId?: string | null;
  readonly debit: Money;
  readonly credit: Money;
  readonly narration?: string | null;
}

export interface BalanceCheck {
  readonly totalDebit: Money;
  readonly totalCredit: Money;
  readonly difference: Money;
  readonly balanced: boolean;
}

export const checkBalance = (lines: readonly PostingLine[]): BalanceCheck => {
  const totalDebit = sum(lines.map((l) => l.debit));
  const totalCredit = sum(lines.map((l) => l.credit));
  const difference = add(totalDebit, { currency: totalCredit.currency, minor: -totalCredit.minor });
  return { totalDebit, totalCredit, difference, balanced: isZero(difference) };
};

/**
 * Validates the shape of a posting. Everything here is a refusal to write, never a correction:
 * the ledger does not repair an unbalanced voucher by inventing a line.
 */
export const validatePosting = (
  type: VoucherType,
  lines: readonly PostingLine[],
  accountsById: ReadonlyMap<string, Account>,
  companyId: string,
): BalanceCheck => {
  if (lines.length < 2) {
    throw invalid('LEDGER_TOO_FEW_LINES', 'An entry needs at least two lines, one on each side.');
  }

  lines.forEach((line, index) => {
    const at = `line ${index + 1}`;
    if (isNegative(line.debit) || isNegative(line.credit)) {
      throw invalid(
        'LEDGER_NEGATIVE_AMOUNT',
        `${at}: an amount cannot be negative. Put the value on the other side instead.`,
      );
    }
    const hasDebit = !isZero(line.debit);
    const hasCredit = !isZero(line.credit);
    if (hasDebit && hasCredit) {
      throw invalid('LEDGER_BOTH_SIDES', `${at}: one line is either a debit or a credit, never both.`);
    }
    if (!hasDebit && !hasCredit) {
      throw invalid('LEDGER_EMPTY_LINE', `${at}: an entry line cannot be for zero.`);
    }
    const account = accountsById.get(line.accountId);
    if (account === undefined) {
      throw invalid('LEDGER_UNKNOWN_ACCOUNT', `${at}: this account does not exist in this business.`);
    }
    if (account.companyId !== companyId) {
      // Reached only if a caller hands us an account it loaded for another company.
      throw invalid('LEDGER_CROSS_COMPANY_ACCOUNT', `${at}: this account belongs to a different business.`);
    }
    if (account.isGroup) {
      throw invalid(
        'LEDGER_GROUP_ACCOUNT',
        `${at}: "${account.name}" is a heading that holds other accounts, so nothing can be posted to it directly.`,
      );
    }
    if (!account.active) {
      throw invalid('LEDGER_INACTIVE_ACCOUNT', `${at}: "${account.name}" is closed and cannot be used.`);
    }
    if (account.partyId !== null && (line.partyId ?? null) !== account.partyId) {
      throw invalid(
        'LEDGER_PARTY_MISMATCH',
        `${at}: "${account.name}" belongs to one customer or supplier, and the line names a different one.`,
      );
    }
  });

  const currencies = new Set(lines.flatMap((l) => [l.debit.currency, l.credit.currency]));
  if (currencies.size > 1) {
    throw invalid('LEDGER_MIXED_CURRENCY', 'One entry cannot mix currencies. This product is rupee-only.');
  }

  const check = checkBalance(lines);
  if (!check.balanced) {
    throw invalid(
      'LEDGER_UNBALANCED',
      `The two sides do not match. One side is ${toDecimalString(check.totalDebit)} and the other is ${toDecimalString(
        check.totalCredit,
      )}, a difference of ${toDecimalString(check.difference)}.`,
      { details: { difference: toDecimalString(check.difference) } },
    );
  }
  if (isZero(check.totalDebit)) {
    throw invalid('LEDGER_ZERO_VOUCHER', 'An entry for zero has no effect and is not recorded.');
  }

  if (type === 'REVERSAL') {
    // A reversal is produced by the engine, never hand-built by a caller.
    throw invalid('LEDGER_REVERSAL_NOT_DIRECT', 'A reversal is created by undoing an entry, not by posting one.');
  }

  return check;
};

/** Mirrors every line, which is the only way a final entry is ever undone. */
export const mirrorLines = <T extends PostingLine>(lines: readonly T[]): PostingLine[] =>
  lines.map((l) => ({
    accountId: l.accountId,
    partyId: l.partyId ?? null,
    debit: l.credit,
    credit: l.debit,
    narration: l.narration ?? null,
  }));

export const zeroMoney = (): Money => zero('INR');

/**
 * Issue #36 [E36] — what the business already had on the day it started here.
 *
 * This is the single most dangerous screen in the product. Everything after it is checked by
 * double entry; the opening balances are where a wrong number enters the books without anything
 * to contradict it. So the rule here is stricter than anywhere else: **a difference is never
 * absorbed silently.** It is shown, named, and either corrected or explicitly accepted by a person
 * who has to write down why.
 */
import { formatINR, isZero, subtract, sum, zero, type Money } from '@invoice/kernel';
import type { OpeningBalanceEntry, StepProblem } from './model.ts';

export interface OpeningBalanceCheck {
  readonly totalDebit: Money;
  readonly totalCredit: Money;
  readonly difference: Money;
  readonly balanced: boolean;
  readonly problems: readonly StepProblem[];
}

const problem = (code: string, en: string, hi: string, field?: string): StepProblem => ({
  code,
  message: { 'en-IN': en, 'hi-IN': hi },
  ...(field === undefined ? {} : { field }),
});

/**
 * Checks the opening figures.
 *
 * The wording matters as much as the arithmetic: "the two sides do not match by ₹4,500" is
 * something a shopkeeper can go and find. "Trial balance mismatch" is not.
 */
export const checkOpeningBalances = (entries: readonly OpeningBalanceEntry[]): OpeningBalanceCheck => {
  const problems: StepProblem[] = [];
  const nil = zero('INR');

  entries.forEach((entry, index) => {
    const where = entry.label.trim() === '' ? `row ${index + 1}` : entry.label;
    if (entry.debit.minor < 0n || entry.credit.minor < 0n) {
      problems.push(
        problem(
          'OPENING_NEGATIVE',
          `${where}: an amount cannot be less than zero. Put it on the other side instead.`,
          `${where}: rakam shoonya se kam nahin ho sakti. Use doosri taraf likhein.`,
          entry.accountCode,
        ),
      );
    }
    if (!isZero(entry.debit) && !isZero(entry.credit)) {
      problems.push(
        problem(
          'OPENING_BOTH_SIDES',
          `${where}: put the amount on one side only.`,
          `${where}: rakam sirf ek taraf likhein.`,
          entry.accountCode,
        ),
      );
    }
    if (entry.accountCode === undefined && entry.party === undefined) {
      problems.push(
        problem(
          'OPENING_NO_TARGET',
          `${where}: say which account this belongs to, or which customer or supplier it is for.`,
          `${where}: batayein yeh kis khaate ka hai, ya kis customer ya supplier ka hai.`,
        ),
      );
    }
    if (isZero(entry.debit) && isZero(entry.credit)) {
      problems.push(
        problem(
          'OPENING_EMPTY',
          `${where}: this row has no amount. Remove it or fill it in.`,
          `${where}: is row mein rakam nahin hai. Ise hatayein ya bharein.`,
          entry.accountCode,
        ),
      );
    }
  });

  const totalDebit = sum(entries.map((e) => e.debit));
  const totalCredit = sum(entries.map((e) => e.credit));
  const difference = subtract(totalDebit, totalCredit);
  const balanced = isZero(difference);

  if (!balanced && entries.length > 0) {
    const short = difference.minor > 0n;
    const magnitude = { currency: difference.currency, minor: short ? difference.minor : -difference.minor };
    problems.push(
      problem(
        'OPENING_UNBALANCED',
        `The two sides do not match. What you own is ${formatINR(magnitude)} ${short ? 'more than' : 'less than'} what you owe plus your own money in the business. Find the missing entry, or record the difference and say why.`,
        `Dono taraf barabar nahin hain. Aapka apna ${formatINR(magnitude)} ${short ? 'zyada' : 'kam'} nikal raha hai. Chhooti hui entry dhoondein, ya antar darj karke kaaran likhein.`,
      ),
    );
  }

  if (entries.length === 0) {
    // Not an error. A brand-new business genuinely starts with nothing.
    return { totalDebit: nil, totalCredit: nil, difference: nil, balanced: true, problems: [] };
  }

  return { totalDebit, totalCredit, difference, balanced, problems };
};

/**
 * Adds the balancing line for a difference a person has decided to accept.
 *
 * Called only when someone has looked at the difference and written down why they are recording it
 * anyway. The line is posted to a visible account with their reason attached, so nobody later has
 * to guess what the number was.
 */
export const withAcceptedDifference = (
  entries: readonly OpeningBalanceEntry[],
  difference: Money,
  reason: string,
): OpeningBalanceEntry[] => {
  if (isZero(difference)) return [...entries];
  const positive = difference.minor > 0n;
  return [
    ...entries,
    {
      accountCode: '3900',
      label: `Opening balance difference — ${reason}`,
      debit: positive ? zero('INR') : { currency: 'INR', minor: -difference.minor },
      credit: positive ? difference : zero('INR'),
    },
  ];
};

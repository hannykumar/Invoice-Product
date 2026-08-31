/**
 * Issue #30 [E30] — proving the return agrees with the books.
 *
 * A return built from the books ought to agree with the books, and mostly it does. It stops
 * agreeing when a sale was posted to the ledger but never made it into the documents the return
 * reads — a journal entry typed straight into the output-tax account, a bill posted under a
 * different branch, a cancellation that reversed the voucher but left the document behind.
 *
 * So the two are compared head by head and the difference is reported rather than absorbed. The
 * comparison is deliberately blunt: totals from the return against movement in the output-tax
 * accounts for the same period. A blunt check that a shopkeeper can understand and that fires
 * exactly when something is wrong is worth more than a clever one nobody reads.
 *
 * Where the two disagree the finding names both figures and the documents behind the return's
 * side, so the search starts somewhere rather than nowhere.
 */
import { formatINR, type Money } from '@invoice/kernel';
import {
  formatTaxPeriod,
  totalTaxOf,
  type Bilingual,
  type ReturnFinding,
  type SourceRef,
  type TaxAmounts,
  type TaxPeriod,
} from './types.ts';

/**
 * What the ledger says was collected in the period, read from the output-tax accounts.
 *
 * Supplied by the caller through `BookTaxPort` rather than read here, because the ledger belongs
 * to another module and the return has no business reaching into it.
 */
export interface BookTaxTotals {
  readonly period: TaxPeriod;
  readonly cgst: Money;
  readonly sgst: Money;
  readonly igst: Money;
  readonly cess: Money;
  /** Every voucher that moved an output-tax account this period, for the drill-down. */
  readonly contributions: readonly SourceRef[];
}

export interface ReconciliationHead {
  readonly head: 'CGST' | 'SGST' | 'IGST' | 'CESS';
  readonly onTheReturn: Money;
  readonly inTheBooks: Money;
  readonly difference: Money;
  readonly agrees: boolean;
}

export interface Reconciliation {
  readonly period: TaxPeriod;
  readonly heads: readonly ReconciliationHead[];
  readonly agrees: boolean;
  readonly sentence: Bilingual;
  readonly findings: readonly ReturnFinding[];
  /** Vouchers that moved a tax account but that no document on the return accounts for. */
  readonly unexplainedVouchers: readonly SourceRef[];
}

/**
 * Rounding on a return is done to the rupee, and the books hold paise, so a difference smaller
 * than a rupee per head is arithmetic rather than a missing sale.
 */
const TOLERANCE_PAISE = 100n;

const difference = (a: Money, b: Money): Money => ({ currency: 'INR', minor: a.minor - b.minor });

const headOf = (
  head: ReconciliationHead['head'],
  onTheReturn: Money,
  inTheBooks: Money,
): ReconciliationHead => {
  const gap = difference(onTheReturn, inTheBooks);
  return {
    head,
    onTheReturn,
    inTheBooks,
    difference: gap,
    agrees: (gap.minor < 0n ? -gap.minor : gap.minor) <= TOLERANCE_PAISE,
  };
};

const HEAD_WORDS: Readonly<Record<ReconciliationHead['head'], string>> = {
  CGST: 'the central share of GST',
  SGST: 'the state share of GST',
  IGST: 'GST on sales to other states',
  CESS: 'the extra charge on some goods',
};

export interface ReconcileInput {
  readonly period: TaxPeriod;
  /** The return's own totals, across every table. */
  readonly returnTotals: TaxAmounts;
  readonly books: BookTaxTotals;
  /** The documents the return was built from, so a voucher with no document can be spotted. */
  readonly returnSources: readonly SourceRef[];
  /**
   * Documents that are in the books but could not be placed on the return yet.
   *
   * Passed in so the difference can be explained by the real cause. A return that is short by
   * exactly one unanswered bill is not a missing journal entry, and telling a shopkeeper to go
   * looking for one would send them hunting for something that is not there.
   */
  readonly unresolvedSources?: readonly SourceRef[];
}

/**
 * Compares the return with the books and says, in one sentence, whether they agree.
 *
 * The difference is always stated as "the return minus the books", so a positive number always
 * means the return says more than the ledger does. A preparer should never have to work out which
 * way round a difference points.
 */
export const reconcile = (input: ReconcileInput): Reconciliation => {
  const unresolvedCount = input.unresolvedSources?.length ?? 0;
  const heads: ReconciliationHead[] = [
    headOf('CGST', input.returnTotals.cgst, input.books.cgst),
    headOf('SGST', input.returnTotals.sgst, input.books.sgst),
    headOf('IGST', input.returnTotals.igst, input.books.igst),
    headOf('CESS', input.returnTotals.cess, input.books.cess),
  ];

  const onReturn = new Set(
    [...input.returnSources, ...(input.unresolvedSources ?? [])]
      .map((source) => source.voucherId)
      .filter((id): id is string => id !== null),
  );
  const unexplained = input.books.contributions.filter(
    (contribution) => contribution.voucherId !== null && !onReturn.has(contribution.voucherId),
  );

  const findings: ReturnFinding[] = heads
    .filter((head) => !head.agrees)
    .map((head) => ({
      code: 'GSTR_BOOKS_DISAGREE',
      severity: 'BLOCKING' as const,
      origin: 'RECONCILIATION' as const,
      message: {
        'en-IN': `For ${HEAD_WORDS[head.head]}, the return says ${formatINR(head.onTheReturn)} but your books say ${formatINR(head.inTheBooks)} — a difference of ${formatINR(absolute(head.difference))}.`,
        'hi-IN': `${HEAD_WORDS[head.head]} par return ${formatINR(head.onTheReturn)} keh raha hai aur books ${formatINR(head.inTheBooks)} — ${formatINR(absolute(head.difference))} ka antar.`,
      },
      whatToDo: {
        'en-IN':
          unresolvedCount > 0
            ? `${unresolvedCount === 1 ? 'One document is' : `${unresolvedCount} documents are`} in your books but still waiting on a decision, so ${unresolvedCount === 1 ? 'it is' : 'they are'} not on the return yet. Answer the questions on the exceptions list first; the difference will usually close by itself.`
            : head.difference.minor > 0n
            ? 'The return has more tax on it than the books do. Usually a bill was cancelled or reversed in the books without the bill itself being cancelled. Open the bills on this part of the return and find the one the ledger no longer carries.'
            : 'The books have more tax in them than the return does. Usually a sale was entered straight into the accounts as a journal rather than as a bill, so the return never saw it. The list of vouchers below shows which ones the return does not account for.',
        'hi-IN':
          unresolvedCount > 0
            ? `${unresolvedCount} document books me hain par un par faisla baaki hai, isliye woh abhi return me nahi aaye. Pehle exceptions list ke sawal ka jawab dijiye; antar aksar apne aap mit jayega.`
            : head.difference.minor > 0n
            ? 'Return me books se zyada tax hai. Aksar bill books me reverse ho gaya hota hai par bill khud cancel nahi hua. Is hisse ke bill kholkar wahi dhoondhiye.'
            : 'Books me return se zyada tax hai. Aksar bikri seedhe journal se daal di jaati hai, bill nahi banta, isliye return me nahi aati. Neeche ki voucher list wahi dikhati hai.',
      },
    }));

  if (unexplained.length > 0 && findings.length === 0) {
    // The totals agree but a voucher is unaccounted for: two errors that cancel out, or a
    // reclassification. Worth saying, not worth blocking.
    findings.push({
      code: 'GSTR_VOUCHER_NOT_ON_RETURN',
      severity: 'WARNING',
      origin: 'RECONCILIATION',
      message: {
        'en-IN': `${unexplained.length === 1 ? 'One entry' : `${unexplained.length} entries`} in your books touched a GST account this month without belonging to any bill on the return, even though the totals happen to agree.`,
        'hi-IN': `Books me ${unexplained.length === 1 ? 'ek entry' : `${unexplained.length} entry`} ne is mahine GST account ko chhua par return ke kisi bill se judi nahi hai, halanki total mil rahe hain.`,
      },
      whatToDo: {
        'en-IN': 'Have a look at those entries before approving. Totals that agree by accident is a thing that happens.',
        'hi-IN': 'Approve karne se pehle un entries ko dekh lijiye. Total sanyog se bhi mil sakte hain.',
      },
    });
  }

  const agrees = heads.every((head) => head.agrees);
  const returnTax = totalTaxOf(input.returnTotals);
  const bookTax: Money = {
    currency: 'INR',
    minor: input.books.cgst.minor + input.books.sgst.minor + input.books.igst.minor + input.books.cess.minor,
  };

  return {
    period: input.period,
    heads,
    agrees,
    findings,
    unexplainedVouchers: unexplained,
    sentence: agrees
      ? {
          'en-IN': `${formatTaxPeriod(input.period)}: the return and your books both show ${formatINR(returnTax)} of GST on sales.`,
          'hi-IN': `${formatTaxPeriod(input.period)}: return aur books dono bikri par ${formatINR(returnTax)} GST dikha rahe hain.`,
        }
      : {
          'en-IN': `${formatTaxPeriod(input.period)}: the return shows ${formatINR(returnTax)} of GST on sales and your books show ${formatINR(bookTax)}. They have to agree before this can be filed.`,
          'hi-IN': `${formatTaxPeriod(input.period)}: return bikri par ${formatINR(returnTax)} GST dikha raha hai aur books ${formatINR(bookTax)}. File karne se pehle dono ka milna zaroori hai.`,
        },
  };
};

const absolute = (amount: Money): Money => ({ currency: 'INR', minor: amount.minor < 0n ? -amount.minor : amount.minor });

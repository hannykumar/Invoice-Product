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

const HEAD_WORDS_HI: Readonly<Record<ReconciliationHead['head'], string>> = {
  CGST: 'GST के केंद्रीय हिस्से',
  SGST: 'GST के राज्य हिस्से',
  IGST: 'दूसरे राज्यों की बिक्री पर GST',
  CESS: 'कुछ सामान पर अतिरिक्त चार्ज',
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
        'hi-IN': `${HEAD_WORDS_HI[head.head]} पर रिटर्न ${formatINR(head.onTheReturn)} कह रहा है और बुक्स ${formatINR(head.inTheBooks)} — ${formatINR(absolute(head.difference))} का अंतर.`,
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
            ? `${unresolvedCount} दस्तावेज़ बुक्स में हैं पर उन पर फ़ैसला बाक़ी है, इसलिए वे अभी रिटर्न में नहीं आए. पहले exceptions सूची के सवालों का जवाब दीजिए; अंतर अक्सर अपने आप मिट जाएगा.`
            : head.difference.minor > 0n
            ? 'रिटर्न में बुक्स से ज़्यादा टैक्स है. अक्सर बिल बुक्स में रिवर्स हो गया होता है पर बिल ख़ुद कैंसल नहीं हुआ. इस हिस्से के बिल खोलकर वही ढूँढिए.'
            : 'बुक्स में रिटर्न से ज़्यादा टैक्स है. अक्सर बिक्री सीधे जर्नल से डाल दी जाती है, बिल नहीं बनता, इसलिए रिटर्न में नहीं आती. नीचे की वाउचर सूची वही दिखाती है.',
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
        'hi-IN': `बुक्स में ${unexplained.length === 1 ? 'एक एंट्री' : `${unexplained.length} एंट्रियाँ`} ने इस महीने GST अकाउंट को छुआ पर रिटर्न के किसी बिल से जुड़ी नहीं है, हालाँकि टोटल मिल रहे हैं.`,
      },
      whatToDo: {
        'en-IN': 'Have a look at those entries before approving. Totals that agree by accident is a thing that happens.',
        'hi-IN': 'अप्रूव करने से पहले उन एंट्रियों को देख लीजिए. टोटल संयोग से भी मिल सकते हैं.',
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
          'hi-IN': `${formatTaxPeriod(input.period)}: रिटर्न और बुक्स दोनों बिक्री पर ${formatINR(returnTax)} GST दिखा रहे हैं.`,
        }
      : {
          'en-IN': `${formatTaxPeriod(input.period)}: the return shows ${formatINR(returnTax)} of GST on sales and your books show ${formatINR(bookTax)}. They have to agree before this can be filed.`,
          'hi-IN': `${formatTaxPeriod(input.period)}: रिटर्न बिक्री पर ${formatINR(returnTax)} GST दिखा रहा है और बुक्स ${formatINR(bookTax)}. फ़ाइल करने से पहले दोनों का मिलना ज़रूरी है.`,
        },
  };
};

const absolute = (amount: Money): Money => ({ currency: 'INR', minor: amount.minor < 0n ? -amount.minor : amount.minor });

// ---------------------------------------------------------------------------- purchases (issue #249)

export interface PurchaseReconciliationHead {
  readonly head: 'CGST' | 'SGST' | 'IGST' | 'CESS';
  /** Credit on the return, after credit given back (form box 4C). */
  readonly onTheReturn: Money;
  /** Input GST the ledger moved this month, after purchase returns. */
  readonly inTheBooks: Money;
  /** The part of the gap the purchase check accounts for (earlier months' bills, held-back bills). */
  readonly explained: Money;
  /** What is left once that is taken away. Zero when the two sides agree. */
  readonly unexplained: Money;
  readonly agrees: boolean;
}

export interface PurchaseReconciliation {
  readonly period: TaxPeriod;
  readonly heads: readonly PurchaseReconciliationHead[];
  /** Every head's unexplained gap is within a rupee. */
  readonly agrees: boolean;
  readonly onTheReturn: Money;
  readonly inTheBooks: Money;
  readonly sentence: Bilingual;
  readonly findings: readonly ReturnFinding[];
}

export interface ReconcilePurchasesInput {
  readonly period: TaxPeriod;
  /** Box 4C of the return, head by head. */
  readonly netCredit: TaxAmounts;
  /** Input-tax movement in the ledger for the month. */
  readonly books: BookTaxTotals;
  readonly explanation?: { readonly fromEarlierMonths: TaxAmounts; readonly notClaimedThisMonth: TaxAmounts };
}

const HEAD_WORDS_IN: Readonly<Record<PurchaseReconciliationHead['head'], string>> = {
  CGST: 'the central share of GST credit',
  SGST: 'the state share of GST credit',
  IGST: 'IGST credit',
  CESS: 'credit of the extra charge on some goods',
};

const HEAD_WORDS_IN_HI: Readonly<Record<PurchaseReconciliationHead['head'], string>> = {
  CGST: 'GST क्रेडिट का केंद्रीय हिस्सा',
  SGST: 'GST क्रेडिट का राज्य हिस्सा',
  IGST: 'IGST क्रेडिट',
  CESS: 'कुछ सामान के अतिरिक्त चार्ज का क्रेडिट',
};

/**
 * Issue #249 — the credit side: the return's credit against the input GST in the books.
 *
 * Sales has had this line since #30; purchases never had it, which is how a return claiming the full
 * credit on goods already sent back went unnoticed while the ledger had taken the credit down.
 *
 * The two may differ for good reasons, and the purchase check knows each one: a bill from an earlier
 * month settled now (on the return, not in this month's books), and a bill of this month still
 * waiting on its supplier (in the books, not on the return). Those are taken out first. What remains
 * is a real disagreement. A return claiming more than the books can support is an over-claim and
 * blocks approval; a return claiming less is credit left behind, and is a warning.
 */
export const reconcilePurchases = (input: ReconcilePurchasesInput): PurchaseReconciliation => {
  const zero = (): TaxAmounts => ({
    taxableValue: { currency: 'INR', minor: 0n }, cgst: { currency: 'INR', minor: 0n },
    sgst: { currency: 'INR', minor: 0n }, igst: { currency: 'INR', minor: 0n }, cess: { currency: 'INR', minor: 0n },
  });
  const earlier = input.explanation?.fromEarlierMonths ?? zero();
  const waiting = input.explanation?.notClaimedThisMonth ?? zero();
  const pick = (amounts: TaxAmounts | BookTaxTotals, head: PurchaseReconciliationHead['head']): Money =>
    head === 'CGST' ? amounts.cgst : head === 'SGST' ? amounts.sgst : head === 'IGST' ? amounts.igst : amounts.cess;
  const heads = (['CGST', 'SGST', 'IGST', 'CESS'] as const).map((head): PurchaseReconciliationHead => {
    const onTheReturn = pick(input.netCredit, head);
    const inTheBooks = pick(input.books, head);
    const explained: Money = { currency: 'INR', minor: pick(earlier, head).minor - pick(waiting, head).minor };
    const unexplained: Money = { currency: 'INR', minor: onTheReturn.minor - inTheBooks.minor - explained.minor };
    return {
      head, onTheReturn, inTheBooks, explained, unexplained,
      agrees: (unexplained.minor < 0n ? -unexplained.minor : unexplained.minor) <= TOLERANCE_PAISE,
    };
  });
  const total = (pickOne: (head: PurchaseReconciliationHead) => Money): Money =>
    ({ currency: 'INR', minor: heads.reduce((sum, head) => sum + pickOne(head).minor, 0n) });
  const onTheReturn = total((head) => head.onTheReturn);
  const inTheBooks = total((head) => head.inTheBooks);
  const explained = total((head) => head.explained);
  const agrees = heads.every((head) => head.agrees);

  const findings: ReturnFinding[] = heads.filter((head) => !head.agrees).map((head) => {
    const over = head.unexplained.minor > 0n;
    return {
      code: over ? 'GSTR_CREDIT_ABOVE_BOOKS' : 'GSTR_CREDIT_BELOW_BOOKS',
      severity: over ? 'BLOCKING' as const : 'WARNING' as const,
      origin: 'RECONCILIATION' as const,
      message: {
        'en-IN': `For ${HEAD_WORDS_IN[head.head]}, the return claims ${formatINR(head.onTheReturn)} but your books show ${formatINR(head.inTheBooks)}${head.explained.minor === 0n ? '' : ` (${formatINR(absolute(head.explained))} of the gap is explained by the purchase check)`} — ${formatINR(absolute(head.unexplained))} ${over ? 'more' : 'less'} than the books support.`,
        'hi-IN': `${HEAD_WORDS_IN_HI[head.head]} पर रिटर्न ${formatINR(head.onTheReturn)} ले रहा है पर बुक्स ${formatINR(head.inTheBooks)} दिखाती हैं — बुक्स से ${formatINR(absolute(head.unexplained))} ${over ? 'ज़्यादा' : 'कम'}.`,
      },
      whatToDo: over
        ? {
          'en-IN': 'Claiming more credit than your books hold is an over-claim, and it comes back with interest. Usually a purchase was reversed or goods were sent back without the purchase check seeing it. Open the purchase check for this month and find the bill.',
          'hi-IN': 'बुक्स से ज़्यादा क्रेडिट लेना ओवर-क्लेम है, जो ब्याज के साथ वापस देना पड़ता है. अक्सर कोई ख़रीद रिवर्स हुई या माल वापस गया और ख़रीद जाँच ने नहीं देखा. इस महीने की ख़रीद जाँच खोलकर वह बिल ढूँढिए.',
        }
        : {
          'en-IN': 'Your books hold more credit than the return claims. Usually input GST was entered as a journal rather than as a purchase bill, so the purchase check never saw it.',
          'hi-IN': 'बुक्स में रिटर्न से ज़्यादा क्रेडिट है. अक्सर इनपुट GST बिल की जगह जर्नल से डाला गया, इसलिए ख़रीद जाँच ने उसे नहीं देखा.',
        },
    };
  });

  return {
    period: input.period,
    heads,
    agrees,
    onTheReturn,
    inTheBooks,
    findings,
    sentence: agrees
      ? explained.minor === 0n
        ? {
          'en-IN': `${formatTaxPeriod(input.period)}: the return and your books both show ${formatINR(onTheReturn)} of GST credit on purchases.`,
          'hi-IN': `${formatTaxPeriod(input.period)}: रिटर्न और बुक्स दोनों ख़रीद पर ${formatINR(onTheReturn)} GST क्रेडिट दिखा रहे हैं.`,
        }
        : {
          'en-IN': `${formatTaxPeriod(input.period)}: the return claims ${formatINR(onTheReturn)} of GST credit on purchases and your books show ${formatINR(inTheBooks)}. The ${formatINR(absolute(explained))} between them is ${explained.minor < 0n ? 'credit on this month\'s bills still waiting on the purchase check' : 'credit on earlier months\' bills settled this month'}, so the two agree.`,
          'hi-IN': `${formatTaxPeriod(input.period)}: रिटर्न ख़रीद पर ${formatINR(onTheReturn)} GST क्रेडिट ले रहा है और बुक्स ${formatINR(inTheBooks)} दिखाती हैं. बीच का ${formatINR(absolute(explained))} ख़रीद जाँच में रुका या पिछले महीने का क्रेडिट है, इसलिए दोनों मिलते हैं.`,
        }
      : {
        'en-IN': `${formatTaxPeriod(input.period)}: the return claims ${formatINR(onTheReturn)} of GST credit on purchases and your books show ${formatINR(inTheBooks)}, and the purchase check does not account for the difference.`,
        'hi-IN': `${formatTaxPeriod(input.period)}: रिटर्न ख़रीद पर ${formatINR(onTheReturn)} GST क्रेडिट ले रहा है और बुक्स ${formatINR(inTheBooks)} दिखाती हैं, और ख़रीद जाँच इस अंतर को नहीं समझाती.`,
      },
  };
};

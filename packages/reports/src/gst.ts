/**
 * Issue #35 [E35] — the GST a business collected and the GST it already paid.
 *
 * This is a summary of what is in the books, not a return and not advice. It adds up the output
 * and input tax accounts for the period and shows the difference. It deliberately does **not**
 * apply the set-off order between IGST, CGST and SGST: that order is a rule of law, it belongs to
 * the return-filing issues (#29, #30) and to the rules engine that carries its source and its
 * effective date. Guessing it here to make a tidier number would be exactly the invention rule 4
 * forbids.
 */
import { formatINR, subtract, type Money } from '@invoice/kernel';
import type { SystemAccountRole } from '@invoice/ledger';
import { addFigures, emptyFigure, figureOf, type Bilingual, type Figure } from './model.ts';
import { contributionsForAccount, type LoadedBooks } from './source.ts';

export interface TaxHead {
  readonly label: Bilingual;
  readonly roles: readonly SystemAccountRole[];
  readonly collected: Figure;
  readonly alreadyPaid: Figure;
}

export interface GstSummaryBody {
  readonly heads: readonly TaxHead[];
  readonly totalCollected: Figure;
  readonly totalAlreadyPaid: Figure;
  /** Collected less already paid. What it turns into on a return is decided when the return is prepared. */
  readonly difference: Money;
  readonly sentence: Bilingual;
  readonly caution: Bilingual;
}

const HEADS: readonly { label: Bilingual; output: SystemAccountRole; input: SystemAccountRole }[] = [
  {
    label: { 'en-IN': 'Central GST', 'hi-IN': 'Central GST' },
    output: 'OUTPUT_CGST',
    input: 'INPUT_CGST',
  },
  {
    label: { 'en-IN': 'State or union territory GST', 'hi-IN': 'State ya union territory GST' },
    output: 'OUTPUT_SGST',
    input: 'INPUT_SGST',
  },
  {
    label: { 'en-IN': 'GST on sales outside your state', 'hi-IN': 'Doosre state ki bikri par GST' },
    output: 'OUTPUT_IGST',
    input: 'INPUT_IGST',
  },
  {
    label: { 'en-IN': 'Extra charge on some goods', 'hi-IN': 'Kuch cheezon par extra charge' },
    output: 'OUTPUT_CESS',
    input: 'INPUT_CESS',
  },
];

const movementFor = (books: LoadedBooks, role: SystemAccountRole): Figure => {
  const accounts = books.accounts.filter((a) => a.systemRole === role && a.isGroup === false);
  if (accounts.length === 0) return emptyFigure();
  return addFigures(
    accounts.map((account) => figureOf(contributionsForAccount(books.movement, account, account.type === 'ASSET' ? 'DEBIT' : 'CREDIT'))),
  );
};

export const gstSummaryBody = (books: LoadedBooks): GstSummaryBody => {
  const heads: TaxHead[] = HEADS.map((head) => ({
    label: head.label,
    roles: [head.output, head.input],
    collected: movementFor(books, head.output),
    alreadyPaid: movementFor(books, head.input),
  }));

  const totalCollected = addFigures(heads.map((h) => h.collected));
  const totalAlreadyPaid = addFigures(heads.map((h) => h.alreadyPaid));
  const difference = subtract(totalCollected.amount, totalAlreadyPaid.amount);

  return {
    heads,
    totalCollected,
    totalAlreadyPaid,
    difference,
    sentence: {
      'en-IN': `You collected ${formatINR(totalCollected.amount)} of GST on your bills and had already paid ${formatINR(totalAlreadyPaid.amount)} on your purchases.`,
      'hi-IN': `Aapne bill par ${formatINR(totalCollected.amount)} GST liya, aur kharid par ${formatINR(totalAlreadyPaid.amount)} pehle hi de chuke the.`,
    },
    caution: {
      'en-IN':
        'This is what your books show. How much you actually pay is worked out when the return is prepared. The order in which these are adjusted is fixed by the rules.',
      'hi-IN':
        'Yeh aapki books ka hisaab hai. Asli bharna kitna hai, yeh return banate waqt tay hota hai. Adjust karne ka kram niyam se bandha hua hai.',
    },
  };
};

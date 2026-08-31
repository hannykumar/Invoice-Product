/**
 * Issue #30 [E30] — the checks that run before a return may be approved.
 *
 * These are not the classifier's questions. The classifier asks what it needs in order to place a
 * document at all; these are the checks a preparer would make afterwards, looking at the finished
 * tables: does the tax on this bill match its rate, are two bills sharing a number, does a credit
 * note point at a bill that was never reported, is a GST number the right shape.
 *
 * Everything here produces a `ReturnFinding` rather than a change. The product never quietly
 * corrects a bill in the course of preparing a return: a bill that is wrong is wrong in the books
 * too, and fixing it in the return alone would hide the problem exactly where it matters most.
 */
import { formatINR } from '@invoice/kernel';
import { validateGstin } from '../../masters/src/validation.ts';
import { sourceRefOf } from './classify.ts';
import { taxPeriodOf } from './types.ts';
import {
  type OutwardDocument,
  type ReturnFinding,
  type SupplyTreatment,
  type TaxPeriod,
} from './types.ts';

/**
 * How far the tax on a line may sit from the rate times the value before it is worth mentioning.
 *
 * One rupee, not zero. Rounding on a multi-line bill legitimately moves a few paise, and a check
 * that fires on every bill is a check a preparer learns to click past.
 */
const TAX_TOLERANCE_PAISE = 100n;

const NO_TAX: readonly SupplyTreatment[] = ['NIL_RATED', 'EXEMPT', 'NON_GST', 'EXPORT_WITHOUT_TAX', 'SEZ_WITHOUT_TAX'];

export interface ValidateInput {
  readonly period: TaxPeriod;
  readonly supplierGstin: string;
  readonly supplierStateCode: string;
  readonly documents: readonly OutwardDocument[];
}

const problem = (
  code: string,
  severity: ReturnFinding['severity'],
  english: string,
  hindi: string,
  fixEnglish: string,
  fixHindi: string,
  document?: OutwardDocument,
): ReturnFinding => ({
  code,
  severity,
  message: { 'en-IN': english, 'hi-IN': hindi },
  whatToDo: { 'en-IN': fixEnglish, 'hi-IN': fixHindi },
  ...(document === undefined ? {} : { source: sourceRefOf(document) }),
  origin: 'VALIDATION',
});

/**
 * The tax split has to match the place of supply.
 *
 * A sale inside the state carries CGST and SGST; a sale across a state line carries IGST. Getting
 * this wrong is the mistake that costs an MSME the most, because the buyer cannot claim the credit
 * and the seller has to pay the right tax again before getting the wrong one back.
 */
const checkSplit = (document: OutwardDocument, supplierStateCode: string): ReturnFinding[] => {
  if (document.placeOfSupplyStateCode === null) return [];
  if (NO_TAX.includes(document.treatment)) return [];
  const interState = document.placeOfSupplyStateCode !== supplierStateCode;
  const totals = document.lines.reduce(
    (acc, line) => ({
      igst: acc.igst + line.amounts.igst.minor,
      local: acc.local + line.amounts.cgst.minor + line.amounts.sgst.minor,
    }),
    { igst: 0n, local: 0n },
  );

  if (interState && totals.local !== 0n) {
    return [problem(
      'GSTR1_SPLIT_SHOULD_BE_IGST',
      'BLOCKING',
      `Bill ${document.number} goes to another state but carries CGST and SGST. A sale across a state line carries IGST instead.`,
      `Bill ${document.number} doosre state ja raha hai par us par CGST aur SGST laga hai. Doosre state ki bikri par IGST lagta hai.`,
      'Correct the bill. Filing it this way means your buyer cannot claim the credit, and you will end up paying the right tax twice before getting the wrong one back.',
      'Bill theek kijiye. Aise file karne par buyer credit nahi le payega, aur aapko sahi tax dobara bharna par sakta hai.',
      document,
    )];
  }
  if (!interState && totals.igst !== 0n) {
    return [problem(
      'GSTR1_SPLIT_SHOULD_BE_LOCAL',
      'BLOCKING',
      `Bill ${document.number} is a sale inside your own state but carries IGST. A local sale carries CGST and SGST.`,
      `Bill ${document.number} aapke apne state ki bikri hai par us par IGST laga hai. Local bikri par CGST aur SGST lagta hai.`,
      'Correct the bill before filing. The two taxes go to different governments and cannot be swapped afterwards.',
      'File karne se pehle bill theek kijiye. Dono tax alag government ko jaate hain aur baad me badle nahi ja sakte.',
      document,
    )];
  }
  return [];
};

/** The tax on a line should be its rate times its taxable value, within a rupee. */
const checkArithmetic = (document: OutwardDocument): ReturnFinding[] => {
  const found: ReturnFinding[] = [];
  for (const line of document.lines) {
    if (line.ratePercentTimes100 === null) continue;
    const expected = (line.amounts.taxableValue.minor * line.ratePercentTimes100) / 10_000n;
    const actual = line.amounts.cgst.minor + line.amounts.sgst.minor + line.amounts.igst.minor;
    const gap = expected > actual ? expected - actual : actual - expected;
    if (gap > TAX_TOLERANCE_PAISE) {
      found.push(problem(
        'GSTR1_TAX_DOES_NOT_MATCH_RATE',
        'WARNING',
        `On bill ${document.number}, "${line.description}" is at ${Number(line.ratePercentTimes100) / 100}% of ${formatINR(line.amounts.taxableValue)}, which is ${formatINR({ currency: 'INR', minor: expected })} of tax, but the bill carries ${formatINR({ currency: 'INR', minor: actual })}.`,
        `Bill ${document.number} par "${line.description}" ${formatINR(line.amounts.taxableValue)} ka ${Number(line.ratePercentTimes100) / 100}% hai, yaani ${formatINR({ currency: 'INR', minor: expected })} tax, par bill par ${formatINR({ currency: 'INR', minor: actual })} hai.`,
        'Open the bill and check the rate and the amount. The return reports what the bill says, so this difference will be filed as it is.',
        'Bill kholkar rate aur amount dekhiye. Return wahi bhejta hai jo bill par hai, isliye yeh antar waise hi file hoga.',
        document,
      ));
    }
  }
  return found;
};

/** A buyer's GST number has to be the right shape, or the government file is rejected outright. */
const checkGstin = (document: OutwardDocument): ReturnFinding[] => {
  if (document.counterpartyGstin === null) return [];
  const result = validateGstin(document.counterpartyGstin, 'counterpartyGstin');
  if (result.ok) return [];
  return [problem(
    'GSTR1_BAD_GSTIN',
    'BLOCKING',
    `The GST number on bill ${document.number} for ${document.partyName} is not valid: ${result.problems[0]?.message ?? 'it is the wrong shape.'}`,
    `Bill ${document.number} par ${document.partyName} ka GST number sahi nahi hai: ${result.problems[0]?.message ?? 'shape galat hai.'}`,
    'Check the number against the customer\'s own bill or the GST portal. The government will reject the whole return over one bad number.',
    'Customer ke bill ya GST portal se number milaiye. Ek galat number par poora return reject ho jata hai.',
    document,
  )];
};

/** The seller's registration must be the one the return is being filed under. */
const checkSupplier = (document: OutwardDocument, supplierGstin: string): ReturnFinding[] =>
  document.supplierGstin === supplierGstin
    ? []
    : [problem(
        'GSTR1_WRONG_SUPPLIER',
        'BLOCKING',
        `Bill ${document.number} was issued under GST number ${document.supplierGstin}, but this return is being filed for ${supplierGstin}.`,
        `Bill ${document.number} GST number ${document.supplierGstin} se bana tha, par yeh return ${supplierGstin} ke liye file ho raha hai.`,
        'Each registration files its own return. Move this bill to the right branch, or prepare the return for the registration that issued it.',
        'Har registration apna return file karta hai. Bill sahi branch me daliye, ya usi registration ka return banaiye.',
        document,
      )];

/** A bill dated outside the month is either mis-dated or belongs to a different return. */
const checkPeriod = (document: OutwardDocument, period: TaxPeriod): ReturnFinding[] =>
  taxPeriodOf(document.documentDate) === period
    ? []
    : [problem(
        'GSTR1_OUTSIDE_PERIOD',
        'BLOCKING',
        `Bill ${document.number} is dated ${document.documentDate}, which is not in the month this return covers.`,
        `Bill ${document.number} ki date ${document.documentDate} hai, jo is return ke mahine me nahi hai.`,
        'Check the date on the bill. If the date is right, it belongs to another month\'s return.',
        'Bill ki date dekhiye. Agar date sahi hai to yeh doosre mahine ke return me jayega.',
        document,
      )];

/** Two documents cannot share a number, and a numbering gap is worth telling a person about. */
const checkNumbers = (documents: readonly OutwardDocument[]): ReturnFinding[] => {
  const byNumber = new Map<string, OutwardDocument[]>();
  for (const document of documents) {
    const key = `${document.kind}|${document.number}`;
    byNumber.set(key, [...(byNumber.get(key) ?? []), document]);
  }
  return [...byNumber.values()]
    .filter((group) => group.length > 1)
    .map((group) => {
      const first = group[0] as OutwardDocument;
      return problem(
        'GSTR1_DUPLICATE_NUMBER',
        'BLOCKING',
        `${group.length} documents share the number ${first.number}.`,
        `${group.length} document ek hi number ${first.number} par hain.`,
        'A bill number has to be unique. The government file will be rejected, and until it is fixed the return cannot say which sale is which.',
        'Bill number alag-alag hone chahiye. Government file reject hogi, aur tab tak return bata nahi payega ki kaunsi bikri kaunsi hai.',
        first,
      );
    });
};

/**
 * A credit note against a bill from an earlier month should say which month that was.
 *
 * Not blocking: the note is still reportable. But the buyer's own credit moves in a different
 * month from the sale, and a preparer who does not know that will not understand the mismatch when
 * the buyer telephones about it.
 */
const checkNoteOrigin = (document: OutwardDocument, period: TaxPeriod): ReturnFinding[] => {
  if (document.originalDocument === undefined) return [];
  const originalPeriod = taxPeriodOf(document.originalDocument.date);
  if (originalPeriod === period) return [];
  return [problem(
    'GSTR1_NOTE_AGAINST_EARLIER_MONTH',
    'INFORMATION',
    `Note ${document.number} adjusts bill ${document.originalDocument.number}, which was from an earlier month.`,
    `Note ${document.number} pichhle mahine ke bill ${document.originalDocument.number} ko theek karta hai.`,
    'Nothing to fix. It is worth knowing because your customer\'s credit will move this month while the sale was in another.',
    'Kuch theek nahi karna. Bas jaan lijiye ki customer ka credit is mahine badlega jabki bikri doosre mahine ki thi.',
    document,
  )];
};

/**
 * Everything worth telling the preparer about the documents in this period.
 *
 * Deliberately returns all of it at once. A preparer who is told about one bad GST number, fixes
 * it, and is then told about a second one has been made to do the work twice.
 */
export const validateDocuments = (input: ValidateInput): readonly ReturnFinding[] => [
  ...input.documents.flatMap((document) => [
    ...checkSupplier(document, input.supplierGstin),
    ...checkPeriod(document, input.period),
    ...checkGstin(document),
    ...checkSplit(document, input.supplierStateCode),
    ...checkArithmetic(document),
    ...checkNoteOrigin(document, input.period),
  ]),
  ...checkNumbers(input.documents),
];

/** The findings that stop an approval, as opposed to the ones a person may read and accept. */
export const blockingOf = (findings: readonly ReturnFinding[]): readonly ReturnFinding[] =>
  findings.filter((finding) => finding.severity === 'BLOCKING');

/** Used by the screen that says "3 things must be decided, 2 are worth a look". */
export const countBySeverity = (findings: readonly ReturnFinding[]): Readonly<Record<ReturnFinding['severity'], number>> => ({
  BLOCKING: findings.filter((f) => f.severity === 'BLOCKING').length,
  WARNING: findings.filter((f) => f.severity === 'WARNING').length,
  INFORMATION: findings.filter((f) => f.severity === 'INFORMATION').length,
});


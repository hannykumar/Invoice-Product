/**
 * Issue #31 [E31] — from "these two papers are the same bill" to "this much credit is safe".
 *
 * The matching in `match.ts` is arithmetic and comparison. This file is where the product makes a
 * claim about money, so it is written to be read by somebody checking whether it is honest.
 *
 * The rule it exists to keep is the second acceptance criterion, and it is stated once here in
 * plain words: **a purchase the portal does not carry is not credit.** It is held back, it is
 * counted, it is shown with the question that would release it, and it can only leave that state
 * because a named person said so, with a reason, on the record.
 *
 * The rest is the same idea applied to the cases that are not simply present or absent.
 *
 *   - **Figures differ.** The credit is held back until somebody accepts it, and if they do, the
 *     amount claimed is the *lower* of the two figures. Claiming more than the supplier reported
 *     is the part that costs money later, so it is not something a person can do by pressing one
 *     button on a screen that had already decided for them.
 *   - **The portal says the credit is not available.** That is the government's own statement
 *     about our purchase. It is never overridden quietly; accepting it is possible and always
 *     leaves the line marked.
 *   - **The supplier amended or withdrew the document.** Held back. An amendment changes the
 *     figures the supplier stands behind, and last month's answer was to a different question.
 *   - **The same bill is in our books twice.** No credit at all, on either copy, whatever anybody
 *     decides. This is the one hard refusal in the file: credit taken twice on one bill is the
 *     mistake that produces a demand notice, and no reason a person could type makes it right.
 *   - **The books already blocked the credit** (section 17(5) — cars, food, and the rest of the
 *     blocked list). There was never a credit here; the tax was part of what the goods cost. The
 *     line says so rather than showing a hole.
 */
import { allocateByWeight, formatINR, type IsoDate, type Money } from '@invoice/kernel';
import { createHash } from 'node:crypto';
import { disagreements, lineKeyOf } from './match.ts';
import { formatClaimDate, hasClaimDeadline, isTimeBarred, lastClaimDateFor } from './deadline.ts';
import type { MatchPair } from './match.ts';
import {
  DECISION_PLAIN,
  DEFAULT_MATCH_POLICY,
  MATCH_STATUS_PLAIN,
  OUTCOME_PLAIN,
  addAmounts,
  emptyAmounts,
  formatTaxPeriod,
  sumAmounts,
  totalTaxOf,
  type Bilingual,
  type BookPurchaseDocument,
  type Gstr3bLinkage,
  type ItcDecision,
  type ItcFinding,
  type ItcFindingCode,
  type ItcMatchPolicy,
  type ItcOutcome,
  type PortalDocument,
  type ReconciliationLine,
  type SourceRef,
  type TaxAmounts,
  type TaxPeriod,
} from './types.ts';

// ---------------------------------------------------------------------------- the creditable part

const zeroMoney: Money = { currency: 'INR', minor: 0n };

/**
 * What our own books say could be claimed on a bill, before the portal is consulted at all.
 *
 * The tax the books already blocked is taken off head by head, in proportion, so the four heads
 * still add back to exactly the claimable total. `allocateByWeight` is the ledger's own splitter,
 * used here for the same reason it is used there: a proportional split done with division loses
 * paise, and this one cannot.
 */
export const creditableFromBooks = (book: BookPurchaseDocument): TaxAmounts => {
  const heads = [book.amounts.cgst.minor, book.amounts.sgst.minor, book.amounts.igst.minor, book.amounts.cess.minor];
  const total = heads.reduce((sum, head) => sum + head, 0n);
  if (total === 0n) return { ...book.amounts, cgst: zeroMoney, sgst: zeroMoney, igst: zeroMoney, cess: zeroMoney };
  const blocked = book.ineligibleItc.minor >= total ? total : book.ineligibleItc.minor;
  if (blocked === 0n) return book.amounts;
  const shares = allocateByWeight({ currency: 'INR', minor: blocked }, heads);
  return {
    taxableValue: book.amounts.taxableValue,
    cgst: { currency: 'INR', minor: book.amounts.cgst.minor - (shares[0] as Money).minor },
    sgst: { currency: 'INR', minor: book.amounts.sgst.minor - (shares[1] as Money).minor },
    igst: { currency: 'INR', minor: book.amounts.igst.minor - (shares[2] as Money).minor },
    cess: { currency: 'INR', minor: book.amounts.cess.minor - (shares[3] as Money).minor },
  };
};

/** Head by head, the smaller of what we recorded and what the supplier reported. */
const lowerOf = (ours: TaxAmounts, theirs: TaxAmounts): TaxAmounts => ({
  taxableValue: { currency: 'INR', minor: ours.taxableValue.minor < theirs.taxableValue.minor ? ours.taxableValue.minor : theirs.taxableValue.minor },
  cgst: { currency: 'INR', minor: ours.cgst.minor < theirs.cgst.minor ? ours.cgst.minor : theirs.cgst.minor },
  sgst: { currency: 'INR', minor: ours.sgst.minor < theirs.sgst.minor ? ours.sgst.minor : theirs.sgst.minor },
  igst: { currency: 'INR', minor: ours.igst.minor < theirs.igst.minor ? ours.igst.minor : theirs.igst.minor },
  cess: { currency: 'INR', minor: ours.cess.minor < theirs.cess.minor ? ours.cess.minor : theirs.cess.minor },
});

const subtract = (from: TaxAmounts, less: TaxAmounts): TaxAmounts => ({
  taxableValue: { currency: 'INR', minor: from.taxableValue.minor - less.taxableValue.minor },
  cgst: { currency: 'INR', minor: from.cgst.minor - less.cgst.minor },
  sgst: { currency: 'INR', minor: from.sgst.minor - less.sgst.minor },
  igst: { currency: 'INR', minor: from.igst.minor - less.igst.minor },
  cess: { currency: 'INR', minor: from.cess.minor - less.cess.minor },
});

// ---------------------------------------------------------------------------- fingerprint

/**
 * The facts a person is actually deciding about.
 *
 * Written out field by field rather than serialising the objects, so that adding a field somewhere
 * else in the product does not mark every decision in the country out of date overnight.
 */
export const fingerprintOf = (book: BookPurchaseDocument | null, portal: PortalDocument | null): string =>
  createHash('sha256')
    .update([
      book?.sourceId ?? '',
      book?.number ?? '',
      book?.documentDate ?? '',
      book?.amounts.taxableValue.minor.toString() ?? '',
      book === null ? '' : totalTaxOf(book.amounts).minor.toString(),
      book?.ineligibleItc.minor.toString() ?? '',
      book?.reversed === true ? 'book-reversed' : '',
      portal?.number ?? '',
      portal?.documentDate ?? '',
      portal?.amounts.taxableValue.minor.toString() ?? '',
      portal === null ? '' : totalTaxOf(portal.amounts).minor.toString(),
      portal?.itcAvailableOnPortal === null || portal === undefined ? '' : String(portal?.itcAvailableOnPortal),
      portal?.reversed === true ? 'portal-reversed' : '',
      portal?.amends === null || portal === null ? '' : `${portal.amends?.period}/${portal.amends?.number}`,
    ].join('|'))
    .digest('hex');

// ---------------------------------------------------------------------------- findings

const finding = (
  code: ItcFindingCode,
  severity: ItcFinding['severity'],
  lineKey: string | null,
  message: Bilingual,
  whatToDo: Bilingual,
): ItcFinding => ({ code, severity, message, whatToDo, lineKey });

// ---------------------------------------------------------------------------- one line

export interface LineInput {
  readonly pair: MatchPair;
  readonly decision: ItcDecision | null;
  readonly policy?: ItcMatchPolicy;
  /**
   * The return being prepared. Section 16(4) is about the return a credit is claimed in, not about
   * the month the bill sits in, so the same bill is claimable in one period and barred in a later
   * one. Absent, the deadline is shown beside the bill and nothing is barred.
   */
  readonly period?: TaxPeriod;
  /** Today, for the case where an old period is only being prepared now. */
  readonly today?: IsoDate;
  /**
   * Issue #249 — the supplier's bills in our books, newest first. A credit note the supplier filed
   * does not say which bill it corrects, so when there is no return in our books to match it, these
   * are the bills the warning names.
   */
  readonly supplierBills?: readonly { readonly number: string; readonly date: IsoDate }[];
}

/** Issue #249 — a credit note lowers the credit, so "safe to claim" is the wrong label for it. */
const CREDIT_NOTE_APPLIED: Bilingual = {
  'en-IN': "Comes off this month's credit",
  'hi-IN': 'इस महीने के क्रेडिट से घटता है',
};

/** Issue #249 — "SRS-101", "SRS-101 or SRS-099", "SRS-101, SRS-099 or SRS-090". */
const orList = (items: readonly string[], or: string): string =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} ${or} ${items[items.length - 1]}`;

/**
 * One pair, one person's answer, and the conclusion the two of them produce.
 *
 * Every branch here ends in an outcome *and* a sentence saying why, because a line that says
 * "held back" without saying what is holding it is a line the shopkeeper will ring their
 * accountant about, and the accountant will ring us.
 */
export const assessLine = (input: LineInput): ReconciliationLine => {
  const policy = input.policy ?? DEFAULT_MATCH_POLICY;
  const { book, portal, status, evidence, matchNote } = input.pair;
  const baseKey = lineKeyOf(
    book?.supplierGstin ?? portal?.supplierGstin ?? null,
    book?.number ?? portal?.number ?? '',
    book?.kind ?? portal?.kind ?? 'INVOICE',
  );
  // A second copy of a bill shares every fact the key is built from, so it needs one more thing to
  // tell it apart. Without it an answer given on the real line would silently attach to the
  // duplicate as well, which is how one decision turns into two claims.
  const key = status === 'DUPLICATE_IN_BOOKS' || status === 'DUPLICATE_ON_PORTAL'
    ? `${baseKey}|COPY:${book?.sourceId ?? portal?.id ?? ''}`
    : baseKey;
  const fingerprint = fingerprintOf(book, portal);
  const decision = input.decision;
  const decisionStale = decision !== null && decision.fingerprint !== fingerprint;
  const findings: ItcFinding[] = [];

  const creditable = book === null ? emptyAmounts() : creditableFromBooks(book);
  const blockedInBooks = book !== null && totalTaxOf(book.amounts).minor > 0n && totalTaxOf(creditable).minor === 0n;
  // Section 16(4) — the 30 November after the end of the financial year the bill belongs to. Shown
  // on every line that has a bill of ours, whether or not the date has passed.
  // A supplier's credit note has no claim deadline: it gives credit back rather than taking it, so
  // there is no date on which it stops. See `hasClaimDeadline`.
  const lastClaimDate: IsoDate | null =
    book === null || !hasClaimDeadline(book.kind) ? null : lastClaimDateFor(book.documentDate);
  const timeBarred = lastClaimDate !== null && input.period !== undefined
    && isTimeBarred((book as BookPurchaseDocument).documentDate, input.period, input.today);

  // An accepted line only counts as accepted while it is answering the question it was asked.
  const accepted = decision?.kind === 'ACCEPT' && !decisionStale;
  const refused = decision?.kind === 'REJECT' || decision?.kind === 'PENDING';

  if (decisionStale) {
    findings.push(finding('ITC_DECISION_STALE', 'WARNING', key, {
      'en-IN': `The figures on this bill changed after you marked it ${DECISION_PLAIN[decision.kind]['en-IN'].toLowerCase()} on ${decision.decidedAt.slice(0, 10)}. Your answer has been kept, but it was given about different numbers.`,
      'hi-IN': `आपने ${decision.decidedAt.slice(0, 10)} को इसे ${DECISION_PLAIN[decision.kind]['hi-IN']} कहा था, उसके बाद इस बिल के आँकड़े बदले हैं. आपका जवाब रखा गया है, पर वह दूसरे आँकड़ों पर था.`,
    }, {
      'en-IN': 'Look at the two figures below and answer again. Nothing is claimed on this line until you do.',
      'hi-IN': 'नीचे दोनों आँकड़े देखकर दोबारा जवाब दीजिए. तब तक इस लाइन पर कुछ नहीं लिया जाएगा.',
    }));
  }

  let outcome: ItcOutcome = 'HELD_BACK';
  let claimable: TaxAmounts = emptyAmounts();
  let sentence: Bilingual;

  const supplier = book?.supplierName ?? portal?.supplierName ?? 'this supplier';
  const number = book?.number ?? portal?.number ?? '';
  // A person's typed reason is dropped into the middle of a sentence, and half of them end in a
  // full stop already. Two full stops in a row look like a bug to the person who typed one.
  const because = decision === null || decision.reason === '' ? '' : `: ${decision.reason.replace(/[.\s]+$/, '')}`;
  // A credit note lowers the credit rather than adding to it, so it cannot share the invoice's
  // wording. "₹1,800 goes on the return" is the opposite of what a credit note does.
  const isCreditNote = (book?.kind ?? portal?.kind) === 'CREDIT_NOTE';

  if (status === 'DUPLICATE_IN_BOOKS' || status === 'DUPLICATE_ON_PORTAL') {
    // The hard refusal. Nothing below can turn this into credit.
    findings.push(finding(
      status === 'DUPLICATE_IN_BOOKS' ? 'ITC_DUPLICATE_IN_BOOKS' : 'ITC_DUPLICATE_ON_PORTAL',
      'BLOCKING',
      key,
      status === 'DUPLICATE_IN_BOOKS'
        ? {
          'en-IN': `Bill ${number} from ${supplier} is in your books more than once. Only the first copy can carry credit.`,
          'hi-IN': `${supplier} का बिल ${number} आपकी बुक्स में एक से ज़्यादा बार है. क्रेडिट सिर्फ़ पहली कॉपी पर मिल सकता है.`,
        }
        : {
          'en-IN': `The portal reports bill ${number} from ${supplier} more than once.`,
          'hi-IN': `पोर्टल पर ${supplier} का बिल ${number} एक से ज़्यादा बार आया है.`,
        },
      {
        'en-IN': 'Open both copies. If one of them was entered by mistake, reverse it; a posted bill is corrected by a reversal, never by deleting it.',
        'hi-IN': 'दोनों कॉपी खोलिए. अगर एक ग़लती से डाली गई थी तो उसे रिवर्स कीजिए; पोस्ट हुआ बिल डिलीट नहीं, रिवर्स होता है.',
      },
    ));
    sentence = {
      'en-IN': `No credit is being taken on this copy of bill ${number}.`,
      'hi-IN': `बिल ${number} की इस कॉपी पर कोई क्रेडिट नहीं लिया जा रहा.`,
    };
  } else if (book === null && portal !== null && portal.kind === 'CREDIT_NOTE') {
    // Issue #249 — the supplier says goods came back (or the price came down), and our books hold no
    // return against them. Their note does not say which bill it corrects, so the bills we hold from
    // them are named: that is where the search starts.
    const bills = (input.supplierBills ?? []).slice(0, 3).map((bill) => bill.number);
    const against = bills.length === 0
      ? { en: 'Your books hold no bill from them either.', hi: 'आपकी बुक्स में उनका कोई बिल भी नहीं है.' }
      : bills.length === 1
        ? { en: `It will be against their bill ${bills[0]}.`, hi: `यह उनके बिल ${bills[0]} के अगेंस्ट होगा.` }
        : { en: `It will be against one of their bills: ${orList(bills, 'or')}.`, hi: `यह उनके किसी बिल के अगेंस्ट होगा: ${orList(bills, 'या')}.` };
    findings.push(finding('ITC_ONLY_ON_PORTAL', 'WARNING', key, {
      'en-IN': `${supplier} has reported credit note ${number} of ${formatINR(portal.invoiceValue)} to the government, and your books have no return against it. ${against.en}`,
      'hi-IN': `${supplier} ने सरकार को ${formatINR(portal.invoiceValue)} का क्रेडिट नोट ${number} बताया है, और आपकी बुक्स में इसके अगेंस्ट कोई वापसी नहीं है. ${against.hi}`,
    }, {
      'en-IN': `If goods did go back${bills.length === 0 ? '' : ` on ${bills.length === 1 ? 'that bill' : 'one of those bills'}`}, record the return on the Returns screen with this note's number, and the credit will come down by its tax. If nothing went back, ask ${supplier} why they issued it.`,
      'hi-IN': `अगर माल वापस गया था${bills.length === 0 ? '' : ` ${bills.length === 1 ? 'उस बिल पर' : 'इन में से किसी बिल पर'}`}, तो Returns screen पर इस नोट के नंबर के साथ वापसी दर्ज कीजिए, क्रेडिट उसके टैक्स जितना घट जाएगा. अगर कुछ वापस नहीं गया, तो ${supplier} से पूछिए कि यह नोट क्यों दिया.`,
    }));
    sentence = {
      'en-IN': `${supplier}'s credit note ${number} has no return in your books against it.`,
      'hi-IN': `${supplier} के क्रेडिट नोट ${number} के अगेंस्ट आपकी बुक्स में कोई वापसी नहीं है.`,
    };
  } else if (book === null && portal !== null) {
    findings.push(finding('ITC_ONLY_ON_PORTAL', 'WARNING', key, {
      'en-IN': `${supplier} has reported bill ${number} of ${formatINR(portal.invoiceValue)} to the government, and there is no such bill in your books.`,
      'hi-IN': `${supplier} ने सरकार को ${formatINR(portal.invoiceValue)} का बिल ${number} बताया है, और आपकी बुक्स में ऐसा कोई बिल नहीं है.`,
    }, {
      'en-IN': 'Find the paper. If you did buy this, record the bill and the credit will follow. If you did not, keep it pending and ask the supplier — do not accept it.',
      'hi-IN': 'काग़ज़ ढूँढिए. अगर ख़रीदा था तो बिल दर्ज कीजिए, क्रेडिट अपने आप आ जाएगा. अगर नहीं, तो pending रखकर सप्लायर से पूछिए — accept मत कीजिए.',
    }));
    sentence = {
      'en-IN': 'Nothing can be claimed until this purchase is in your books.',
      'hi-IN': 'जब तक यह ख़रीद आपकी बुक्स में नहीं आती, कुछ नहीं लिया जा सकता.',
    };
  } else if (book !== null && book.reversed) {
    findings.push(finding('ITC_BILL_REVERSED_IN_BOOKS', 'INFORMATION', key, {
      'en-IN': `Bill ${number} was reversed in your books, so there is no credit left on it.`,
      'hi-IN': `बिल ${number} आपकी बुक्स में रिवर्स हो चुका है, इस पर अब कोई क्रेडिट नहीं बचा.`,
    }, {
      'en-IN': 'Nothing to do. It is shown so the portal line beside it has an explanation.',
      'hi-IN': 'कुछ करना नहीं है. यह इसलिए दिख रहा है ताकि पोर्टल वाली लाइन का मतलब समझ आए.',
    }));
    sentence = { 'en-IN': 'Reversed in your books.', 'hi-IN': 'आपकी बुक्स में रिवर्स हो चुका.' };
  } else if (blockedInBooks) {
    outcome = 'BLOCKED_IN_BOOKS';
    sentence = {
      'en-IN': `The GST on bill ${number} was added to what the goods cost, because the law does not allow credit on this purchase. There is nothing to claim and nothing to chase.`,
      'hi-IN': `बिल ${number} का GST सामान की लागत में जोड़ा गया था, क्योंकि इस ख़रीद पर क्रेडिट नहीं मिलता. ना कुछ लेना है, ना कुछ पूछना है.`,
    };
  } else if (timeBarred) {
    // The credit is refused and the purchase is untouched: the bill stays in the books, and the GST
    // on it is part of what the goods cost. Section 16(4) bars the claim, not the purchase.
    outcome = 'TIME_BARRED';
    findings.push(finding('ITC_TIME_BARRED', 'BLOCKING', key, {
      'en-IN': `Credit on bill ${number} from ${supplier} had to be claimed by ${formatClaimDate(lastClaimDate as IsoDate)}. That date has gone, so the ${formatINR(totalTaxOf(creditable))} of GST on it cannot go on this return.`,
      'hi-IN': `${supplier} के बिल ${number} का क्रेडिट ${formatClaimDate(lastClaimDate as IsoDate)} तक लेना ज़रूरी था. वह तारीख़ निकल गई, इसलिए इस पर का ${formatINR(totalTaxOf(creditable))} GST अब इस रिटर्न पर नहीं जा सकता.`,
    }, {
      'en-IN': 'Nothing can be done about the credit now. Leave the bill where it is — the GST on it is part of what the goods cost. Section 16(4) allows no extension.',
      'hi-IN': 'अब इस क्रेडिट का कुछ नहीं हो सकता. बिल वहीं रहने दीजिए — उस पर का GST सामान की लागत का हिस्सा है. Section 16(4) में कोई छूट नहीं है.',
    }));
    sentence = {
      'en-IN': `Credit on this bill had to be claimed by ${formatClaimDate(lastClaimDate as IsoDate)}.`,
      'hi-IN': `इस बिल का क्रेडिट ${formatClaimDate(lastClaimDate as IsoDate)} तक लेना था.`,
    };
  } else if (book !== null && book.imported) {
    // Imports are paid at customs and never appear in GSTR-2B. Holding them back for want of a 2B
    // line would hold back a credit that has nothing to do with any supplier's filing.
    outcome = refused ? 'HELD_BACK' : 'CLAIM_NOW';
    claimable = outcome === 'CLAIM_NOW' ? creditable : emptyAmounts();
    sentence = outcome === 'CLAIM_NOW'
      ? {
        'en-IN': `Goods brought in from outside India. The GST was paid at customs, so this credit does not depend on any supplier reporting it.`,
        'hi-IN': `बाहर से मँगाया सामान. GST customs पर दिया गया था, इस क्रेडिट का किसी सप्लायर की filing से कोई लेना-देना नहीं.`,
      }
      : {
        'en-IN': `You marked this ${DECISION_PLAIN[decision?.kind ?? 'PENDING']['en-IN'].toLowerCase()}, so it is not on this month's return.`,
        'hi-IN': `आपने इसे ${DECISION_PLAIN[decision?.kind ?? 'PENDING']['hi-IN']} कहा, इसलिए यह इस महीने के रिटर्न पर नहीं है.`,
      };
  } else if (book !== null && book.reverseCharge && book.kind === 'INVOICE' && input.period !== undefined
    && book.taxPointPeriod !== undefined && book.taxPointPeriod > input.period) {
    // Issue #289, part 2b — the credit on reverse-charge tax comes from paying that tax, and the tax
    // is due only in the month of its time of supply (CGST s.12(3) / s.13(3)). Until then there is
    // nothing paid to take credit for, whatever GSTR-2B shows.
    outcome = 'HELD_BACK';
    sentence = {
      'en-IN': `Reverse charge: the GST on bill ${number} falls due in ${formatTaxPeriod(book.taxPointPeriod)}, its time of supply (CGST s.12(3) for goods, s.13(3) for services). You pay it on that month's return, and the credit comes on the same return. Paying ${supplier} sooner brings it forward.`,
      'hi-IN': `Reverse charge: बिल ${number} का GST ${formatTaxPeriod(book.taxPointPeriod)} में भरना है, यही इसका time of supply है (CGST s.12(3) माल के लिए, s.13(3) सेवा के लिए). इसे उस महीने के रिटर्न पर भरिए, क्रेडिट उसी रिटर्न पर मिलेगा. ${supplier} को पहले पैसा देने से यह पहले आ जाएगा.`,
    };
  } else if (book !== null && book.reverseCharge && book.outsideGstr2b === true && book.kind === 'INVOICE') {
    // Issue #289, part 2 — reverse charge on a purchase from a seller with no GST number. The buyer
    // pays this tax in cash and takes the same amount as credit in the same return (CGST s.49(4);
    // Circular 172/04/2022-GST; GSTR-3B 4(A)(3)). No supplier reports it, so there is no 2B line
    // to wait for: it is self-assessed.
    outcome = refused ? 'HELD_BACK' : 'CLAIM_NOW';
    claimable = outcome === 'CLAIM_NOW' ? creditable : emptyAmounts();
    sentence = outcome === 'CLAIM_NOW'
      ? {
        'en-IN': `Reverse charge: you pay this ${formatINR(totalTaxOf(creditable))} of GST in cash on this return, and the same amount comes back as credit. ${supplier} has no GST number, so it is never in GSTR-2B.`,
        'hi-IN': `Reverse charge: यह ${formatINR(totalTaxOf(creditable))} GST आप इस रिटर्न में नक़द से भरेंगे, और उतना ही क्रेडिट वापस मिलेगा. ${supplier} का GST नंबर नहीं है, इसलिए यह GSTR-2B में कभी नहीं आता.`,
      }
      : {
        'en-IN': `You marked this ${DECISION_PLAIN[decision?.kind ?? 'PENDING']['en-IN'].toLowerCase()}, so its credit is not on this month's return. The tax itself is still owed.`,
        'hi-IN': `आपने इसे ${DECISION_PLAIN[decision?.kind ?? 'PENDING']['hi-IN']} कहा, इसलिए इसका क्रेडिट इस महीने के रिटर्न पर नहीं है. टैक्स फिर भी भरना है.`,
      };
  } else if (book !== null && book.kind === 'CREDIT_NOTE') {
    // Issue #249 — goods we sent back to the supplier. The credit on them comes down from the month
    // of the return, at the tax our own books took off (which is what the ledger reversed), whatever
    // the supplier's note says or whether it has arrived at all: the credit on goods we no longer
    // hold is not ours to keep, and waiting for the supplier would keep it. Their note in the
    // government's record is matched as evidence, and any disagreement is said out loud.
    outcome = 'CLAIM_NOW';
    claimable = creditable;
    const tax = formatINR(totalTaxOf(creditable));
    const goods = book.goodsReturned === undefined || book.goodsReturned === null || book.goodsReturned === ''
      ? { en: 'goods back', hi: 'माल वापस' }
      : { en: `${book.goodsReturned} back`, hi: `${book.goodsReturned} वापस` };
    const onBill = book.original === undefined || book.original === null ? { en: '', hi: '' }
      : { en: ` against bill ${book.original.number}`, hi: ` बिल ${book.original.number} के अगेंस्ट` };
    if (portal === null) {
      const awaiting = book.awaitingSupplierNote === true;
      const message: Bilingual = {
        'en-IN': `You sent ${goods.en} to ${supplier}${onBill.en}. ${tax} of credit comes off this month. ${awaiting ? 'Ask them for their credit note.' : `Their credit note ${number} is not in the government's record yet.`}`,
        'hi-IN': `आपने ${supplier} को${onBill.hi} ${goods.hi} भेजा. इस महीने ${tax} क्रेडिट घट जाता है. ${awaiting ? 'उनसे उनका क्रेडिट नोट मँगाइए.' : `उनका क्रेडिट नोट ${number} अभी सरकारी रिकॉर्ड में नहीं है.`}`,
      };
      findings.push(finding('ITC_SUPPLIER_CREDIT_NOTE_AWAITED', 'INFORMATION', key, message, awaiting
        ? {
          'en-IN': "When their credit note comes, add its number and date to this return on the Returns screen. The credit has already come down, so nothing else changes.",
          'hi-IN': 'जब उनका क्रेडिट नोट आए, Returns screen पर इस वापसी में उसका नंबर और तारीख़ डाल दीजिए. क्रेडिट पहले ही घट चुका है, और कुछ नहीं बदलेगा.',
        }
        : {
          'en-IN': `Ask ${supplier} to file credit note ${number}. The credit has already come down, so nothing else needs doing here.`,
          'hi-IN': `${supplier} से क्रेडिट नोट ${number} file करने को कहिए. क्रेडिट पहले ही घट चुका है, यहाँ और कुछ नहीं करना.`,
        }));
      sentence = message;
    } else {
      if (portal.reversed) {
        findings.push(finding('ITC_SUPPLIER_REVERSED', 'WARNING', key, {
          'en-IN': `${supplier} withdrew credit note ${number} from their filing after reporting it.`,
          'hi-IN': `${supplier} ने क्रेडिट नोट ${number} report करने के बाद अपनी filing से हटा दिया.`,
        }, {
          'en-IN': `The goods still went back, so the credit stays down by ${tax}. Ask ${supplier} to file the note again.`,
          'hi-IN': `माल तो वापस गया है, इसलिए क्रेडिट ${tax} घटा ही रहेगा. ${supplier} से नोट दोबारा file करवाइए.`,
        }));
      }
      const differing = disagreements(evidence);
      if (differing.length > 0) {
        findings.push(finding(
          differing.some((row) => row.field === 'TAX_TYPE') ? 'ITC_TAX_TYPE_DIFFERS' : 'ITC_FIGURES_DIFFER',
          'WARNING',
          key,
          {
            'en-IN': `Credit note ${number}: ${differing.map((row) => `${row.label['en-IN'].toLowerCase()} — yours ${row.ours ?? '—'}, theirs ${row.theirs ?? '—'}`).join('; ')}.`,
            'hi-IN': `क्रेडिट नोट ${number}: ${differing.map((row) => `${row.label['hi-IN']} — आपका ${row.ours ?? '—'}, उनका ${row.theirs ?? '—'}`).join('; ')}.`,
          },
          {
            'en-IN': `The credit comes down by ${tax}, the tax on the goods your books show going back. Compare the supplier's note with your return, and ask them to correct it if theirs is wrong.`,
            'hi-IN': `क्रेडिट ${tax} घटता है, जितना टैक्स आपकी बुक्स के हिसाब से वापस गए माल पर था. सप्लायर का नोट अपनी वापसी से मिलाइए, और उनका ग़लत हो तो ठीक करवाइए.`,
          },
        ));
      }
      sentence = status === 'EXACT' && !portal.reversed
        ? {
          'en-IN': `Your return${onBill.en} and ${supplier}'s credit note ${number} agree. ${tax} of GST comes off this month's credit.`,
          'hi-IN': `आपकी वापसी${onBill.hi} और ${supplier} का क्रेडिट नोट ${number} मिलते हैं. इस महीने के क्रेडिट से ${tax} GST घट जाता है.`,
        }
        : {
          'en-IN': `${tax} of GST comes off this month's credit for the goods you sent back${onBill.en}. The supplier's note does not fully agree; see below.`,
          'hi-IN': `${onBill.hi.trim() === '' ? '' : `${onBill.hi.trim()} `}वापस भेजे माल के लिए इस महीने के क्रेडिट से ${tax} GST घट जाता है. सप्लायर का नोट पूरी तरह नहीं मिलता; नीचे देखिए.`,
        };
    }
  } else if (book !== null && book.supplierGstin === null) {
    // Nothing can be compared, so nothing is concluded. This is a missing fact, and a missing fact
    // is a question rather than a default — the credit waits for somebody to supply the number.
    findings.push(finding('ITC_SUPPLIER_GSTIN_MISSING', 'WARNING', key, {
      'en-IN': `Bill ${number} from ${supplier} has no GST number for the supplier, so it cannot be looked for in the government's record.`,
      'hi-IN': `${supplier} के बिल ${number} पर सप्लायर का GST नंबर नहीं है, इसलिए इसे सरकारी रिकॉर्ड में ढूँढा ही नहीं जा सकता.`,
    }, {
      'en-IN': 'Add the supplier\'s GST number to their record, then open this month again. The bill will be compared automatically.',
      'hi-IN': 'सप्लायर के रिकॉर्ड में उनका GST नंबर डालिए, फिर यह महीना दोबारा खोलिए. बिल अपने आप मिल जाएगा.',
    }));
    sentence = {
      'en-IN': `${formatINR(totalTaxOf(creditable))} of GST is waiting on the supplier's GST number.`,
      'hi-IN': `${formatINR(totalTaxOf(creditable))} GST सप्लायर के GST नंबर का इंतज़ार कर रहा है.`,
    };
  } else if (portal === null) {
    // The user's own example from the issue, and the acceptance criterion that matters most.
    findings.push(finding('ITC_MISSING_FROM_PORTAL', 'WARNING', key, {
      'en-IN': `Bill ${number} from ${supplier} is in your books, but the government's record for this month does not show it. The GST of ${formatINR(totalTaxOf(creditable))} on it is not being claimed yet.`,
      'hi-IN': `${supplier} का बिल ${number} आपकी बुक्स में है, पर इस महीने के सरकारी रिकॉर्ड में नहीं दिख रहा. इस पर का ${formatINR(totalTaxOf(creditable))} GST अभी नहीं लिया जा रहा.`,
    }, {
      'en-IN': 'Ask the supplier whether they have filed this bill. It often appears next month. Keep it pending until it does.',
      'hi-IN': 'सप्लायर से पूछिए कि उन्होंने यह बिल file किया है या नहीं. अक्सर अगले महीने आ जाता है. तब तक pending रखिए.',
    }));
    if (accepted && policy.allowClaimWithoutPortal) {
      outcome = 'CLAIM_AT_RISK';
      claimable = creditable;
      findings.push(atRiskFinding(key, decision as ItcDecision, {
        'en-IN': `${formatINR(totalTaxOf(creditable))} is being claimed on a bill the government's record does not carry.`,
        'hi-IN': `${formatINR(totalTaxOf(creditable))} ऐसे बिल पर लिया जा रहा है जो सरकारी रिकॉर्ड में नहीं है.`,
      }));
      sentence = {
        'en-IN': `Claimed on your instruction, although the portal does not carry this bill yet.`,
        'hi-IN': `आपके कहने पर लिया गया, हालाँकि पोर्टल पर यह बिल अभी नहीं है.`,
      };
    } else {
      sentence = {
        'en-IN': `${formatINR(totalTaxOf(creditable))} of GST is waiting on this supplier's filing.`,
        'hi-IN': `${formatINR(totalTaxOf(creditable))} GST इस सप्लायर की filing का इंतज़ार कर रहा है.`,
      };
    }
  } else {
    // Both sides exist. From here on it is about how well they agree and what the portal says.
    const theirs = portal.amounts;
    const safeAmount = lowerOf(creditable, theirs);

    if (portal.reversed) {
      findings.push(finding('ITC_SUPPLIER_REVERSED', 'WARNING', key, {
        'en-IN': `${supplier} withdrew bill ${number} from their filing after reporting it.`,
        'hi-IN': `${supplier} ने बिल ${number} report करने के बाद अपनी filing से हटा दिया.`,
      }, {
        'en-IN': 'Ask the supplier what replaced it. Do not claim this credit until there is a document standing behind it.',
        'hi-IN': 'सप्लायर से पूछिए कि इसके बदले क्या आया. जब तक कोई दस्तावेज़ न हो, यह क्रेडिट मत लीजिए.',
      }));
    }
    if (portal.amends !== null) {
      findings.push(finding('ITC_SUPPLIER_AMENDED', 'INFORMATION', key, {
        'en-IN': `This is an amended version of bill ${portal.amends.number}, which ${supplier} first reported in ${portal.amends.period}. The figures below are the amended ones.`,
        'hi-IN': `यह बिल ${portal.amends.number} का बदला हुआ रूप है, जिसे ${supplier} ने पहले ${portal.amends.period} में बताया था. नीचे के आँकड़े नए हैं.`,
      }, {
        'en-IN': 'Check the new figures against your bill. If they now agree, accept it; if the credit you already took was larger, the difference has to be given back.',
        'hi-IN': 'नए आँकड़े अपने बिल से मिलाइए. अगर अब मिल जाएँ तो accept कीजिए; अगर पहले ज़्यादा क्रेडिट ले लिया था तो अंतर वापस करना होगा.',
      }));
    }
    if (portal.itcAvailableOnPortal === false) {
      findings.push(finding('ITC_PORTAL_SAYS_UNAVAILABLE', 'WARNING', key, {
        'en-IN': `The government's own record marks the credit on bill ${number} as not available${portal.itcUnavailableReason === null ? '' : `: ${portal.itcUnavailableReason}`}.`,
        'hi-IN': `सरकारी रिकॉर्ड ख़ुद कहता है कि बिल ${number} पर क्रेडिट नहीं मिलता${portal.itcUnavailableReason === null ? '' : `: ${portal.itcUnavailableReason}`}.`,
      }, {
        'en-IN': 'Take this one to whoever does your GST. Claiming against the portal\'s own note is the kind of thing that comes back as a notice.',
        'hi-IN': 'इसे अपने GST वाले को दिखाइए. पोर्टल के अपने नोट के ख़िलाफ़ क्रेडिट लेना बाद में नोटिस बनकर आता है.',
      }));
    }
    // Issue #228 — the books and the filing carry different kinds of GST. One of the two is wrong,
    // and credit of IGST cannot be taken as CGST and SGST (or the reverse), so no answer on this
    // screen can release it: the bill or the filing has to be corrected first.
    const taxTypeRow = evidence.find((row) => row.field === 'TAX_TYPE' && row.verdict === 'DIFFERS');
    if (taxTypeRow !== undefined) {
      findings.push(finding('ITC_TAX_TYPE_DIFFERS', 'BLOCKING', key, {
        'en-IN': `Your books say ${taxTypeRow.ours ?? '—'}; ${supplier} filed ${taxTypeRow.theirs ?? '—'}. One of the two is wrong.`,
        'hi-IN': `आपकी बुक्स में ${taxTypeRow.ours ?? '—'} है; ${supplier} ने ${taxTypeRow.theirs ?? '—'} file किया. दोनों में से एक ग़लत है.`,
      }, {
        'en-IN': 'Look at the paper bill. If it shows the other kind of GST, correct the bill in your books; if your books are right, ask the supplier to correct their filing. The credit comes back on the month it is corrected.',
        'hi-IN': 'काग़ज़ वाला बिल देखिए. अगर उस पर दूसरी किस्म का GST है तो अपनी बुक्स में बिल ठीक कीजिए; अगर बुक्स सही हैं तो सप्लायर से filing ठीक करवाइए. क्रेडिट उसी महीने वापस आएगा जब यह ठीक होगा.',
      }));
    }
    const otherDifferences = disagreements(evidence).filter((row) => row.field !== 'TAX_TYPE');
    if (status === 'CLOSE' && otherDifferences.length > 0) {
      const fields = otherDifferences;
      findings.push(finding('ITC_FIGURES_DIFFER', 'WARNING', key, {
        'en-IN': `Bill ${number}: ${fields.map((row) => `${row.label['en-IN'].toLowerCase()} — yours ${row.ours ?? '—'}, theirs ${row.theirs ?? '—'}`).join('; ')}.`,
        'hi-IN': `बिल ${number}: ${fields.map((row) => `${row.label['hi-IN']} — आपका ${row.ours ?? '—'}, उनका ${row.theirs ?? '—'}`).join('; ')}.`,
      }, {
        'en-IN': 'Compare the paper bill with these two figures. If the supplier reported less than the bill says, ask them to correct it before you claim the difference.',
        'hi-IN': 'काग़ज़ वाला बिल इन दोनों आँकड़ों से मिलाइए. अगर सप्लायर ने कम बताया है तो अंतर लेने से पहले उनसे ठीक करवाइए.',
      }));
    }

    const clean = status === 'EXACT' && !portal.reversed && portal.itcAvailableOnPortal !== false && portal.amends === null;

    if (taxTypeRow !== undefined) {
      sentence = {
        'en-IN': `Your books say ${taxTypeRow.ours ?? '—'}; the supplier filed ${taxTypeRow.theirs ?? '—'}. One of the two is wrong. ${formatINR(totalTaxOf(creditable))} is held back until the bill or the filing is corrected.`,
        'hi-IN': `आपकी बुक्स में ${taxTypeRow.ours ?? '—'} है; सप्लायर ने ${taxTypeRow.theirs ?? '—'} file किया. दोनों में से एक ग़लत है. ${formatINR(totalTaxOf(creditable))} तब तक रोका गया है जब तक बिल या filing ठीक ना हो.`,
      };
    } else if (refused) {
      sentence = {
        'en-IN': `You marked this ${DECISION_PLAIN[decision?.kind ?? 'PENDING']['en-IN'].toLowerCase()}${because}. It is not on this month's return.`,
        'hi-IN': `आपने इसे ${DECISION_PLAIN[decision?.kind ?? 'PENDING']['hi-IN']} कहा${because}. यह इस महीने के रिटर्न पर नहीं है.`,
      };
    } else if (clean) {
      outcome = 'CLAIM_NOW';
      claimable = safeAmount;
      sentence = {
        'en-IN': isCreditNote
          ? `Your credit note and ${supplier}'s filing agree. ${formatINR(totalTaxOf(claimable))} of GST comes back off this month's credit.`
          : `Your bill and ${supplier}'s filing agree. ${formatINR(totalTaxOf(claimable))} of GST goes on this month's return.`,
        'hi-IN': isCreditNote
          ? `आपका क्रेडिट नोट और ${supplier} की filing मिलते हैं. ${formatINR(totalTaxOf(claimable))} GST इस महीने के क्रेडिट से घट जाएगा.`
          : `आपका बिल और ${supplier} की filing मिलते हैं. ${formatINR(totalTaxOf(claimable))} GST इस महीने के रिटर्न पर जाएगा.`,
      };
    } else if (accepted) {
      outcome = 'CLAIM_AT_RISK';
      claimable = safeAmount;
      const withheld = subtract(creditable, safeAmount);
      findings.push(atRiskFinding(key, decision as ItcDecision, {
        'en-IN': `${formatINR(totalTaxOf(claimable))} is being claimed on a line that does not fully agree with the portal.`,
        'hi-IN': `${formatINR(totalTaxOf(claimable))} ऐसी लाइन पर लिया जा रहा है जो पोर्टल से पूरी तरह नहीं मिलती.`,
      }));
      sentence = totalTaxOf(withheld).minor > 0n
        ? {
          'en-IN': `Claimed at the lower of the two figures: ${formatINR(totalTaxOf(claimable))}. The remaining ${formatINR(totalTaxOf(withheld))} is not being claimed until the supplier corrects their filing.`,
          'hi-IN': `दोनों में से छोटी रक़म ली गई: ${formatINR(totalTaxOf(claimable))}. बाक़ी ${formatINR(totalTaxOf(withheld))} तब तक नहीं लिया जाएगा जब तक सप्लायर अपनी filing ठीक ना करे.`,
        }
        : {
          'en-IN': `Claimed on your instruction: ${formatINR(totalTaxOf(claimable))}.`,
          'hi-IN': `आपके कहने पर लिया गया: ${formatINR(totalTaxOf(claimable))}.`,
        };
    } else {
      sentence = {
        'en-IN': `${formatINR(totalTaxOf(creditable))} of GST is held back until somebody answers the question on this line.`,
        'hi-IN': `${formatINR(totalTaxOf(creditable))} GST तब तक रोका गया है जब तक इस लाइन का जवाब ना मिले.`,
      };
    }
  }

  const heldBack = subtract(creditable, claimable);

  return {
    key,
    status,
    // Issue #289 — a self-assessed reverse-charge bill is not "missing" from the portal: it never goes there.
    statusLabel: input.pair.matchNote === SELF_ASSESSED_NOTE ? SELF_ASSESSED_LABEL : MATCH_STATUS_PLAIN[status],
    lastClaimDate,
    book,
    portal,
    evidence,
    matchNote,
    outcome,
    outcomeLabel: isCreditNote && outcome === 'CLAIM_NOW' ? CREDIT_NOTE_APPLIED : OUTCOME_PLAIN[outcome],
    claimable,
    heldBack: { ...heldBack, taxableValue: outcome === 'CLAIM_NOW' || outcome === 'CLAIM_AT_RISK' ? zeroMoney : creditable.taxableValue },
    decision,
    decisionStale,
    findings,
    sentence,
    fingerprint,
  };
};

const atRiskFinding = (key: string, decision: ItcDecision, message: Bilingual): ItcFinding =>
  finding('ITC_CLAIMED_AT_RISK', 'WARNING', key, message, {
    'en-IN': `${decision.reason === '' ? 'A reason was recorded with this decision.' : `Your reason: ${decision.reason}.`} If the portal never carries this bill, this credit has to be given back with interest, so keep the paperwork.`,
    'hi-IN': `${decision.reason === '' ? 'इस फ़ैसले के साथ एक वज़ह लिखी गई थी.' : `आपकी वज़ह: ${decision.reason}.`} अगर पोर्टल पर यह बिल कभी नहीं आता, तो यह क्रेडिट ब्याज के साथ वापस करना पड़ेगा — काग़ज़ संभालकर रखिए.`,
  });

/**
 * What the 3B screen is told about the credit that is *not* in its figure.
 *
 * Two kinds of money, and running them into one sentence is how a business is told that money it
 * has lost is coming back. Credit held back is waiting on a supplier or on an answer, and it
 * returns on the month it is settled. Credit barred by section 16(4) does not return on any month,
 * and saying otherwise sends somebody looking for it next quarter.
 */
const cautionFor = (held: TaxAmounts, barred: TaxAmounts): Bilingual => {
  const waiting = totalTaxOf(held);
  const gone = totalTaxOf(barred);
  if (waiting.minor === 0n && gone.minor === 0n) {
    return {
      'en-IN': 'Every purchase this month is accounted for, so the credit here is the whole of it.',
      'hi-IN': 'इस महीने की हर ख़रीद का हिसाब है, इसलिए यहाँ पूरा क्रेडिट दिख रहा है.',
    };
  }
  const parts: Bilingual[] = [];
  if (waiting.minor > 0n) {
    parts.push({
      'en-IN': `${formatINR(waiting)} of GST on your purchases is deliberately not in this figure, because those bills are still waiting on the supplier or on you. They are not lost — they come back on the month they are settled.`,
      'hi-IN': `आपकी ख़रीद का ${formatINR(waiting)} GST जान-बूझकर इस आँकड़े में नहीं है, क्योंकि वह बिल अभी सप्लायर या आप पर रुके हैं. वे खोए नहीं हैं — जिस महीने तय होंगे उस महीने आ जाएँगे.`,
    });
  }
  if (gone.minor > 0n) {
    // "A further" only when something was named before it, so the sentence reads on its own when
    // the whole of the missing credit is the barred kind.
    const alsoEn = waiting.minor > 0n ? `A further ${formatINR(gone)} is not in it either, and that part` : `${formatINR(gone)} of GST on your purchases is not in this figure, and it`;
    const alsoHi = waiting.minor > 0n ? `इसके अलावा ${formatINR(gone)} भी इसमें नहीं है, और वह` : `आपकी ख़रीद का ${formatINR(gone)} GST इस आँकड़े में नहीं है, और वह`;
    parts.push({
      'en-IN': `${alsoEn} does not come back on any month: the last date for claiming it has gone by.`,
      'hi-IN': `${alsoHi} किसी भी महीने वापस नहीं आएगा: इसे लेने की आख़िरी तारीख़ निकल चुकी है.`,
    });
  }
  return {
    'en-IN': parts.map((part) => part['en-IN']).join(' '),
    'hi-IN': parts.map((part) => part['hi-IN']).join(' '),
  };
};

// ---------------------------------------------------------------------------- the month

/**
 * The credit side of GSTR-3B, built from these lines and nothing else.
 *
 * The reverse-charge *liability* is the one figure here that does not depend on a decision: when
 * a business buys from an unregistered supplier or an importer of services, it owes that tax over
 * whatever anybody accepted, and a reconciliation screen is not allowed to make that go away.
 */
export const linkageFor = (
  period: TaxPeriod,
  lines: readonly ReconciliationLine[],
  allBooks: readonly BookPurchaseDocument[],
): Gstr3bLinkage => {
  const claimed = lines.filter((line) => line.outcome === 'CLAIM_NOW' || line.outcome === 'CLAIM_AT_RISK');
  const bucket = (predicate: (line: ReconciliationLine) => boolean): TaxAmounts =>
    sumAmounts(claimed.filter(predicate).map((line) => line.claimable));

  const isCreditNote = (line: ReconciliationLine): boolean => (line.book?.kind ?? line.portal?.kind) === 'CREDIT_NOTE';

  // Issue #286 — a supplier's credit note reduces the credit in the same box its bill was claimed
  // in, as GSTR-2B nets it into 4(A)(5) (or 4(A)(3) under reverse charge). Putting it in 4(B) as well
  // as 2B's net figure reduced it twice, or disagreed with 2B. 4(B)(1) is kept for real reversals:
  // section 17(5) below (issue #289, part 3); Rules 42/43 are not posted by this module.
  const net = (predicate: (line: ReconciliationLine) => boolean): TaxAmounts =>
    subtract(bucket((line) => !isCreditNote(line) && predicate(line)), bucket((line) => isCreditNote(line) && predicate(line)));
  // Issue #289, part 3 — credit CGST s.17(5) blocks. Table 4(A) carries the whole of the credit as
  // GSTR-2B shows it, eligible and ineligible alike, and the s.17(5) part is taken out in Table
  // 4(B)(1) (Circular 170/02/2022-GST, 06.07.2022, para 4 A and B; form as amended by Notification
  // 14/2022-CT). So a bill's blocked tax goes into its 4(A) box and into 4(B)(1), in the month its
  // credit goes on the return; a bill whose credit is blocked entirely, in the month its tax belongs to.
  const blockedOf = (line: ReconciliationLine): TaxAmounts => {
    const book = line.book;
    if (book === null || book.kind !== 'INVOICE' || book.reversed || book.ineligibleItc.minor === 0n) return emptyAmounts();
    return { ...subtract(book.amounts, creditableFromBooks(book)), taxableValue: zeroMoney };
  };
  const blockedLines = lines.filter((line) => line.outcome === 'CLAIM_NOW' || line.outcome === 'CLAIM_AT_RISK'
    || (line.outcome === 'BLOCKED_IN_BOOKS' && line.book !== null && liabilityPeriodOf(line.book) === period));
  const blockedIn = (predicate: (line: ReconciliationLine) => boolean): TaxAmounts =>
    sumAmounts(blockedLines.filter(predicate).map(blockedOf));
  const isOther = (line: ReconciliationLine) => line.book?.reverseCharge !== true && line.book?.imported !== true;
  const isReverse = (line: ReconciliationLine) => line.book?.reverseCharge === true;
  const isImport = (line: ReconciliationLine) => line.book?.imported === true;
  const allOtherItc = addAmounts(net(isOther), blockedIn(isOther));
  const reverseChargeItc = addAmounts(net(isReverse), blockedIn(isReverse));
  const importItc = addAmounts(net(isImport), blockedIn(isImport));
  const reversedItc = blockedIn(() => true);

  // Issue #249 — the books hand over every unclaimed document up to this month (so late credit can
  // be taken, #222), but tax owed under reverse charge and the value of untaxed purchases belong to
  // the month of the document only. Counting an earlier month's bill again would owe its tax twice.
  const monthBooks = allBooks.filter((book) => book.period === period);
  // Issue #289, part 2b — a reverse-charge bill's tax goes on the return of its time of supply
  // (CGST s.12(3) goods, s.13(3) services), which need not be the month of the bill.
  const liabilityBooks = allBooks.filter((book) => liabilityPeriodOf(book) === period);
  // Issue #249 — goods sent back on a reverse-charge purchase lower the tax owed on it, as the ledger
  // does when it posts the return; the liability here is net of them.
  const reverseChargeLiability = subtract(
    sumAmounts(liabilityBooks.filter((book) => book.reverseCharge && !book.reversed && book.kind === 'INVOICE').map((book) => book.amounts)),
    sumAmounts(monthBooks.filter((book) => book.reverseCharge && !book.reversed && book.kind === 'CREDIT_NOTE').map((book) => book.amounts)),
  );
  const exemptInwardValue: Money = {
    currency: 'INR',
    minor: monthBooks
      .filter((book) => !book.reversed && book.kind === 'INVOICE' && totalTaxOf(book.amounts).minor === 0n && book.inTable5 !== false)
      .reduce((total, book) => total + book.amounts.taxableValue.minor, 0n),
  };

  const contributions: SourceRef[] = claimed
    .filter((line) => line.book !== null)
    .map((line) => {
      const book = line.book as BookPurchaseDocument;
      return {
        sourceKind: book.sourceKind,
        sourceId: book.sourceId,
        number: book.number,
        date: book.documentDate,
        voucherId: book.voucherId,
        amount: totalTaxOf(line.claimable),
      };
    });

  // Credit that is waiting on somebody, kept apart from credit whose last claim date has gone by.
  // The two are both "not in this figure", and that is the only thing they have in common: one
  // comes back on the month it is settled, and the other never comes back at all.
  const held = sumAmounts(lines.filter((line) => line.outcome !== 'TIME_BARRED').map((line) => line.heldBack));
  const barred = sumAmounts(lines.filter((line) => line.outcome === 'TIME_BARRED').map((line) => line.heldBack));

  // Issue #249 — the gap between this return's credit and the ledger's input GST for the month, and
  // where it comes from. A credit note counts against the credit on both sides.
  const signed = (line: ReconciliationLine, amounts: TaxAmounts): TaxAmounts =>
    isCreditNote(line) && totalTaxOf(amounts).minor > 0n ? negate(amounts) : amounts;
  const fromEarlierMonths = sumAmounts(claimed
    .filter((line) => line.book !== null && line.book.period < period)
    .map((line) => signed(line, line.claimable)));
  const notClaimedThisMonth = sumAmounts(lines
    .filter((line) => line.book !== null && line.book.period === period && !line.book.reversed)
    .map((line) => signed(line, line.heldBack)));

  return {
    period,
    allOtherItc,
    reverseChargeItc,
    importItc,
    reversedItc,
    reverseChargeLiability,
    exemptInwardValue,
    contributions,
    caution: cautionFor(held, barred),
    booksExplanation: { fromEarlierMonths, notClaimedThisMonth },
  };
};

// ---------------------------------------------------------------------------- returns and their bills

const negate = (amounts: TaxAmounts): TaxAmounts => ({
  taxableValue: { currency: 'INR', minor: -amounts.taxableValue.minor },
  cgst: { currency: 'INR', minor: -amounts.cgst.minor },
  sgst: { currency: 'INR', minor: -amounts.sgst.minor },
  igst: { currency: 'INR', minor: -amounts.igst.minor },
  cess: { currency: 'INR', minor: -amounts.cess.minor },
});

/**
 * Issue #249 — goods sent back against a bill whose own credit has not been taken.
 *
 * The return takes its tax off the credit on the bill it corrects. When that bill's credit is on
 * this return, or went on an earlier one, the reduction stands this month. When the bill is still
 * waiting — its supplier has not filed it, or somebody is holding it — there is no credit on it yet
 * to reduce, and reducing this month would give back credit that was never taken. So the return
 * waits with the bill: nothing comes off this month, and the credit held back on the bill is shown
 * net of the return (₹5,760 on the bill, less ₹576 back, is ₹5,184 waiting). The return goes on the
 * return in the month the bill does, and a matched pair is reduced exactly once.
 *
 * `claimedBefore` is the set of `sourceKind|sourceId` whose credit went on an earlier return.
 */
export const settleReturnsAgainstBills = (
  lines: readonly ReconciliationLine[],
  claimedBefore: ReadonlySet<string>,
): readonly ReconciliationLine[] =>
  lines.map((line) => {
    const book = line.book;
    if (book === null || book.kind !== 'CREDIT_NOTE' || line.outcome !== 'CLAIM_NOW') return line;
    const linked = book.original ?? null;
    const claimedNow = (candidate: ReconciliationLine): boolean => candidate.outcome === 'CLAIM_NOW' || candidate.outcome === 'CLAIM_AT_RISK';
    let billLine: ReconciliationLine | undefined;
    if (linked !== null) {
      if (claimedBefore.has(`${linked.sourceKind}|${linked.sourceId}`)) return line;
      billLine = lines.find((candidate) => candidate.book !== null && candidate.book.kind === 'INVOICE'
        && candidate.book.sourceKind === linked.sourceKind && candidate.book.sourceId === linked.sourceId);
    } else {
      // A credit note that does not say which bill it corrects: it waits only when every bill from
      // that supplier in this month's comparison is itself waiting, and none of theirs is claimed.
      const theirs = lines.filter((candidate) => candidate.book !== null && candidate.book.kind === 'INVOICE'
        && book.supplierGstin !== null && (candidate.book.supplierGstin ?? '').toUpperCase() === book.supplierGstin.toUpperCase());
      if (theirs.length === 0 || theirs.some(claimedNow)) return line;
      billLine = theirs[0];
    }
    if (billLine === undefined || claimedNow(billLine)) return line;
    const original = linked ?? { number: (billLine.book as BookPurchaseDocument).number };
    const reduction = line.claimable;
    const tax = formatINR(totalTaxOf(reduction));
    const barred = billLine.outcome === 'TIME_BARRED';
    const supplier = book.supplierName;
    const goods = book.goodsReturned === undefined || book.goodsReturned === null || book.goodsReturned === '' ? 'goods' : book.goodsReturned;
    const message: Bilingual = barred
      ? {
        'en-IN': `You sent ${goods} back to ${supplier} against bill ${original.number}. The credit on that bill can no longer be claimed, so there is nothing for this return to take off.`,
        'hi-IN': `आपने बिल ${original.number} के अगेंस्ट ${supplier} को ${goods} वापस भेजा. उस बिल का क्रेडिट अब लिया नहीं जा सकता, इसलिए इस वापसी से घटाने को कुछ नहीं है.`,
      }
      : {
        'en-IN': `You sent ${goods} back to ${supplier} against bill ${original.number}. ${tax} of credit comes off that bill. Its own credit is still waiting, so nothing comes off this month; when bill ${original.number} is claimed, it is claimed less this ${tax}.`,
        'hi-IN': `आपने बिल ${original.number} के अगेंस्ट ${supplier} को ${goods} वापस भेजा. उस बिल के क्रेडिट से ${tax} घटता है. उस बिल का अपना क्रेडिट अभी रुका है, इसलिए इस महीने कुछ नहीं घटता; जब बिल ${original.number} का क्रेडिट लिया जाएगा, ${tax} कम लिया जाएगा.`,
      };
    return {
      ...line,
      outcome: barred ? 'TIME_BARRED' : 'HELD_BACK',
      outcomeLabel: barred ? OUTCOME_PLAIN.TIME_BARRED : {
        'en-IN': `Waits with bill ${original.number}`,
        'hi-IN': `बिल ${original.number} के साथ रुका है`,
      },
      claimable: emptyAmounts(),
      // Negative on purpose: it is taken off the credit held back on the bill, so the month's total
      // held back is what will actually come back.
      heldBack: negate(reduction),
      findings: [
        ...line.findings.filter((one) => one.code !== 'ITC_SUPPLIER_CREDIT_NOTE_AWAITED'),
        finding('ITC_RETURN_WAITS_WITH_BILL', 'INFORMATION', line.key, message, barred
          ? { 'en-IN': 'Nothing to do.', 'hi-IN': 'कुछ करना नहीं है.' }
          : {
            'en-IN': `Settle bill ${original.number} first. This return follows it onto the return in the same month.`,
            'hi-IN': `पहले बिल ${original.number} निपटा लीजिए. यह वापसी उसी महीने उसके साथ रिटर्न पर जाएगी.`,
          }),
      ],
      sentence: message,
    };
  });

/** Adds one line's contribution to a running set of totals. Used by the workspace. */
export const accumulate = (total: TaxAmounts, line: TaxAmounts): TaxAmounts => addAmounts(total, line);

/** Issue #289 — how a self-assessed reverse-charge line is named in place of "not on the portal". */
const SELF_ASSESSED_LABEL: Bilingual = {
  'en-IN': 'Reverse charge, self-assessed (not in GSTR-2B)',
  'hi-IN': 'Reverse charge, ख़ुद का हिसाब (GSTR-2B में नहीं)',
};

/** Issue #289 — the note on a reverse-charge line that is self-assessed rather than matched. */
export const SELF_ASSESSED_NOTE: Bilingual = {
  'en-IN': 'Reverse charge from a seller with no GST number: self-assessed, never in GSTR-2B.',
  'hi-IN': 'बिना GST नंबर वाले सेलर से reverse charge: ख़ुद का हिसाब, GSTR-2B में कभी नहीं.',
};

/**
 * Issue #289, part 2b — the month whose GSTR-3B carries a document's reverse-charge tax: its time of
 * supply for a reverse-charge bill (CGST s.12(3) / s.13(3)), else the document's own month.
 */
export const liabilityPeriodOf = (book: BookPurchaseDocument): TaxPeriod =>
  book.reverseCharge && book.kind === 'INVOICE' && book.taxPointPeriod !== undefined ? book.taxPointPeriod : book.period;

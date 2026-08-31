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
import { allocateByWeight, formatINR, type Money } from '@invoice/kernel';
import { createHash } from 'node:crypto';
import { disagreements, lineKeyOf } from './match.ts';
import type { MatchPair } from './match.ts';
import {
  DECISION_PLAIN,
  DEFAULT_MATCH_POLICY,
  MATCH_STATUS_PLAIN,
  OUTCOME_PLAIN,
  addAmounts,
  emptyAmounts,
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
}

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

  // An accepted line only counts as accepted while it is answering the question it was asked.
  const accepted = decision?.kind === 'ACCEPT' && !decisionStale;
  const refused = decision?.kind === 'REJECT' || decision?.kind === 'PENDING';

  if (decisionStale) {
    findings.push(finding('ITC_DECISION_STALE', 'WARNING', key, {
      'en-IN': `The figures on this bill changed after you marked it ${DECISION_PLAIN[decision.kind]['en-IN'].toLowerCase()} on ${decision.decidedAt.slice(0, 10)}. Your answer has been kept, but it was given about different numbers.`,
      'hi-IN': `Aapne ${decision.decidedAt.slice(0, 10)} ko ise ${DECISION_PLAIN[decision.kind]['hi-IN']} kaha tha, uske baad is bill ke figure badle hain. Aapka jawab rakha gaya hai, par woh doosre numbers par tha.`,
    }, {
      'en-IN': 'Look at the two figures below and answer again. Nothing is claimed on this line until you do.',
      'hi-IN': 'Neeche dono figure dekh kar dobara jawab dijiye. Tab tak is line par kuch nahin liya jayega.',
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
          'hi-IN': `${supplier} ka bill ${number} aapki books mein ek se zyada baar hai. Credit sirf pehli copy par mil sakta hai.`,
        }
        : {
          'en-IN': `The portal reports bill ${number} from ${supplier} more than once.`,
          'hi-IN': `Portal par ${supplier} ka bill ${number} ek se zyada baar aaya hai.`,
        },
      {
        'en-IN': 'Open both copies. If one of them was entered by mistake, reverse it; a posted bill is corrected by a reversal, never by deleting it.',
        'hi-IN': 'Dono copy kholiye. Agar ek galti se dali gayi thi to use reverse kijiye; posted bill delete nahin, reverse hota hai.',
      },
    ));
    sentence = {
      'en-IN': `No credit is being taken on this copy of bill ${number}.`,
      'hi-IN': `Bill ${number} ki is copy par koi credit nahin liya ja raha.`,
    };
  } else if (book === null && portal !== null) {
    findings.push(finding('ITC_ONLY_ON_PORTAL', 'WARNING', key, {
      'en-IN': `${supplier} has reported bill ${number} of ${formatINR(portal.invoiceValue)} to the government, and there is no such bill in your books.`,
      'hi-IN': `${supplier} ne sarkar ko ${formatINR(portal.invoiceValue)} ka bill ${number} bataya hai, aur aapki books mein aisa koi bill nahin hai.`,
    }, {
      'en-IN': 'Find the paper. If you did buy this, record the bill and the credit will follow. If you did not, keep it pending and ask the supplier — do not accept it.',
      'hi-IN': 'Kagaz dhoondhiye. Agar kharida tha to bill darj kijiye, credit apne aap aa jayega. Agar nahin, to pending rakh kar supplier se poochhiye — accept mat kijiye.',
    }));
    sentence = {
      'en-IN': 'Nothing can be claimed until this purchase is in your books.',
      'hi-IN': 'Jab tak yeh kharid aapki books mein nahin aati, kuch nahin liya ja sakta.',
    };
  } else if (book !== null && book.reversed) {
    findings.push(finding('ITC_BILL_REVERSED_IN_BOOKS', 'INFORMATION', key, {
      'en-IN': `Bill ${number} was reversed in your books, so there is no credit left on it.`,
      'hi-IN': `Bill ${number} aapki books mein reverse ho chuka hai, is par ab koi credit nahin bacha.`,
    }, {
      'en-IN': 'Nothing to do. It is shown so the portal line beside it has an explanation.',
      'hi-IN': 'Kuch karna nahin hai. Yeh isliye dikh raha hai taki portal wali line ka matlab samajh aaye.',
    }));
    sentence = { 'en-IN': 'Reversed in your books.', 'hi-IN': 'Aapki books mein reverse ho chuka.' };
  } else if (blockedInBooks) {
    outcome = 'BLOCKED_IN_BOOKS';
    sentence = {
      'en-IN': `The GST on bill ${number} was added to what the goods cost, because the law does not allow credit on this purchase. There is nothing to claim and nothing to chase.`,
      'hi-IN': `Bill ${number} ka GST saaman ki laagat mein joda gaya tha, kyunki is kharid par credit nahin milta. Na kuch lena hai, na kuch poochhna hai.`,
    };
  } else if (book !== null && book.imported) {
    // Imports are paid at customs and never appear in GSTR-2B. Holding them back for want of a 2B
    // line would hold back a credit that has nothing to do with any supplier's filing.
    outcome = refused ? 'HELD_BACK' : 'CLAIM_NOW';
    claimable = outcome === 'CLAIM_NOW' ? creditable : emptyAmounts();
    sentence = outcome === 'CLAIM_NOW'
      ? {
        'en-IN': `Goods brought in from outside India. The GST was paid at customs, so this credit does not depend on any supplier reporting it.`,
        'hi-IN': `Bahar se mangaya saaman. GST customs par diya gaya tha, is credit ka kisi supplier ki filing se koi lena-dena nahin.`,
      }
      : {
        'en-IN': `You marked this ${DECISION_PLAIN[decision?.kind ?? 'PENDING']['en-IN'].toLowerCase()}, so it is not on this month's return.`,
        'hi-IN': `Aapne ise ${DECISION_PLAIN[decision?.kind ?? 'PENDING']['hi-IN']} kaha, isliye yeh is mahine ke return par nahin hai.`,
      };
  } else if (book !== null && book.supplierGstin === null) {
    // Nothing can be compared, so nothing is concluded. This is a missing fact, and a missing fact
    // is a question rather than a default — the credit waits for somebody to supply the number.
    findings.push(finding('ITC_SUPPLIER_GSTIN_MISSING', 'WARNING', key, {
      'en-IN': `Bill ${number} from ${supplier} has no GST number for the supplier, so it cannot be looked for in the government's record.`,
      'hi-IN': `${supplier} ke bill ${number} par supplier ka GST number nahin hai, isliye use sarkari record mein dhoondha hi nahin ja sakta.`,
    }, {
      'en-IN': 'Add the supplier\'s GST number to their record, then open this month again. The bill will be compared automatically.',
      'hi-IN': 'Supplier ke record mein unka GST number daaliye, phir yeh mahina dobara kholiye. Bill apne aap mil jayega.',
    }));
    sentence = {
      'en-IN': `${formatINR(totalTaxOf(creditable))} of GST is waiting on the supplier's GST number.`,
      'hi-IN': `${formatINR(totalTaxOf(creditable))} GST supplier ke GST number ka intezaar kar raha hai.`,
    };
  } else if (portal === null) {
    // The user's own example from the issue, and the acceptance criterion that matters most.
    findings.push(finding('ITC_MISSING_FROM_PORTAL', 'WARNING', key, {
      'en-IN': `Bill ${number} from ${supplier} is in your books, but the government's record for this month does not show it. The GST of ${formatINR(totalTaxOf(creditable))} on it is not being claimed yet.`,
      'hi-IN': `${supplier} ka bill ${number} aapki books mein hai, par is mahine ke sarkari record mein nahin dikh raha. Is par ka ${formatINR(totalTaxOf(creditable))} GST abhi nahin liya ja raha.`,
    }, {
      'en-IN': 'Ask the supplier whether they have filed this bill. It often appears next month. Keep it pending until it does.',
      'hi-IN': 'Supplier se poochhiye ki unhone yeh bill file kiya hai ya nahin. Aksar agle mahine aa jata hai. Tab tak pending rakhiye.',
    }));
    if (accepted && policy.allowClaimWithoutPortal) {
      outcome = 'CLAIM_AT_RISK';
      claimable = creditable;
      findings.push(atRiskFinding(key, decision as ItcDecision, {
        'en-IN': `${formatINR(totalTaxOf(creditable))} is being claimed on a bill the government's record does not carry.`,
        'hi-IN': `${formatINR(totalTaxOf(creditable))} aise bill par liya ja raha hai jo sarkari record mein nahin hai.`,
      }));
      sentence = {
        'en-IN': `Claimed on your instruction, although the portal does not carry this bill yet.`,
        'hi-IN': `Aapke kehne par liya gaya, halanki portal par yeh bill abhi nahin hai.`,
      };
    } else {
      sentence = {
        'en-IN': `${formatINR(totalTaxOf(creditable))} of GST is waiting on this supplier's filing.`,
        'hi-IN': `${formatINR(totalTaxOf(creditable))} GST is supplier ki filing ka intezaar kar raha hai.`,
      };
    }
  } else {
    // Both sides exist. From here on it is about how well they agree and what the portal says.
    const theirs = portal.amounts;
    const safeAmount = lowerOf(creditable, theirs);

    if (portal.reversed) {
      findings.push(finding('ITC_SUPPLIER_REVERSED', 'WARNING', key, {
        'en-IN': `${supplier} withdrew bill ${number} from their filing after reporting it.`,
        'hi-IN': `${supplier} ne bill ${number} report karne ke baad apni filing se hata diya.`,
      }, {
        'en-IN': 'Ask the supplier what replaced it. Do not claim this credit until there is a document standing behind it.',
        'hi-IN': 'Supplier se poochhiye ki iske badle kya aaya. Jab tak koi document na ho, yeh credit mat lijiye.',
      }));
    }
    if (portal.amends !== null) {
      findings.push(finding('ITC_SUPPLIER_AMENDED', 'INFORMATION', key, {
        'en-IN': `This is an amended version of bill ${portal.amends.number}, which ${supplier} first reported in ${portal.amends.period}. The figures below are the amended ones.`,
        'hi-IN': `Yeh bill ${portal.amends.number} ka badla hua roop hai, jise ${supplier} ne pehle ${portal.amends.period} mein bataya tha. Neeche ke figure naye hain.`,
      }, {
        'en-IN': 'Check the new figures against your bill. If they now agree, accept it; if the credit you already took was larger, the difference has to be given back.',
        'hi-IN': 'Naye figure apne bill se milaiye. Agar ab mil jayein to accept kijiye; agar pehle zyada credit le liya tha to antar wapas karna hoga.',
      }));
    }
    if (portal.itcAvailableOnPortal === false) {
      findings.push(finding('ITC_PORTAL_SAYS_UNAVAILABLE', 'WARNING', key, {
        'en-IN': `The government's own record marks the credit on bill ${number} as not available${portal.itcUnavailableReason === null ? '' : `: ${portal.itcUnavailableReason}`}.`,
        'hi-IN': `Sarkari record khud kehta hai ki bill ${number} par credit nahin milta${portal.itcUnavailableReason === null ? '' : `: ${portal.itcUnavailableReason}`}.`,
      }, {
        'en-IN': 'Take this one to whoever does your GST. Claiming against the portal\'s own note is the kind of thing that comes back as a notice.',
        'hi-IN': 'Ise apne GST wale ko dikhaiye. Portal ke apne note ke khilaf credit lena baad mein notice ban kar aata hai.',
      }));
    }
    if (status === 'CLOSE') {
      const fields = disagreements(evidence);
      findings.push(finding('ITC_FIGURES_DIFFER', 'WARNING', key, {
        'en-IN': `Bill ${number}: ${fields.map((row) => `${row.label['en-IN'].toLowerCase()} — yours ${row.ours ?? '—'}, theirs ${row.theirs ?? '—'}`).join('; ')}.`,
        'hi-IN': `Bill ${number}: ${fields.map((row) => `${row.label['hi-IN']} — aapka ${row.ours ?? '—'}, unka ${row.theirs ?? '—'}`).join('; ')}.`,
      }, {
        'en-IN': 'Compare the paper bill with these two figures. If the supplier reported less than the bill says, ask them to correct it before you claim the difference.',
        'hi-IN': 'Kagaz wala bill in dono figure se milaiye. Agar supplier ne kam bataya hai to antar lene se pehle unse theek karwaiye.',
      }));
    }

    const clean = status === 'EXACT' && !portal.reversed && portal.itcAvailableOnPortal !== false && portal.amends === null;

    if (refused) {
      sentence = {
        'en-IN': `You marked this ${DECISION_PLAIN[decision?.kind ?? 'PENDING']['en-IN'].toLowerCase()}${because}. It is not on this month's return.`,
        'hi-IN': `Aapne ise ${DECISION_PLAIN[decision?.kind ?? 'PENDING']['hi-IN']} kaha${because}. Yeh is mahine ke return par nahin hai.`,
      };
    } else if (clean) {
      outcome = 'CLAIM_NOW';
      claimable = safeAmount;
      sentence = {
        'en-IN': isCreditNote
          ? `Your credit note and ${supplier}'s filing agree. ${formatINR(totalTaxOf(claimable))} of GST comes back off this month's credit.`
          : `Your bill and ${supplier}'s filing agree. ${formatINR(totalTaxOf(claimable))} of GST goes on this month's return.`,
        'hi-IN': isCreditNote
          ? `Aapka credit note aur ${supplier} ki filing milte hain. ${formatINR(totalTaxOf(claimable))} GST is mahine ke credit se ghat jayega.`
          : `Aapka bill aur ${supplier} ki filing milte hain. ${formatINR(totalTaxOf(claimable))} GST is mahine ke return par jayega.`,
      };
    } else if (accepted) {
      outcome = 'CLAIM_AT_RISK';
      claimable = safeAmount;
      const withheld = subtract(creditable, safeAmount);
      findings.push(atRiskFinding(key, decision as ItcDecision, {
        'en-IN': `${formatINR(totalTaxOf(claimable))} is being claimed on a line that does not fully agree with the portal.`,
        'hi-IN': `${formatINR(totalTaxOf(claimable))} aisi line par liya ja raha hai jo portal se poori tarah nahin milti.`,
      }));
      sentence = totalTaxOf(withheld).minor > 0n
        ? {
          'en-IN': `Claimed at the lower of the two figures: ${formatINR(totalTaxOf(claimable))}. The remaining ${formatINR(totalTaxOf(withheld))} is not being claimed until the supplier corrects their filing.`,
          'hi-IN': `Dono mein se chhoti rakam li gayi: ${formatINR(totalTaxOf(claimable))}. Baaki ${formatINR(totalTaxOf(withheld))} tab tak nahin liya jayega jab tak supplier apni filing theek na kare.`,
        }
        : {
          'en-IN': `Claimed on your instruction: ${formatINR(totalTaxOf(claimable))}.`,
          'hi-IN': `Aapke kehne par liya gaya: ${formatINR(totalTaxOf(claimable))}.`,
        };
    } else {
      sentence = {
        'en-IN': `${formatINR(totalTaxOf(creditable))} of GST is held back until somebody answers the question on this line.`,
        'hi-IN': `${formatINR(totalTaxOf(creditable))} GST tab tak roka gaya hai jab tak is line ka jawab na mile.`,
      };
    }
  }

  const heldBack = subtract(creditable, claimable);

  return {
    key,
    status,
    statusLabel: MATCH_STATUS_PLAIN[status],
    book,
    portal,
    evidence,
    matchNote,
    outcome,
    outcomeLabel: OUTCOME_PLAIN[outcome],
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
    'hi-IN': `${decision.reason === '' ? 'Is faisle ke saath ek wajah likhi gayi thi.' : `Aapki wajah: ${decision.reason}.`} Agar portal par yeh bill kabhi nahin aata, to yeh credit byaj ke saath wapas karna padega — kagaz sambhal kar rakhiye.`,
  });

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

  const allOtherItc = bucket((line) => !isCreditNote(line) && line.book?.reverseCharge !== true && line.book?.imported !== true);
  const reverseChargeItc = bucket((line) => !isCreditNote(line) && line.book?.reverseCharge === true);
  const importItc = bucket((line) => !isCreditNote(line) && line.book?.imported === true);
  const reversedItc = bucket(isCreditNote);

  const reverseChargeLiability = sumAmounts(
    allBooks.filter((book) => book.reverseCharge && !book.reversed && book.kind === 'INVOICE').map((book) => book.amounts),
  );
  const exemptInwardValue: Money = {
    currency: 'INR',
    minor: allBooks
      .filter((book) => !book.reversed && totalTaxOf(book.amounts).minor === 0n)
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

  const held = sumAmounts(lines.map((line) => line.heldBack));

  return {
    period,
    allOtherItc,
    reverseChargeItc,
    importItc,
    reversedItc,
    reverseChargeLiability,
    exemptInwardValue,
    contributions,
    caution: totalTaxOf(held).minor === 0n
      ? {
        'en-IN': 'Every purchase this month is accounted for, so the credit here is the whole of it.',
        'hi-IN': 'Is mahine ki har kharid ka hisaab hai, isliye yahan poora credit dikh raha hai.',
      }
      : {
        'en-IN': `${formatINR(totalTaxOf(held))} of GST on your purchases is deliberately not in this figure, because those bills are still waiting on the supplier or on you. They are not lost — they come back on the month they are settled.`,
        'hi-IN': `Aapki kharid ka ${formatINR(totalTaxOf(held))} GST jaan-boojh kar is figure mein nahin hai, kyunki woh bill abhi supplier ya aap par ruke hain. Woh khoye nahin hain — jis mahine tay honge us mahine aa jayenge.`,
      },
  };
};

/** Adds one line's contribution to a running set of totals. Used by the workspace. */
export const accumulate = (total: TaxAmounts, line: TaxAmounts): TaxAmounts => addAmounts(total, line);

/**
 * Issue #30 [E30] — deciding which table of GSTR-1 a document belongs in.
 *
 * This is the whole judgement of the return, and it is deliberately a pure function over facts
 * already recorded on the document. It reads no database, calls no model and has no default
 * branch. Given the same document and the same threshold it returns the same table every time,
 * which is what lets a filing be re-derived from the books years later.
 *
 * The chain of questions, in the order the form itself asks them:
 *
 *   1. Is this a correction to something already filed? Then it goes in the matching amendment
 *      table, not in the ordinary one, and it names the period being corrected.
 *   2. Did the supply carry no GST at all — nil-rated, exempt, or outside GST? Then it is only
 *      counted, in the nil table.
 *   3. Did the goods leave India? Exports have their own table.
 *   4. Does the buyer have a GST number? Then it is a business sale, reported bill by bill. A
 *      supply to a special economic zone or a deemed export is a business sale too; the form keeps
 *      the difference in a flag on the row rather than in a separate table.
 *   5. Otherwise the buyer is a consumer. A large bill to a consumer in another state is reported
 *      one by one; everything else is added into a rate-wise total.
 *
 * Where a fact needed to answer one of those questions is missing, the function does not pick the
 * more likely answer. It returns `UNRESOLVED` with the question in a shopkeeper's words, and the
 * document goes to the exception workspace. That is the issue's "never silently guess" rule
 * expressed as code rather than as a comment.
 */
import { formatINR } from '@invoice/kernel';
import { GST_STATE_CODES, OVERSEAS_STATE_CODE } from '../../masters/src/validation.ts';
import type { B2clThresholdTable, ThresholdLookup } from './thresholds.ts';
import {
  type Bilingual,
  type Gstr1SectionId,
  type OutwardDocument,
  type ReturnFinding,
  type SourceRef,
  type SupplyTreatment,
} from './types.ts';

/** The tables an ordinary document can land in, before amendments are considered. */
type BaseSection = Extract<Gstr1SectionId, 'B2B' | 'B2CL' | 'B2CS' | 'CDNR' | 'CDNUR' | 'EXP' | 'NIL' | 'AT' | 'TXPD'>;

/** Each base table's amendment table, where the form has one. */
const AMENDMENT_OF: Partial<Record<BaseSection, Gstr1SectionId>> = {
  B2B: 'B2BA',
  B2CL: 'B2CLA',
  B2CS: 'B2CSA',
  CDNR: 'CDNRA',
  CDNUR: 'CDNURA',
};

export type Classification =
  | {
      readonly outcome: 'CLASSIFIED';
      readonly section: Gstr1SectionId;
      /** The table it would have been in had it not been a correction. Kept for the audit trail. */
      readonly baseSection: BaseSection;
      /** Why this table, in one sentence, printable next to the row. */
      readonly reason: Bilingual;
      /** Set only where the B2CL boundary actually decided the answer. */
      readonly thresholdUsed?: ThresholdLookup & { readonly found: true };
      readonly findings: readonly ReturnFinding[];
    }
  | {
      readonly outcome: 'UNRESOLVED';
      readonly findings: readonly ReturnFinding[];
    };

export interface ClassifyContext {
  readonly thresholds: B2clThresholdTable;
  /** `production` refuses an unreviewed threshold; `development` uses it so the workspace runs. */
  readonly mode: 'production' | 'development';
}

const NO_TAX: readonly SupplyTreatment[] = ['NIL_RATED', 'EXEMPT', 'NON_GST'];
const EXPORTS: readonly SupplyTreatment[] = ['EXPORT_WITH_TAX', 'EXPORT_WITHOUT_TAX'];
const REGISTERED_ONLY: readonly SupplyTreatment[] = ['SEZ_WITH_TAX', 'SEZ_WITHOUT_TAX', 'DEEMED_EXPORT'];
const NOTES: readonly OutwardDocument['kind'][] = ['CREDIT_NOTE', 'DEBIT_NOTE'];

export const sourceRefOf = (document: OutwardDocument): SourceRef => ({
  sourceKind: document.sourceKind,
  sourceId: document.sourceId,
  number: document.number,
  date: document.documentDate,
  voucherId: document.voucherId,
  amount: document.invoiceValue,
});

const stateName = (code: string | null): string =>
  code === null ? 'an unknown state' : (GST_STATE_CODES[code]?.name ?? `state code ${code}`);

const finding = (
  code: string,
  severity: ReturnFinding['severity'],
  message: Bilingual,
  whatToDo: Bilingual,
  document: OutwardDocument,
): ReturnFinding => ({
  code,
  severity,
  message,
  whatToDo,
  source: sourceRefOf(document),
  origin: 'CLASSIFICATION',
});

/**
 * Whether the supply crossed a state line.
 *
 * Returns `null` when the place of supply is not known, because "we do not know" is a third answer
 * and collapsing it into `false` would file an inter-state sale as a local one.
 */
export const isInterState = (document: OutwardDocument): boolean | null => {
  if (document.placeOfSupplyStateCode === null) return null;
  return document.placeOfSupplyStateCode !== document.supplierStateCode;
};

/**
 * The facts every document needs before any table can be chosen.
 *
 * Collected all at once rather than one at a time, so a preparer fixes four things in one pass —
 * the same rule the tax calculator follows.
 */
const missingFacts = (document: OutwardDocument): ReturnFinding[] => {
  const found: ReturnFinding[] = [];

  if (document.placeOfSupplyStateCode === null && document.originalDocument?.missing === true) {
    // Issue #232 — a note counts in the state its original bill counted in. Without that bill the
    // state is unknown, and guessing our own state is exactly how an inter-state note was misfiled.
    const original = document.originalDocument;
    found.push(finding(
      'GSTR1_NOTE_ORIGINAL_MISSING',
      'BLOCKING',
      {
        'en-IN': `Note ${document.number} corrects bill ${original.number} of ${original.date}, but that bill cannot be found in your sales, so the state the note counts in is not known.`,
        'hi-IN': `नोट ${document.number} बिल ${original.number} (${original.date}) को ठीक करता है, पर वह बिल आपकी बिक्री में नहीं मिल रहा, इसलिए पता नहीं कि नोट किस राज्य का माना जाएगा.`,
      },
      {
        'en-IN': `A note counts in the same state as the bill it corrects. Find bill ${original.number} and make sure it is in your sales; the note then takes its state from it.`,
        'hi-IN': `नोट उसी राज्य का होता है जिस राज्य का बिल था. बिल ${original.number} ढूँढिए और बिक्री में है यह पक्का कीजिए; फिर नोट वही राज्य ले लेगा.`,
      },
      document,
    ));
  } else if (document.placeOfSupplyStateCode === null) {
    found.push(finding(
      'GSTR1_NO_PLACE_OF_SUPPLY',
      'BLOCKING',
      {
        'en-IN': `Bill ${document.number} does not say which state the sale counts as made in.`,
        'hi-IN': `बिल ${document.number} पर नहीं लिखा कि बिक्री किस राज्य की मानी जाएगी.`,
      },
      {
        'en-IN': 'Open the bill and set the place of supply. It decides whether the tax is IGST or CGST plus SGST, so the return cannot be prepared without it.',
        'hi-IN': 'बिल खोलकर place of supply भरीए. इसी से तय होता है कि IGST लगेगा या CGST और SGST.',
      },
      document,
    ));
  } else if (
    GST_STATE_CODES[document.placeOfSupplyStateCode] === undefined
    // Issue #143 — an export's place of supply is outside India, which the return writes as 96.
    && !(isExport(document.treatment) && document.placeOfSupplyStateCode === OVERSEAS_STATE_CODE)
  ) {
    found.push(finding(
      'GSTR1_UNKNOWN_STATE',
      'BLOCKING',
      {
        'en-IN': `Bill ${document.number} carries state code ${document.placeOfSupplyStateCode}, which is not a GST state code.`,
        'hi-IN': `बिल ${document.number} पर राज्य कोड ${document.placeOfSupplyStateCode} है, जो GST का राज्य कोड नहीं है.`,
      },
      {
        'en-IN': 'Correct the state on the bill. The government file will be rejected with an unknown code in it.',
        'hi-IN': 'बिल पर राज्य ठीक कीजिए. ग़लत कोड के साथ सरकारी फ़ाइल रिजेक्ट हो जाएगी.',
      },
      document,
    ));
  }

  if (document.counterpartyGstin === null && !document.unregisteredConfirmed) {
    found.push(finding(
      'GSTR1_GSTIN_NOT_CONFIRMED',
      'BLOCKING',
      {
        'en-IN': `${document.partyName} has no GST number on bill ${document.number}, and nobody has confirmed that they do not have one.`,
        'hi-IN': `बिल ${document.number} पर ${document.partyName} का GST नंबर नहीं है, और किसी ने यह कन्फ़र्म भी नहीं किया कि उनके पास है ही नहीं.`,
      },
      {
        'en-IN': 'Either type the buyer\'s GST number, or tick that this customer is not registered. A sale to a business and a sale to a consumer go on different parts of the return, so the difference cannot be guessed.',
        'hi-IN': 'या तो ख़रीदार का GST नंबर लिखिए, या टिक कीजिए कि ग्राहक रजिस्टर्ड नहीं है. दोनों रिटर्न के अलग हिस्सों में जाते हैं.',
      },
      document,
    ));
  }

  if (document.lines.length === 0) {
    found.push(finding(
      'GSTR1_NO_LINES',
      'BLOCKING',
      {
        'en-IN': `Bill ${document.number} has no lines on it.`,
        'hi-IN': `बिल ${document.number} पर कोई लाइन नहीं है.`,
      },
      { 'en-IN': 'Check the bill. An empty bill cannot be reported.', 'hi-IN': 'बिल देखिए. ख़ाली बिल रिपोर्ट नहीं हो सकता.' },
      document,
    ));
  }

  if (NOTES.includes(document.kind) && document.originalDocument === undefined) {
    found.push(finding(
      'GSTR1_NOTE_WITHOUT_ORIGINAL',
      'BLOCKING',
      {
        'en-IN': `Credit or debit note ${document.number} does not say which bill it adjusts.`,
        'hi-IN': `क्रेडिट या डेबिट नोट ${document.number} पर नहीं लिखा कि किस बिल को ठीक कर रहा है.`,
      },
      {
        'en-IN': 'Link the note to the original bill. The return has to name the bill being adjusted.',
        'hi-IN': 'नोट को असली बिल से जोड़िए. रिटर्न में उस बिल का नाम देना ज़रूरी है.',
      },
      document,
    ));
  }

  return found;
};

const reason = (english: string, hindi: string): Bilingual => ({ 'en-IN': english, 'hi-IN': hindi });

const classified = (
  section: BaseSection,
  document: OutwardDocument,
  because: Bilingual,
  findings: readonly ReturnFinding[],
  thresholdUsed?: ThresholdLookup & { found: true },
): Classification => {
  const amendment = document.amends === undefined ? undefined : AMENDMENT_OF[section];
  return {
    outcome: 'CLASSIFIED',
    section: amendment ?? section,
    baseSection: section,
    reason: amendment === undefined
      ? because
      : reason(
          `${because['en-IN']} It is a correction to ${document.amends?.number} from ${document.amends?.period}, so it goes in the corrections table.`,
          `${because['hi-IN']} यह ${document.amends?.period} के बिल ${document.amends?.number} का सुधार है, इसलिए सुधारों वाली टेबल में जाएगा.`,
        ),
    ...(thresholdUsed === undefined ? {} : { thresholdUsed }),
    findings,
  };
};

/**
 * Which GSTR-1 table this document belongs in, and why.
 *
 * The `findings` on a `CLASSIFIED` result are warnings worth showing — an odd but workable
 * document. Anything that makes the table itself unknowable comes back as `UNRESOLVED`.
 */
export const classifyDocument = (document: OutwardDocument, context: ClassifyContext): Classification => {
  const blocking = missingFacts(document);
  if (blocking.length > 0) return { outcome: 'UNRESOLVED', findings: blocking };

  const warnings: ReturnFinding[] = [];
  const registered = document.counterpartyGstin !== null;
  const interState = isInterState(document);

  if (document.kind === 'ADVANCE_ADJUSTED') {
    return classified('TXPD', document, reason(
      'Tax paid on an advance in an earlier month, now set against the bill it paid for.',
      'पिछले महीने के एडवांस पर दिया टैक्स, अब उस बिल में जुड़ा.',
    ), warnings);
  }

  if (document.kind === 'ADVANCE_RECEIPT' || document.kind === 'REFUND_VOUCHER') {
    return classified('AT', document, reason(
      'Money received before the goods went out, which the form counts on its own.',
      'सामान जाने से पहले मिला पैसा, जिसे फ़ॉर्म अलग गिनता है.',
    ), warnings);
  }

  if (NO_TAX.includes(document.treatment)) {
    return classified('NIL', document, reason(
      'This supply carried no GST, so the form only counts its value.',
      'इस बिक्री पर GST नहीं लगा, इसलिए फ़ॉर्म सिर्फ़ उसकी वैल्यू गिनता है.',
    ), warnings);
  }

  if (EXPORTS.includes(document.treatment)) {
    if (NOTES.includes(document.kind)) {
      return classified('CDNUR', document, reason(
        'A note against an export, which the form keeps with the other notes to buyers without a GST number.',
        'एक्सपोर्ट के अगेंस्ट नोट, जिसे फ़ॉर्म बिना GST नंबर वाले ख़रीदारों के नोटों के साथ रखता है.',
      ), warnings);
    }
    return classified('EXP', document, reason(
      'The goods or services left India, which the form reports on its own.',
      'सामान या सर्विस भारत के बाहर गया, जिसे फ़ॉर्म अलग रिपोर्ट करता है.',
    ), warnings);
  }

  if (REGISTERED_ONLY.includes(document.treatment)) {
    if (!registered) {
      return {
        outcome: 'UNRESOLVED',
        findings: [finding(
          'GSTR1_SEZ_WITHOUT_GSTIN',
          'BLOCKING',
          {
            'en-IN': `Bill ${document.number} is marked as a supply to a special economic zone or a deemed export, but the buyer has no GST number on it.`,
            'hi-IN': `बिल ${document.number} स्पेशल इकोनॉमिक ज़ोन या डीम्ड एक्सपोर्ट के रूप में है, पर ख़रीदार का GST नंबर नहीं है.`,
          },
          {
            'en-IN': 'These buyers are always registered. Add the buyer\'s GST number, or change how the bill is marked.',
            'hi-IN': 'ऐसे ख़रीदार हमेशा रजिस्टर्ड होते हैं. GST नंबर भरीए, या बिल की मार्किंग बदलीए.',
          },
          document,
        )],
      };
    }
    if (NOTES.includes(document.kind)) {
      return classified('CDNR', document, reason(
        'A note against a supply to a buyer with a GST number.',
        'GST नंबर वाले ख़रीदार की सप्लाई के अगेंस्ट नोट.',
      ), warnings);
    }
    return classified('B2B', document, reason(
      'A supply to a special economic zone or a deemed export. The form reports it with the business sales and marks what kind it is.',
      'स्पेशल इकोनॉमिक ज़ोन या डीम्ड एक्सपोर्ट की सप्लाई. फ़ॉर्म इसे बिज़नेस बिक्री के साथ, अपनी मार्किंग के साथ दिखाता है.',
    ), warnings);
  }

  if (registered) {
    if (NOTES.includes(document.kind)) {
      return classified('CDNR', document, reason(
        `A ${document.kind === 'CREDIT_NOTE' ? 'credit' : 'debit'} note to ${document.partyName}, a buyer with a GST number, so it is reported one by one against the original bill.`,
        `${document.partyName} को ${document.kind === 'CREDIT_NOTE' ? 'क्रेडिट' : 'डेबिट'} नोट, जिनके पास GST नंबर है, इसलिए असली बिल के साथ एक-एक करके रिपोर्ट होगा.`,
      ), warnings);
    }
    return classified('B2B', document, reason(
      `${document.partyName} has a GST number, so this bill is reported one by one and the buyer will see it against their own credit.`,
      `${document.partyName} के पास GST नंबर है, इसलिए यह बिल एक-एक करके रिपोर्ट होगा और उन्हें अपने क्रेडिट में दिखेगा.`,
    ), warnings);
  }

  // From here the buyer is a confirmed consumer. Only the state and the value are left to decide.
  if (interState === false) {
    return classified('B2CS', document, reason(
      `A sale to a customer in ${stateName(document.placeOfSupplyStateCode)}, your own state, so it is added into the rate-wise total rather than listed.`,
      `${stateName(document.placeOfSupplyStateCode)} — आपके अपने राज्य — के ग्राहक को बिक्री, इसलिए रेट के हिसाब से टोटल में जुड़ेगी.`,
    ), warnings);
  }

  const lookup = context.thresholds.find(document.companyId, document.documentDate, context.mode);
  if (!lookup.found) {
    return {
      outcome: 'UNRESOLVED',
      findings: [finding(
        lookup.reason === 'NOT_REVIEWED' ? 'GSTR1_THRESHOLD_NOT_REVIEWED' : 'GSTR1_THRESHOLD_MISSING',
        'BLOCKING',
        {
          'en-IN': `Bill ${document.number} is a ${formatINR(document.invoiceValue)} sale to a customer in ${stateName(document.placeOfSupplyStateCode)} with no GST number. Above a certain value such a bill must be listed one by one, and this app does not yet hold a checked figure for where that line sits on ${document.documentDate}.`,
          'hi-IN': `बिल ${document.number} ${stateName(document.placeOfSupplyStateCode)} के बिना GST नंबर वाले ग्राहक को ${formatINR(document.invoiceValue)} की बिक्री है. एक वैल्यू से ऊपर ऐसे बिल अलग-अलग देने होते हैं, और ${document.documentDate} के लिए वह आँकड़ा अभी चेक नहीं हुआ है.`,
        },
        {
          'en-IN': 'Ask your accountant what the limit is for this month and enter it once, or wait for the checked figure. The app will not choose between the two tables on its own.',
          'hi-IN': 'अपने अकाउंटेंट से इस महीने की लिमिट पूछकर एक बार भर दीजिए, या चेक किए हुए आँकड़े का इंतज़ार कीजिए. ऐप ख़ुद फ़ैसला नहीं करेगा.',
        },
        document,
      )],
    };
  }

  // Issue #325 — a note follows its bill: judged on the bill's total when that is known, not on
  // the note's own (a ₹5,000 note against a ₹1,18,944 B2CL bill is CDNUR, not B2CS).
  const judgedValue = NOTES.includes(document.kind) && document.originalDocument?.invoiceValue !== undefined
    ? document.originalDocument.invoiceValue
    : document.invoiceValue;
  const large = judgedValue.minor > lookup.threshold.aboveValue.minor;

  if (lookup.basis === 'BUSINESS_DECLARED') {
    warnings.push(finding(
      'GSTR1_THRESHOLD_BUSINESS_DECLARED',
      'INFORMATION',
      {
        'en-IN': `The ${formatINR(lookup.threshold.aboveValue)} limit used for bill ${document.number} is one your business set, not one checked against a notification. ${lookup.declaredBy} entered it.`,
        'hi-IN': `बिल ${document.number} पर लगी ${formatINR(lookup.threshold.aboveValue)} की लिमिट आपके बिज़नेस की सेट की हुई है, नोटिफ़िकेशन से चेक नहीं. ${lookup.declaredBy} ने भरी थी.`,
      },
      {
        'en-IN': 'Nothing to do now. It is recorded this way so the return can be explained later.',
        'hi-IN': 'अभी कुछ नहीं करना. बाद में रिटर्न समझाने के लिए ऐसे लिखा गया है.',
      },
      document,
    ));
  }

  if (NOTES.includes(document.kind)) {
    // A note to a consumer follows its bill: it is listed one by one only where the bill would
    // have been. Below the line it is netted off inside the rate-wise total instead.
    return classified(large ? 'CDNUR' : 'B2CS', document, reason(
      large
        ? `A note on a large out-of-state sale to a customer without a GST number, so it is listed against the original bill.`
        : `A note on a small out-of-state sale to a customer without a GST number, so it is taken off the rate-wise total.`,
      large
        ? `बिना GST नंबर वाले दूसरे राज्य के ग्राहक की बड़ी बिक्री का नोट, इसलिए असली बिल के साथ दिया जाएगा.`
        : `बिना GST नंबर वाले दूसरे राज्य के ग्राहक की छोटी बिक्री का नोट, इसलिए रेट वाले टोटल में से घटा जाएगा.`,
    ), warnings, lookup);
  }

  return classified(large ? 'B2CL' : 'B2CS', document, reason(
    large
      ? `${formatINR(document.invoiceValue)} to a customer in ${stateName(document.placeOfSupplyStateCode)} with no GST number, which is above the ${formatINR(lookup.threshold.aboveValue)} limit, so it is listed on its own.`
      : `${formatINR(document.invoiceValue)} to a customer in ${stateName(document.placeOfSupplyStateCode)} with no GST number, which is under the ${formatINR(lookup.threshold.aboveValue)} limit, so it is added into the rate-wise total.`,
    large
      ? `${stateName(document.placeOfSupplyStateCode)} के बिना GST नंबर वाले ग्राहक को ${formatINR(document.invoiceValue)}, जो ${formatINR(lookup.threshold.aboveValue)} से ऊपर है, इसलिए अलग दिखेगा.`
      : `${stateName(document.placeOfSupplyStateCode)} के बिना GST नंबर वाले ग्राहक को ${formatINR(document.invoiceValue)}, जो ${formatINR(lookup.threshold.aboveValue)} से कम है, इसलिए रेट वाले टोटल में जुड़ेगा.`,
  ), warnings, lookup);
};

/** Exported for the screens that explain a state code to a person. */
export const stateNameOf = stateName;

/** Exported so the export writer and the reconciliation share one idea of "no tax". */
export const carriesNoTax = (treatment: SupplyTreatment): boolean => NO_TAX.includes(treatment);
export const isExport = (treatment: SupplyTreatment): boolean => EXPORTS.includes(treatment);
export const isNote = (kind: OutwardDocument['kind']): boolean => NOTES.includes(kind);

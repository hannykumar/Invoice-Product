/**
 * Issue #296 — the composition scheme: what the law lets a composition dealer do, what they owe,
 * and the two statements they file (CMP-08 every quarter, GSTR-4 once a year).
 *
 * # Rule 0 — what this file stands on
 *
 * Verified against the text of the sources named below, as found through search results from
 * `cbic-gst.gov.in`, `gstcouncil.gov.in` and `taxinformation.cbic.gov.in`. **Those hosts could not be
 * opened from the build sandbox**, so the full notification PDFs were not read end to end; every
 * item marked "NOT VERIFIED" below is carried as a `DRAFT` entry and is shown to the owner as
 * something to confirm, never as checked law (the same bargain as `thresholds.ts` and the rate
 * table).
 *
 * | Rule | Source | Effect here |
 * | --- | --- | --- |
 * | A composition dealer collects no tax from the buyer | CGST Act s.10(4) | no GST on any bill; `compositionChargingApproved` in the rules engine already decides this |
 * | The bill is a **bill of supply**, not a tax invoice | CGST Rule 49 (and s.31(3)(c)) | document type, own number series |
 * | The words "composition taxable person, not eligible to collect tax on supplies" at the top of the bill | CGST Rule 5 (the issue text cites 5(1)(g); the clause letter is NOT VERIFIED) | printed by `COMPOSITION_LEGEND` |
 * | No input tax credit | CGST Act s.10(4) read with s.17 | purchases post their GST into cost (see `packages/purchasing`) |
 * | No inter-State outward supply of goods | CGST Act s.10(2)(c) | refused with a plain reason by `packages/gst-calc` |
 * | No supply through an e-commerce operator that must collect TCS | CGST Act s.10(2)(d) | the sale screen has no e-commerce channel; stated as a refusal reason, not enforced by data |
 * | Services-only composition at 6% up to ₹50 lakh | CGST Act s.10(2A); Notification 2/2019-Central Tax (Rate), 7 March 2019 | category `SERVICES_ONLY` |
 * | Goods limit ₹1.5 crore; ₹75 lakh in the special-category States | Notification 14/2019-Central Tax, 7 March 2019 (supersedes 8/2017) | `compositionLimitFor` — which States count as special-category is NOT VERIFIED: CBIC documents disagree on Assam, Himachal Pradesh and Uttarakhand |
 * | Rates 1% (manufacturer, trader), 5% (restaurant), 6% (other services) | CGST Rules 2017 Rule 7; Notification 2/2019-CT(Rate) for the 6% | `COMPOSITION_RATES` — the 2025/2026 amendment history is NOT VERIFIED |
 * | CMP-08, quarterly, by the 18th of the month after the quarter | CGST Rules 2017 Rule 62 | `cmp08DueDate` |
 * | GSTR-4, yearly, by 30 June after the year (30 April before FY 2024-25) | Notification 12/2024-Central Tax, 10 July 2024 (as reported in secondary sources — NOT VERIFIED against the gazette) | `gstr4DueDate` |
 *
 * Not built, on purpose, and said plainly to the owner: interest and late fee on a late CMP-08 or
 * GSTR-4, ITC-01 on leaving the scheme (Rule 44), tax on reverse-charge purchases beyond a figure
 * the owner enters by hand, and the portal's own upload JSON for either form. The statements below
 * are **working papers** for the owner or their accountant to file on the GST portal.
 */
import { compareDates, invalid, type IsoDate } from '@invoice/kernel';
import type { Bilingual } from './types.ts';

// ------------------------------------------------------------------ what a composition bill says

/** The words Rule 5 requires at the top of every bill of supply a composition dealer issues. */
export const COMPOSITION_LEGEND = 'Composition taxable person, not eligible to collect tax on supplies';

export const COMPOSITION_LEGEND_HI = 'कम्पोज़िशन करदाता, बिक्री पर टैक्स लेने के लिए पात्र नहीं';

/** The bill's own title and the number series it needs. A bill of supply is not a tax invoice. */
export const BILL_OF_SUPPLY_SERIES_PREFIX = 'BOS';

// ------------------------------------------------------------------ the dated table

/**
 * Which kind of composition dealer this is. It decides the rate and the turnover limit.
 *
 * `SERVICES_ONLY` is the s.10(2A) option under Notification 2/2019-CT(Rate); a business that sells
 * goods as well can only use the ordinary s.10(1) scheme, so a services-only choice is refused for
 * a business that has recorded goods sales (checked by the caller from the books).
 */
export type CompositionCategory = 'MANUFACTURER_OR_TRADER' | 'RESTAURANT' | 'SERVICES_ONLY';

export const COMPOSITION_CATEGORIES: readonly CompositionCategory[] = ['MANUFACTURER_OR_TRADER', 'RESTAURANT', 'SERVICES_ONLY'];

export interface CompositionRateEntry {
  readonly category: CompositionCategory;
  /** The whole rate, in basis points of turnover. Half is central tax and half State tax. */
  readonly rateBasisPoints: bigint;
  readonly effectiveFrom: IsoDate;
  readonly effectiveTo: IsoDate | null;
  readonly sourceRef: string;
  /** `DRAFT` until a person has compared it with the notification. See the header. */
  readonly reviewState: 'DRAFT' | 'APPROVED';
  readonly description: Bilingual;
}

/**
 * **Fixture data, not a statement of Indian law.** The figures are the ones every secondary source
 * agrees on; the entries stay `DRAFT` until issue #54's register carries the notification.
 */
export const COMPOSITION_RATES: readonly CompositionRateEntry[] = Object.freeze([
  {
    category: 'MANUFACTURER_OR_TRADER', rateBasisPoints: 100n, effectiveFrom: '2017-07-01' as IsoDate, effectiveTo: null,
    sourceRef: 'cgst-rules-2017-r7; pending:#54/composition-rate-goods', reviewState: 'DRAFT',
    description: { 'en-IN': '1% of turnover (half central tax, half State tax) for a manufacturer or a trader.', 'hi-IN': 'निर्माता या व्यापारी के लिए टर्नओवर का 1% (आधा सेंट्रल, आधा राज्य टैक्स)।' },
  },
  {
    category: 'RESTAURANT', rateBasisPoints: 500n, effectiveFrom: '2017-07-01' as IsoDate, effectiveTo: null,
    sourceRef: 'cgst-rules-2017-r7; pending:#54/composition-rate-restaurant', reviewState: 'DRAFT',
    description: { 'en-IN': '5% of turnover for a restaurant that does not serve alcohol.', 'hi-IN': 'शराब न परोसने वाले रेस्तरां के लिए टर्नओवर का 5%।' },
  },
  {
    category: 'SERVICES_ONLY', rateBasisPoints: 600n, effectiveFrom: '2019-04-01' as IsoDate, effectiveTo: null,
    sourceRef: 'notification-2-2019-ct-rate; cgst-act-s10-2A; pending:#54/composition-rate-services', reviewState: 'DRAFT',
    description: { 'en-IN': '6% of turnover for a business that only supplies services (up to ₹50 lakh).', 'hi-IN': 'सिर्फ़ सेवाएँ देने वाले बिज़नेस के लिए टर्नओवर का 6% (₹50 लाख तक)।' },
  },
]);

/** The rate the law is understood to set for `category` on `on`, to suggest — never to impose. */
export const suggestedCompositionRate = (category: CompositionCategory, on: IsoDate): CompositionRateEntry | undefined =>
  COMPOSITION_RATES.find((entry) =>
    entry.category === category && compareDates(on, entry.effectiveFrom) >= 0 && (entry.effectiveTo === null || compareDates(on, entry.effectiveTo) <= 0));

/**
 * The States Notification 14/2019-CT is understood to give the lower ₹75 lakh goods limit. **NOT
 * VERIFIED**: the CBIC update of May 2019 lists these eight; a CBIC FAQ lists a different set. The
 * limit is therefore only ever used to warn, never to refuse a bill.
 */
export const SPECIAL_CATEGORY_STATE_CODES: readonly string[] = ['12', '14', '17', '15', '13', '11', '16', '05'];

export interface CompositionLimit {
  /** Aggregate turnover above this, in paise, ends eligibility (s.10(1), s.10(3)). */
  readonly limitPaise: bigint;
  readonly sourceRef: string;
  readonly verified: false;
}

export const compositionLimitFor = (category: CompositionCategory, stateCode: string): CompositionLimit => {
  if (category === 'SERVICES_ONLY') {
    return { limitPaise: 5_000_000_00n, sourceRef: 'cgst-act-s10-2A; notification-2-2019-ct-rate', verified: false };
  }
  return SPECIAL_CATEGORY_STATE_CODES.includes(stateCode)
    ? { limitPaise: 7_500_000_00n, sourceRef: 'notification-14-2019-ct', verified: false }
    : { limitPaise: 15_000_000_00n, sourceRef: 'notification-14-2019-ct', verified: false };
};

// ------------------------------------------------------------------ the limit watch

export type LimitStanding = 'WITHIN' | 'NEAR' | 'CROSSED';

export interface LimitWatch {
  readonly standing: LimitStanding;
  readonly turnoverPaise: bigint;
  readonly limitPaise: bigint;
  readonly crossedOn: IsoDate | null;
  readonly message: Bilingual;
}

/**
 * Where this year's sales stand against the limit. Sales are given oldest first so the day the
 * limit was crossed can be named: s.10(3) takes a dealer out of the scheme from that day, and every
 * bill after it has to be a tax invoice. We warn from 80%; we never refuse a bill, because whether
 * the aggregate counts exempt or inter-State supplies is NOT VERIFIED here.
 */
export const watchLimit = (
  sales: readonly { readonly date: IsoDate; readonly valuePaise: bigint }[],
  limit: CompositionLimit,
): LimitWatch => {
  let running = 0n;
  let crossedOn: IsoDate | null = null;
  for (const sale of [...sales].sort((a, b) => a.date.localeCompare(b.date))) {
    running += sale.valuePaise;
    if (crossedOn === null && running > limit.limitPaise) crossedOn = sale.date;
  }
  const standing: LimitStanding = crossedOn !== null ? 'CROSSED' : running * 10n >= limit.limitPaise * 8n ? 'NEAR' : 'WITHIN';
  const lakh = (paise: bigint): string => `₹${(Number(paise / 100n) / 100_000).toLocaleString('en-IN')} lakh`;
  return {
    standing, turnoverPaise: running, limitPaise: limit.limitPaise, crossedOn,
    message: standing === 'CROSSED'
      ? {
        'en-IN': `Your sales this year have gone past ${lakh(limit.limitPaise)} (on ${crossedOn}). The composition scheme ends from the day the limit is crossed, and bills after that day need to be tax invoices. Please speak to your accountant and change the scheme in Business details.`,
        'hi-IN': `इस साल आपकी बिक्री ${lakh(limit.limitPaise)} से ऊपर चली गई (${crossedOn} को)। जिस दिन सीमा पार होती है उसी दिन से कम्पोज़िशन स्कीम खत्म हो जाती है, और उसके बाद के बिल टैक्स इनवॉइस होने चाहिए। कृपया अपने अकाउंटेंट से बात करें और Business details में स्कीम बदलें।`,
      }
      : standing === 'NEAR'
        ? {
          'en-IN': `Your sales this year are close to the ${lakh(limit.limitPaise)} limit for the composition scheme. If you cross it, the scheme ends from that day.`,
          'hi-IN': `इस साल की बिक्री कम्पोज़िशन स्कीम की ${lakh(limit.limitPaise)} की सीमा के क़रीब है। सीमा पार होते ही स्कीम उसी दिन से खत्म हो जाएगी।`,
        }
        : { 'en-IN': `Your sales this year are within the ${lakh(limit.limitPaise)} limit.`, 'hi-IN': `इस साल की बिक्री ${lakh(limit.limitPaise)} की सीमा के अंदर है।` },
  };
};

// ------------------------------------------------------------------ the money

/**
 * One half of the levy: `turnover × (rate ÷ 2)`, rounded to the nearest paisa, half up. Central and
 * State tax are computed separately and are always equal, so the two halves printed on CMP-08 never
 * differ by a paisa.
 */
const halfLevy = (turnoverPaise: bigint, rateBasisPoints: bigint): bigint =>
  (turnoverPaise * rateBasisPoints + 10_000n) / 20_000n;

export const validateCompositionRate = (rateBasisPoints: bigint): void => {
  if (rateBasisPoints <= 0n || rateBasisPoints > 1_000n) {
    throw invalid('COMPOSITION_RATE_RANGE', 'A composition rate is a percentage of turnover between 0.01% and 10%.');
  }
  if (rateBasisPoints % 2n !== 0n) {
    throw invalid('COMPOSITION_RATE_HALVES', 'A composition rate is shared equally between central and State tax, so it has to split into two equal halves.');
  }
};

export interface Levy {
  readonly turnoverPaise: bigint;
  readonly rateBasisPoints: bigint;
  readonly centralPaise: bigint;
  readonly statePaise: bigint;
  readonly totalPaise: bigint;
}

export const levyOn = (turnoverPaise: bigint, rateBasisPoints: bigint): Levy => {
  validateCompositionRate(rateBasisPoints);
  const base = turnoverPaise < 0n ? 0n : turnoverPaise;
  const half = halfLevy(base, rateBasisPoints);
  return { turnoverPaise: base, rateBasisPoints, centralPaise: half, statePaise: half, totalPaise: half * 2n };
};

// ------------------------------------------------------------------ quarters and due dates

export interface Quarter {
  /** e.g. "2026-27" */
  readonly financialYear: string;
  /** 1 = April–June … 4 = January–March */
  readonly number: 1 | 2 | 3 | 4;
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly label: string;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const pad = (n: number): string => String(n).padStart(2, '0');

export const quarterOf = (date: IsoDate): Quarter => {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const startYear = month >= 4 ? year : year - 1;
  const number = (month >= 4 && month <= 6 ? 1 : month >= 7 && month <= 9 ? 2 : month >= 10 && month <= 12 ? 3 : 4) as 1 | 2 | 3 | 4;
  const firstMonth = [4, 7, 10, 1][number - 1] as number;
  const lastMonth = firstMonth + 2;
  const yearOfFirst = firstMonth >= 4 ? startYear : startYear + 1;
  const lastDay = new Date(Date.UTC(yearOfFirst, lastMonth, 0)).getUTCDate();
  return {
    financialYear: `${startYear}-${pad((startYear + 1) % 100)}`,
    number,
    from: `${yearOfFirst}-${pad(firstMonth)}-01` as IsoDate,
    to: `${yearOfFirst}-${pad(lastMonth)}-${pad(lastDay)}` as IsoDate,
    label: `${MONTH_NAMES[firstMonth - 1]}–${MONTH_NAMES[lastMonth - 1]} ${yearOfFirst}`,
  };
};

/** Rule 62: CMP-08 is due by the 18th of the month after the quarter ends. */
export const cmp08DueDate = (quarter: Quarter): IsoDate => {
  const endYear = Number(quarter.to.slice(0, 4));
  const endMonth = Number(quarter.to.slice(5, 7));
  const dueYear = endMonth === 12 ? endYear + 1 : endYear;
  const dueMonth = endMonth === 12 ? 1 : endMonth + 1;
  return `${dueYear}-${pad(dueMonth)}-18` as IsoDate;
};

/** GSTR-4: 30 June after the year (30 April for years before 2024-25). NOT VERIFIED against the gazette. */
export const gstr4DueDate = (financialYear: string): IsoDate => {
  const start = Number(financialYear.slice(0, 4));
  return (start >= 2024 ? `${start + 1}-06-30` : `${start + 1}-04-30`) as IsoDate;
};

// ------------------------------------------------------------------ CMP-08

/** A sale, credit note or debit note as the quarterly statement reads it. */
export interface CompositionDocument {
  readonly id: string;
  readonly number: string;
  readonly date: IsoDate;
  readonly kind: 'BILL_OF_SUPPLY' | 'CREDIT_NOTE' | 'DEBIT_NOTE';
  /** What was charged for the goods or services, in paise — no tax is ever added. */
  readonly valuePaise: bigint;
  /** Exempt, nil-rated and non-GST sales appear on the form but carry no composition tax. */
  readonly taxable: boolean;
}

export interface Cmp08 {
  readonly quarter: Quarter;
  readonly dueDate: IsoDate;
  readonly rateBasisPoints: bigint;
  /** Row 1 of the form — all outward supplies, exempt ones included, net of credit notes. */
  readonly outwardValuePaise: bigint;
  /** The part of row 1 tax is worked out on. */
  readonly levy: Levy;
  /** Row 2 — tax on reverse-charge purchases, entered by hand; this product does not work it out. */
  readonly reverseChargeTaxPaise: bigint;
  readonly interestPaise: bigint;
  readonly lateFeePaise: bigint;
  readonly totalPayablePaise: bigint;
  readonly documents: readonly string[];
  readonly notes: readonly Bilingual[];
}

const signed = (doc: CompositionDocument): bigint => (doc.kind === 'CREDIT_NOTE' ? -doc.valuePaise : doc.valuePaise);

export const buildCmp08 = (input: {
  readonly quarter: Quarter;
  readonly documents: readonly CompositionDocument[];
  readonly rateBasisPoints: bigint;
  readonly reverseChargeTaxPaise?: bigint;
}): Cmp08 => {
  const inQuarter = input.documents.filter((doc) => compareDates(doc.date, input.quarter.from) >= 0 && compareDates(doc.date, input.quarter.to) <= 0);
  const outward = inQuarter.reduce((sum, doc) => sum + signed(doc), 0n);
  const taxable = inQuarter.filter((doc) => doc.taxable).reduce((sum, doc) => sum + signed(doc), 0n);
  const levy = levyOn(taxable, input.rateBasisPoints);
  const rcm = input.reverseChargeTaxPaise ?? 0n;
  const notes: Bilingual[] = [];
  if (taxable < 0n) {
    notes.push({
      'en-IN': 'Credit notes this quarter are larger than the sales, so no tax is due for it. A refund is not claimed from this statement; speak to your accountant about the excess.',
      'hi-IN': 'इस तिमाही के क्रेडिट नोट बिक्री से ज़्यादा हैं, इसलिए कोई टैक्स नहीं बनता। इस स्टेटमेंट से रिफ़ंड नहीं माँगा जाता; ज़्यादा रकम के लिए अपने अकाउंटेंट से बात करें।',
    });
  }
  notes.push({
    'en-IN': 'Interest and late fee are not worked out here. If this statement is filed after the due date, add them on the GST portal.',
    'hi-IN': 'ब्याज और लेट फ़ीस यहाँ नहीं निकाली जाती। देर से फ़ाइल करें तो GST पोर्टल पर जोड़ें।',
  });
  return {
    quarter: input.quarter, dueDate: cmp08DueDate(input.quarter), rateBasisPoints: input.rateBasisPoints,
    outwardValuePaise: outward, levy, reverseChargeTaxPaise: rcm, interestPaise: 0n, lateFeePaise: 0n,
    totalPayablePaise: levy.totalPaise + rcm, documents: inQuarter.map((doc) => doc.id), notes,
  };
};

// ------------------------------------------------------------------ GSTR-4

export interface Gstr4 {
  readonly financialYear: string;
  readonly dueDate: IsoDate;
  readonly quarters: readonly Cmp08[];
  /** Tax already declared quarter by quarter, and the year's total. */
  readonly taxPayablePaise: bigint;
  /** What the four statements said was payable, set against what the books say was paid. */
  readonly taxPaidPaise: bigint | null;
  readonly differencePaise: bigint | null;
  /** Inward supplies for the year (purchases), by kind. Informational: composition tax is on turnover only. */
  readonly inward: { readonly fromRegisteredPaise: bigint; readonly fromUnregisteredPaise: bigint; readonly reverseChargePaise: bigint };
  readonly findings: readonly Bilingual[];
  readonly notes: readonly Bilingual[];
}

export const buildGstr4 = (input: {
  readonly financialYear: string;
  readonly documents: readonly CompositionDocument[];
  /** The rate in force in each quarter, oldest first (a dealer may change category on 1 April only). */
  readonly rateBasisPoints: bigint;
  readonly reverseChargeTaxByQuarter?: Readonly<Record<number, bigint>>;
  readonly taxPaidPaise?: bigint | null;
  readonly inward?: { readonly fromRegisteredPaise?: bigint; readonly fromUnregisteredPaise?: bigint; readonly reverseChargePaise?: bigint };
}): Gstr4 => {
  const startYear = Number(input.financialYear.slice(0, 4));
  const quarters = ([1, 2, 3, 4] as const).map((number) => {
    const first = [`${startYear}-04-01`, `${startYear}-07-01`, `${startYear}-10-01`, `${startYear + 1}-01-01`][number - 1] as IsoDate;
    return buildCmp08({
      quarter: quarterOf(first), documents: input.documents, rateBasisPoints: input.rateBasisPoints,
      reverseChargeTaxPaise: input.reverseChargeTaxByQuarter?.[number] ?? 0n,
    });
  });
  const payable = quarters.reduce((sum, q) => sum + q.totalPayablePaise, 0n);
  const paid = input.taxPaidPaise ?? null;
  const findings: Bilingual[] = [];
  if (paid !== null && paid !== payable) {
    findings.push({
      'en-IN': paid < payable
        ? 'The tax paid through the year is less than the four quarterly statements add up to. Pay the difference before filing the yearly return.'
        : 'More tax was paid through the year than the four quarterly statements add up to. Check the payments before filing.',
      'hi-IN': paid < payable
        ? 'साल भर में भरा टैक्स चारों तिमाही स्टेटमेंट के जोड़ से कम है। सालाना रिटर्न भरने से पहले फ़र्क भर दें।'
        : 'साल भर में चारों तिमाही स्टेटमेंट के जोड़ से ज़्यादा टैक्स भरा गया है। रिटर्न से पहले भुगतान जाँच लें।',
    });
  }
  return {
    financialYear: input.financialYear, dueDate: gstr4DueDate(input.financialYear), quarters, taxPayablePaise: payable,
    taxPaidPaise: paid, differencePaise: paid === null ? null : payable - paid,
    inward: {
      fromRegisteredPaise: input.inward?.fromRegisteredPaise ?? 0n,
      fromUnregisteredPaise: input.inward?.fromUnregisteredPaise ?? 0n,
      reverseChargePaise: input.inward?.reverseChargePaise ?? 0n,
    },
    findings,
    notes: [{
      'en-IN': 'This is a working paper for filing GSTR-4 on the GST portal. The portal’s upload file for GSTR-4 is not produced here.',
      'hi-IN': 'यह GST पोर्टल पर GSTR-4 भरने के लिए काम का काग़ज़ है। GSTR-4 की पोर्टल अपलोड फ़ाइल यहाँ नहीं बनती।',
    }],
  };
};

// ------------------------------------------------------------------ the refusals

export type SchemeOnDate = 'REGULAR' | 'COMPOSITION';

/** The one sentence a regular-return screen shows a composition dealer, in place of GSTR-1 or GSTR-3B. */
export const NOT_FOR_COMPOSITION: Bilingual = {
  'en-IN': 'Your business is on the composition scheme, so it does not file GSTR-1 or GSTR-3B. You pay tax every quarter with CMP-08 and file GSTR-4 once a year. Open the Composition returns screen.',
  'hi-IN': 'आपका बिज़नेस कम्पोज़िशन स्कीम में है, इसलिए GSTR-1 या GSTR-3B नहीं भरना होता। हर तिमाही CMP-08 से टैक्स भरें और साल में एक बार GSTR-4 भरें। Composition returns स्क्रीन खोलिए।',
};

export const MIXED_MONTH: Bilingual = {
  'en-IN': 'Your business moved between the composition scheme and regular GST during this month, so one return cannot cover it. Please ask your accountant how to file this month.',
  'hi-IN': 'इस महीने आपका बिज़नेस कम्पोज़िशन और रेगुलर GST के बीच बदला है, इसलिए एक रिटर्न में यह महीना नहीं आ सकता। इस महीने की फ़ाइलिंग अपने अकाउंटेंट से पूछ लें।',
};

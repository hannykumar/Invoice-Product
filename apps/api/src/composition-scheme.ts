/**
 * Issue #296 — which GST scheme the business is under, and since when.
 *
 * It is a company setting with a history, never an overwrite: every change is a dated entry that
 * names who declared it and on what basis, so a bill from March still reads as it did in March
 * after the business moves to the composition scheme in April. Posted documents are immutable, so
 * a change that would reach back over bills already issued is refused rather than rewriting them.
 *
 * The change itself is previewed first and applied with the token the preview returned, so what a
 * person approves is what happens; the same request id applies once however many times it is sent.
 *
 * Rule 0: CGST Act s.10 and CGST Rules 3 and 6 (see `packages/gst-returns/src/composition.ts` for
 * the sources and what could not be verified). Rule 3: the option is exercised before the start of
 * the financial year it is for, which is why an opt-in must start on 1 April unless the business is
 * newly registered (NOT VERIFIED beyond that). Leaving the scheme may start on any date.
 */
import { createHash } from 'node:crypto';
import { conflict, invalid, isoDate, type CompanyId, type IsoDate } from '@invoice/kernel';
import {
  COMPOSITION_CATEGORIES, compositionLimitFor, suggestedCompositionRate, validateCompositionRate,
  type CompositionCategory,
} from '@invoice/gst-returns';
import { DurableMap } from './durable.ts';
import { appToday } from './app-clock.ts';

/** CGST Act s.10(4): the clause that takes input tax credit away from a composition dealer. */
export const COMPOSITION_NO_CREDIT_CLAUSE = '10(4)';

export type Scheme = 'REGULAR' | 'COMPOSITION';

export interface SchemeChange {
  readonly requestId: string;
  readonly scheme: Scheme;
  readonly effectiveFrom: IsoDate;
  /** Only for `COMPOSITION`. */
  readonly category: CompositionCategory | null;
  /** The whole rate the business declared, as a bigint written out. `null` for `REGULAR`. */
  readonly rateBasisPoints: string | null;
  /** Whether the business took the product's suggested rate or typed its own. */
  readonly rateBasis: 'SUGGESTED_UNVERIFIED' | 'BUSINESS_DECLARED' | null;
  readonly newlyRegistered: boolean;
  readonly declaredBy: string;
  readonly declaredOn: IsoDate;
  readonly note: string;
}

const history = new DurableMap<readonly SchemeChange[]>('composition_scheme', (companyId) => companyId);

export const schemeHistoryOf = (companyId: CompanyId | string): readonly SchemeChange[] => history.get(String(companyId)) ?? [];

/** The change in force on `date`: the last one starting on or before it. */
const changeOn = (companyId: CompanyId | string, date: string): SchemeChange | undefined => {
  let found: SchemeChange | undefined;
  for (const change of schemeHistoryOf(companyId)) if (change.effectiveFrom <= date) found = change;
  return found;
};

/** Every business is a regular taxpayer until it says otherwise. */
export const schemeOn = (companyId: CompanyId | string, date: string): Scheme => changeOn(companyId, date)?.scheme ?? 'REGULAR';

export const compositionRateOn = (companyId: CompanyId | string, date: string): { readonly rateBasisPoints: bigint; readonly category: CompositionCategory } | null => {
  const change = changeOn(companyId, date);
  if (change === undefined || change.scheme !== 'COMPOSITION' || change.rateBasisPoints === null || change.category === null) return null;
  return { rateBasisPoints: BigInt(change.rateBasisPoints), category: change.category };
};

/** For the tax calculator: the scheme changes, oldest first. Empty for a business that never changed. */
export const registrationHistoryOf = (companyId: CompanyId | string): readonly { readonly from: string; readonly registration: Scheme }[] =>
  schemeHistoryOf(companyId).map((change) => ({ from: change.effectiveFrom, registration: change.scheme }));

/** Whether the business was on the composition scheme on any day from `from` to `to`, and on every day. */
export const schemeDuring = (companyId: CompanyId | string, from: string, to: string): 'REGULAR' | 'COMPOSITION' | 'BOTH' => {
  const starts = [from, ...schemeHistoryOf(companyId).map((change) => change.effectiveFrom).filter((date) => date > from && date <= to)];
  const schemes = new Set(starts.map((date) => schemeOn(companyId, date)));
  return schemes.size === 2 ? 'BOTH' : schemes.has('COMPOSITION') ? 'COMPOSITION' : 'REGULAR';
};

export const forgetScheme = (companyId: CompanyId | string): void => { history.delete(String(companyId)); };

// ------------------------------------------------------------------------- previewing a change

/** What the screen needs from the rest of the shop to judge a change. */
export interface SchemeContext {
  readonly companyId: CompanyId | string;
  readonly gstin: string;
  /** Bills (tax invoices and bills of supply) already issued on or after `date`. */
  readonly billsIssuedSince: (date: IsoDate) => Promise<number>;
  readonly goodsItemCount: () => number;
  readonly declaredBy: string;
  readonly today?: IsoDate;
}

export interface Bilingual { readonly 'en-IN': string; readonly 'hi-IN': string }

export interface SchemePreview {
  readonly ok: boolean;
  readonly change: SchemeChange | null;
  readonly blockers: readonly Bilingual[];
  readonly warnings: readonly Bilingual[];
  /** What will be different once it is applied, in the owner's words. */
  readonly whatChanges: readonly Bilingual[];
  /** Hand this back to apply: it proves the person saw this exact change. */
  readonly token: string | null;
}

const text = (value: unknown): string => String(value ?? '').trim();
const yes = (value: unknown): boolean => value === true || ['yes', 'true', 'on', '1'].includes(text(value).toLowerCase());
const pair = (en: string, hi: string): Bilingual => ({ 'en-IN': en, 'hi-IN': hi });

const tokenOf = (companyId: CompanyId | string, change: SchemeChange): string =>
  createHash('sha256').update(JSON.stringify({ companyId: String(companyId), change: { ...change, declaredOn: undefined }, entries: schemeHistoryOf(companyId).length })).digest('hex').slice(0, 32);

const percentToBasisPoints = (value: string): bigint | null => {
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(value)) return null;
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
};

const isFinancialYearStart = (date: string): boolean => date.endsWith('-04-01');

export const previewSchemeChange = async (context: SchemeContext, input: Record<string, unknown>): Promise<SchemePreview> => {
  const today = context.today ?? appToday();
  const blockers: Bilingual[] = [];
  const warnings: Bilingual[] = [];
  const whatChanges: Bilingual[] = [];
  const scheme = text(input.scheme).toUpperCase();
  if (scheme !== 'REGULAR' && scheme !== 'COMPOSITION') {
    throw invalid('COMPOSITION_SCHEME', 'Choose whether the business pays GST the regular way or under the composition scheme.');
  }
  const dateText = text(input.effectiveFrom);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText) || Number.isNaN(Date.parse(dateText))) {
    throw invalid('COMPOSITION_DATE', 'Say from which date the change applies.');
  }
  const effectiveFrom = isoDate(dateText);
  const current = schemeOn(context.companyId, effectiveFrom);
  const last = schemeHistoryOf(context.companyId).at(-1);

  if (last !== undefined && effectiveFrom <= last.effectiveFrom) {
    blockers.push(pair(
      `The last change took effect on ${last.effectiveFrom}. A new change has to start after it; earlier changes are never rewritten.`,
      `पिछला बदलाव ${last.effectiveFrom} से लागू हुआ था। नया बदलाव उसके बाद की तारीख़ से होना चाहिए; पुराने बदलाव कभी दोबारा नहीं लिखे जाते।`,
    ));
  }
  const issued = await context.billsIssuedSince(effectiveFrom);
  if (issued > 0) {
    blockers.push(pair(
      `${issued} bill${issued === 1 ? ' has' : 's have'} already been issued on or after ${effectiveFrom}, and an issued bill is never changed. Pick a date after your last bill, or ask your accountant how to treat those bills.`,
      `${effectiveFrom} या उसके बाद ${issued} बिल पहले ही बन चुके हैं, और बना हुआ बिल कभी बदला नहीं जाता। अपने आख़िरी बिल के बाद की तारीख़ चुनिए, या उन बिलों के बारे में अकाउंटेंट से पूछिए।`,
    ));
  }

  let category: CompositionCategory | null = null;
  let rateBasisPoints: bigint | null = null;
  let rateBasis: SchemeChange['rateBasis'] = null;
  const newlyRegistered = yes(input.newlyRegistered);

  if (scheme === 'COMPOSITION') {
    const wanted = text(input.category).toUpperCase() as CompositionCategory;
    if (!COMPOSITION_CATEGORIES.includes(wanted)) {
      throw invalid('COMPOSITION_CATEGORY', 'Choose what the business does: makes or trades goods, runs a restaurant, or only provides services.');
    }
    category = wanted;
    if (!isFinancialYearStart(effectiveFrom) && !newlyRegistered) {
      blockers.push(pair(
        'The composition scheme is chosen before a financial year begins, so it starts on 1 April. If your GST registration is new and you chose the scheme when you registered, tick "newly registered".',
        'कम्पोज़िशन स्कीम वित्त वर्ष शुरू होने से पहले चुनी जाती है, इसलिए यह 1 अप्रैल से शुरू होती है। अगर आपका GST रजिस्ट्रेशन नया है और आपने रजिस्ट्रेशन के समय स्कीम चुनी थी, तो "newly registered" पर निशान लगाइए।',
      ));
    }
    // The three promises CGST s.10(2) and the services notification ask the business to stand behind.
    const promises: readonly [string, string, string][] = [
      ['withinLimit', `Your total sales last year were within ${category === 'SERVICES_ONLY' ? '₹50 lakh' : 'the ₹1.5 crore limit (₹75 lakh in some hill and north-eastern states)'}.`, 'पिछले साल की कुल बिक्री सीमा के अंदर थी।'],
      ['noInterState', 'The business does not sell to customers in other states or send goods abroad.', 'बिज़नेस दूसरे राज्यों के ग्राहकों को बिक्री नहीं करता और विदेश माल नहीं भेजता।'],
      ['noEcommerce', 'The business does not sell through an e-commerce site that collects tax at source.', 'बिज़नेस ऐसी ई-कॉमर्स साइट से नहीं बेचता जो टैक्स काटती है।'],
    ];
    for (const [key, en, hi] of promises) {
      if (!yes(input[key])) blockers.push(pair(`Please confirm: ${en}`, `कृपया पुष्टि कीजिए: ${hi}`));
    }
    if (category === 'SERVICES_ONLY' && context.goodsItemCount() > 0) {
      blockers.push(pair(
        'You keep goods in your item list, and the services-only option is for businesses that only provide services. Choose "makes or trades goods", or remove the goods.',
        'आपकी आइटम लिस्ट में सामान है, और सिर्फ़-सेवा वाला विकल्प उन बिज़नेस के लिए है जो सिर्फ़ सेवाएँ देते हैं। "सामान बनाता/बेचता है" चुनिए, या सामान हटाइए।',
      ));
    }
    const suggestion = suggestedCompositionRate(category, effectiveFrom);
    const typed = text(input.ratePercent);
    if (typed === '') {
      if (suggestion === undefined) {
        blockers.push(pair('Type the composition rate your accountant confirmed.', 'अकाउंटेंट से पक्का किया गया कम्पोज़िशन रेट लिखिए।'));
      } else {
        rateBasisPoints = suggestion.rateBasisPoints;
        rateBasis = 'SUGGESTED_UNVERIFIED';
      }
    } else {
      rateBasisPoints = percentToBasisPoints(typed);
      if (rateBasisPoints === null) throw invalid('COMPOSITION_RATE', 'Type the rate as a percentage of sales, like 1 or 6.');
      try { validateCompositionRate(rateBasisPoints); } catch (error) { throw invalid('COMPOSITION_RATE', (error as Error).message); }
      rateBasis = 'BUSINESS_DECLARED';
    }
    if (rateBasis === 'SUGGESTED_UNVERIFIED') {
      // Once the owner confirms the usual rate it is theirs to stand behind: recorded as declared
      // by them, never as checked law (the same bargain as business-declared GST rates, option C).
      if (yes(input.rateConfirmed)) rateBasis = 'BUSINESS_DECLARED';
      else {
        blockers.push(pair(
          `The usual rate for this kind of business is ${Number(rateBasisPoints) / 100}% of sales, but we have not been able to check it against the government notice this month. Please confirm the rate with your accountant and tick "rate confirmed".`,
          `इस तरह के बिज़नेस का सामान्य रेट बिक्री का ${Number(rateBasisPoints) / 100}% है, पर हम इस महीने इसे सरकारी नोटिस से जाँच नहीं पाए हैं। कृपया अकाउंटेंट से रेट पक्का करके "rate confirmed" पर निशान लगाइए।`,
        ));
      }
    }
    const limit = compositionLimitFor(category, context.gstin.slice(0, 2));
    warnings.push(pair(
      `The sales limit for this kind of business is ₹${(Number(limit.limitPaise / 100n) / 100_000).toLocaleString('en-IN')} lakh a year. We will warn you when your sales come close, and if you cross it the scheme ends from that day.`,
      `इस तरह के बिज़नेस की सालाना बिक्री सीमा ₹${(Number(limit.limitPaise / 100n) / 100_000).toLocaleString('en-IN')} लाख है। बिक्री इसके क़रीब पहुँचे तो हम चेताएँगे, और सीमा पार होते ही उसी दिन से स्कीम खत्म हो जाती है।`,
    ));
    whatChanges.push(
      pair(`From ${effectiveFrom}, your bills are Bills of Supply, numbered BOS/…, with the words "composition taxable person, not eligible to collect tax on supplies" at the top and no GST on them.`,
        `${effectiveFrom} से आपके बिल Bill of Supply होंगे, नंबर BOS/… से शुरू, ऊपर "composition taxable person, not eligible to collect tax on supplies" लिखा होगा और उन पर GST नहीं होगा।`),
      pair('Sales to customers in other states are stopped, with the reason.', 'दूसरे राज्य के ग्राहकों को बिक्री रोक दी जाएगी, कारण के साथ।'),
      pair('GST on purchases is no longer claimed back; it is added to what the goods cost you.', 'ख़रीद पर GST वापस नहीं माँगा जाएगा; वह सामान की लागत में जुड़ेगा।'),
      pair(`You pay ${Number(rateBasisPoints ?? 0n) / 100}% of your sales every quarter with CMP-08, and file GSTR-4 once a year. GSTR-1 and GSTR-3B stop for you.`,
        `आप हर तिमाही बिक्री का ${Number(rateBasisPoints ?? 0n) / 100}% CMP-08 से भरेंगे और साल में एक बार GSTR-4। आपके लिए GSTR-1 और GSTR-3B बंद हो जाएँगे।`),
    );
    warnings.push(pair(
      'Credit for the GST on stock you hold on the day you join the scheme has to be reversed (Form ITC-03). This product does not work that out; please ask your accountant.',
      'स्कीम में आने के दिन आपके पास जो माल है उस पर लिया गया GST क्रेडिट वापस करना होता है (फ़ॉर्म ITC-03)। यह प्रोडक्ट इसकी गिनती नहीं करता; कृपया अकाउंटेंट से पूछिए।',
    ));
  } else {
    whatChanges.push(
      pair(`From ${effectiveFrom}, your bills are tax invoices again, with GST on them.`, `${effectiveFrom} से आपके बिल फिर टैक्स इनवॉइस होंगे, GST के साथ।`),
      pair('You file GSTR-1 and GSTR-3B each month again, and can claim back GST on purchases.', 'आप फिर हर महीने GSTR-1 और GSTR-3B भरेंगे और ख़रीद पर GST वापस माँग सकेंगे।'),
    );
    warnings.push(pair(
      'Credit on the stock you hold on the day you leave the scheme can be claimed with Form ITC-01. This product does not work that out; please ask your accountant.',
      'स्कीम छोड़ने के दिन आपके पास जो माल है उस पर क्रेडिट फ़ॉर्म ITC-01 से माँगा जा सकता है। यह प्रोडक्ट इसकी गिनती नहीं करता; कृपया अकाउंटेंट से पूछिए।',
    ));
    if (current !== 'COMPOSITION') {
      blockers.push(pair('The business is not on the composition scheme on that date, so there is nothing to leave.', 'उस तारीख़ को बिज़नेस कम्पोज़िशन स्कीम में नहीं है, इसलिए छोड़ने को कुछ नहीं है।'));
    }
  }

  const requestId = text(input.requestId);
  const change: SchemeChange = {
    requestId,
    scheme,
    effectiveFrom,
    category,
    rateBasisPoints: rateBasisPoints === null ? null : rateBasisPoints.toString(),
    rateBasis,
    newlyRegistered,
    declaredBy: context.declaredBy,
    declaredOn: today,
    note: text(input.note),
  };
  const inForce = changeOn(context.companyId, effectiveFrom);
  if (scheme === current && (scheme === 'REGULAR' || (inForce?.category === category && inForce?.rateBasisPoints === change.rateBasisPoints))) {
    blockers.push(pair(
      scheme === 'COMPOSITION' ? 'The business is already on the composition scheme, on these terms, from that date.' : 'The business is already paying GST the regular way from that date.',
      scheme === 'COMPOSITION' ? 'बिज़नेस उस तारीख़ से इन्हीं शर्तों पर पहले ही कम्पोज़िशन स्कीम में है।' : 'बिज़नेस उस तारीख़ से पहले ही रेगुलर तरीक़े से GST भर रहा है।',
    ));
  }
  const ok = blockers.length === 0;
  return { ok, change, blockers, warnings, whatChanges, token: ok ? tokenOf(context.companyId, change) : null };
};

/**
 * Applies a previewed change. The preview is worked out again here, so a bill issued between the
 * preview and the press of the button is caught, and the token must match what is worked out now.
 */
export const applySchemeChange = async (context: SchemeContext, input: Record<string, unknown>): Promise<{ readonly change: SchemeChange; readonly deduplicated: boolean }> => {
  const requestId = text(input.requestId);
  if (requestId === '') throw invalid('COMPOSITION_REQUEST_ID', 'This change needs a request id, so pressing the button twice applies it once.');
  const earlier = schemeHistoryOf(context.companyId).find((change) => change.requestId === requestId);
  if (earlier !== undefined) return { change: earlier, deduplicated: true };
  const preview = await previewSchemeChange(context, input);
  // The preview awaited the bills, so another press of the same button may have applied it meanwhile.
  const meanwhile = schemeHistoryOf(context.companyId).find((change) => change.requestId === requestId);
  if (meanwhile !== undefined) return { change: meanwhile, deduplicated: true };
  if (!preview.ok || preview.change === null || preview.token === null) {
    throw invalid('COMPOSITION_NOT_ALLOWED', preview.blockers[0]?.['en-IN'] ?? 'This change cannot be made.', { details: { blockers: preview.blockers.map((blocker) => blocker['en-IN']).join(' | ') } });
  }
  if (text(input.token) === '') throw invalid('COMPOSITION_NOT_PREVIEWED', 'Please look at what the change does first, then confirm it.');
  if (text(input.token) !== preview.token) {
    throw conflict('COMPOSITION_CHANGED_SINCE_PREVIEW', 'Something changed after you looked at this. Please look at it again before confirming.');
  }
  // No await from here to the write: a different change that landed first is a conflict, never a second entry on one date.
  const latest = schemeHistoryOf(context.companyId).at(-1);
  if (latest !== undefined && latest.effectiveFrom >= preview.change.effectiveFrom) {
    throw conflict('COMPOSITION_CHANGED_SINCE_PREVIEW', 'Something changed after you looked at this. Please look at it again before confirming.');
  }
  history.set(String(context.companyId), [...schemeHistoryOf(context.companyId), preview.change]);
  return { change: preview.change, deduplicated: false };
};

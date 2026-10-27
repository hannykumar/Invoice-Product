/**
 * Issue #36 [E36] — what a business type is allowed to suggest.
 *
 * "Business-type suggestions never invent legal facts" is an acceptance criterion, and it is the
 * whole reason this file is a data table rather than a paragraph of code. A bakery gets a template
 * that has room for flavour and a delivery date. A bakery does **not** get a GST rate, an HSN
 * code, a turnover threshold or a filing frequency, because the product does not know those things
 * about this particular bakery and a filled-in box reads as a fact.
 *
 * Everything suggested here is a convenience the person can see and change. Nothing suggested here
 * is a claim about the law.
 */
import type { BusinessType } from './model.ts';

export interface BusinessTypeProfile {
  readonly type: BusinessType;
  readonly name: { readonly 'en-IN': string; readonly 'hi-IN': string };
  /** An example so a person can recognise their own trade rather than decode a category. */
  readonly soundsLike: { readonly 'en-IN': string; readonly 'hi-IN': string };
  readonly suggestedTemplateId: string;
  /** Units the trade actually uses, offered first in a dropdown. */
  readonly commonUnits: readonly string[];
  /** Whether this trade normally keeps stock. Changes which questions are asked, not any figure. */
  readonly keepsStock: boolean;
  /** Extra ledger accounts this trade usually wants, by name. Editable, and never mandatory. */
  readonly suggestedAccounts: readonly string[];
  /** Things a person of this trade is likely to want on the bill. */
  readonly suggestedOptionalFields: readonly string[];
}

export const BUSINESS_TYPE_PROFILES: readonly BusinessTypeProfile[] = [
  {
    type: 'WHOLESALE',
    name: { 'en-IN': 'Wholesale or trading', 'hi-IN': 'थोक या ट्रेडिंग' },
    soundsLike: { 'en-IN': 'You buy in bulk and sell to other businesses.', 'hi-IN': 'आप थोक में ख़रीदते हैं और दूसरे बिज़नेस को बेचते हैं।' },
    suggestedTemplateId: 'wholesale-classic',
    commonUnits: ['BOX', 'BAG', 'KG', 'QUINTAL', 'PCS'],
    keepsStock: true,
    suggestedAccounts: ['Freight inward', 'Loading and unloading', 'Commission paid'],
    suggestedOptionalFields: ['line.batch', 'transport.vehicleNumber', 'seller.bankDetails', 'document.dueDate'],
  },
  {
    type: 'RETAIL',
    name: { 'en-IN': 'Shop or counter sales', 'hi-IN': 'दुकान या काउंटर' },
    soundsLike: { 'en-IN': 'Customers come to your shop and buy in small amounts.', 'hi-IN': 'ग्राहक दुकान पर आते हैं और थोड़ा-थोड़ा लेते हैं।' },
    suggestedTemplateId: 'counter-thermal',
    commonUnits: ['PCS', 'KG', 'LTR', 'PACKET'],
    keepsStock: true,
    suggestedAccounts: ['Shop rent', 'Electricity'],
    suggestedOptionalFields: ['totals.amountPaid', 'footer.thankYou'],
  },
  {
    type: 'BAKERY',
    name: { 'en-IN': 'Bakery or food making', 'hi-IN': 'बेकरी या खाने का काम' },
    soundsLike: { 'en-IN': 'You make what you sell — cakes, bread, snacks.', 'hi-IN': 'जो बेचते हैं वो ख़ुद बनाते हैं — केक, ब्रेड, नमकीन।' },
    suggestedTemplateId: 'bakery-warm',
    commonUnits: ['PCS', 'KG', 'DOZEN', 'TRAY'],
    keepsStock: true,
    suggestedAccounts: ['Raw material', 'Gas and fuel', 'Packing material'],
    suggestedOptionalFields: ['line.note', 'footer.thankYou', 'totals.amountPaid'],
  },
  {
    type: 'SERVICES',
    name: { 'en-IN': 'Services', 'hi-IN': 'सर्विस का काम' },
    soundsLike: { 'en-IN': 'You charge for work done, not for goods.', 'hi-IN': 'आप काम का पैसा लेते हैं, सामान का नहीं।' },
    suggestedTemplateId: 'services-simple',
    commonUnits: ['JOB', 'HOUR', 'DAY', 'MONTH'],
    keepsStock: false,
    suggestedAccounts: ['Staff salary', 'Travel', 'Professional fees'],
    suggestedOptionalFields: ['document.dueDate', 'seller.bankDetails', 'footer.terms'],
  },
  {
    type: 'TRANSPORT',
    name: { 'en-IN': 'Transport', 'hi-IN': 'ट्रांसपोर्ट' },
    soundsLike: { 'en-IN': 'You move goods for other people.', 'hi-IN': 'आप दूसरों का माल ले जाते हैं।' },
    suggestedTemplateId: 'transport-consignment',
    commonUnits: ['TRIP', 'KM', 'TONNE'],
    keepsStock: false,
    suggestedAccounts: ['Diesel', 'Vehicle repairs', 'Driver wages', 'Toll and parking'],
    suggestedOptionalFields: ['transport.vehicleNumber', 'transport.transporter', 'footer.signature'],
  },
  {
    type: 'MANUFACTURING',
    name: { 'en-IN': 'Manufacturing', 'hi-IN': 'मैन्युफ़ैक्चरिंग' },
    soundsLike: { 'en-IN': 'You turn raw material into something else and sell that.', 'hi-IN': 'कच्चे माल से कुछ बनाते हैं और वही बेचते हैं।' },
    suggestedTemplateId: 'wholesale-classic',
    commonUnits: ['PCS', 'KG', 'METRE', 'SET'],
    keepsStock: true,
    suggestedAccounts: ['Raw material', 'Power and fuel', 'Factory wages', 'Job work charges'],
    suggestedOptionalFields: ['line.batch', 'seller.bankDetails', 'document.dueDate'],
  },
];

export const profileFor = (type: BusinessType): BusinessTypeProfile => {
  const found = BUSINESS_TYPE_PROFILES.find((p) => p.type === type);
  if (found === undefined) throw new Error(`No profile for business type ${type}`);
  return found;
};

/**
 * The things a business type is **never** allowed to suggest, kept as data so a test can hold the
 * line rather than a reviewer having to notice.
 *
 * Each of these is a fact about this particular business or about the law. Guessing any of them
 * would put a number in front of someone who would reasonably believe we had checked it.
 */
export const NEVER_SUGGESTED: readonly string[] = [
  'gstin',
  'gst rate',
  'tax rate',
  'hsn',
  'sac',
  'turnover',
  'threshold',
  'filing frequency',
  'registration type',
  'composition eligibility',
  'e-way bill limit',
  'due date for filing',
];

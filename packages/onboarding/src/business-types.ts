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
    name: { 'en-IN': 'Wholesale or trading', 'hi-IN': 'Thok ya trading' },
    soundsLike: { 'en-IN': 'You buy in bulk and sell to other businesses.', 'hi-IN': 'Aap thok mein kharidte hain aur doosre businesses ko bechte hain.' },
    suggestedTemplateId: 'wholesale-classic',
    commonUnits: ['BOX', 'BAG', 'KG', 'QUINTAL', 'PCS'],
    keepsStock: true,
    suggestedAccounts: ['Freight inward', 'Loading and unloading', 'Commission paid'],
    suggestedOptionalFields: ['line.batch', 'transport.vehicleNumber', 'seller.bankDetails', 'document.dueDate'],
  },
  {
    type: 'RETAIL',
    name: { 'en-IN': 'Shop or counter sales', 'hi-IN': 'Dukaan ya counter' },
    soundsLike: { 'en-IN': 'Customers come to your shop and buy in small amounts.', 'hi-IN': 'Customer dukaan par aate hain aur thoda-thoda lete hain.' },
    suggestedTemplateId: 'counter-thermal',
    commonUnits: ['PCS', 'KG', 'LTR', 'PACKET'],
    keepsStock: true,
    suggestedAccounts: ['Shop rent', 'Electricity'],
    suggestedOptionalFields: ['totals.amountPaid', 'footer.thankYou'],
  },
  {
    type: 'BAKERY',
    name: { 'en-IN': 'Bakery or food making', 'hi-IN': 'Bakery ya khaane ka kaam' },
    soundsLike: { 'en-IN': 'You make what you sell — cakes, bread, snacks.', 'hi-IN': 'Jo bechte hain woh khud banate hain — cake, bread, namkeen.' },
    suggestedTemplateId: 'bakery-warm',
    commonUnits: ['PCS', 'KG', 'DOZEN', 'TRAY'],
    keepsStock: true,
    suggestedAccounts: ['Raw material', 'Gas and fuel', 'Packing material'],
    suggestedOptionalFields: ['line.note', 'footer.thankYou', 'totals.amountPaid'],
  },
  {
    type: 'SERVICES',
    name: { 'en-IN': 'Services', 'hi-IN': 'Service ka kaam' },
    soundsLike: { 'en-IN': 'You charge for work done, not for goods.', 'hi-IN': 'Aap kaam ka paisa lete hain, saaman ka nahin.' },
    suggestedTemplateId: 'services-simple',
    commonUnits: ['JOB', 'HOUR', 'DAY', 'MONTH'],
    keepsStock: false,
    suggestedAccounts: ['Staff salary', 'Travel', 'Professional fees'],
    suggestedOptionalFields: ['document.dueDate', 'seller.bankDetails', 'footer.terms'],
  },
  {
    type: 'TRANSPORT',
    name: { 'en-IN': 'Transport', 'hi-IN': 'Transport' },
    soundsLike: { 'en-IN': 'You move goods for other people.', 'hi-IN': 'Aap doosron ka maal le jaate hain.' },
    suggestedTemplateId: 'transport-consignment',
    commonUnits: ['TRIP', 'KM', 'TONNE'],
    keepsStock: false,
    suggestedAccounts: ['Diesel', 'Vehicle repairs', 'Driver wages', 'Toll and parking'],
    suggestedOptionalFields: ['transport.vehicleNumber', 'transport.transporter', 'footer.signature'],
  },
  {
    type: 'MANUFACTURING',
    name: { 'en-IN': 'Manufacturing', 'hi-IN': 'Manufacturing' },
    soundsLike: { 'en-IN': 'You turn raw material into something else and sell that.', 'hi-IN': 'Kachche maal se kuch banate hain aur wahi bechte hain.' },
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

/**
 * Issue #13 [E13] — the part of an invoice a template may not touch.
 *
 * "Required fields cannot be removed" is the first acceptance criterion, so it is enforced as a
 * data structure rather than as a rule someone remembers. A template describes *styling* and
 * *optional* content. The compliance section is assembled by this module, from the invoice, and a
 * template has no way to express its removal.
 *
 * The list below is what this product prints today. It is deliberately conservative: printing a
 * field nobody needed is harmless, and omitting one is not.
 */
export type FieldScope = 'DOCUMENT' | 'SELLER' | 'BUYER' | 'LINE' | 'TOTALS' | 'TRANSPORT';

export interface MandatoryField {
  readonly id: string;
  readonly scope: FieldScope;
  readonly label: { readonly 'en-IN': string; readonly 'hi-IN': string };
  /** Why it is on the invoice, in words a business owner can check. */
  readonly why: string;
  /** Printed only when the fact applies — a B2C bill has no buyer GSTIN. */
  readonly conditional: boolean;
}

const field = (
  id: string,
  scope: FieldScope,
  en: string,
  hi: string,
  why: string,
  conditional = false,
): MandatoryField => ({ id, scope, label: { 'en-IN': en, 'hi-IN': hi }, why, conditional });

export const MANDATORY_FIELDS: readonly MandatoryField[] = [
  field('document.title', 'DOCUMENT', 'Tax invoice', 'Tax invoice', 'The document must say what it is.'),
  field('document.number', 'DOCUMENT', 'Invoice number', 'Bill number', 'The unique number in the seller’s series.'),
  field('document.date', 'DOCUMENT', 'Invoice date', 'Bill ki taarikh', 'Decides the tax period and which rules applied.'),
  field('seller.name', 'SELLER', 'Seller', 'Bechne wala', 'Who issued the bill.'),
  field('seller.address', 'SELLER', 'Address', 'Pata', 'The seller’s place of business.'),
  field('seller.gstin', 'SELLER', 'GST number', 'GST number', 'The seller’s registration.', true),
  field('seller.stateName', 'SELLER', 'State', 'Rajya', 'Half of what decides which GST applies.'),
  field('buyer.name', 'BUYER', 'Customer', 'Customer', 'Who the bill is for.'),
  field('buyer.address', 'BUYER', 'Address', 'Pata', 'Where the customer is.', true),
  field('buyer.gstin', 'BUYER', 'GST number', 'GST number', 'Needed for the customer to claim credit.', true),
  field('supply.placeOfSupply', 'DOCUMENT', 'Place of supply', 'Bikri kis rajya ki', 'Decides whether one GST applies or two.'),
  field('supply.reverseCharge', 'DOCUMENT', 'Reverse charge', 'Reverse charge', 'Says whether the customer pays the GST directly.'),
  field('line.description', 'LINE', 'Item', 'Item', 'What was sold.'),
  field('line.hsnOrSac', 'LINE', 'HSN or SAC', 'HSN ya SAC', 'The government’s code for the item.', true),
  field('line.quantity', 'LINE', 'Quantity', 'Kitna', 'How much was sold, with its unit.'),
  field('line.unitPrice', 'LINE', 'Rate', 'Rate', 'The agreed price per unit.'),
  field('line.taxableValue', 'LINE', 'Taxable value', 'Jis par tax laga', 'The amount the tax was worked out on.'),
  field('line.taxRate', 'LINE', 'GST rate', 'GST rate', 'The rate applied to the line.', true),
  field('line.taxAmount', 'LINE', 'GST amount', 'GST', 'The tax on the line.', true),
  field('totals.taxableValue', 'TOTALS', 'Total before GST', 'GST se pehle total', 'The sum the tax was worked out on.'),
  field('totals.taxBreakup', 'TOTALS', 'GST', 'GST', 'Each tax shown separately, never lumped together.'),
  field('totals.roundOff', 'TOTALS', 'Rounded', 'Round kiya', 'The few paise added or removed.', true),
  field('totals.invoiceValue', 'TOTALS', 'Total', 'Kul', 'What the customer must pay.'),
  field('totals.amountInWords', 'TOTALS', 'Amount in words', 'Rakam shabdon mein', 'Guards against a misread figure.'),
];

export const MANDATORY_FIELD_IDS: ReadonlySet<string> = new Set(MANDATORY_FIELDS.map((f) => f.id));

/** Fields a template may add, move or drop. Everything else is not a template's business. */
export const OPTIONAL_FIELDS: readonly string[] = [
  'seller.logo',
  'seller.phone',
  'seller.email',
  'seller.bankDetails',
  'buyer.phone',
  'document.dueDate',
  'document.poReference',
  'line.batch',
  'line.expiry',
  'line.discount',
  'line.note',
  'totals.amountPaid',
  'totals.outstanding',
  'footer.terms',
  'footer.signature',
  'footer.thankYou',
  'transport.vehicleNumber',
  'transport.transporter',
  'transport.eWayBillNumber',
  'qr.eInvoice',
];

/**
 * Issue #30 [E30] — the four-invoice small business the issue asks for.
 *
 * Sunrise Soap Works is a soap maker in Maharashtra with one shop, one lorry and a July that fits
 * on one page. Four bills and one credit note, chosen so that between them they land in four
 * different tables of GSTR-1 and exercise every branch of the classifier that a real MSME meets:
 *
 *   INV-001  ₹59,000   to Pune Retail Stores, who have a GST number, in Maharashtra   → B2B
 *   INV-002  ₹11,800   to a walk-in customer in Maharashtra                           → B2CS
 *   INV-003  ₹1,41,600 to a customer in Gujarat with no GST number                    → B2CL
 *   INV-004  ₹88,500   to Bengaluru Kirana Mart, who have a GST number, in Karnataka  → B2B
 *   CN-001   ₹5,900    twenty boxes of INV-001 came back                              → CDNR
 *
 * The arithmetic is exact and deliberately checkable by hand: everything is ₹250 a unit at 18%.
 * Add the tax up and the month comes to ₹4,950 of central GST, ₹4,950 of state GST and ₹35,100 of
 * GST on the two out-of-state sales — which is what `SUNRISE_BOOK_TAX` independently says the
 * ledger holds, so the reconciliation has something real to agree with.
 *
 * Every GST number here is built by `syntheticGstin`: structurally valid, checksum-correct, and
 * belonging to nobody. None of these businesses exists.
 */
import { asId, isoDate, type CompanyId, type IsoDate, type Money } from '@invoice/kernel';
import { syntheticGstin } from '../../masters/src/fixtures.ts';
import type { BookTaxTotals } from './reconcile.ts';
import { inwardWithOrdinaryCredit } from './adapters.ts';
import {
  taxPeriod,
  type InwardTaxSummary,
  type OutwardDocument,
  type OutwardLine,
  type SourceRef,
  type TaxPeriod,
} from './types.ts';

export const SUNRISE_COMPANY: CompanyId = asId<'Company'>('11111111-1111-4111-8111-111111111111');
export const SUNRISE_PERIOD: TaxPeriod = taxPeriod('2026-07');

/** Maharashtra is state code 27. The seller's own registration. */
export const SUNRISE_GSTIN = syntheticGstin('27', 'AAECS5678D');
export const SUNRISE_STATE = '27';

export const PUNE_RETAIL_GSTIN = syntheticGstin('27', 'AAFCD1234K');
export const BENGALURU_KIRANA_GSTIN = syntheticGstin('29', 'AAGCN3456P');

const rupees = (whole: number, paise = 0): Money => ({ currency: 'INR', minor: BigInt(whole) * 100n + BigInt(paise) });
const nil: Money = rupees(0);

/**
 * One line of soap or shampoo at 18%.
 *
 * `local` decides whether the tax is split between the centre and the state or charged whole as
 * IGST. That is the only difference between an in-state and an out-of-state line, and writing it
 * once here keeps the five documents below readable.
 */
const line = (
  lineId: string,
  itemId: string,
  description: string,
  hsn: string,
  quantity: string,
  taxableRupees: number,
  local: boolean,
): OutwardLine => {
  const taxable = rupees(taxableRupees);
  const wholeTax = (taxable.minor * 1800n) / 10_000n;
  return {
    lineId,
    itemId,
    description,
    hsnOrSac: hsn,
    supplyKind: 'GOODS',
    unit: 'BOX',
    quantity,
    ratePercentTimes100: 1800n,
    amounts: {
      taxableValue: taxable,
      cgst: { currency: 'INR', minor: local ? wholeTax / 2n : 0n },
      sgst: { currency: 'INR', minor: local ? wholeTax / 2n : 0n },
      igst: { currency: 'INR', minor: local ? 0n : wholeTax },
      cess: nil,
    },
    // The rate came from the business's own declaration, because no rate in this product has been
    // checked against a notification yet (#54). The return says so on every line that uses one.
    rateBasis: 'BUSINESS_DECLARED',
    reverseCharge: false,
  };
};

const base = {
  companyId: SUNRISE_COMPANY,
  treatment: 'REGULAR' as const,
  supplierGstin: SUNRISE_GSTIN,
  supplierStateCode: SUNRISE_STATE,
  reverseCharge: false,
};

/** INV-001 — 200 boxes of soap to a shop in Pune that has a GST number. Goes in B2B. */
export const INV_001: OutwardDocument = {
  ...base,
  sourceKind: 'sales_invoice',
  sourceId: 'inv-001',
  voucherId: 'vch-inv-001',
  kind: 'INVOICE',
  number: 'INV-001',
  documentDate: isoDate('2026-07-05') as IsoDate,
  partyId: 'party-pune-retail',
  partyName: 'Pune Retail Stores',
  counterpartyGstin: PUNE_RETAIL_GSTIN,
  counterpartyStateCode: '27',
  placeOfSupplyStateCode: '27',
  lines: [line('l1', 'SOAP', 'Herbal Bath Soap 100g', '3401', '200', 50_000, true)],
  invoiceValue: rupees(59_000),
  unregisteredConfirmed: true,
};

/** INV-002 — 40 boxes over the counter to somebody with no GST number, in Maharashtra. B2CS. */
export const INV_002: OutwardDocument = {
  ...base,
  sourceKind: 'sales_invoice',
  sourceId: 'inv-002',
  voucherId: 'vch-inv-002',
  kind: 'INVOICE',
  number: 'INV-002',
  documentDate: isoDate('2026-07-09') as IsoDate,
  partyId: 'party-walk-in',
  partyName: 'Walk-in customer',
  counterpartyGstin: null,
  counterpartyStateCode: '27',
  placeOfSupplyStateCode: '27',
  lines: [line('l1', 'SOAP', 'Herbal Bath Soap 100g', '3401', '40', 10_000, true)],
  invoiceValue: rupees(11_800),
  // Somebody at the counter ticked "this customer has no GST number". Without that tick this bill
  // would be an exception rather than a B2C sale, which is the point of the flag.
  unregisteredConfirmed: true,
};

/**
 * INV-003 — a big order to a customer in Gujarat with no GST number.
 *
 * This is the bill that makes the B2CL threshold matter: at ₹1,41,600 it is above the limit, so it
 * is listed on its own rather than folded into a state-wise total.
 */
export const INV_003: OutwardDocument = {
  ...base,
  sourceKind: 'sales_invoice',
  sourceId: 'inv-003',
  voucherId: 'vch-inv-003',
  kind: 'INVOICE',
  number: 'INV-003',
  documentDate: isoDate('2026-07-17') as IsoDate,
  partyId: 'party-surat-buyer',
  partyName: 'Surat wedding order',
  counterpartyGstin: null,
  counterpartyStateCode: '24',
  placeOfSupplyStateCode: '24',
  lines: [line('l1', 'SOAP', 'Herbal Bath Soap 100g', '3401', '480', 120_000, false)],
  invoiceValue: rupees(141_600),
  unregisteredConfirmed: true,
};

/** INV-004 — shampoo to a registered shop in Karnataka. B2B, and IGST because it crosses a border. */
export const INV_004: OutwardDocument = {
  ...base,
  sourceKind: 'sales_invoice',
  sourceId: 'inv-004',
  voucherId: 'vch-inv-004',
  kind: 'INVOICE',
  number: 'INV-004',
  documentDate: isoDate('2026-07-23') as IsoDate,
  partyId: 'party-bengaluru-kirana',
  partyName: 'Bengaluru Kirana Mart',
  counterpartyGstin: BENGALURU_KIRANA_GSTIN,
  counterpartyStateCode: '29',
  placeOfSupplyStateCode: '29',
  lines: [line('l1', 'SHAMPOO', 'Herbal Shampoo 200ml', '3305', '300', 75_000, false)],
  invoiceValue: rupees(88_500),
  unregisteredConfirmed: true,
};

/** CN-001 — twenty boxes of INV-001 came back damaged. A credit note, so it reduces the month. */
export const CN_001: OutwardDocument = {
  ...base,
  sourceKind: 'credit_note',
  sourceId: 'cn-001',
  voucherId: 'vch-cn-001',
  kind: 'CREDIT_NOTE',
  number: 'CN-001',
  documentDate: isoDate('2026-07-28') as IsoDate,
  partyId: 'party-pune-retail',
  partyName: 'Pune Retail Stores',
  counterpartyGstin: PUNE_RETAIL_GSTIN,
  counterpartyStateCode: '27',
  placeOfSupplyStateCode: '27',
  lines: [line('l1', 'SOAP', 'Herbal Bath Soap 100g', '3401', '20', 5_000, true)],
  invoiceValue: rupees(5_900),
  originalDocument: { number: 'INV-001', date: isoDate('2026-07-05') as IsoDate },
  unregisteredConfirmed: true,
};

export const SUNRISE_DOCUMENTS: readonly OutwardDocument[] = Object.freeze([INV_001, INV_002, INV_003, INV_004, CN_001]);

const sourceOf = (document: OutwardDocument): SourceRef => ({
  sourceKind: document.sourceKind,
  sourceId: document.sourceId,
  number: document.number,
  date: document.documentDate,
  voucherId: document.voucherId,
  amount: document.invoiceValue,
});

/**
 * What the ledger holds for July, worked out from the same five documents by hand.
 *
 * Deliberately written out as figures rather than computed from `SUNRISE_DOCUMENTS`. A
 * reconciliation whose two sides are computed from one source proves nothing at all; these are the
 * numbers a person would add up off the vouchers, and the test is that the return agrees with them.
 */
export const SUNRISE_BOOK_TAX: BookTaxTotals = Object.freeze({
  period: SUNRISE_PERIOD,
  // 4,500 on INV-001 plus 900 on INV-002 less 450 given back on CN-001.
  cgst: rupees(4_950),
  sgst: rupees(4_950),
  // 21,600 on the Gujarat order plus 13,500 on the Karnataka one.
  igst: rupees(35_100),
  cess: nil,
  contributions: SUNRISE_DOCUMENTS.map(sourceOf),
});

/**
 * The tax Sunrise already paid on its own purchases in July: ₹60,000 of oils and packaging at 18%,
 * bought locally, so ₹5,400 to the centre and ₹5,400 to the state.
 *
 * That is more central and state credit than the month's liability, and less IGST, which is exactly
 * the ordinary situation a small manufacturer selling out of state finds itself in — and exactly
 * the case where the order of set-off matters and this product declines to guess it.
 */
export const SUNRISE_INWARD: InwardTaxSummary = inwardWithOrdinaryCredit(
  SUNRISE_PERIOD,
  { cgst: 540_000n, sgst: 540_000n },
  [{ sourceKind: 'purchase_bill', sourceId: 'pb-July-oils', number: 'SUP/1187', date: isoDate('2026-07-11') as IsoDate, voucherId: 'vch-pb-1187', amount: rupees(70_800) }],
);

/**
 * A bill that cannot be classified, for exercising the exception workspace.
 *
 * Nothing exotic is wrong with it: a customer with no GST number where nobody ticked to say the
 * customer really has none. That single unanswered question is the commonest reason a real return
 * stalls, and the product refuses to resolve it by assuming.
 */
export const UNRESOLVED_INVOICE: OutwardDocument = {
  ...INV_002,
  sourceId: 'inv-005',
  number: 'INV-005',
  voucherId: 'vch-inv-005',
  documentDate: isoDate('2026-07-30') as IsoDate,
  partyName: 'Kolhapur order — name only',
  counterpartyGstin: null,
  unregisteredConfirmed: false,
  invoiceValue: rupees(11_800),
};

/**
 * A correction to a bill already filed in June, for exercising the amendment tables.
 *
 * The GST number on the original was wrong, which is the amendment an MSME actually files: the
 * buyer telephoned because the credit never appeared against their registration.
 */
export const AMENDMENT_INVOICE: OutwardDocument = {
  ...INV_001,
  sourceId: 'inv-jun-014-amended',
  number: 'INV-JUN-014',
  voucherId: 'vch-inv-jun-014-a',
  documentDate: isoDate('2026-07-02') as IsoDate,
  amends: {
    period: taxPeriod('2026-06'),
    number: 'INV-JUN-014',
    date: isoDate('2026-06-14') as IsoDate,
    reason: 'The buyer\'s GST number was typed wrongly, so the credit never reached them.',
  },
};

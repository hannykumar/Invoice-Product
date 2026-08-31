/**
 * Issue #31 [E31] — one month of a real-looking Bengaluru hardware shop.
 *
 * Sunrise Hardware buys from six suppliers in July 2026, and every case the issue names is in
 * there once: a bill that agrees, a bill numbered differently at each end, a bill the supplier has
 * not filed, a bill where the two sides disagree about money, a purchase the law blocks credit on,
 * a document only the portal has, and a credit note.
 *
 * Every GST number is built by `syntheticGstin`: structurally valid, checksum-correct, and
 * belonging to nobody. No production registration appears anywhere in this product's fixtures.
 */
import { asId, type CompanyId, type IsoDate } from '@invoice/kernel';
import { syntheticGstin } from '../../masters/src/fixtures.ts';
import { taxPeriod, type BookPurchaseDocument, type TaxPeriod } from './types.ts';

export const SUNRISE_COMPANY = asId<'Company'>('11111111-1111-4111-8111-111111111111') as unknown as CompanyId;
export const SUNRISE_GSTIN = syntheticGstin('29', 'AAECS1234H');
export const SUNRISE_PERIOD: TaxPeriod = taxPeriod('2026-07');

export const SHREE_RAM_GSTIN = syntheticGstin('27', 'AAECS5678D');
export const KONKAN_GSTIN = syntheticGstin('30', 'AAFCK4321L');
export const DECCAN_GSTIN = syntheticGstin('29', 'AABCD7788M');
export const MYSORE_GSTIN = syntheticGstin('29', 'AAGCM3344N');
export const NANDI_GSTIN = syntheticGstin('29', 'AAHCN2211P');
export const COASTAL_GSTIN = syntheticGstin('29', 'AAJCC9911Q');

const rupees = (whole: number, paise = 0): { currency: 'INR'; minor: bigint } => ({
  currency: 'INR',
  minor: BigInt(whole) * 100n + BigInt(paise),
});

const bill = (input: {
  id: string;
  supplierName: string;
  gstin: string | null;
  number: string;
  date: string;
  taxable: number;
  cgst?: number;
  sgst?: number;
  igst?: number;
  ineligible?: number;
  kind?: BookPurchaseDocument['kind'];
  reverseCharge?: boolean;
  imported?: boolean;
  reversed?: boolean;
}): BookPurchaseDocument => ({
  sourceKind: 'purchase_bill',
  sourceId: input.id,
  companyId: SUNRISE_COMPANY,
  supplierPartyId: `party:${input.id}`,
  supplierName: input.supplierName,
  supplierGstin: input.gstin,
  kind: input.kind ?? 'INVOICE',
  number: input.number,
  documentDate: input.date as IsoDate,
  period: taxPeriod(input.date.slice(0, 7)),
  amounts: {
    taxableValue: rupees(input.taxable),
    cgst: rupees(input.cgst ?? 0),
    sgst: rupees(input.sgst ?? 0),
    igst: rupees(input.igst ?? 0),
    cess: rupees(0),
  },
  invoiceValue: rupees(input.taxable + (input.cgst ?? 0) + (input.sgst ?? 0) + (input.igst ?? 0)),
  ineligibleItc: rupees(input.ineligible ?? 0),
  reverseCharge: input.reverseCharge ?? false,
  imported: input.imported ?? false,
  voucherId: `voucher:${input.id}`,
  reversed: input.reversed ?? false,
});

/** Steel from Pune: an ordinary inter-state purchase that both sides report identically. */
export const STEEL_BILL = bill({
  id: 'bill-steel', supplierName: 'Shree Ram Steels', gstin: SHREE_RAM_GSTIN,
  number: 'SRS/2026-27/118', date: '2026-07-05', taxable: 100_000, igst: 18_000,
});

/** Packaging from Goa: our register writes the number one way, the supplier writes it another. */
export const PACKAGING_BILL = bill({
  id: 'bill-packaging', supplierName: 'Konkan Packaging', gstin: KONKAN_GSTIN,
  number: 'KP/0042', date: '2026-07-09', taxable: 40_000, igst: 7_200,
});

/** Paint from a local supplier who has not filed the month. The issue's own user example. */
export const PAINT_BILL = bill({
  id: 'bill-paint', supplierName: 'Deccan Chemicals', gstin: DECCAN_GSTIN,
  number: 'DC-556', date: '2026-07-14', taxable: 50_000, cgst: 4_500, sgst: 4_500,
});

/** Paper: we recorded ₹40,000, the supplier reported ₹30,000. Somebody is wrong about money. */
export const PAPER_BILL = bill({
  id: 'bill-paper', supplierName: 'Mysore Papers', gstin: MYSORE_GSTIN,
  number: 'MP-9', date: '2026-07-18', taxable: 40_000, cgst: 3_600, sgst: 3_600,
});

/** A car for the office. The law blocks the credit, so #17 already put the tax into the cost. */
export const CAR_BILL = bill({
  id: 'bill-car', supplierName: 'Nandi Motors', gstin: NANDI_GSTIN,
  number: 'NM-771', date: '2026-07-21', taxable: 800_000, cgst: 112_000, sgst: 112_000, ineligible: 224_000,
});

/** The supplier took back part of the steel, so the credit on it comes back down. */
export const STEEL_CREDIT_NOTE = bill({
  id: 'note-steel', supplierName: 'Shree Ram Steels', gstin: SHREE_RAM_GSTIN,
  number: 'SRS/CN/14', date: '2026-07-27', taxable: 10_000, igst: 1_800, kind: 'CREDIT_NOTE',
});

export const SUNRISE_BOOKS: readonly BookPurchaseDocument[] = Object.freeze([
  STEEL_BILL, PACKAGING_BILL, PAINT_BILL, PAPER_BILL, CAR_BILL, STEEL_CREDIT_NOTE,
]);

/**
 * The GSTR-2B file as the portal hands it over, for the same month.
 *
 * Written as the portal writes it — `ctin`, `inum`, `05-07-2026`, amounts as JSON numbers — so the
 * reader is exercised against the real shape and not against a tidied one. Note what is *not* in
 * here: Deccan Chemicals' paint bill, because that supplier has not filed.
 */
export const SUNRISE_GSTR2B_FILE = JSON.stringify({
  data: {
    gstin: SUNRISE_GSTIN,
    rtnprd: '072026',
    docdata: {
      b2b: [
        {
          ctin: SHREE_RAM_GSTIN,
          trdnm: 'Shree Ram Steels',
          supprd: '072026',
          inv: [{
            inum: 'SRS/2026-27/118', dt: '05-07-2026', val: 118000.00, itcavl: 'Y', rsn: null,
            txval: 100000.00, igst: 18000.00, cgst: 0, sgst: 0, cess: 0, rchrg: 'N',
          }],
        },
        {
          ctin: KONKAN_GSTIN,
          trdnm: 'Konkan Packaging',
          supprd: '072026',
          // The same bill, numbered without the slash and with the zeros dropped.
          inv: [{
            inum: 'KP-42', dt: '09-07-2026', val: 47200.00, itcavl: 'Y', rsn: null,
            txval: 40000.00, igst: 7200.00, cgst: 0, sgst: 0, cess: 0, rchrg: 'N',
          }],
        },
        {
          ctin: MYSORE_GSTIN,
          trdnm: 'Mysore Papers',
          supprd: '072026',
          inv: [{
            inum: 'MP-9', dt: '18-07-2026', val: 35400.00, itcavl: 'Y', rsn: null,
            txval: 30000.00, cgst: 2700.00, sgst: 2700.00, igst: 0, cess: 0, rchrg: 'N',
          }],
        },
        {
          ctin: NANDI_GSTIN,
          trdnm: 'Nandi Motors',
          supprd: '072026',
          inv: [{
            inum: 'NM-771', dt: '21-07-2026', val: 1024000.00, itcavl: 'N',
            rsn: 'Credit not available on this kind of purchase',
            txval: 800000.00, cgst: 112000.00, sgst: 112000.00, igst: 0, cess: 0, rchrg: 'N',
          }],
        },
        {
          ctin: COASTAL_GSTIN,
          trdnm: 'Coastal Traders',
          supprd: '072026',
          // Reported against us, and nowhere in our books. Somebody has to find the paper.
          inv: [{
            inum: 'CT-77', dt: '23-07-2026', val: 23600.00, itcavl: 'Y', rsn: null,
            txval: 20000.00, cgst: 1800.00, sgst: 1800.00, igst: 0, cess: 0, rchrg: 'N',
          }],
        },
      ],
      cdnr: [
        {
          ctin: SHREE_RAM_GSTIN,
          trdnm: 'Shree Ram Steels',
          supprd: '072026',
          nt: [{
            ntnum: 'SRS/CN/14', ntdt: '27-07-2026', typ: 'C', val: 11800.00, itcavl: 'Y',
            txval: 10000.00, igst: 1800.00, cgst: 0, sgst: 0, cess: 0,
          }],
        },
      ],
    },
  },
}, null, 2);

/**
 * The same six documents as a spreadsheet.
 *
 * Used to prove that a business working from an accountant's CSV and a business working from the
 * portal's own file get the same reconciliation, which is the "file/API equivalence" the issue
 * asks to be tested.
 */
export const SUNRISE_CSV_FILE = [
  'Supplier GSTIN,Supplier name,Type,Invoice number,Invoice date,Taxable value,CGST,SGST,IGST,Cess,Invoice value,ITC available,Reason',
  `${SHREE_RAM_GSTIN},Shree Ram Steels,Invoice,SRS/2026-27/118,2026-07-05,100000.00,0,0,18000.00,0,118000.00,Y,`,
  `${KONKAN_GSTIN},Konkan Packaging,Invoice,KP-42,2026-07-09,40000.00,0,0,7200.00,0,47200.00,Y,`,
  `${MYSORE_GSTIN},Mysore Papers,Invoice,MP-9,2026-07-18,30000.00,2700.00,2700.00,0,0,35400.00,Y,`,
  `${NANDI_GSTIN},Nandi Motors,Invoice,NM-771,2026-07-21,800000.00,112000.00,112000.00,0,0,1024000.00,N,Credit not available on this kind of purchase`,
  `${COASTAL_GSTIN},Coastal Traders,Invoice,CT-77,2026-07-23,20000.00,1800.00,1800.00,0,0,23600.00,Y,`,
  `${SHREE_RAM_GSTIN},Shree Ram Steels,Credit note,SRS/CN/14,2026-07-27,10000.00,0,0,1800.00,0,11800.00,Y,`,
].join('\n');

/**
 * August's statement, in which Deccan Chemicals finally files the paint bill.
 *
 * Imported into the July period in the "it turns up next month" test, which is what actually
 * happens: the supplier files late, the bill appears, and the credit that was held back is
 * released without anybody having to remember what they decided in July.
 */
export const DECCAN_LATE_FILING = JSON.stringify({
  data: {
    gstin: SUNRISE_GSTIN,
    rtnprd: '072026',
    docdata: {
      b2b: [{
        ctin: DECCAN_GSTIN,
        trdnm: 'Deccan Chemicals',
        supprd: '082026',
        inv: [{
          inum: 'DC-556', dt: '14-07-2026', val: 59000.00, itcavl: 'Y', rsn: null,
          txval: 50000.00, cgst: 4500.00, sgst: 4500.00, igst: 0, cess: 0, rchrg: 'N',
        }],
      }],
    },
  },
});

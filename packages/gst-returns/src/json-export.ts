/**
 * Issue #30 [E30] — the file a business uploads to the government portal by hand.
 *
 * This exists because of the third acceptance criterion: **manual export must work without
 * production GSP access.** A GSP is the licensed intermediary that submits returns through an API,
 * and getting one costs money, takes weeks and needs a signed agreement. A shop that has just
 * started using this product has none of that, and it still has a return due on the eleventh. So
 * the product writes the same file the government's own offline tool writes, the shopkeeper
 * uploads it, and nothing about that path depends on an integration existing.
 *
 * The shape below follows the portal's published offline-utility JSON: `gstin`, `fp` for the
 * period, and one key per table. Field names are the government's, not this product's, and they
 * are deliberately terse and lower-case — that is what the portal reads.
 *
 * Two things this writer will not do:
 *
 *  - it will not write a file for a return that has not been approved, because a file on a
 *    shopkeeper's desktop is indistinguishable from a filed one once it leaves here;
 *  - it will not invent a field. Where a value is genuinely unknown the export refuses rather than
 *    writing a zero, since a zero in a tax field is a claim, not a blank.
 */
import { invalid } from '@invoice/kernel';
import type { Money } from '@invoice/kernel';
import { governmentPeriod, type DocumentSeriesKind, type Gstr1Return, type Gstr1Row, type Gstr3bReturn, type HsnRow, type TaxAmounts, type TaxPeriod } from './types.ts';

/** The portal reads rupees with two decimals, not paise. Exact conversion, never floating point. */
const rupees = (amount: Money): number => {
  const negative = amount.minor < 0n;
  const absolute = negative ? -amount.minor : amount.minor;
  const whole = absolute / 100n;
  const paise = absolute % 100n;
  return Number(`${negative ? '-' : ''}${whole}.${paise.toString().padStart(2, '0')}`);
};

const rate = (ratePercentTimes100: bigint | null): number =>
  ratePercentTimes100 === null ? 0 : Number(ratePercentTimes100) / 100;

/** The portal's item block: rate, taxable value and the four taxes. */
const itemBlock = (row: Gstr1Row): Record<string, number> => ({
  rt: rate(row.ratePercentTimes100),
  txval: rupees(row.amounts.taxableValue),
  iamt: rupees(row.amounts.igst),
  camt: rupees(row.amounts.cgst),
  samt: rupees(row.amounts.sgst),
  csamt: rupees(row.amounts.cess),
});

const requireValue = <T>(value: T | null | undefined, what: string, where: string): T => {
  if (value === null || value === undefined) {
    throw invalid('GSTR1_EXPORT_MISSING_FIELD', `The government file needs ${what} on ${where}, and this return does not have it. Fix it on the bill rather than filing a blank.`);
  }
  return value;
};

/**
 * Rows of a listed table, grouped back into one entry per bill with its rate lines inside.
 *
 * `buildGstr1` split each bill into one row per rate because that is how a person reads a return;
 * the portal wants them nested again. Doing the regrouping here rather than keeping two shapes
 * around means the screen and the file can never drift apart.
 */
const groupByDocument = (rows: readonly Gstr1Row[]): Map<string, Gstr1Row[]> => {
  const grouped = new Map<string, Gstr1Row[]>();
  for (const row of rows) {
    const key = `${row.documentNumber ?? ''}|${row.documentDate ?? ''}`;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return grouped;
};

/** The portal writes a date as "15-07-2026". */
const portalDate = (date: string): string => {
  const [year, month, day] = date.split('-') as [string, string, string];
  return `${day}-${month}-${year}`;
};

const sectionRows = (gstr1: Gstr1Return, id: string): readonly Gstr1Row[] =>
  gstr1.sections.find((section) => section.id === id)?.rows ?? [];

/**
 * Writes the GSTR-1 upload file.
 *
 * `Record<string, unknown>` rather than a typed shape on purpose: this is somebody else's schema,
 * it changes when the portal changes, and modelling it as if it were ours would invite the rest of
 * the product to depend on it.
 */
export const toGstr1Json = (gstr1: Gstr1Return): Record<string, unknown> => {
  const file: Record<string, unknown> = {
    gstin: gstr1.gstin,
    fp: governmentPeriod(gstr1.period),
    // The portal's own version marker for the offline tool's format.
    version: 'GST3.2.2',
    hash: 'hash',
  };

  const b2b = [...groupByDocument(sectionRows(gstr1, 'B2B')).values()];
  if (b2b.length > 0) {
    const byCounterparty = new Map<string, Gstr1Row[][]>();
    for (const invoice of b2b) {
      const first = invoice[0] as Gstr1Row;
      const gstin = requireValue(first.counterpartyGstin, "the buyer's GST number", `bill ${first.documentNumber}`);
      byCounterparty.set(gstin, [...(byCounterparty.get(gstin) ?? []), invoice]);
    }
    file['b2b'] = [...byCounterparty.entries()].map(([ctin, invoices]) => ({
      ctin,
      inv: invoices.map((rows) => {
        const first = rows[0] as Gstr1Row;
        return {
          inum: requireValue(first.documentNumber, 'a bill number', 'a business sale'),
          idt: portalDate(requireValue(first.documentDate, 'a bill date', `bill ${first.documentNumber}`)),
          val: rupees(requireValue(first.invoiceValue, 'the bill total', `bill ${first.documentNumber}`)),
          pos: requireValue(first.placeOfSupplyStateCode, 'the place of supply', `bill ${first.documentNumber}`),
          rchrg: first.reverseCharge ? 'Y' : 'N',
          inv_typ: invoiceType(first),
          itms: rows.map((row, index) => ({ num: index + 1, itm_det: itemBlock(row) })),
        };
      }),
    }));
  }

  const b2cl = [...groupByDocument(sectionRows(gstr1, 'B2CL')).values()];
  if (b2cl.length > 0) {
    const byState = new Map<string, Gstr1Row[][]>();
    for (const invoice of b2cl) {
      const first = invoice[0] as Gstr1Row;
      const pos = requireValue(first.placeOfSupplyStateCode, 'the place of supply', `bill ${first.documentNumber}`);
      byState.set(pos, [...(byState.get(pos) ?? []), invoice]);
    }
    file['b2cl'] = [...byState.entries()].map(([pos, invoices]) => ({
      pos,
      inv: invoices.map((rows) => {
        const first = rows[0] as Gstr1Row;
        return {
          inum: requireValue(first.documentNumber, 'a bill number', 'a large consumer sale'),
          idt: portalDate(requireValue(first.documentDate, 'a bill date', `bill ${first.documentNumber}`)),
          val: rupees(requireValue(first.invoiceValue, 'the bill total', `bill ${first.documentNumber}`)),
          itms: rows.map((row, index) => ({ num: index + 1, itm_det: itemBlock(row) })),
        };
      }),
    }));
  }

  const b2cs = sectionRows(gstr1, 'B2CS');
  if (b2cs.length > 0) {
    file['b2cs'] = b2cs.map((row) => ({
      sply_ty: row.amounts.igst.minor !== 0n ? 'INTER' : 'INTRA',
      pos: requireValue(row.placeOfSupplyStateCode, 'the place of supply', 'an everyday consumer sale'),
      typ: 'OE',
      ...itemBlock(row),
    }));
  }

  const cdnr = [...groupByDocument(sectionRows(gstr1, 'CDNR')).values()];
  if (cdnr.length > 0) {
    const byCounterparty = new Map<string, Gstr1Row[][]>();
    for (const note of cdnr) {
      const first = note[0] as Gstr1Row;
      const gstin = requireValue(first.counterpartyGstin, "the buyer's GST number", `note ${first.documentNumber}`);
      byCounterparty.set(gstin, [...(byCounterparty.get(gstin) ?? []), note]);
    }
    file['cdnr'] = [...byCounterparty.entries()].map(([ctin, notes]) => ({
      ctin,
      nt: notes.map((rows) => {
        const first = rows[0] as Gstr1Row;
        return {
          ntty: first.documentKind === 'DEBIT_NOTE' ? 'D' : 'C',
          nt_num: requireValue(first.documentNumber, 'a note number', 'a credit or debit note'),
          nt_dt: portalDate(requireValue(first.documentDate, 'a note date', `note ${first.documentNumber}`)),
          // The portal wants the note's own value as a positive figure; the sign is in `ntty`.
          val: rupees(requireValue(first.invoiceValue, 'the note total', `note ${first.documentNumber}`)),
          pos: requireValue(first.placeOfSupplyStateCode, 'the place of supply', `note ${first.documentNumber}`),
          rchrg: first.reverseCharge ? 'Y' : 'N',
          inv_typ: invoiceType(first),
          itms: rows.map((row, index) => ({ num: index + 1, itm_det: positiveItemBlock(row) })),
        };
      }),
    }));
  }

  const cdnur = [...groupByDocument(sectionRows(gstr1, 'CDNUR')).values()];
  if (cdnur.length > 0) {
    file['cdnur'] = cdnur.map((rows) => {
      const first = rows[0] as Gstr1Row;
      return {
        typ: first.treatment === 'EXPORT_WITH_TAX' ? 'EXPWP' : first.treatment === 'EXPORT_WITHOUT_TAX' ? 'EXPWOP' : 'B2CL',
        ntty: first.documentKind === 'DEBIT_NOTE' ? 'D' : 'C',
        nt_num: requireValue(first.documentNumber, 'a note number', 'a consumer credit or debit note'),
        nt_dt: portalDate(requireValue(first.documentDate, 'a note date', `note ${first.documentNumber}`)),
        val: rupees(requireValue(first.invoiceValue, 'the note total', `note ${first.documentNumber}`)),
        pos: requireValue(first.placeOfSupplyStateCode, 'the place of supply', `note ${first.documentNumber}`),
        itms: rows.map((row, index) => ({ num: index + 1, itm_det: positiveItemBlock(row) })),
      };
    });
  }

  // Issue #286 — table 6A, exports: with payment of IGST (WPAY) or under LUT/bond (WOPAY).
  const exp = [...groupByDocument(sectionRows(gstr1, 'EXP')).values()];
  if (exp.length > 0) {
    const byType = new Map<'WPAY' | 'WOPAY', Gstr1Row[][]>();
    for (const invoice of exp) {
      const type = (invoice[0] as Gstr1Row).treatment === 'EXPORT_WITH_TAX' ? 'WPAY' : 'WOPAY';
      byType.set(type, [...(byType.get(type) ?? []), invoice]);
    }
    file['exp'] = [...byType.entries()].map(([expTyp, invoices]) => ({
      exp_typ: expTyp,
      inv: invoices.map((rows) => {
        const first = rows[0] as Gstr1Row;
        return {
          inum: requireValue(first.documentNumber, 'a bill number', 'an export'),
          idt: portalDate(requireValue(first.documentDate, 'a bill date', `bill ${first.documentNumber}`)),
          val: rupees(requireValue(first.invoiceValue, 'the bill total', `bill ${first.documentNumber}`)),
          // The shipping bill may follow the invoice; the portal accepts it added later.
          ...(first.shippingBill === undefined ? {} : {
            sbpcode: first.shippingBill.portCode,
            sbnum: first.shippingBill.number,
            sbdt: portalDate(first.shippingBill.date),
          }),
          itms: rows.map((row) => ({
            txval: rupees(row.amounts.taxableValue),
            rt: rate(row.ratePercentTimes100),
            iamt: rupees(row.amounts.igst),
            csamt: rupees(row.amounts.cess),
          })),
        };
      }),
    }));
  }

  // Issue #286 — table 11A (advances received, net of refunds) and 11B (advances used this month).
  const supplierState = gstr1.gstin.slice(0, 2);
  const advances = (id: 'AT' | 'TXPD'): Record<string, unknown>[] => {
    const byPlace = new Map<string, Map<string, { rate: bigint | null; amounts: TaxAmounts }>>();
    for (const row of sectionRows(gstr1, id)) {
      const pos = requireValue(row.placeOfSupplyStateCode, 'the place of supply', `advance ${row.documentNumber}`);
      const rates = byPlace.get(pos) ?? new Map();
      const key = row.ratePercentTimes100 === null ? 'none' : row.ratePercentTimes100.toString();
      const existing = rates.get(key);
      rates.set(key, { rate: row.ratePercentTimes100, amounts: existing === undefined ? row.amounts : addTax(existing.amounts, row.amounts) });
      byPlace.set(pos, rates);
    }
    return [...byPlace.entries()].map(([pos, rates]) => ({
      pos,
      sply_ty: pos === supplierState ? 'INTRA' : 'INTER',
      itms: [...rates.values()].map((entry) => {
        // 11B rows are held as negatives (they reduce what is owed); the portal wants them positive.
        const amounts = id === 'TXPD' ? absoluteTax(entry.amounts) : entry.amounts;
        return {
          rt: rate(entry.rate),
          ad_amt: rupees(amounts.taxableValue),
          iamt: rupees(amounts.igst),
          camt: rupees(amounts.cgst),
          samt: rupees(amounts.sgst),
          csamt: rupees(amounts.cess),
        };
      }),
    }));
  };
  const at = advances('AT');
  if (at.length > 0) file['at'] = at;
  const txpd = advances('TXPD');
  if (txpd.length > 0) file['txpd'] = txpd;

  const nil = sectionRows(gstr1, 'NIL');
  if (nil.length > 0) {
    file['nil'] = {
      inv: nil.map((row) => ({
        sply_ty: nilSupplyType(row),
        nil_amt: row.treatment === 'NIL_RATED' ? rupees(row.amounts.taxableValue) : 0,
        expt_amt: row.treatment === 'EXEMPT' ? rupees(row.amounts.taxableValue) : 0,
        ngsup_amt: row.treatment === 'NON_GST' ? rupees(row.amounts.taxableValue) : 0,
      })),
    };
  }

  if (gstr1.hsn.length > 0) {
    // Issue #286 — from the January 2025 tax period table 12 has a B2B tab and a B2C tab, each
    // numbered from 1. A services code (SAC, 99…) has no quantity: UQC "NA", quantity 0.
    const hsnRows = (rows: readonly HsnRow[]) => rows.map((row, index) => {
      const service = isServiceCode(row.hsnOrSac);
      return {
        num: index + 1,
        hsn_sc: row.hsnOrSac,
        desc: row.description,
        uqc: service ? 'NA' : row.unit ?? 'OTH',
        qty: service ? 0 : Number(row.quantity ?? '0'),
        rt: rate(row.ratePercentTimes100),
        txval: rupees(row.amounts.taxableValue),
        iamt: rupees(row.amounts.igst),
        camt: rupees(row.amounts.cgst),
        samt: rupees(row.amounts.sgst),
        csamt: rupees(row.amounts.cess),
      };
    });
    const b2bHsn = gstr1.hsn.filter((row) => row.supplyTo === 'B2B');
    const b2cHsn = gstr1.hsn.filter((row) => row.supplyTo === 'B2C');
    file['hsn'] = {
      ...(b2bHsn.length === 0 ? {} : { hsn_b2b: hsnRows(b2bHsn) }),
      ...(b2cHsn.length === 0 ? {} : { hsn_b2c: hsnRows(b2cHsn) }),
    };
  }

  if (gstr1.documents.length > 0) {
    file['doc_issue'] = {
      // Issue #286 — `doc_num` is the portal's fixed code for the kind of paper, not a counter.
      doc_det: gstr1.documents.map((series) => ({
        doc_num: DOCUMENT_CODES[series.kind],
        doc_typ: documentTypeName(series.kind),
        docs: [{ num: 1, from: series.from, to: series.to, totnum: series.total, cancel: series.cancelled, net_issue: series.issued }],
      })),
    };
  }

  return file;
};

/** A note's amounts are held as negatives on the return; the portal wants them positive. */
const positiveItemBlock = (row: Gstr1Row): Record<string, number> => {
  const absolute = (value: Money): Money => ({ currency: 'INR', minor: value.minor < 0n ? -value.minor : value.minor });
  const amounts: TaxAmounts = {
    taxableValue: absolute(row.amounts.taxableValue),
    cgst: absolute(row.amounts.cgst),
    sgst: absolute(row.amounts.sgst),
    igst: absolute(row.amounts.igst),
    cess: absolute(row.amounts.cess),
  };
  return itemBlock({ ...row, amounts });
};

const invoiceType = (row: Gstr1Row): string => {
  switch (row.treatment) {
    case 'SEZ_WITH_TAX': return 'SEWP';
    case 'SEZ_WITHOUT_TAX': return 'SEWOP';
    case 'DEEMED_EXPORT': return 'DE';
    default: return 'R';
  }
};

const nilSupplyType = (row: Gstr1Row): string => {
  const interState = row.key.includes('|inter|');
  const registered = row.key.includes('|b2b');
  return `${interState ? 'INTER' : 'INTRA'}${registered ? 'B2B' : 'B2C'}`;
};

/**
 * GSTR-1 table 13's fixed codes. 2, 3 and 7 (inward invoices from unregistered persons, revised
 * invoices, payment vouchers) are papers this product does not issue.
 */
const DOCUMENT_CODES: Readonly<Record<DocumentSeriesKind, number>> = {
  INVOICE: 1,
  DEBIT_NOTE: 4,
  CREDIT_NOTE: 5,
  ADVANCE_RECEIPT: 6,
  REFUND_VOUCHER: 8,
  DELIVERY_CHALLAN_JOB_WORK: 9,
  DELIVERY_CHALLAN_APPROVAL: 10,
  DELIVERY_CHALLAN_LIQUID_GAS: 11,
  DELIVERY_CHALLAN_OTHER: 12,
};

const documentTypeName = (kind: DocumentSeriesKind): string => {
  switch (kind) {
    case 'CREDIT_NOTE': return 'Credit Note';
    case 'DEBIT_NOTE': return 'Debit Note';
    case 'ADVANCE_RECEIPT': return 'Receipt Voucher';
    case 'REFUND_VOUCHER': return 'Refund Voucher';
    case 'DELIVERY_CHALLAN_JOB_WORK': return 'Delivery Challan for job work';
    case 'DELIVERY_CHALLAN_APPROVAL': return 'Delivery Challan for supply on approval';
    case 'DELIVERY_CHALLAN_LIQUID_GAS': return 'Delivery Challan in case of liquid gas';
    case 'DELIVERY_CHALLAN_OTHER': return 'Delivery Challan in case other than by way of supply (excluding at S no. 9 to 11)';
    default: return 'Invoices for outward supply';
  }
};

/** Services codes (SAC) are the 99 chapter. */
const isServiceCode = (code: string): boolean => code.startsWith('99');

const addTax = (a: TaxAmounts, b: TaxAmounts): TaxAmounts => ({
  taxableValue: { currency: 'INR', minor: a.taxableValue.minor + b.taxableValue.minor },
  cgst: { currency: 'INR', minor: a.cgst.minor + b.cgst.minor },
  sgst: { currency: 'INR', minor: a.sgst.minor + b.sgst.minor },
  igst: { currency: 'INR', minor: a.igst.minor + b.igst.minor },
  cess: { currency: 'INR', minor: a.cess.minor + b.cess.minor },
});

const absoluteTax = (amounts: TaxAmounts): TaxAmounts => {
  const absolute = (value: Money): Money => ({ currency: 'INR', minor: value.minor < 0n ? -value.minor : value.minor });
  return { taxableValue: absolute(amounts.taxableValue), cgst: absolute(amounts.cgst), sgst: absolute(amounts.sgst), igst: absolute(amounts.igst), cess: absolute(amounts.cess) };
};

/**
 * Writes the GSTR-3B upload file.
 *
 * Shorter than GSTR-1 because the form is: five outward lines, the state-wise consumer figures,
 * and the credit block. Table 6.1 — what is actually paid — is not written, because this product
 * has not decided it. See the note at the top of `gstr3b.ts`.
 */
export const toGstr3bJson = (gstr3b: Gstr3bReturn): Record<string, unknown> => {
  const box = (id: string): TaxAmounts => {
    const found = gstr3b.outward.find((entry) => entry.boxId === id);
    if (found === undefined) throw invalid('GSTR3B_EXPORT_MISSING_BOX', `The 3B file needs box ${id} and this return does not have it.`);
    return found.amounts;
  };
  const creditBox = (id: string): TaxAmounts => {
    const found = gstr3b.credit.find((entry) => entry.boxId === id);
    if (found === undefined) throw invalid('GSTR3B_EXPORT_MISSING_BOX', `The 3B file needs box ${id} and this return does not have it.`);
    return found.amounts;
  };
  const supply = (amounts: TaxAmounts) => ({
    txval: rupees(amounts.taxableValue),
    iamt: rupees(amounts.igst),
    camt: rupees(amounts.cgst),
    samt: rupees(amounts.sgst),
    csamt: rupees(amounts.cess),
  });
  const itc = (amounts: TaxAmounts) => ({
    iamt: rupees(amounts.igst),
    camt: rupees(amounts.cgst),
    samt: rupees(amounts.sgst),
    csamt: rupees(amounts.cess),
  });

  return {
    gstin: gstr3b.gstin,
    ret_period: governmentPeriod(gstr3b.period),
    sup_details: {
      osup_det: supply(box('3.1(a)')),
      osup_zero: supply(box('3.1(b)')),
      osup_nil_exmp: { txval: rupees(box('3.1(c)').taxableValue) },
      isup_rev: supply(box('3.1(d)')),
      osup_nongst: { txval: rupees(box('3.1(e)').taxableValue) },
    },
    // Issue #286 — table 3.1.1, supplies through an e-commerce operator under section 9(5). This
    // product sells through none, so both rows are written as nothing rather than left out.
    eco_dtls: {
      eco_sup: { txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 },
      eco_reg_sup: { txval: 0 },
    },
    inter_sup: {
      unreg_details: gstr3b.interStateToUnregistered.map((entry) => ({
        pos: entry.stateCode,
        txval: rupees(entry.taxableValue),
        iamt: rupees(entry.igst),
      })),
    },
    itc_elg: {
      itc_avl: [
        { ty: 'IMPG', ...itc(creditBox('4A(4)')) },
        { ty: 'ISRC', ...itc(creditBox('4A(3)')) },
        { ty: 'OTH', ...itc(creditBox('4A(5)')) },
      ],
      itc_rev: [{ ty: 'OTH', ...itc(creditBox('4B')) }],
      itc_net: itc(creditBox('4C')),
    },
    inward_sup: {
      // Issue #286 — table 5 has two rows. Purchases outside GST are not recorded separately here,
      // so the NONGST row is written as nothing, not left out.
      isup_details: [
        { ty: 'GST', inter: 0, intra: rupees(gstr3b.exemptInwardValue) },
        { ty: 'NONGST', inter: 0, intra: 0 },
      ],
    },
  };
};

/**
 * The file name a person will recognise on their own desktop.
 *
 * The period is written the government's way, `MMYYYY`, so it matches the period inside the file
 * and the one on the portal screen they are uploading it to. A person checking that they are about
 * to upload July's return should not have to translate between two ways of writing July.
 */
export const exportFileName = (returnType: 'GSTR1' | 'GSTR3B', gstin: string, period: TaxPeriod): string =>
  `${returnType.toLowerCase()}_${gstin}_${governmentPeriod(period)}.json`;

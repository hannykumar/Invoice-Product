/**
 * Issue #35 [E35] — what was sold and what was bought, bill by bill.
 *
 * A register is the bridge between a document a person remembers and the entries the books
 * made from it. Only issued bills count: a draft is not a sale, and a cancelled bill has already
 * been undone in the ledger, so counting it would make the register disagree with the books.
 */
import { formatINR, sum, zero, type BranchId, type CompanyId, type IsoDate, type Money, type PartyId } from '@invoice/kernel';
import type { SalesInvoice, SalesRepository } from '@invoice/sales';
import { figureOf, type Bilingual, type Contribution, type Figure, type ReportFilter } from './model.ts';
import { nameOr, type PurchaseReadPort, type ReportNames } from './ports.ts';

export interface RegisterRow {
  readonly documentId: string;
  readonly number: string;
  readonly date: IsoDate;
  readonly branchId: BranchId | null;
  readonly partyId: PartyId;
  readonly partyName: string;
  readonly taxableValue: Money;
  readonly cgst: Money;
  readonly sgst: Money;
  readonly igst: Money;
  readonly cess: Money;
  readonly total: Money;
  /** Set when the bill was priced without a rate anyone could stand behind. */
  readonly taxNotDecided: boolean;
}

export interface RegisterBody {
  readonly rows: readonly RegisterRow[];
  readonly taxableValue: Figure;
  readonly tax: Figure;
  readonly total: Figure;
  readonly sentence: Bilingual;
  /** False when the module that owns these documents is not built yet. */
  readonly available: boolean;
}

const contribution = (row: RegisterRow, kind: string, amount: Money, what: string): Contribution => ({
  sourceKind: kind,
  sourceId: row.documentId,
  sourceNumber: row.number,
  date: row.date,
  branchId: row.branchId,
  partyId: row.partyId,
  description: `${what} on ${row.number} for ${row.partyName}`,
  amount,
});

const bodyOf = (rows: readonly RegisterRow[], kind: string, available: boolean, words: Bilingual): RegisterBody => ({
  rows,
  taxableValue: figureOf(rows.map((r) => contribution(r, kind, r.taxableValue, 'Value of goods and services'))),
  tax: figureOf(rows.map((r) => contribution(r, kind, sum([r.cgst, r.sgst, r.igst, r.cess]), 'GST'))),
  total: figureOf(rows.map((r) => contribution(r, kind, r.total, 'Bill total'))),
  sentence: words,
  available,
});

const inPeriod = (date: IsoDate, filter: ReportFilter): boolean => date >= filter.from && date <= filter.to;
const inBranch = (branchId: BranchId | null, filter: ReportFilter): boolean =>
  filter.branchId === undefined ? true : branchId === filter.branchId;

/** An issued bill, and nothing else. */
export const countsInSalesRegister = (invoice: SalesInvoice): boolean => invoice.state === 'FINAL';

export const salesRegister = async (
  repository: SalesRepository,
  names: ReportNames,
  companyId: CompanyId,
  filter: ReportFilter,
): Promise<RegisterBody> => {
  const invoices = (await repository.list(companyId))
    .filter(countsInSalesRegister)
    .filter((i) => inPeriod(i.documentDate, filter) && inBranch(i.branchId, filter))
    .sort((a, b) => (a.documentDate === b.documentDate ? (a.number ?? '').localeCompare(b.number ?? '') : a.documentDate.localeCompare(b.documentDate)));

  const rows: RegisterRow[] = invoices.map((invoice) => {
    const totals = invoice.pricing?.totals;
    const lines = invoice.pricing?.lines ?? [];
    return {
      documentId: invoice.id,
      number: invoice.number ?? invoice.id,
      date: invoice.documentDate,
      branchId: invoice.branchId,
      partyId: invoice.partyId,
      partyName: nameOr(names.party(companyId, invoice.partyId), invoice.partyId),
      taxableValue: totals?.taxableValue ?? zero('INR'),
      cgst: totals?.cgst ?? zero('INR'),
      sgst: sum([totals?.sgst ?? zero('INR'), totals?.utgst ?? zero('INR')]),
      igst: totals?.igst ?? zero('INR'),
      cess: totals?.cess ?? zero('INR'),
      total: totals?.invoiceValue ?? zero('INR'),
      taxNotDecided: lines.some((line) => line.ratePercentTimes100 === null && line.treatment === 'TAXABLE'),
    };
  });

  const total = sum(rows.map((r) => r.total));
  return bodyOf(rows, 'sales_invoice', true, {
    'en-IN': `You billed ${formatINR(total)} across ${rows.length} ${rows.length === 1 ? 'bill' : 'bills'}.`,
    'hi-IN': `Aapne ${rows.length} bill banaye, kul ${formatINR(total)} ke.`,
  });
};

/**
 * The purchase side, through GPT 3's #17.
 *
 * When the port says it is a mock, the register is empty and says so. An empty section a reader
 * understands is worth more than a filled one nobody can trust.
 */
export const purchaseRegister = async (
  purchases: PurchaseReadPort,
  companyId: CompanyId,
  filter: ReportFilter,
): Promise<RegisterBody> => {
  const documents = (await purchases.list(companyId, filter.from, filter.to)).filter((d) => inBranch(d.branchId, filter));
  const rows: RegisterRow[] = documents.map((d) => ({
    documentId: d.documentId,
    number: d.number,
    date: d.date,
    branchId: d.branchId,
    partyId: d.supplierId,
    partyName: d.supplierName,
    taxableValue: d.taxableValue,
    cgst: d.cgst,
    sgst: d.sgst,
    igst: d.igst,
    cess: d.cess,
    total: d.invoiceValue,
    taxNotDecided: false,
  }));
  const total = sum(rows.map((r) => r.total));
  return bodyOf(rows, 'purchase_invoice', purchases.available, {
    'en-IN': purchases.available
      ? `You bought ${formatINR(total)} across ${rows.length} ${rows.length === 1 ? 'bill' : 'bills'}.`
      : 'Purchase bills are not being recorded in this product yet, so this part is empty on purpose.',
    'hi-IN': purchases.available
      ? `Aapne ${rows.length} bill par kul ${formatINR(total)} ki kharid ki.`
      : 'Kharid ke bill abhi is product mein darj nahin ho rahe, isliye yeh hissa jaan-boojh kar khaali hai.',
  });
};

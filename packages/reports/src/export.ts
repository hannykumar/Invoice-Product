/**
 * Issue #35 [E35] — taking a report off the screen.
 *
 * An exported file carries its header first — the business, the dates, the branch, when it was
 * taken and the snapshot id — because a page of figures with no idea what it was filtered to is
 * how the wrong month ends up in front of an accountant.
 *
 * The bytes are a function of the report alone. Exporting the same snapshot twice produces the
 * same file, so a retry after a failed download cannot produce a second, subtly different
 * document.
 */
import { formatDate, toDecimalString, type Money } from '@invoice/kernel';
import type { Locale } from '@invoice/ux-vocabulary';
import type { Figure, Report, ReportHeader } from './model.ts';
import type { TrialBalanceBody, ProfitAndLossBody, BalanceSheetBody } from './financial.ts';
import type { RegisterBody } from './registers.ts';
import type { StockBody } from './stock.ts';
import type { AgeingBody } from './dues.ts';
import type { GstSummaryBody } from './gst.ts';
import type { ExceptionsBody } from './exceptions.ts';

export interface ReportTable {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

/**
 * The words a table is made of, in both languages.
 *
 * A page that is half Hindi and half English is harder to read than either, so the headings and the
 * standing row labels live here rather than as string literals inside each builder.
 */
const WORDS = {
  accountCode: { 'en-IN': 'Account code', 'hi-IN': 'Account number' },
  account: { 'en-IN': 'Account', 'hi-IN': 'Account' },
  opening: { 'en-IN': 'At the start', 'hi-IN': 'Shuruaat mein' },
  putIn: { 'en-IN': 'Put in during the period', 'hi-IN': 'Is dauraan jama' },
  takenOut: { 'en-IN': 'Taken out during the period', 'hi-IN': 'Is dauraan nikala' },
  closing: { 'en-IN': 'At the end', 'hi-IN': 'Aakhir mein' },
  side: { 'en-IN': 'Which side', 'hi-IN': 'Kaunsi taraf' },
  owned: { 'en-IN': 'Owned or spent', 'hi-IN': 'Apna ya kharch' },
  owed: { 'en-IN': 'Owed or earned', 'hi-IN': 'Dena ya kamai' },
  group: { 'en-IN': 'Group', 'hi-IN': 'Samooh' },
  amount: { 'en-IN': 'Amount', 'hi-IN': 'Rakam' },
  total: { 'en-IN': 'Total', 'hi-IN': 'Kul' },
  whatIsLeft: { 'en-IN': 'What is left', 'hi-IN': 'Kya bacha' },
  earnedLessSpent: { 'en-IN': 'Earned less spent', 'hi-IN': 'Kamai minus kharch' },
  earnedLessSpentSoFar: { 'en-IN': 'Earned less spent so far', 'hi-IN': 'Ab tak kamai minus kharch' },
  claims: { 'en-IN': 'Claims on it', 'hi-IN': 'Uspar dawe' },
  date: { 'en-IN': 'Date', 'hi-IN': 'Tareekh' },
  number: { 'en-IN': 'Number', 'hi-IN': 'Number' },
  name: { 'en-IN': 'Name', 'hi-IN': 'Naam' },
  goodsValue: { 'en-IN': 'Value of goods and services', 'hi-IN': 'Maal aur kaam ki keemat' },
  centralGst: { 'en-IN': 'Central GST', 'hi-IN': 'Central GST' },
  stateGst: { 'en-IN': 'State GST', 'hi-IN': 'State GST' },
  outsideGst: { 'en-IN': 'GST on outside sales', 'hi-IN': 'Bahar ki bikri par GST' },
  extraCharge: { 'en-IN': 'Extra charge', 'hi-IN': 'Extra charge' },
  billTotal: { 'en-IN': 'Bill total', 'hi-IN': 'Bill ka kul' },
  item: { 'en-IN': 'Item', 'hi-IN': 'Item' },
  godown: { 'en-IN': 'Godown', 'hi-IN': 'Godown' },
  unit: { 'en-IN': 'Unit', 'hi-IN': 'Unit' },
  cameIn: { 'en-IN': 'Came in', 'hi-IN': 'Aaya' },
  wentOut: { 'en-IN': 'Went out', 'hi-IN': 'Gaya' },
  keptAside: { 'en-IN': 'Kept aside', 'hi-IN': 'Alag rakha' },
  canBeSold: { 'en-IN': 'Can be sold', 'hi-IN': 'Bech sakte hain' },
  worth: { 'en-IN': 'Worth', 'hi-IN': 'Keemat' },
  outstanding: { 'en-IN': 'Still owed', 'hi-IN': 'Abhi baaki' },
  moneyNoBill: { 'en-IN': 'Money with no bill', 'hi-IN': 'Bina bill ka paisa' },
  chequesNotCleared: { 'en-IN': 'Cheques not cleared', 'hi-IN': 'Cheque jo abhi paise nahin bane' },
  kindOfGst: { 'en-IN': 'Kind of GST', 'hi-IN': 'GST ka prakaar' },
  collected: { 'en-IN': 'Collected on your bills', 'hi-IN': 'Aapke bill par liya' },
  alreadyPaid: { 'en-IN': 'Already paid on purchases', 'hi-IN': 'Kharid par pehle diya' },
  howUrgent: { 'en-IN': 'How urgent', 'hi-IN': 'Kitna zaroori' },
  whatHappened: { 'en-IN': 'What happened', 'hi-IN': 'Kya hua' },
  whyItMatters: { 'en-IN': 'Why it matters', 'hi-IN': 'Kyun zaroori hai' },
  records: { 'en-IN': 'Records', 'hi-IN': 'Record' },
  whatItWas: { 'en-IN': 'What it was', 'hi-IN': 'Kya tha' },
  lookFirst: { 'en-IN': 'Look at this first', 'hi-IN': 'Pehle yeh dekhein' },
  needsDecision: { 'en-IN': 'Needs a decision', 'hi-IN': 'Faisla chahiye' },
  worthKnowing: { 'en-IN': 'Worth knowing', 'hi-IN': 'Jaan lena achha hai' },
} as const;

const w = (key: keyof typeof WORDS, locale: Locale): string => WORDS[key][locale];

const amount = (m: Money): string => toDecimalString(m);

export const trialBalanceTable = (body: TrialBalanceBody, locale: Locale = 'en-IN'): ReportTable => ({
  columns: (['accountCode', 'account', 'opening', 'putIn', 'takenOut', 'closing', 'side'] as const).map((k) => w(k, locale)),
  rows: body.rows.map((r) => [
    r.code,
    r.name,
    amount(r.opening.amount),
    amount(r.periodDebits.amount),
    amount(r.periodCredits.amount),
    amount(r.closing.amount),
    r.side === 'DEBIT' ? w('owned', locale) : w('owed', locale),
  ]),
});

export const profitAndLossTable = (body: ProfitAndLossBody, locale: Locale = 'en-IN'): ReportTable => ({
  columns: (['group', 'account', 'amount'] as const).map((k) => w(k, locale)),
  rows: [
    ...body.income.rows.map((r) => [body.income.heading[locale], r.name, amount(r.movement.amount)]),
    [body.income.heading[locale], w('total', locale), amount(body.income.total.amount)],
    ...body.expenses.rows.map((r) => [body.expenses.heading[locale], r.name, amount(r.movement.amount)]),
    [body.expenses.heading[locale], w('total', locale), amount(body.expenses.total.amount)],
    [w('whatIsLeft', locale), w('earnedLessSpent', locale), amount(body.result.amount)],
  ],
});

export const balanceSheetTable = (body: BalanceSheetBody, locale: Locale = 'en-IN'): ReportTable => ({
  columns: (['group', 'account', 'amount'] as const).map((k) => w(k, locale)),
  rows: [
    ...body.assets.rows.map((r) => [body.assets.heading[locale], r.name, amount(r.closing.amount)]),
    [body.assets.heading[locale], w('total', locale), amount(body.totalAssets.amount)],
    ...body.liabilities.rows.map((r) => [body.liabilities.heading[locale], r.name, amount(r.closing.amount)]),
    ...body.ownersMoney.rows.map((r) => [body.ownersMoney.heading[locale], r.name, amount(r.closing.amount)]),
    [body.ownersMoney.heading[locale], w('earnedLessSpentSoFar', locale), amount(body.resultSoFar.amount)],
    [w('claims', locale), w('total', locale), amount(body.totalClaims.amount)],
  ],
});

export const registerTable = (body: RegisterBody, locale: Locale = 'en-IN'): ReportTable => ({
  columns: (['date', 'number', 'name', 'goodsValue', 'centralGst', 'stateGst', 'outsideGst', 'extraCharge', 'billTotal'] as const).map(
    (k) => w(k, locale),
  ),
  rows: body.rows.map((r) => [
    formatDate(r.date),
    r.number,
    r.partyName,
    amount(r.taxableValue),
    amount(r.cgst),
    amount(r.sgst),
    amount(r.igst),
    amount(r.cess),
    amount(r.total),
  ]),
});

export const stockTable = (body: StockBody, locale: Locale = 'en-IN'): ReportTable => ({
  columns: (['item', 'godown', 'unit', 'opening', 'cameIn', 'wentOut', 'closing', 'keptAside', 'canBeSold', 'worth'] as const).map(
    (k) => w(k, locale),
  ),
  rows: body.rows.map((r) => [
    r.itemName,
    r.warehouseName,
    r.unitCode,
    r.opening,
    r.received,
    r.issued,
    r.closing,
    r.reserved,
    r.available,
    amount(r.value),
  ]),
});

export const ageingTable = (body: AgeingBody, locale: Locale = 'en-IN'): ReportTable => ({
  columns: [
    w('name', locale),
    w('outstanding', locale),
    ...body.bandLabels.map((b) => b[locale]),
    w('moneyNoBill', locale),
    w('chequesNotCleared', locale),
  ],
  rows: body.rows.map((r) => [
    r.partyName,
    amount(r.outstanding),
    ...r.buckets.map(amount),
    amount(r.onAccount),
    amount(r.chequesNotCleared),
  ]),
});

export const gstTable = (body: GstSummaryBody, locale: Locale = 'en-IN'): ReportTable => ({
  columns: (['kindOfGst', 'collected', 'alreadyPaid'] as const).map((k) => w(k, locale)),
  rows: [
    ...body.heads.map((h) => [h.label[locale], amount(h.collected.amount), amount(h.alreadyPaid.amount)]),
    [w('total', locale), amount(body.totalCollected.amount), amount(body.totalAlreadyPaid.amount)],
  ],
});

export const exceptionsTable = (body: ExceptionsBody, locale: Locale = 'en-IN'): ReportTable => ({
  columns: (['howUrgent', 'whatHappened', 'whyItMatters', 'amount', 'records'] as const).map((k) => w(k, locale)),
  rows: body.exceptions.map((e) => [
    e.severity === 'BLOCKING' ? w('lookFirst', locale) : e.severity === 'NEEDS_A_DECISION' ? w('needsDecision', locale) : w('worthKnowing', locale),
    e.what[locale],
    e.why[locale],
    e.amount === null ? '' : amount(e.amount),
    String(e.records.length),
  ]),
});

/** The records behind one total, as a table a person can read down. */
export const drillTable = (figure: Figure, locale: Locale = 'en-IN'): ReportTable => ({
  columns: (['date', 'number', 'whatItWas', 'amount'] as const).map((k) => w(k, locale)),
  rows: figure.contributors.map((c) => [formatDate(c.date), c.sourceNumber ?? '', c.description, amount(c.amount)]),
});

const csvCell = (value: string): string => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

const headerLines = (header: ReportHeader, locale: Locale): string[] => [
  header.title[locale],
  `Period: ${formatDate(header.filter.from)} to ${formatDate(header.filter.to)}`,
  `Shop: ${header.filter.branchId === undefined ? 'all' : (header.filter.branchId ?? 'entries with no shop')}`,
  `Taken at: ${header.asAt}`,
  `Snapshot: ${header.snapshotId}`,
  ...header.notes.map((n) => n[locale]),
];

export type ExportFormat = 'CSV' | 'JSON';

/**
 * One report as a file.
 *
 * CSV carries the header as comment-free leading lines, because that is what a spreadsheet shows
 * at the top of the sheet and what a person reads first. JSON carries the header as an object, for
 * whatever reads it next.
 */
export const exportReport = <T>(
  report: Report<T>,
  table: ReportTable,
  format: ExportFormat,
  locale: Locale = 'en-IN',
): string => {
  if (format === 'JSON') {
    return `${JSON.stringify({ header: report.header, columns: table.columns, rows: table.rows }, null, 2)}\n`;
  }
  const lines = [
    ...headerLines(report.header, locale).map((line) => csvCell(line)),
    '',
    table.columns.map(csvCell).join(','),
    ...table.rows.map((row) => row.map(csvCell).join(',')),
  ];
  return `${lines.join('\n')}\n`;
};

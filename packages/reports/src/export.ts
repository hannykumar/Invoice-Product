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
import { formatDate, neutraliseSpreadsheetCell, toDecimalString, type Money } from '@invoice/kernel';
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
  accountCode: { 'en-IN': 'Account code', 'hi-IN': 'खाता नंबर' },
  account: { 'en-IN': 'Account', 'hi-IN': 'खाता' },
  opening: { 'en-IN': 'At the start', 'hi-IN': 'शुरुआत में' },
  putIn: { 'en-IN': 'Put in during the period', 'hi-IN': 'इस दौरान जमा' },
  takenOut: { 'en-IN': 'Taken out during the period', 'hi-IN': 'इस दौरान निकाला' },
  closing: { 'en-IN': 'At the end', 'hi-IN': 'आख़िर में' },
  side: { 'en-IN': 'Which side', 'hi-IN': 'कौनसी तरफ़' },
  owned: { 'en-IN': 'Owned or spent', 'hi-IN': 'अपना या ख़र्च' },
  owed: { 'en-IN': 'Owed or earned', 'hi-IN': 'देना या कमाई' },
  group: { 'en-IN': 'Group', 'hi-IN': 'समूह' },
  amount: { 'en-IN': 'Amount', 'hi-IN': 'रक़म' },
  total: { 'en-IN': 'Total', 'hi-IN': 'कुल' },
  whatIsLeft: { 'en-IN': 'What is left', 'hi-IN': 'क्या बचा' },
  earnedLessSpent: { 'en-IN': 'Earned less spent', 'hi-IN': 'कमाई माइनस ख़र्च' },
  earnedLessSpentSoFar: { 'en-IN': 'Earned less spent so far', 'hi-IN': 'अब तक कमाई माइनस ख़र्च' },
  claims: { 'en-IN': 'Claims on it', 'hi-IN': 'उस पर दावे' },
  date: { 'en-IN': 'Date', 'hi-IN': 'तारीख़' },
  number: { 'en-IN': 'Number', 'hi-IN': 'नंबर' },
  name: { 'en-IN': 'Name', 'hi-IN': 'नाम' },
  goodsValue: { 'en-IN': 'Value of goods and services', 'hi-IN': 'माल और काम की कीमत' },
  centralGst: { 'en-IN': 'Central GST', 'hi-IN': 'सेंट्रल GST' },
  stateGst: { 'en-IN': 'State GST', 'hi-IN': 'स्टेट GST' },
  outsideGst: { 'en-IN': 'GST on outside sales', 'hi-IN': 'बाहर की बिक्री पर GST' },
  extraCharge: { 'en-IN': 'Extra charge', 'hi-IN': 'एक्स्ट्रा चार्ज' },
  billTotal: { 'en-IN': 'Bill total', 'hi-IN': 'बिल का कुल' },
  item: { 'en-IN': 'Item', 'hi-IN': 'आइटम' },
  godown: { 'en-IN': 'Godown', 'hi-IN': 'गोदाम' },
  unit: { 'en-IN': 'Unit', 'hi-IN': 'यूनिट' },
  cameIn: { 'en-IN': 'Came in', 'hi-IN': 'आया' },
  wentOut: { 'en-IN': 'Went out', 'hi-IN': 'गया' },
  keptAside: { 'en-IN': 'Kept aside', 'hi-IN': 'अलग रखा' },
  canBeSold: { 'en-IN': 'Can be sold', 'hi-IN': 'बेच सकते हैं' },
  worth: { 'en-IN': 'Worth', 'hi-IN': 'कीमत' },
  outstanding: { 'en-IN': 'Still owed', 'hi-IN': 'अभी बाक़ी' },
  moneyNoBill: { 'en-IN': 'Money with no bill', 'hi-IN': 'बिना बिल का पैसा' },
  chequesNotCleared: { 'en-IN': 'Cheques not cleared', 'hi-IN': 'चेक जो अभी पैसे नहीं बने' },
  kindOfGst: { 'en-IN': 'Kind of GST', 'hi-IN': 'GST का प्रकार' },
  collected: { 'en-IN': 'Collected on your bills', 'hi-IN': 'आपके बिल पर लिया' },
  alreadyPaid: { 'en-IN': 'Already paid on purchases', 'hi-IN': 'ख़रीद पर पहले दिया' },
  howUrgent: { 'en-IN': 'How urgent', 'hi-IN': 'कितना ज़रूरी' },
  whatHappened: { 'en-IN': 'What happened', 'hi-IN': 'क्या हुआ' },
  whyItMatters: { 'en-IN': 'Why it matters', 'hi-IN': 'क्यों ज़रूरी है' },
  records: { 'en-IN': 'Records', 'hi-IN': 'रिकॉर्ड' },
  whatItWas: { 'en-IN': 'What it was', 'hi-IN': 'क्या था' },
  lookFirst: { 'en-IN': 'Look at this first', 'hi-IN': 'पहले यह देखिए' },
  needsDecision: { 'en-IN': 'Needs a decision', 'hi-IN': 'फ़ैसला चाहिए' },
  worthKnowing: { 'en-IN': 'Worth knowing', 'hi-IN': 'जान लेना अच्छा है' },
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
    // Issue #273 — returns are shown as a deduction under what they undo, with the net line under it.
    ...body.income.lines.map((l) => [body.income.heading[locale], l.label[locale], amount(l.amount.amount)]),
    [body.income.heading[locale], w('total', locale), amount(body.income.total.amount)],
    ...body.expenses.lines.map((l) => [body.expenses.heading[locale], l.label[locale], amount(l.amount.amount)]),
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

/** A cell that would run as a formula in a spreadsheet is marked as text first (#394). */
const csvCell = (raw: string): string => {
  const value = neutraliseSpreadsheetCell(raw);
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
};

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

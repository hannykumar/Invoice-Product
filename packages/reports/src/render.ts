/**
 * Issue #35 [E35] — the reports as a page a person can actually look at.
 *
 * Printing is not the point; drilling is. Every total on the page opens into the records it was
 * folded from, because that is the difference between a figure an owner is asked to believe and one
 * they can check. The markup is plain HTML with no scripts, so it prints, opens on a slow phone and
 * can be handed to an accountant as a file.
 */
import { formatDate, formatINR, type Money } from '@invoice/kernel';
import type { Locale } from '@invoice/ux-vocabulary';
import type { Figure, Report, ReportHeader } from './model.ts';
import {
  ageingTable,
  balanceSheetTable,
  exceptionsTable,
  gstTable,
  profitAndLossTable,
  drillTable,
  registerTable,
  stockTable,
  trialBalanceTable,
  type ReportTable,
} from './export.ts';
import type { ReportPack } from './service.ts';

const escape = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const money = (m: Money): string => escape(formatINR(m));

const tableHtml = (table: ReportTable): string => `
  <div class="scroll">
  <table>
    <thead><tr>${table.columns.map((c) => `<th>${escape(c)}</th>`).join('')}</tr></thead>
    <tbody>
      ${table.rows.map((row) => `<tr>${row.map((cell) => `<td>${escape(cell)}</td>`).join('')}</tr>`).join('\n      ')}
    </tbody>
  </table>
  </div>`;

/** The labels the page puts on a total that opens. */
const DRILL_LABELS = {
  earned: { 'en-IN': 'Everything you earned', 'hi-IN': 'Jo kuch kamaya' },
  spent: { 'en-IN': 'Everything you spent', 'hi-IN': 'Jo kuch kharch hua' },
  owningSide: { 'en-IN': 'Everything put on the owning side', 'hi-IN': 'Apni taraf jo kuch daala gaya' },
  owingSide: { 'en-IN': 'Everything put on the owing side', 'hi-IN': 'Dene ki taraf jo kuch daala gaya' },
  everyBill: { 'en-IN': 'Total of every bill', 'hi-IN': 'Har bill ka kul' },
  goodsWorth: { 'en-IN': 'What the goods are worth', 'hi-IN': 'Maal ki keemat' },
  stillOwed: { 'en-IN': 'Everything customers still owe', 'hi-IN': 'Customers se jo kuch lena baaki hai' },
  gstCollected: { 'en-IN': 'GST you collected', 'hi-IN': 'Aapne jo GST liya' },
  gstPaid: { 'en-IN': 'GST you had already paid', 'hi-IN': 'Aap pehle hi jo GST de chuke the' },
} as const;

/** A total, and underneath it the records that made it, folded away until someone asks. */
const drillHtml = (label: keyof typeof DRILL_LABELS, figure: Figure, locale: Locale): string => `
  <details class="drill">
    <summary><span class="label">${escape(DRILL_LABELS[label][locale])}</span><span class="amount">${money(figure.amount)}</span></summary>
    <table class="records">
      <thead><tr>${drillTable(figure, locale)
        .columns.map((c) => `<th>${escape(c)}</th>`)
        .join('')}</tr></thead>
      <tbody>
        ${figure.contributors
          .map(
            (c) =>
              `<tr><td>${escape(formatDate(c.date))}</td><td>${escape(c.sourceNumber ?? '')}</td><td>${escape(c.description)}</td><td class="amount">${money(c.amount)}</td></tr>`,
          )
          .join('\n        ')}
      </tbody>
    </table>
  </details>`;

const headerHtml = (header: ReportHeader, locale: Locale): string => `
  <h2>${escape(header.title[locale])}</h2>
  <p class="notes">${header.notes.map((n) => escape(n[locale])).join('<br>')}</p>`;

const sectionHtml = <T>(report: Report<T>, locale: Locale, table: ReportTable, extra = ''): string => `
<section>
  ${headerHtml(report.header, locale)}
  ${tableHtml(table)}
  ${extra}
  <p class="snapshot">${escape(report.header.snapshotId)}</p>
</section>`;

const STYLE = `
  :root { color-scheme: light; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 24px;
         background: #f6f5f2; color: #1c1b19; line-height: 1.5; }
  main { max-width: 980px; margin: 0 auto; }
  h1 { font-size: 1.6rem; margin: 0 0 4px; }
  h2 { font-size: 1.15rem; margin: 0 0 4px; }
  section { background: #fff; border: 1px solid #e3e0d8; border-radius: 10px; padding: 18px 20px; margin: 0 0 18px; }
  p.notes { color: #5a564d; margin: 0 0 12px; font-size: 0.92rem; }
  p.snapshot { color: #9a958a; font-size: 0.72rem; margin: 12px 0 0; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 0.92rem; }
  th, td { white-space: nowrap; }
  td:nth-child(3), th:nth-child(3) { white-space: normal; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eeece6; vertical-align: top; }
  th { font-weight: 600; color: #5a564d; }
  td:last-child, th:last-child, .amount { text-align: right; font-variant-numeric: tabular-nums; }
  details.drill { border-top: 1px solid #eeece6; padding: 8px 0 0; margin-top: 12px; }
  details.drill summary { cursor: pointer; display: flex; justify-content: space-between; font-weight: 600; }
  details.drill table.records { margin-top: 8px; font-size: 0.86rem; background: #fbfaf7; }
  .headline { font-size: 1.05rem; margin: 0 0 10px; }
  .flag { background: #fff6e8; border: 1px solid #f0d9b0; border-radius: 8px; padding: 10px 12px; margin: 0 0 10px; }
  .flag strong { display: block; }
  .flag span { color: #5a564d; font-size: 0.9rem; }
`;

/** The whole pack as one page: what happened, what is left, and what needs a person. */
export const renderPack = (pack: ReportPack, businessName: string, locale: Locale = 'en-IN'): string => {
  const period = `${formatDate(pack.trialBalance.header.filter.from)} to ${formatDate(pack.trialBalance.header.filter.to)}`;

  const flags = pack.exceptions.body.exceptions
    .map(
      (e) =>
        `<div class="flag"><strong>${escape(e.what[locale])}</strong><span>${escape(e.why[locale])}</span></div>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="${locale === 'hi-IN' ? 'hi' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(businessName)} — ${escape(period)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1>${escape(businessName)}</h1>
  <p class="notes">${escape(period)}</p>

  <section>
    <h2>${escape(pack.exceptions.header.title[locale])}</h2>
    <p class="headline">${escape(pack.exceptions.body.sentence[locale])}</p>
    ${flags}
  </section>

  ${sectionHtml(
    pack.profitAndLoss,
    locale,
    profitAndLossTable(pack.profitAndLoss.body, locale),
    `<p class="headline">${escape(pack.profitAndLoss.body.sentence[locale])}</p>
     ${drillHtml('earned', pack.profitAndLoss.body.income.total, locale)}
     ${drillHtml('spent', pack.profitAndLoss.body.expenses.total, locale)}`,
  )}

  ${sectionHtml(
    pack.balanceSheet,
    locale,
    balanceSheetTable(pack.balanceSheet.body, locale),
    `<p class="headline">${escape(pack.balanceSheet.body.sentence[locale])}</p>`,
  )}

  ${sectionHtml(
    pack.trialBalance,
    locale,
    trialBalanceTable(pack.trialBalance.body, locale),
    `${drillHtml('owningSide', pack.trialBalance.body.totalDebits, locale)}
     ${drillHtml('owingSide', pack.trialBalance.body.totalCredits, locale)}`,
  )}

  ${sectionHtml(
    pack.sales,
    locale,
    registerTable(pack.sales.body, locale),
    `<p class="headline">${escape(pack.sales.body.sentence[locale])}</p>
     ${drillHtml('everyBill', pack.sales.body.total, locale)}`,
  )}

  ${sectionHtml(pack.purchases, locale, registerTable(pack.purchases.body, locale), `<p class="headline">${escape(pack.purchases.body.sentence[locale])}</p>`)}

  ${sectionHtml(
    pack.stock,
    locale,
    stockTable(pack.stock.body, locale),
    `<p class="headline">${escape(pack.stock.body.sentence[locale])}</p>
     ${drillHtml('goodsWorth', pack.stock.body.value, locale)}`,
  )}

  ${sectionHtml(
    pack.receivables,
    locale,
    ageingTable(pack.receivables.body, locale),
    `<p class="headline">${escape(pack.receivables.body.sentence[locale])}</p>
     ${drillHtml('stillOwed', pack.receivables.body.total, locale)}`,
  )}

  ${sectionHtml(
    pack.payables,
    locale,
    ageingTable(pack.payables.body, locale),
    `<p class="headline">${escape(pack.payables.body.sentence[locale])}</p>`,
  )}

  ${sectionHtml(
    pack.gst,
    locale,
    gstTable(pack.gst.body, locale),
    `<p class="headline">${escape(pack.gst.body.sentence[locale])}</p>
     ${drillHtml('gstCollected', pack.gst.body.totalCollected, locale)}
     ${drillHtml('gstPaid', pack.gst.body.totalAlreadyPaid, locale)}`,
  )}

  ${sectionHtml(pack.exceptions, locale, exceptionsTable(pack.exceptions.body, locale))}
</main>
</body>
</html>
`;
};

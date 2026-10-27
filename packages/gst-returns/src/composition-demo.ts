/**
 * Issue #296 — a composition business's year, start to finish.
 *
 *   npm run demo:composition
 *
 * Kaveri Provision Store (an invented shop, with an invented GST number) sells groceries and pays
 * 1% of its sales every quarter under the composition scheme. The figures below come from the real
 * levy, quarter and limit code; nothing needs a credential, a network or a database.
 */
import { formatINR, isoDate } from '@invoice/kernel';
import {
  COMPOSITION_LEGEND, NOT_FOR_COMPOSITION, buildCmp08, buildGstr4, compositionLimitFor, quarterOf, watchLimit,
  type CompositionDocument,
} from './composition.ts';

const heading = (text: string): void => console.log(`\n${text}\n${'─'.repeat(text.length)}`);
const rupees = (paise: bigint): string => formatINR({ currency: 'INR', minor: paise });
const bill = (n: number, date: string, rupeeValue: number, extra: Partial<CompositionDocument> = {}): CompositionDocument =>
  ({ id: `b${n}`, number: `BOS/26-27/${String(n).padStart(6, '0')}`, date: isoDate(date), kind: 'BILL_OF_SUPPLY', valuePaise: BigInt(rupeeValue) * 100n, taxable: true, ...extra });

heading('Every bill starts with these words');
console.log(COMPOSITION_LEGEND);

const documents: CompositionDocument[] = [
  bill(1, '2026-04-12', 4_20_000), bill(2, '2026-05-30', 6_80_000), bill(3, '2026-06-20', 3_00_000),
  bill(4, '2026-07-15', 9_50_000), bill(5, '2026-08-02', 2_00_000, { taxable: false }),
  bill(6, '2026-09-10', 5_00_000), bill(7, '2026-09-20', 50_000, { kind: 'CREDIT_NOTE' }),
  bill(8, '2026-11-05', 7_00_000), bill(9, '2027-02-14', 8_00_000),
];

heading('CMP-08: the tax for each quarter, at 1%');
for (const number of [1, 2, 3, 4] as const) {
  const first = [`2026-04-01`, `2026-07-01`, `2026-10-01`, `2027-01-01`][number - 1] as string;
  const cmp = buildCmp08({ quarter: quarterOf(isoDate(first)), documents, rateBasisPoints: 100n });
  console.log(`${cmp.quarter.label.padEnd(26)} sold ${rupees(cmp.outwardValuePaise).padStart(14)}  tax ${rupees(cmp.levy.totalPaise).padStart(11)}  (central ${rupees(cmp.levy.centralPaise)} + state ${rupees(cmp.levy.statePaise)})  due ${cmp.dueDate}`);
}

heading('GSTR-4: the year');
const year = buildGstr4({ financialYear: '2026-27', documents, rateBasisPoints: 100n, taxPaidPaise: 40_000_00n });
console.log(`Tax for the year ${rupees(year.taxPayablePaise)}, paid ${rupees(year.taxPaidPaise ?? 0n)}, due by ${year.dueDate}`);
for (const finding of year.findings) console.log(`! ${finding['en-IN']}`);

heading('Watching the limit (₹1.5 crore for goods)');
const watch = watchLimit(documents.filter((d) => d.kind === 'BILL_OF_SUPPLY').map((d) => ({ date: d.date, valuePaise: d.valuePaise })), compositionLimitFor('MANUFACTURER_OR_TRADER', '29'));
console.log(watch.message['en-IN']);

heading('What GSTR-1 and GSTR-3B say to this shop');
console.log(NOT_FOR_COMPOSITION['en-IN']);

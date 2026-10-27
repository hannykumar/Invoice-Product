/**
 * Issue #296 — the composition scheme: the levy, the quarterly statement, the yearly return, the
 * limit watch, and the refusal of GSTR-1 and GSTR-3B for a composition month.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, asId, fixedClock, isoDate } from '@invoice/kernel';
import { InMemoryAuditPort, type ActorContext } from '@invoice/ledger';
import {
  COMPOSITION_LEGEND, buildCmp08, buildGstr4, cmp08DueDate, compositionLimitFor, gstr4DueDate, levyOn,
  quarterOf, suggestedCompositionRate, watchLimit, type CompositionDocument,
} from '../src/composition.ts';
import { GstReturnService } from '../src/service.ts';
import {
  InMemoryBookTax, InMemoryInwardTax, InMemoryOutwardSupplies, InMemoryReturnPreparations,
} from '../src/adapters.ts';
import {
  SUNRISE_BOOK_TAX, SUNRISE_COMPANY, SUNRISE_DOCUMENTS, SUNRISE_GSTIN, SUNRISE_INWARD, SUNRISE_PERIOD, SUNRISE_STATE,
} from '../src/fixtures.ts';
import { GST_RETURN_PERMISSIONS } from '../src/types.ts';

const d = (value: string) => isoDate(value);
const rupees = (n: number): bigint => BigInt(n) * 100n;
const sale = (id: string, date: string, value: bigint, extra: Partial<CompositionDocument> = {}): CompositionDocument =>
  ({ id, number: `BOS/26-27/${id}`, date: d(date), kind: 'BILL_OF_SUPPLY', valuePaise: value, taxable: true, ...extra });

test('the legend is the sentence Rule 5 asks for', () => {
  assert.equal(COMPOSITION_LEGEND, 'Composition taxable person, not eligible to collect tax on supplies');
});

test('1% of ₹10,00,000 is ₹10,000, shared equally between central and State tax', () => {
  const levy = levyOn(rupees(1_000_000), 100n);
  assert.equal(levy.totalPaise, rupees(10_000));
  assert.equal(levy.centralPaise, rupees(5_000));
  assert.equal(levy.statePaise, rupees(5_000));
});

test('the two halves are always equal, rounding to the nearest paisa', () => {
  const levy = levyOn(12_345n, 100n); // 0.5% of ₹123.45 = 61.725 paise → 62
  assert.equal(levy.centralPaise, 62n);
  assert.equal(levy.statePaise, levy.centralPaise);
  assert.equal(levy.totalPaise, 124n);
});

test('a rate that cannot be split in two, or is out of range, is refused', () => {
  assert.throws(() => levyOn(1n, 101n), (e) => e instanceof DomainError && e.code === 'COMPOSITION_RATE_HALVES');
  assert.throws(() => levyOn(1n, 0n), (e) => e instanceof DomainError && e.code === 'COMPOSITION_RATE_RANGE');
  assert.throws(() => levyOn(1n, 1_002n), (e) => e instanceof DomainError && e.code === 'COMPOSITION_RATE_RANGE');
});

test('suggested rates are 1%, 5% and 6% — and are still DRAFT', () => {
  assert.equal(suggestedCompositionRate('MANUFACTURER_OR_TRADER', d('2026-10-27'))?.rateBasisPoints, 100n);
  assert.equal(suggestedCompositionRate('RESTAURANT', d('2026-10-27'))?.rateBasisPoints, 500n);
  assert.equal(suggestedCompositionRate('SERVICES_ONLY', d('2026-10-27'))?.rateBasisPoints, 600n);
  assert.equal(suggestedCompositionRate('SERVICES_ONLY', d('2019-03-31')), undefined, 'the services option began in April 2019');
  assert.ok(['MANUFACTURER_OR_TRADER', 'RESTAURANT', 'SERVICES_ONLY'].every((c) =>
    suggestedCompositionRate(c as never, d('2026-10-27'))?.reviewState === 'DRAFT'));
});

test('quarters follow the financial year and CMP-08 is due on the 18th after each', () => {
  const q1 = quarterOf(d('2026-05-17'));
  assert.deepEqual([q1.financialYear, q1.number, q1.from, q1.to], ['2026-27', 1, '2026-04-01', '2026-06-30']);
  assert.equal(cmp08DueDate(q1), '2026-07-18');
  const q3 = quarterOf(d('2026-12-31'));
  assert.equal(cmp08DueDate(q3), '2027-01-18', 'a December quarter-end rolls into the next calendar year');
  const q4 = quarterOf(d('2027-02-10'));
  assert.deepEqual([q4.financialYear, q4.number, q4.from, q4.to], ['2026-27', 4, '2027-01-01', '2027-03-31']);
  assert.equal(cmp08DueDate(q4), '2027-04-18');
});

test('GSTR-4 is due on 30 June from 2024-25 and 30 April before', () => {
  assert.equal(gstr4DueDate('2026-27'), '2027-06-30');
  assert.equal(gstr4DueDate('2023-24'), '2024-04-30');
});

test('CMP-08 nets credit notes off the quarter and leaves other quarters alone', () => {
  const docs = [
    sale('1', '2026-04-10', rupees(100_000)),
    sale('2', '2026-06-30', rupees(50_000)),
    sale('3', '2026-06-15', rupees(10_000), { kind: 'CREDIT_NOTE' }),
    sale('4', '2026-07-01', rupees(999_999)), // next quarter
  ];
  const cmp = buildCmp08({ quarter: quarterOf(d('2026-05-01')), documents: docs, rateBasisPoints: 100n });
  assert.equal(cmp.outwardValuePaise, rupees(140_000));
  assert.equal(cmp.levy.totalPaise, rupees(1_400));
  assert.deepEqual([...cmp.documents].sort(), ['1', '2', '3']);
  assert.equal(cmp.dueDate, '2026-07-18');
});

test('exempt sales show on the form but carry no composition tax', () => {
  const docs = [sale('1', '2026-04-10', rupees(100_000)), sale('2', '2026-04-11', rupees(50_000), { taxable: false })];
  const cmp = buildCmp08({ quarter: quarterOf(d('2026-04-01')), documents: docs, rateBasisPoints: 100n });
  assert.equal(cmp.outwardValuePaise, rupees(150_000));
  assert.equal(cmp.levy.turnoverPaise, rupees(100_000));
});

test('credit notes bigger than the sales owe nothing and say so — no refund is invented', () => {
  const docs = [sale('1', '2026-04-10', rupees(1_000)), sale('2', '2026-04-11', rupees(5_000), { kind: 'CREDIT_NOTE' })];
  const cmp = buildCmp08({ quarter: quarterOf(d('2026-04-01')), documents: docs, rateBasisPoints: 100n });
  assert.equal(cmp.levy.totalPaise, 0n);
  assert.ok(cmp.notes.some((note) => note['en-IN'].includes('larger than the sales')));
});

test('a quarter with no sales owes nothing', () => {
  const cmp = buildCmp08({ quarter: quarterOf(d('2026-04-01')), documents: [], rateBasisPoints: 100n });
  assert.equal(cmp.totalPayablePaise, 0n);
});

test('reverse-charge tax entered by hand is added to what is payable', () => {
  const cmp = buildCmp08({ quarter: quarterOf(d('2026-04-01')), documents: [sale('1', '2026-04-10', rupees(100_000))], rateBasisPoints: 100n, reverseChargeTaxPaise: rupees(180) });
  assert.equal(cmp.totalPayablePaise, rupees(1_000) + rupees(180));
});

test('GSTR-4 adds the four quarters and compares them with what was paid', () => {
  const docs = [sale('1', '2026-04-10', rupees(100_000)), sale('2', '2026-08-10', rupees(200_000)), sale('3', '2026-11-10', rupees(300_000)), sale('4', '2027-02-10', rupees(400_000))];
  const ok = buildGstr4({ financialYear: '2026-27', documents: docs, rateBasisPoints: 100n, taxPaidPaise: rupees(10_000) });
  assert.equal(ok.taxPayablePaise, rupees(10_000));
  assert.equal(ok.findings.length, 0);
  assert.deepEqual(ok.quarters.map((q) => q.levy.totalPaise), [rupees(1_000), rupees(2_000), rupees(3_000), rupees(4_000)]);
  const short = buildGstr4({ financialYear: '2026-27', documents: docs, rateBasisPoints: 100n, taxPaidPaise: rupees(9_000) });
  assert.equal(short.differencePaise, rupees(1_000));
  assert.equal(short.findings.length, 1);
  assert.equal(buildGstr4({ financialYear: '2026-27', documents: docs, rateBasisPoints: 100n }).differencePaise, null);
});

test('the limit watch names the day the turnover crossed, and warns from 80%', () => {
  const limit = compositionLimitFor('MANUFACTURER_OR_TRADER', '29');
  assert.equal(limit.limitPaise, rupees(15_000_000));
  const near = watchLimit([{ date: d('2026-09-01'), valuePaise: rupees(12_500_000) }], limit);
  assert.equal(near.standing, 'NEAR');
  const crossed = watchLimit([
    { date: d('2027-01-20'), valuePaise: rupees(5_000_000) },
    { date: d('2026-10-01'), valuePaise: rupees(11_000_000) },
  ], limit);
  assert.equal(crossed.standing, 'CROSSED');
  assert.equal(crossed.crossedOn, '2027-01-20', 'sorted by date: the second sale is the one that passes ₹1.5 crore');
  assert.equal(watchLimit([{ date: d('2026-09-01'), valuePaise: rupees(15_000_000) }], limit).standing, 'NEAR', 'exactly at the limit has not crossed it');
  assert.equal(watchLimit([], limit).standing, 'WITHIN');
});

test('limits: ₹1.5 crore, ₹75 lakh in a special-category State, ₹50 lakh for services only', () => {
  assert.equal(compositionLimitFor('MANUFACTURER_OR_TRADER', '27').limitPaise, rupees(15_000_000));
  assert.equal(compositionLimitFor('MANUFACTURER_OR_TRADER', '15').limitPaise, rupees(7_500_000)); // Mizoram
  assert.equal(compositionLimitFor('SERVICES_ONLY', '15').limitPaise, rupees(5_000_000));
});

// ---------------------------------------------------------------- GSTR-1 and GSTR-3B are refused

const actor: ActorContext = {
  companyId: SUNRISE_COMPANY, branchId: asId<'Branch'>('main'), userId: asId<'User'>('22222222-2222-4222-8222-222222222222'),
  permissions: Object.values(GST_RETURN_PERMISSIONS),
};

const serviceUnder = (scheme: 'REGULAR' | 'COMPOSITION' | 'BOTH') => {
  const outward = new InMemoryOutwardSupplies();
  outward.add(...SUNRISE_DOCUMENTS);
  const inward = new InMemoryInwardTax();
  inward.set(SUNRISE_COMPANY, SUNRISE_INWARD);
  const books = new InMemoryBookTax();
  books.set(SUNRISE_COMPANY, SUNRISE_BOOK_TAX);
  return new GstReturnService({
    outward, inward, books, repository: new InMemoryReturnPreparations(), audit: new InMemoryAuditPort(),
    clock: fixedClock('2026-08-11T09:30:00.000Z'), scheme: { during: async () => scheme },
  });
};
const input = { period: SUNRISE_PERIOD, gstin: SUNRISE_GSTIN, supplierStateCode: SUNRISE_STATE };

test('a composition month cannot be prepared, approved, exported or submitted as GSTR-1 or GSTR-3B', async () => {
  const service = serviceUnder('COMPOSITION');
  const refused = (e: unknown) => e instanceof DomainError && e.code === 'GST_RETURN_NOT_FOR_COMPOSITION' && /CMP-08/.test(e.message);
  await assert.rejects(service.workspace(actor, input), refused);
  await assert.rejects(service.prepare(actor, { ...input, idempotencyKey: 'k1' }), refused);
  await assert.rejects(service.approve(actor, input), refused);
  await assert.rejects(service.exportFile(actor, { ...input, returnType: 'GSTR1' }), refused);
  await assert.rejects(service.submit(actor, { ...input, returnType: 'GSTR3B' }), refused);
});

test('a month in which the scheme changed is refused with its own message', async () => {
  await assert.rejects(serviceUnder('BOTH').workspace(actor, input), (e) => e instanceof DomainError && e.code === 'GST_RETURN_MIXED_SCHEME_MONTH');
});

test('a regular taxpayer is unaffected', async () => {
  const workspace = await serviceUnder('REGULAR').workspace(actor, input);
  assert.equal(workspace.gstin, SUNRISE_GSTIN);
});

/**
 * Issue #188 — freight is reported under the codes of the goods it travelled with.
 *
 * These are the worked examples from the issue, to the paisa. The printed summary and the GSTR-1
 * HSN table both use this one function; their own tests are in invoice-templates.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { toDecimalString, zero, type Money } from '@invoice/kernel';
import { apportionChargesToHsn, foldChargesIntoGoods, type ChargeShareableLine, type FoldableLine } from '../src/charge-shares.ts';
import { inr } from './fixtures.ts';

const nil = (): Money => zero('INR');
const line = (over: Partial<ChargeShareableLine> & Pick<ChargeShareableLine, 'taxableValue'>): ChargeShareableLine => ({
  kind: 'GOODS', hsnOrSac: null, ratePercentTimes100: 1800n, reverseCharge: false,
  cgst: nil(), sgst: nil(), utgst: nil(), igst: nil(), cess: nil(), ...over,
});

/** Adds up the parts code by code, the way a summary does. */
const byCode = (lines: readonly ChargeShareableLine[]) => {
  const out = new Map<string, { taxable: string; cgst: string; sgst: string }>();
  const sums = new Map<string, { taxable: bigint; cgst: bigint; sgst: bigint }>();
  for (const p of apportionChargesToHsn(lines)) {
    const key = p.hsnOrSac ?? '—';
    const s = sums.get(key) ?? { taxable: 0n, cgst: 0n, sgst: 0n };
    s.taxable += p.taxableValue.minor; s.cgst += p.cgst.minor; s.sgst += p.sgst.minor;
    sums.set(key, s);
  }
  for (const [k, s] of sums) {
    const d = (m: bigint) => toDecimalString({ currency: 'INR', minor: m });
    out.set(k, { taxable: d(s.taxable), cgst: d(s.cgst), sgst: d(s.sgst) });
  }
  return Object.fromEntries(out);
};

test('two codes at one rate share the freight 60 : 40, tax split from the charge line, not worked out again', () => {
  const lines = [
    line({ hsnOrSac: '3923', taxableValue: inr(6000), cgst: inr(540), sgst: inr(540) }),
    line({ hsnOrSac: '3926', taxableValue: inr(4000), cgst: inr(360), sgst: inr(360) }),
    line({ kind: 'CHARGE', taxableValue: inr(500), cgst: inr(45), sgst: inr(45) }),
  ];
  assert.deepEqual(byCode(lines), {
    // 6,000 + 60% of 500 = 6,300. 540 + 60% of 45 = 567.
    '3923': { taxable: '6300.00', cgst: '567.00', sgst: '567.00' },
    // 4,000 + 40% of 500 = 4,200. 360 + 40% of 45 = 378.
    '3926': { taxable: '4200.00', cgst: '378.00', sgst: '378.00' },
  });
});

test('shares add back exactly: ₹100 across three equal codes is 33.34, 33.33, 33.33', () => {
  const lines = [
    line({ hsnOrSac: 'A001', taxableValue: inr(1) }),
    line({ hsnOrSac: 'B002', taxableValue: inr(1) }),
    line({ hsnOrSac: 'C003', taxableValue: inr(1) }),
    line({ kind: 'CHARGE', taxableValue: inr(100), cgst: inr(9), sgst: inr(9), igst: inr(0, 1) }),
  ];
  const shares = apportionChargesToHsn(lines).filter((p) => p.isChargeShare);
  assert.deepEqual(shares.map((p) => toDecimalString(p.taxableValue)), ['33.34', '33.33', '33.33']);
  for (const head of ['taxableValue', 'cgst', 'sgst', 'utgst', 'igst', 'cess'] as const) {
    const total = shares.reduce((acc, p) => acc + p[head].minor, 0n);
    assert.equal(total, (lines[3] as ChargeShareableLine)[head].minor, `${head} shares must add back to the charge line`);
  }
});

test('a charge is shared only within its own rate and reverse-charge bucket', () => {
  const lines = [
    line({ hsnOrSac: '3923', taxableValue: inr(1000), ratePercentTimes100: 1800n }),
    line({ hsnOrSac: '2009', taxableValue: inr(9000), ratePercentTimes100: 500n }),
    line({ hsnOrSac: '9999', taxableValue: inr(9000), ratePercentTimes100: 1800n, reverseCharge: true }),
    line({ kind: 'CHARGE', taxableValue: inr(100), ratePercentTimes100: 1800n }),
  ];
  const shares = apportionChargesToHsn(lines).filter((p) => p.isChargeShare);
  assert.deepEqual(shares.map((p) => [p.hsnOrSac, toDecimalString(p.taxableValue)]), [['3923', '100.00']]);
});

test('a charge on a bill with no goods keeps its own row, as before', () => {
  const parts = apportionChargesToHsn([line({ kind: 'CHARGE', taxableValue: inr(500), ratePercentTimes100: null })]);
  assert.equal(parts.length, 1);
  assert.equal(parts[0]?.hsnOrSac, null);
  assert.equal(parts[0]?.isChargeShare, false);
});

// ---------------------------------------------------------------- issue #231: the government items

const foldable = (over: Partial<FoldableLine> & Pick<FoldableLine, 'taxableValue'>): FoldableLine => {
  const base = line(over);
  const tax = base.cgst.minor + base.sgst.minor + base.utgst.minor + base.igst.minor + base.cess.minor;
  return { ...base, lineTotal: { currency: 'INR', minor: base.taxableValue.minor + tax }, ...over };
};
const rupees = (m: Money): string => toDecimalString(m);

test('#231 the worked bill: 450 KGS TMT at ₹90 with ₹2,000 freight is one item of ₹42,500, IGST ₹7,650', () => {
  const items = foldChargesIntoGoods([
    foldable({ hsnOrSac: '72142090', taxableValue: inr(40500), igst: inr(7290) }),
    foldable({ kind: 'CHARGE', taxableValue: inr(2000), igst: inr(360) }),
  ]);
  assert.equal(items.length, 1, 'freight is not an item of its own');
  const [item] = items;
  assert.equal(item?.line.hsnOrSac, '72142090');
  assert.equal(rupees(item!.taxableValue), '42500.00');
  assert.equal(rupees(item!.igst), '7650.00');
  assert.equal(rupees(item!.chargeValue), '2000.00');
  assert.equal(rupees(item!.lineTotal), '50150.00', 'the item adds up to the bill');
});

test('#231 two codes at 18% (₹30,000 and ₹10,000) share ₹2,000 freight as ₹1,500 and ₹500', () => {
  const items = foldChargesIntoGoods([
    foldable({ hsnOrSac: '72142090', taxableValue: inr(30000), cgst: inr(2700), sgst: inr(2700) }),
    foldable({ hsnOrSac: '73170019', taxableValue: inr(10000), cgst: inr(900), sgst: inr(900) }),
    foldable({ kind: 'CHARGE', taxableValue: inr(2000), cgst: inr(180), sgst: inr(180) }),
  ]);
  assert.deepEqual(items.map((i) => rupees(i.chargeValue)), ['1500.00', '500.00']);
  assert.deepEqual(items.map((i) => rupees(i.taxableValue)), ['31500.00', '10500.00']);
  assert.deepEqual(items.map((i) => rupees(i.cgst)), ['2835.00', '945.00']);
  assert.deepEqual(items.map((i) => rupees(i.lineTotal)), ['37170.00', '12390.00']);
});

test('#231 each code gets the share the printed summary gives it, and the paise left over go to the largest line', () => {
  const lines = [
    foldable({ hsnOrSac: '3923', taxableValue: inr(200), igst: inr(36) }),
    foldable({ hsnOrSac: '3923', taxableValue: inr(100), igst: inr(18) }),
    foldable({ hsnOrSac: '3926', taxableValue: inr(100), igst: inr(18) }),
    foldable({ kind: 'CHARGE', taxableValue: { currency: 'INR', minor: 1000n }, igst: { currency: 'INR', minor: 180n } }),
  ];
  const items = foldChargesIntoGoods(lines);
  // ₹10 over 300 : 100 by code is ₹7.50 and ₹2.50; ₹7.50 over 200 : 100 is ₹5.00 and ₹2.50.
  assert.deepEqual(items.map((i) => rupees(i.chargeValue)), ['5.00', '2.50', '2.50']);
  // ₹1.80 of tax: ₹1.35 to 3923 and ₹0.45 to 3926; ₹1.35 over 200 : 100 is ₹0.90 and ₹0.45.
  assert.deepEqual(items.map((i) => rupees(i.igst)), ['36.90', '18.45', '18.45']);
  const summary = byCode(lines);
  const folded3923 = (items[0]!.taxableValue.minor + items[1]!.taxableValue.minor);
  assert.equal(rupees({ currency: 'INR', minor: folded3923 }), summary['3923']?.taxable);

  const odd = foldChargesIntoGoods([
    foldable({ hsnOrSac: '3923', taxableValue: inr(100) }),
    foldable({ hsnOrSac: '3923', taxableValue: inr(200) }),
    foldable({ kind: 'CHARGE', taxableValue: { currency: 'INR', minor: 100n } }),
  ]);
  // ₹1.00 over 100 : 200 is 33.33 and 66.66, and the one paisa left goes to the larger line.
  assert.deepEqual(odd.map((i) => rupees(i.chargeValue)), ['0.33', '0.67']);
});

test('#231 a bill with only a charge keeps it as it is, so a government document refuses it rather than dropping it', () => {
  const items = foldChargesIntoGoods([foldable({ kind: 'CHARGE', ratePercentTimes100: null, taxableValue: inr(500) })]);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.line.kind, 'CHARGE');
  assert.equal(rupees(items[0]!.taxableValue), '500.00');
});

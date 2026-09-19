/**
 * Issue #188 — freight is reported under the codes of the goods it travelled with.
 *
 * These are the worked examples from the issue, to the paisa. The printed summary and the GSTR-1
 * HSN table both use this one function; their own tests are in invoice-templates.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { toDecimalString, zero, type Money } from '@invoice/kernel';
import { apportionChargesToHsn, type ChargeShareableLine } from '../src/charge-shares.ts';
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

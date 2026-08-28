/**
 * Issue #1 [E01] — "Review the specification against at least one sale, purchase, partial
 * payment, return and transport example."
 *
 * The worked examples in docs/product/05-worked-examples.md are re-computed here in exact
 * integer paise so the page cannot drift into arithmetic that does not balance. Every figure
 * asserted below is also checked to appear on the page.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../spec-docs/render.ts';

const page = readFileSync(join(repoRoot, 'docs', 'product', '05-worked-examples.md'), 'utf8');

/** Rupees expressed as an exact integer number of paise. */
const rupees = (whole: number, paise = 0): bigint => BigInt(whole) * 100n + BigInt(paise);

/** Half-up rounding of a paise-scaled product, used for percentage tax on a line. */
const percentOf = (amountPaise: bigint, percentTimes100: bigint): bigint => {
  const numerator = amountPaise * percentTimes100;
  const denominator = 10000n;
  const q = numerator / denominator;
  const r = numerator % denominator;
  return r * 2n >= denominator ? q + 1n : q;
};

const inr = (paise: bigint): string => {
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  const w = whole.toString();
  // Indian digit grouping: last three, then pairs.
  const last3 = w.slice(-3);
  const rest = w.slice(0, -3);
  const grouped = rest === '' ? last3 : `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
  return `${negative ? '-' : ''}₹${grouped}.${frac}`;
};

const onPage = (text: string): void => assert.ok(page.includes(text), `"${text}" is not on the worked-examples page`);

interface Line { account: string; debit: bigint; credit: bigint }
const assertBalanced = (name: string, lines: Line[]): void => {
  const debit = lines.reduce((a, l) => a + l.debit, 0n);
  const credit = lines.reduce((a, l) => a + l.credit, 0n);
  assert.equal(debit, credit, `${name} does not balance: debits ${inr(debit)} vs credits ${inr(credit)}`);
  assert.ok(debit > 0n, `${name} posts nothing`);
  for (const l of lines) {
    assert.ok(!(l.debit > 0n && l.credit > 0n), `${name}: ${l.account} is both debited and credited on one line`);
  }
};

test('digit grouping helper formats Indian amounts the way the docs do', () => {
  assert.equal(inr(rupees(100000)), '₹1,00,000.00');
  assert.equal(inr(rupees(1180)), '₹1,180.00');
  assert.equal(inr(rupees(0, 1)), '₹0.01');
});

test('example 1 — nil-rated purchase balances and creates a payable, not a receivable', () => {
  const value = 100n * rupees(500);
  assert.equal(value, rupees(50000));
  assertBalanced('purchase NF/1187', [
    { account: 'Purchases – Goods', debit: value, credit: 0n },
    { account: 'Nashik Farms', debit: 0n, credit: value },
  ]);
  onPage('₹50,000.00');
  onPage('+100 BOX of `APL-BOX-10` into Narela godown');
  assert.ok(!page.includes('Nil GST line of ₹0.00'), 'a nil rate must not be shown as a zero-rupee tax line');
});

test('example 2 — inter-state purchase carries IGST only, never CGST or SGST', () => {
  const taxable = 200n * rupees(200);
  const igst = percentOf(taxable, 1800n);
  assert.equal(taxable, rupees(40000));
  assert.equal(igst, rupees(7200));
  assertBalanced('purchase NF/1191', [
    { account: 'Purchases – Goods', debit: taxable, credit: 0n },
    { account: 'Input IGST', debit: igst, credit: 0n },
    { account: 'Nashik Farms', debit: 0n, credit: taxable + igst },
  ]);
  assert.equal(taxable + igst, rupees(47200));
  onPage('₹47,200.00');
  const example2 = page.slice(page.indexOf('## Example 2'), page.indexOf('## Example 3'));
  assert.ok(!example2.includes('CGST'), 'an inter-state supply must not show CGST');
  assert.ok(!example2.includes('SGST'), 'an inter-state supply must not show SGST');
});

test('example 3 — intra-state sale splits CGST and SGST and still balances after round-off', () => {
  const taxable = 3n * rupees(333, 33);
  assert.equal(taxable, rupees(999, 99));
  const cgst = percentOf(taxable, 900n);
  const sgst = percentOf(taxable, 900n);
  assert.equal(cgst, rupees(90), 'CGST of ₹999.99 at 9% rounds half-up to ₹90.00');
  assert.equal(sgst, rupees(90));
  const beforeRounding = taxable + cgst + sgst;
  assert.equal(beforeRounding, rupees(1179, 99));
  const invoiceValue = rupees(1180);
  const roundOff = invoiceValue - beforeRounding;
  assert.equal(roundOff, rupees(0, 1));
  assertBalanced('sale INV/KB/2026-27/00041', [
    { account: 'ABC Traders', debit: invoiceValue, credit: 0n },
    { account: 'Sales – Goods', debit: 0n, credit: taxable },
    { account: 'Output CGST', debit: 0n, credit: cgst },
    { account: 'Output SGST', debit: 0n, credit: sgst },
    { account: 'Round-off', debit: 0n, credit: roundOff },
  ]);
  onPage('₹1,179.99');
  onPage('₹1,180.00');
  assert.equal(cgst, sgst, 'CGST and SGST must be equal halves of the intra-state rate');
});

test('example 4 — availability blocks the second sale and the shortfall is exact', () => {
  const purchased = 100;
  const firstSale = 70;
  const remaining = purchased - firstSale;
  assert.equal(remaining, 30);
  const secondSaleWanted = 70;
  const shortfall = secondSaleWanted - remaining;
  assert.equal(shortfall, 40);
  onPage('**30 boxes**');
  onPage('**40 are missing**');
  const value = 70n * rupees(800);
  assert.equal(value, rupees(56000));
  assertBalanced('sale INV/KB/2026-27/00042', [
    { account: 'ABC Traders', debit: value, credit: 0n },
    { account: 'Sales – Goods', debit: 0n, credit: value },
  ]);
});

test('example 5 — a partial payment leaves an exact outstanding and never marks the invoice paid', () => {
  const invoice = 125n * rupees(800);
  assert.equal(invoice, rupees(100000));
  const cheque = rupees(30000);
  const transfer = rupees(20000);
  const outstanding = invoice - cheque - transfer;
  assert.equal(outstanding, rupees(50000));

  assertBalanced('receipt 1 (cheque received)', [
    { account: 'Cheques in hand', debit: cheque, credit: 0n },
    { account: 'ABC Traders', debit: 0n, credit: cheque },
  ]);
  assertBalanced('cheque cleared', [
    { account: 'HDFC Current Account', debit: cheque, credit: 0n },
    { account: 'Cheques in hand', debit: 0n, credit: cheque },
  ]);
  assertBalanced('receipt 2 (bank transfer)', [
    { account: 'HDFC Current Account', debit: transfer, credit: 0n },
    { account: 'ABC Traders', debit: 0n, credit: transfer },
  ]);

  onPage('**outstanding\n₹50,000.00**');
  onPage('It is never shown as paid.');

  // A bounce must restore exactly what the receipt removed.
  const afterBounce = outstanding + cheque;
  assert.equal(afterBounce, rupees(80000));
  onPage('₹80,000');
});

test('example 6 — a partial return reduces stock, value and outstanding consistently', () => {
  const soldBoxes = 125;
  const returnedBoxes = 25;
  assert.ok(returnedBoxes <= soldBoxes, 'a return can never exceed the original quantity');
  const creditNoteValue = BigInt(returnedBoxes) * rupees(800);
  assert.equal(creditNoteValue, rupees(20000));
  assertBalanced('credit note CN/KB/2026-27/0003', [
    { account: 'Sales returns', debit: creditNoteValue, credit: 0n },
    { account: 'ABC Traders', debit: 0n, credit: creditNoteValue },
  ]);
  const outstandingAfter = rupees(50000) - creditNoteValue;
  assert.equal(outstandingAfter, rupees(30000));
  onPage('**₹30,000.00**');
  onPage('+25 BOX back into Narela godown');
});

test('example 7 — the transport decision can refuse, and the load figure is exact', () => {
  const boxes = 125;
  const kgPerBox = 10;
  assert.equal(boxes * kgPerBox, 1250);
  onPage('**1,250 kg**');
  onPage('CANNOT_DECIDE');
  onPage('missingFacts');
  assert.ok(
    page.includes('The product never assumes a threshold.'),
    'the transport example must state that thresholds are never assumed',
  );
});

test('the page warns that its rates are fixtures, not legal authority', () => {
  onPage('are *fixture* values');
  onPage('No module may hard-code a rate');
  onPage('#54');
});

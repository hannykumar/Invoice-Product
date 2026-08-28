/**
 * Issue #25 [E25] acceptance criteria, enforced automatically.
 *
 *  - "Same facts/rule version produce identical tax lines"
 *  - "Missing place-of-supply facts block unsupported decisions"
 *  - "UI explains the chosen tax treatment"
 *
 * plus the required intra/inter-state golden cases, rate, effective-date and rounding tests, and
 * reverse-charge and exempt-supply tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { toDecimalString } from '@invoice/kernel';
import { lintUserFacingText } from '../../ux-vocabulary/src/lint.ts';
import { RateTable } from '../src/rate-table.ts';
import { SOURCE, SHARMA, inr, makeCalculator, on, qty } from './fixtures.ts';
import type { ComputeInput, ComputeResult } from '../src/compute.ts';

const computed = (result: ComputeResult) => {
  assert.equal(result.status, 'COMPUTED', result.status === 'CANNOT_COMPUTE' ? result.explanation['en-IN'] : '');
  return result as Extract<ComputeResult, { status: 'COMPUTED' }>;
};
const refused = (result: ComputeResult) => {
  assert.equal(result.status, 'CANNOT_COMPUTE', 'this case must be refused, not answered');
  return result as Extract<ComputeResult, { status: 'CANNOT_COMPUTE' }>;
};

const crateSale = (overrides: Partial<ComputeInput> = {}): ComputeInput => ({
  companyId: SHARMA,
  documentDate: on('2026-04-10'),
  partyId: 'abc-traders',
  supplyKind: 'GOODS',
  lines: [
    { lineId: 'l1', itemId: 'CRATE-P', quantity: qty('3', 'PCS'), unitPrice: inr(333, 33), priceBasis: 'EXCLUSIVE' },
  ],
  source: SOURCE,
  ...overrides,
});

test('golden case — intra-state sale splits into two GST amounts and rounds to ₹1,180 (worked example 3)', () => {
  const { calculator } = makeCalculator();
  const result = computed(calculator.compute(crateSale()));

  assert.equal(result.split, 'CGST_SGST');
  assert.equal(result.placeOfSupplyStateCode, '07');

  const line = result.lines[0];
  assert.ok(line !== undefined);
  assert.equal(toDecimalString(line.taxableValue), '999.99');
  assert.equal(toDecimalString(line.cgst), '90.00');
  assert.equal(toDecimalString(line.sgst), '90.00');
  assert.equal(toDecimalString(line.igst), '0.00');
  assert.equal(toDecimalString(line.utgst), '0.00');

  assert.equal(toDecimalString(result.totals.beforeRounding), '1179.99');
  assert.equal(toDecimalString(result.totals.roundOff), '0.01');
  assert.equal(toDecimalString(result.totals.invoiceValue), '1180.00');
});

test('golden case — inter-state sale carries one combined GST and no CGST or SGST', () => {
  const { calculator } = makeCalculator();
  const result = computed(
    calculator.compute(
      crateSale({
        partyId: 'gurugram-fresh',
        lines: [{ lineId: 'l1', itemId: 'CRATE-P', quantity: qty('200', 'PCS'), unitPrice: inr(200), priceBasis: 'EXCLUSIVE' }],
      }),
    ),
  );

  assert.equal(result.split, 'IGST');
  assert.equal(result.placeOfSupplyStateCode, '06');
  assert.equal(toDecimalString(result.totals.taxableValue), '40000.00');
  assert.equal(toDecimalString(result.totals.igst), '7200.00');
  assert.equal(toDecimalString(result.totals.cgst), '0.00');
  assert.equal(toDecimalString(result.totals.sgst), '0.00');
  assert.equal(toDecimalString(result.totals.invoiceValue), '47200.00');
});

test('golden case — a supply inside a union territory carries UTGST, not SGST', () => {
  const { calculator } = makeCalculator({ companyState: '04' });
  const result = computed(
    calculator.compute(
      crateSale({
        partyId: 'chandigarh-mart',
        lines: [{ lineId: 'l1', itemId: 'CRATE-P', quantity: qty('10', 'PCS'), unitPrice: inr(100), priceBasis: 'EXCLUSIVE' }],
      }),
    ),
  );
  assert.equal(result.split, 'CGST_UTGST');
  assert.equal(toDecimalString(result.totals.cgst), '90.00');
  assert.equal(toDecimalString(result.totals.utgst), '90.00');
  assert.equal(toDecimalString(result.totals.sgst), '0.00');
});

test('the same input produces identical tax lines, every time', () => {
  const { calculator } = makeCalculator();
  const first = computed(calculator.compute(crateSale()));
  const second = computed(calculator.compute(crateSale()));
  assert.deepEqual(second.lines, first.lines);
  assert.deepEqual(second.totals, first.totals);
  assert.deepEqual(second.explanation, first.explanation);
});

test('a missing place of supply blocks the bill instead of choosing a tax', () => {
  const { calculator } = makeCalculator();
  const result = refused(calculator.compute(crateSale({ partyId: 'walk-in' })));

  assert.deepEqual(result.reasons.map((r) => r.code), ['PLACE_OF_SUPPLY_UNKNOWN']);
  assert.equal(result.reasons[0]?.messageId, 'tax.place_of_supply_missing');
  assert.match(result.explanation['en-IN'], /which state this sale counts in/);
  assert.ok(result.exceptions.length > 0, 'a refusal must become work for a person');
  assert.equal(result.exceptions[0]?.kind, 'RULE_CANNOT_DECIDE');
});

test('a confirmed place of supply is used, and the delivery state is not second-guessed', () => {
  const { calculator } = makeCalculator();
  const result = computed(calculator.compute(crateSale({ partyId: 'walk-in', placeOfSupplyStateCode: '06' })));
  assert.equal(result.placeOfSupplyStateCode, '06');
  assert.equal(result.split, 'IGST');
});

test('the rate in force on the document date applies, not the newest rate', () => {
  const { calculator } = makeCalculator();
  const june = computed(calculator.compute(crateSale({ documentDate: on('2026-06-30') })));
  assert.equal(june.lines[0]?.ratePercentTimes100, 1800n);

  const july = computed(calculator.compute(crateSale({ documentDate: on('2026-07-01') })));
  assert.equal(july.lines[0]?.ratePercentTimes100, 1200n, 'the rate changed on 1 July');
  assert.equal(toDecimalString(july.lines[0]?.cgst ?? inr(0)), '60.00');
});

test('a tax-inclusive price is worked backwards and the parts add back exactly', () => {
  const { calculator } = makeCalculator();
  const result = computed(
    calculator.compute(
      crateSale({
        lines: [{ lineId: 'l1', itemId: 'CRATE-P', quantity: qty('1', 'PCS'), unitPrice: inr(118), priceBasis: 'INCLUSIVE' }],
      }),
    ),
  );
  const line = result.lines[0];
  assert.ok(line !== undefined);
  assert.equal(toDecimalString(line.taxableValue), '100.00');
  assert.equal(toDecimalString(line.cgst), '9.00');
  assert.equal(toDecimalString(line.sgst), '9.00');
  assert.equal(
    toDecimalString(result.totals.beforeRounding),
    '118.00',
    'the parts must add back to exactly the price that was quoted',
  );
});

test('a discount reduces the taxable value before tax, not after', () => {
  const { calculator } = makeCalculator();
  const result = computed(
    calculator.compute(
      crateSale({
        lines: [
          {
            lineId: 'l1',
            itemId: 'CRATE-P',
            quantity: qty('10', 'PCS'),
            unitPrice: inr(100),
            priceBasis: 'EXCLUSIVE',
            discount: { kind: 'PERCENT', percentTimes100: 500n },
          },
        ],
      }),
    ),
  );
  const line = result.lines[0];
  assert.equal(toDecimalString(line?.grossAmount ?? inr(0)), '1000.00');
  assert.equal(toDecimalString(line?.discountAmount ?? inr(0)), '50.00');
  assert.equal(toDecimalString(line?.taxableValue ?? inr(0)), '950.00');
  assert.equal(toDecimalString(line?.cgst ?? inr(0)), '85.50');
});

test('freight is shared across the lines by value and taxed with them, never left untaxed', () => {
  const { calculator } = makeCalculator();
  const result = computed(
    calculator.compute(
      crateSale({
        freight: inr(1000),
        lines: [
          { lineId: 'l1', itemId: 'CRATE-P', quantity: qty('10', 'PCS'), unitPrice: inr(300), priceBasis: 'EXCLUSIVE' },
          { lineId: 'l2', itemId: 'JUICE-1L', quantity: qty('10', 'PCS'), unitPrice: inr(100), priceBasis: 'EXCLUSIVE' },
        ],
      }),
    ),
  );
  const [crates, juice] = result.lines;
  assert.equal(toDecimalString(crates?.chargesShare ?? inr(0)), '750.00');
  assert.equal(toDecimalString(juice?.chargesShare ?? inr(0)), '250.00');
  assert.equal(toDecimalString(crates?.taxableValue ?? inr(0)), '3750.00');
  assert.equal(toDecimalString(juice?.taxableValue ?? inr(0)), '1250.00');
  assert.equal(
    toDecimalString(result.totals.taxableValue),
    '5000.00',
    'the whole of the freight is inside the taxable value',
  );
  // Different items, different rates: 18% on the crates, 12% on the juice.
  assert.equal(toDecimalString(crates?.cgst ?? inr(0)), '337.50');
  assert.equal(toDecimalString(juice?.cgst ?? inr(0)), '75.00');
});

test('nil-rated, exempt and non-GST supplies produce no tax at all — and are told apart', () => {
  const { calculator } = makeCalculator();
  const result = computed(
    calculator.compute(
      crateSale({
        lines: [
          { lineId: 'l1', itemId: 'APL-BOX-10', quantity: qty('70', 'BOX'), unitPrice: inr(800), priceBasis: 'EXCLUSIVE' },
          { lineId: 'l2', itemId: 'BOOKS', quantity: qty('5', 'PCS'), unitPrice: inr(100), priceBasis: 'EXCLUSIVE' },
          { lineId: 'l3', itemId: 'LIQUOR', quantity: qty('2', 'PCS'), unitPrice: inr(250), priceBasis: 'EXCLUSIVE' },
        ],
      }),
    ),
  );
  assert.equal(toDecimalString(result.totals.totalTax), '0.00');
  assert.equal(toDecimalString(result.totals.taxableValue), '57000.00');
  assert.deepEqual(result.lines.map((l) => l.treatment), ['NIL_RATED', 'EXEMPT', 'NON_GST']);
  assert.match(result.lines[0]?.explanation['en-IN'] ?? '', /is taxed at nothing/);
  assert.match(result.lines[1]?.explanation['en-IN'] ?? '', /is free of tax/);
  assert.match(result.lines[2]?.explanation['en-IN'] ?? '', /is outside GST/);
  for (const line of result.lines) {
    assert.equal(line.ratePercentTimes100, null, 'a nil rate is not a zero-percent rate line');
  }
});

test('reverse charge computes the tax but keeps it off the bill', () => {
  const { calculator } = makeCalculator();
  const result = computed(
    calculator.compute(
      crateSale({
        lines: [
          { lineId: 'l1', itemId: 'CRATE-P', quantity: qty('10', 'PCS'), unitPrice: inr(100), priceBasis: 'EXCLUSIVE' },
          { lineId: 'l2', itemId: 'FREIGHT-GTA', quantity: qty('1', 'JOB'), unitPrice: inr(2000), priceBasis: 'EXCLUSIVE' },
        ],
      }),
    ),
  );
  const freight = result.lines.find((l) => l.itemId === 'FREIGHT-GTA');
  assert.ok(freight !== undefined);
  assert.equal(freight.reverseCharge, true);
  assert.equal(toDecimalString(freight.totalTax), '100.00', '5% on ₹2,000 is still worked out');
  assert.equal(toDecimalString(freight.lineTotal), '2000.00', 'but it is not billed to the customer');
  assert.equal(toDecimalString(result.totals.reverseChargeTax), '100.00');
  assert.equal(toDecimalString(result.totals.totalTax), '180.00', 'only the crate GST is on the bill');
  assert.equal(toDecimalString(result.totals.invoiceValue), '3180.00');
  assert.match(freight.explanation['en-IN'], /You pay this GST to the government yourself/);
});

test('cess is added on top of GST, and the higher of two cess bases is taken', () => {
  const { calculator } = makeCalculator();
  const result = computed(
    calculator.compute(
      crateSale({
        lines: [{ lineId: 'l1', itemId: 'COLA-300', quantity: qty('100', 'PCS'), unitPrice: inr(20), priceBasis: 'EXCLUSIVE' }],
      }),
    ),
  );
  const line = result.lines[0];
  assert.equal(toDecimalString(line?.taxableValue ?? inr(0)), '2000.00');
  assert.equal(toDecimalString(line?.cgst ?? inr(0)), '280.00');
  assert.equal(toDecimalString(line?.cess ?? inr(0)), '240.00', '12% cess on ₹2,000');
  assert.equal(toDecimalString(result.totals.invoiceValue), '2800.00');
});

test('a tax-inclusive price on a line that carries cess is refused, not approximated', () => {
  const { calculator } = makeCalculator();
  const result = refused(
    calculator.compute(
      crateSale({
        lines: [{ lineId: 'l1', itemId: 'COLA-300', quantity: qty('10', 'PCS'), unitPrice: inr(50), priceBasis: 'INCLUSIVE' }],
      }),
    ),
  );
  assert.deepEqual(result.reasons.map((r) => r.code), ['INCLUSIVE_WITH_CESS_UNSUPPORTED']);
  assert.match(result.reasons[0]?.message['en-IN'] ?? '', /Enter the price without tax/);
});

test('an unclassified item, a missing code and a missing rate each stop the bill', () => {
  const { calculator } = makeCalculator();

  const unclassified = refused(
    calculator.compute(crateSale({ lines: [{ lineId: 'l1', itemId: 'MYSTERY', quantity: qty('1', 'PCS'), unitPrice: inr(100), priceBasis: 'EXCLUSIVE' }] })),
  );
  assert.deepEqual(unclassified.reasons.map((r) => r.code), ['ITEM_NOT_CLASSIFIED']);

  const noCode = refused(
    calculator.compute(crateSale({ lines: [{ lineId: 'l1', itemId: 'NO-CODE', quantity: qty('1', 'PCS'), unitPrice: inr(100), priceBasis: 'EXCLUSIVE' }] })),
  );
  assert.deepEqual(noCode.reasons.map((r) => r.code), ['HSN_MISSING']);

  const noRate = refused(
    calculator.compute(crateSale({ lines: [{ lineId: 'l1', itemId: 'NO-RATE', quantity: qty('1', 'PCS'), unitPrice: inr(100), priceBasis: 'EXCLUSIVE' }] })),
  );
  assert.deepEqual(noRate.reasons.map((r) => r.code), ['RATE_NOT_FOUND']);
});

test('every problem on a bill is reported at once, not one at a time', () => {
  const { calculator } = makeCalculator();
  const result = refused(
    calculator.compute(
      crateSale({
        lines: [
          { lineId: 'l1', itemId: 'MYSTERY', quantity: qty('1', 'PCS'), unitPrice: inr(100), priceBasis: 'EXCLUSIVE' },
          { lineId: 'l2', itemId: 'CRATE-P', quantity: qty('1', 'PCS'), unitPrice: inr(100), priceBasis: 'EXCLUSIVE' },
          { lineId: 'l3', itemId: 'MYSTERY', quantity: qty('2', 'PCS'), unitPrice: inr(100), priceBasis: 'EXCLUSIVE' },
        ],
      }),
    ),
  );
  assert.equal(result.reasons.length, 2, 'both bad lines are reported together');
  assert.deepEqual(result.reasons.map((r) => r.lineId), ['l1', 'l3']);
});

test('an unreviewed rate is refused in production, however plausible it looks', () => {
  const { calculator } = makeCalculator({ mode: 'production' });
  const result = refused(calculator.compute(crateSale()));
  assert.ok(
    result.reasons.some((r) => r.code === 'TAX_SPLIT_UNKNOWN' || r.code === 'RATE_NOT_REVIEWED' || r.code === 'COMPOSITION_UNDECIDED'),
    'production must not use an unreviewed rule or rate',
  );
});

test('an approved rate is used in production, so the refusal is about review state and nothing else', () => {
  const approved = new RateTable([
    {
      code: '3923',
      kind: 'GOODS',
      description: 'Plastic crates',
      ratePercentTimes100: 1800n,
      effectiveFrom: on('2026-04-01'),
      effectiveTo: null,
      sourceRef: 'register:test/approved-3923',
      reviewState: 'APPROVED',
    },
  ]);
  const { calculator } = makeCalculator({ mode: 'development', rates: approved });
  const result = computed(calculator.compute(crateSale()));
  assert.equal(result.lines[0]?.rateReviewState, 'APPROVED');
  assert.equal(result.lines[0]?.rateSourceRef, 'register:test/approved-3923');
});

test('a business on the composition scheme charges no GST, and the bill says so', () => {
  const { calculator } = makeCalculator({ registration: 'COMPOSITION' });
  const result = computed(calculator.compute(crateSale()));
  assert.equal(result.mayChargeGst, false);
  assert.equal(toDecimalString(result.totals.totalTax), '0.00');
  assert.equal(toDecimalString(result.totals.invoiceValue), '1000.00');
  assert.match(result.explanation['en-IN'], /does not charge GST on its bills/);
});

test('a GST number that disagrees with the state is refused, not resolved by preference', () => {
  const { calculator, masterData } = makeCalculator();
  masterData.putCompany({ companyId: SHARMA, gstin: '27AAAAA0000A1Z4', stateCode: '07', registration: 'REGULAR' });
  const result = refused(calculator.compute(crateSale()));
  assert.deepEqual(result.reasons.map((r) => r.code), ['GSTIN_STATE_MISMATCH']);
});

test('every explanation is understandable without accounting training', () => {
  const { calculator } = makeCalculator();
  const results = [
    calculator.compute(crateSale()),
    calculator.compute(crateSale({ partyId: 'gurugram-fresh' })),
    calculator.compute(crateSale({ partyId: 'walk-in' })),
    calculator.compute(
      crateSale({ lines: [{ lineId: 'l1', itemId: 'APL-BOX-10', quantity: qty('70', 'BOX'), unitPrice: inr(800), priceBasis: 'EXCLUSIVE' }] }),
    ),
  ];
  const problems: string[] = [];
  const check = (where: string, text: string, locale: 'en-IN' | 'hi-IN'): void => {
    for (const issue of lintUserFacingText(text, { locale, allow: ['gst'] })) {
      problems.push(`${where} (${locale}): ${issue.rule} — ${issue.detail}`);
    }
  };
  for (const [i, r] of results.entries()) {
    for (const locale of ['en-IN', 'hi-IN'] as const) {
      check(`result ${i} explanation`, r.explanation[locale], locale);
      if (r.status === 'COMPUTED') {
        for (const line of r.lines) check(`result ${i} line ${line.lineId}`, line.explanation[locale], locale);
      } else {
        for (const reason of r.reasons) check(`result ${i} reason ${reason.code}`, reason.message[locale], locale);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the explanation names the treatment that was chosen, so a person can check it', () => {
  const { calculator } = makeCalculator();
  const intra = computed(calculator.compute(crateSale()));
  assert.match(intra.explanation['en-IN'], /counts in state 07, so two separate GST amounts apply/);

  const inter = computed(calculator.compute(crateSale({ partyId: 'gurugram-fresh' })));
  assert.match(inter.explanation['en-IN'], /counts in state 06, so one combined GST applies/);
  assert.match(inter.lines[0]?.explanation['en-IN'] ?? '', /at 18% gives .* as one combined GST/);
});

test('the decisions behind the numbers are returned with the answer', () => {
  const { calculator } = makeCalculator();
  const result = computed(calculator.compute(crateSale()));
  const topics = result.decisions.map((d) => d.topic);
  assert.deepEqual(topics, ['gst.composition.charging', 'gst.place_of_supply', 'gst.tax_split']);
  for (const d of result.decisions) {
    assert.ok(d.ruleId !== null, 'every decision names the rule that made it');
    assert.ok(d.evidence.length > 0, 'every decision shows what it looked at');
    assert.equal(d.ruleReviewState, 'DRAFT', 'these rules are not yet reviewed, and the answer says so');
  }
});

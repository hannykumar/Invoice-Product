/**
 * Option C — a business may use the rates it already uses, and the product never pretends those
 * rates are law.
 *
 * The whole design rests on the difference between "we checked this against a notification" and
 * "the shopkeeper told us". These tests exist to make sure that difference survives all the way to
 * the printed bill.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, isoDate, toDecimalString } from '@invoice/kernel';
import { RulesEngine, shippedRegistry } from '@invoice/rules-engine';
import { GstCalculator } from '../src/compute.ts';
import { RateTable } from '../src/rate-table.ts';
import { InMemoryDeclaredRates, validateDeclaredRate, type DeclaredRate } from '../src/declared-rates.ts';
import { InMemoryMasterData } from '../src/master-data-port.ts';
import { SHARMA, inr, on, qty } from './fixtures.ts';
import type { ComputeInput, ComputeResult } from '../src/compute.ts';

const declared = (overrides: Partial<DeclaredRate> = {}): DeclaredRate => ({
  companyId: SHARMA,
  code: '3923',
  kind: 'GOODS',
  ratePercentTimes100: 1800n,
  effectiveFrom: isoDate('2026-04-01'),
  effectiveTo: null,
  declaredBy: 'user-priya',
  declaredOn: isoDate('2026-04-01'),
  basis: 'The rate our accountant has always used for crates',
  ...overrides,
});

/** A production calculator: no rate in the register is approved yet, so nothing is sourced. */
const productionCalculator = (rates: InMemoryDeclaredRates | undefined) => {
  const masterData = new InMemoryMasterData();
  masterData.putCompany({ companyId: SHARMA, gstin: '07AAAAA0000A1Z4', stateCode: '07', registration: 'REGULAR' });
  masterData.putParty(SHARMA, { partyId: 'abc', gstin: '07DDDDD3333D1ZV', stateCode: '07', registration: 'REGULAR' });
  masterData.putItem(SHARMA, {
    itemId: 'CRATE-P',
    name: 'Plastic crate',
    kind: 'GOODS',
    hsnOrSac: '3923',
    treatment: 'TAXABLE',
    reverseCharge: false,
    baseUnit: 'PCS',
  });
  return new GstCalculator({
    masterData,
    // Deliberately empty: production has no approved rate for anything yet (#54).
    rates: new RateTable([]),
    gstEngine: new RulesEngine({ registry: shippedRegistry(), ruleSetId: 'in.gst', mode: 'production' }),
    mode: 'production',
    ...(rates === undefined ? {} : { declaredRates: rates }),
  });
};

const bill = (): ComputeInput => ({
  companyId: SHARMA,
  documentDate: on('2026-04-10'),
  partyId: 'abc',
  supplyKind: 'GOODS',
  lines: [{ lineId: 'l1', itemId: 'CRATE-P', quantity: qty('10', 'PCS'), unitPrice: inr(100), priceBasis: 'EXCLUSIVE' }],
  source: { kind: 'sales_invoice', id: 'si-c' },
});

const computed = (r: ComputeResult) => {
  assert.equal(r.status, 'COMPUTED', r.status === 'CANNOT_COMPUTE' ? r.explanation['en-IN'] : '');
  return r as Extract<ComputeResult, { status: 'COMPUTED' }>;
};

test('without a declared rate, production still refuses — and says the business may enter one', () => {
  const result = productionCalculator(undefined).compute(bill());
  assert.equal(result.status, 'CANNOT_COMPUTE');
  if (result.status !== 'CANNOT_COMPUTE') return;
  assert.match(result.reasons[0]?.message['en-IN'] ?? '', /You can enter the rate you charge/);
});

test('with a declared rate, the bill is priced, and every line says whose rate it is', () => {
  const rates = new InMemoryDeclaredRates().declare(declared());
  const result = computed(productionCalculator(rates).compute(bill()));

  const line = result.lines[0];
  assert.ok(line !== undefined);
  assert.equal(toDecimalString(line.taxableValue), '1000.00');
  assert.equal(toDecimalString(line.cgst), '90.00');
  assert.equal(toDecimalString(line.sgst), '90.00');
  assert.equal(toDecimalString(result.totals.invoiceValue), '1180.00');

  assert.equal(line.rateBasis, 'BUSINESS_DECLARED');
  assert.equal(line.rateDeclaredBy, 'user-priya');
  assert.equal(line.rateDeclaredBasis, 'The rate our accountant has always used for crates');
  assert.equal(line.rateSourceRef, null, 'a rate the business set cites no notification');
  assert.match(line.explanation['en-IN'], /This is the rate your business set/);
});

test('the whole bill carries the notice, so it can reach the printed invoice and the reports', () => {
  const rates = new InMemoryDeclaredRates().declare(declared());
  const result = computed(productionCalculator(rates).compute(bill()));
  assert.equal(result.usesBusinessDeclaredRates, true);
  assert.ok(result.declaredRateNotice !== null);
  assert.match(result.declaredRateNotice['en-IN'], /rates on this bill are the ones your business set/);
  assert.match(result.declaredRateNotice['en-IN'], /not checked them against a government notification/);
  assert.ok(result.declaredRateNotice['hi-IN'].length > 0);
});

test('a bill with no declared rates carries no notice, so the warning never becomes wallpaper', () => {
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
  const masterData = new InMemoryMasterData();
  masterData.putCompany({ companyId: SHARMA, gstin: '07AAAAA0000A1Z4', stateCode: '07', registration: 'REGULAR' });
  masterData.putParty(SHARMA, { partyId: 'abc', gstin: '07DDDDD3333D1ZV', stateCode: '07', registration: 'REGULAR' });
  masterData.putItem(SHARMA, {
    itemId: 'CRATE-P', name: 'Plastic crate', kind: 'GOODS', hsnOrSac: '3923',
    treatment: 'TAXABLE', reverseCharge: false, baseUnit: 'PCS',
  });
  const calculator = new GstCalculator({
    masterData,
    rates: approved,
    gstEngine: new RulesEngine({ registry: shippedRegistry(), ruleSetId: 'in.gst', mode: 'production' }),
    mode: 'production',
    declaredRates: new InMemoryDeclaredRates().declare(declared()),
  });
  const result = computed(calculator.compute(bill()));
  assert.equal(result.lines[0]?.rateBasis, 'REGISTER', 'a checked notification always wins');
  assert.equal(result.lines[0]?.rateSourceRef, 'register:test/approved-3923');
  assert.equal(result.usesBusinessDeclaredRates, false);
  assert.equal(result.declaredRateNotice, null);
});

test('a declared rate cannot be anonymous, or ungrounded, or impossible', () => {
  assert.throws(() => validateDeclaredRate(declared({ declaredBy: '  ' })), (e: unknown) =>
    e instanceof DomainError && e.code === 'DECLARED_RATE_NO_AUTHOR');
  assert.throws(() => validateDeclaredRate(declared({ basis: '' })), (e: unknown) =>
    e instanceof DomainError && e.code === 'DECLARED_RATE_NO_BASIS');
  assert.throws(() => validateDeclaredRate(declared({ ratePercentTimes100: 12000n })), (e: unknown) =>
    e instanceof DomainError && e.code === 'DECLARED_RATE_OUT_OF_RANGE');
  assert.throws(
    () => validateDeclaredRate(declared({ effectiveFrom: isoDate('2026-06-01'), effectiveTo: isoDate('2026-05-01') })),
    (e: unknown) => e instanceof DomainError && e.code === 'DECLARED_RATE_BAD_RANGE',
  );
});

test('a declared rate is effective-dated like any other, so a business can change its mind forward', () => {
  const rates = new InMemoryDeclaredRates()
    .declare(declared({ ratePercentTimes100: 1800n, effectiveFrom: isoDate('2026-04-01'), effectiveTo: isoDate('2026-06-30') }))
    .declare(declared({ ratePercentTimes100: 500n, effectiveFrom: isoDate('2026-07-01'), declaredOn: isoDate('2026-07-01') }));
  const calculator = productionCalculator(rates);

  const june = computed(calculator.compute({ ...bill(), documentDate: on('2026-06-30') }));
  assert.equal(june.lines[0]?.ratePercentTimes100, 1800n);

  const july = computed(calculator.compute({ ...bill(), documentDate: on('2026-07-01') }));
  assert.equal(july.lines[0]?.ratePercentTimes100, 500n);
});

test('one business cannot use another business’s declared rate', () => {
  const rates = new InMemoryDeclaredRates().declare(declared({ companyId: 'someone-else' }));
  const result = productionCalculator(rates).compute(bill());
  assert.equal(result.status, 'CANNOT_COMPUTE');
});

test('the longest matching code wins, so a specific declaration beats a general one', () => {
  const rates = new InMemoryDeclaredRates()
    .declare(declared({ code: '39', ratePercentTimes100: 1800n }))
    .declare(declared({ code: '3923', ratePercentTimes100: 500n }));
  const result = computed(productionCalculator(rates).compute(bill()));
  assert.equal(result.lines[0]?.ratePercentTimes100, 500n);
});

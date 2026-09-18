/**
 * Issue #187 — how many HSN digits a bill needs (Notification 78/2020-Central Tax, Rule 46(g)).
 *
 *  - turnover last year up to ₹5 crore: at least 4 digits on bills to registered customers, none
 *    required on bills to unregistered ones;
 *  - above ₹5 crore, or not sure: at least 6 digits on every bill;
 *  - the e-way bill portal: 6 above ₹5 crore, 4 otherwise, whoever the customer is.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPartA } from '../../transport/src/payload.ts';
import { interStateMovement, steelLine } from '../../transport/src/fixtures.ts';
import { hsnLengthWarning, turnoverAnswerOn } from '../../masters/src/hsn-digits.ts';
import { turnoverAnsweredEveryYear } from '../../masters/src/fixtures.ts';
import { MASTER_APPROVAL_POLICIES, MasterDataService } from '../../masters/src/index.ts';
import { AccessControl, AuditLog, PlatformCommandService } from '../../platform/src/index.ts';
import { SOURCE, SHARMA, inr, makeCalculator, on, qty } from './fixtures.ts';
import type { ComputeInput } from '../src/compute.ts';
import type { TurnoverAbove5Crore } from '../../masters/src/hsn-digits.ts';

/** Sharma Fruit Traders with a plastic-granules item carrying `code`, and the given turnover answer. */
const shop = (code: string, answer: TurnoverAbove5Crore) => {
  const { calculator, masterData } = makeCalculator();
  masterData.putCompany({ companyId: SHARMA, gstin: '07AAAAA0000A1Z4', stateCode: '07', registration: 'REGULAR', turnoverAbove5Crore: turnoverAnsweredEveryYear(answer) });
  // Under 3923 so that the fixture rate table (which holds 3923 at 18%) prices the longer codes.
  // A counter customer with no GST number, in Delhi, so the bill can be priced at all.
  masterData.putParty(SHARMA, { partyId: 'counter-delhi', gstin: null, stateCode: '07', registration: 'UNREGISTERED' });
  masterData.putItem(SHARMA, { itemId: 'GRANULES', name: 'Test granules', kind: 'GOODS', hsnOrSac: code, treatment: 'TAXABLE', reverseCharge: false, baseUnit: 'PCS' });
  return calculator;
};

const sale = (partyId: string): ComputeInput => ({
  companyId: SHARMA,
  documentDate: on('2026-09-18'),
  partyId,
  supplyKind: 'GOODS',
  lines: [{ lineId: 'l1', itemId: 'GRANULES', quantity: qty('10', 'PCS'), unitPrice: inr(100), priceBasis: 'EXCLUSIVE' }],
  freight: inr(200),
  source: SOURCE,
});

const REGISTERED = 'abc-traders';
const UNREGISTERED = 'counter-delhi';

const tooShort = (result: ReturnType<ReturnType<typeof shop>['compute']>) =>
  result.status === 'CANNOT_COMPUTE' ? result.reasons.find((reason) => reason.code === 'HSN_TOO_SHORT') : undefined;

test('small business, registered customer: 2 digits is refused, 4 digits is issued', () => {
  const refused = tooShort(shop('39', 'NO').compute(sale(REGISTERED)));
  assert.ok(refused, 'a 2-digit code must hold up a bill to a registered customer');
  assert.equal(
    refused.message['en-IN'],
    '"Test granules" has the code 39 (2 digits). Bills to a GST-registered customer need at least 4 digits. Update the item\'s HSN code.',
  );
  assert.equal(shop('3923', 'NO').compute(sale(REGISTERED)).status, 'COMPUTED');
});

test('small business, unregistered customer: a 2-digit code is allowed', () => {
  const result = shop('39', 'NO').compute(sale(UNREGISTERED));
  assert.equal(tooShort(result), undefined);
  // It stops only because the fixture has no rate for "39" — not because of its length.
  assert.ok(result.status === 'COMPUTED' || result.reasons.every((reason) => reason.code === 'RATE_NOT_FOUND'));
});

test('above ₹5 crore, unregistered customer: 4 digits is refused naming 6, 6 digits is issued', () => {
  const refused = tooShort(shop('3923', 'YES').compute(sale(UNREGISTERED)));
  assert.ok(refused);
  assert.match(refused.message['en-IN'], /\(4 digits\)\. Your turnover last year was above ₹5 crore, so every bill needs at least 6 digits\./);
  assert.equal(shop('392310', 'YES').compute(sale(UNREGISTERED)).status, 'COMPUTED');
});

test('not sure counts as above ₹5 crore: 4 digits to a registered customer is refused naming 6', () => {
  const refused = tooShort(shop('3923', 'UNKNOWN').compute(sale(REGISTERED)));
  assert.ok(refused);
  assert.match(refused.message['en-IN'], /at least 6 digits until you tell us/);
  assert.ok(refused.message['hi-IN'].includes('6 ank'), 'the Hindi message names 6 digits too');
});

test('a year nobody answered for counts as not sure, so 1 April asks again', () => {
  const answers = [{ answer: 'NO' as const, forFinancialYear: '2026-27' }];
  assert.equal(turnoverAnswerOn(answers, on('2027-03-31')), 'NO');
  assert.equal(turnoverAnswerOn(answers, on('2027-04-01')), 'UNKNOWN');
  assert.equal(turnoverAnswerOn(undefined, on('2026-09-18')), 'UNKNOWN');
});

test('freight never produces HSN_TOO_SHORT: it has no code of its own', () => {
  const result = shop('392310', 'YES').compute(sale(REGISTERED));
  assert.equal(result.status, 'COMPUTED', 'freight is on the bill and the bill still issues');
});

test('the e-way bill needs 6 digits above ₹5 crore and 4 below, whoever the customer is', () => {
  const movement = interStateMovement({
    documents: [{ ...interStateMovement().documents[0]!, lines: [steelLine({ hsnCode: '3902' })] }],
  });
  const large = buildPartA(movement, { turnoverAbove5Crore: 'YES' });
  assert.equal(large.ok, false);
  assert.ok(!large.ok && large.problems.some((problem) => problem.field === 'itemList[0].hsnCode' && problem.message.includes('at least 6 digits')));
  const unsure = buildPartA(movement);
  assert.ok(!unsure.ok && unsure.problems.some((problem) => problem.field === 'itemList[0].hsnCode'), 'not sure asks for 6');
  const small = buildPartA(movement, { turnoverAbove5Crore: 'NO' });
  assert.ok(small.ok || !small.problems.some((problem) => problem.field === 'itemList[0].hsnCode'));
});

test('saving an item with a short code warns, and never refuses', () => {
  const access = new AccessControl();
  access.grant({ companyId: 'company-hsn', userId: 'owner-hsn', branchIds: new Set(['branch-hsn']), active: true, permissions: new Set(['approval.decide'] as const) });
  const audit = new AuditLog();
  const masters = new MasterDataService(new PlatformCommandService(audit, MASTER_APPROVAL_POLICIES), audit);
  const context = access.context('company-hsn', 'branch-hsn', 'owner-hsn', 'session-hsn');
  const created = masters.createItem(context, { name: 'Test granules', kind: 'goods', hsnSac: '39', baseUnit: 'KGS', trackBatches: false, trackSerials: false }, { idempotencyKey: 'hsn-39' });
  assert.equal(created.record.hsnSac, '39');
  assert.deepEqual(created.warnings.map((warning) => warning.message), ['A code shorter than 4 digits cannot be used on bills to GST-registered customers.']);
  assert.equal(hsnLengthWarning('3923', 'goods', 'YES'), 'This code has 4 digits. Your bills need at least 6 digits.');
  assert.equal(hsnLengthWarning('392310', 'goods', 'YES'), null);
  assert.equal(hsnLengthWarning('998314', 'service', 'YES'), null);
});

test('a bill held up for a short code cannot be issued until the item is fixed', async () => {
  const { ABC, inr: rupee, makeTill, on: day, qty: amount } = await import('../../sales/test/fixtures.ts');
  const till = await makeTill();
  const company = till.actor.companyId;
  // Above ₹5 crore, so the crate's 4-digit code (which the fixture rate table prices at 18%) is too short.
  till.masterData.putCompany({ companyId: company, gstin: '07AAAAA0000A1Z4', stateCode: '07', registration: 'REGULAR', turnoverAbove5Crore: turnoverAnsweredEveryYear('YES') });
  const draftFor = (key: string) => till.service.createDraft(till.actor, {
    idempotencyKey: key,
    input: { partyId: ABC, customerType: 'B2B', supplyKind: 'GOODS', documentDate: day('2026-09-18'), lines: [{ lineId: 'l1', itemId: 'CRATE-P', quantity: amount('1', 'PCS'), unitPrice: rupee(100), priceBasis: 'EXCLUSIVE' }] },
  });
  const held = await draftFor('hsn-short');
  assert.ok(held.problems.some((problem) => problem.code === 'HSN_TOO_SHORT'), 'the draft names the short code');
  await assert.rejects(
    till.service.finalise(till.actor, { idempotencyKey: 'hsn-short-f', invoiceId: held.id }),
    (error: unknown) => (error as { code?: string }).code === 'SALES_NEEDS_INFO',
  );
  till.masterData.putItem(company, { itemId: 'CRATE-P', name: 'Plastic crate', kind: 'GOODS', hsnOrSac: '392310', treatment: 'TAXABLE', reverseCharge: false, baseUnit: 'PCS' });
  const issued = await till.service.finalise(till.actor, { idempotencyKey: 'hsn-fixed-f', invoiceId: (await draftFor('hsn-fixed')).id });
  assert.equal(issued.invoice.state, 'FINAL');
});

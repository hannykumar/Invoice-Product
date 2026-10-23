/**
 * Issue #289, part 2b — the time of supply of reverse-charge purchases (CGST s.12(3) goods,
 * s.13(3) services as amended by the Finance (No. 2) Act, 2024) and the self-invoice's 30 days
 * (s.31(3)(f), Rule 47A), on their own: day boundaries, month ends, leap years, ties, retries,
 * races and wrong inputs. Every name below is synthetic.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixedClock, isoDate, type CompanyId, type IsoDate } from '@invoice/kernel';
import type { ActorContext, AuditEvent } from '@invoice/ledger';
import {
  addDays, goodsDeemedDate, rcmTimeOfSupply, selfInvoiceDue, selfInvoiceLastDay, servicesDeemedDate,
} from '../src/reverse-charge-timing.ts';
import {
  InMemoryReverseChargeRegister, ReverseChargeService, checkReverseChargeEntry, selfInvoiceNumber,
  type ReverseChargePurchase,
} from '../src/reverse-charge-register.ts';

const d = (value: string): IsoDate => isoDate(value);
const base = { supplierDocumentDate: null, supplierIssuesInvoice: true, receivedOn: null, paidOn: null, selfInvoiceOn: null, enteredInBooksOn: d('2026-09-28') } as const;

test('counting from a date leaves that date out (General Clauses Act s.9): 30 and 60 days, month ends and leap years', () => {
  assert.equal(selfInvoiceLastDay(d('2026-10-01')), '2026-10-31', 'received 1 Oct: the 30th day is 31 Oct');
  assert.equal(selfInvoiceLastDay(d('2026-01-31')), '2026-03-02', 'across a 28-day February');
  assert.equal(selfInvoiceLastDay(d('2028-01-31')), '2028-03-01', 'across a 29-day February');
  assert.equal(selfInvoiceLastDay(d('2026-12-15')), '2027-01-14', 'across a year end');
  assert.equal(goodsDeemedDate(d('2026-10-01')), '2026-11-01', 's.12(3)(c): the day after 30 days from 1 Oct');
  assert.equal(goodsDeemedDate(d('2026-01-31')), '2026-03-03');
  assert.equal(servicesDeemedDate(d('2026-10-01')), '2026-12-01', 's.13(3)(b): the day after 60 days from 1 Oct');
  assert.equal(servicesDeemedDate(d('2026-08-31')), '2026-10-31');
  assert.equal(addDays(d('2026-03-31'), 1), '2026-04-01', 'into a new financial year');
});

test('goods (s.12(3)): the earliest of receipt, payment and 30 days after the bill', () => {
  const received = rcmTimeOfSupply({ ...base, supplyKind: 'GOODS', supplierDocumentDate: d('2026-08-10'), receivedOn: d('2026-08-12') });
  assert.deepEqual([received.date, received.clause, received.settled], ['2026-08-12', 's.12(3)(a)', true]);
  const paidFirst = rcmTimeOfSupply({ ...base, supplyKind: 'GOODS', supplierDocumentDate: d('2026-08-10'), receivedOn: d('2026-08-12'), paidOn: d('2026-07-31') });
  assert.deepEqual([paidFirst.date, paidFirst.clause], ['2026-07-31', 's.12(3)(b)'], 'an advance in July puts it in July');
  const late = rcmTimeOfSupply({ ...base, supplyKind: 'GOODS', supplierDocumentDate: d('2026-08-10'), receivedOn: d('2026-09-15') });
  assert.deepEqual([late.date, late.clause], ['2026-09-10', 's.12(3)(c)'], 'goods arriving after day 30 of the bill: the deemed date wins');
  // A tie goes to the clause the section lists first.
  const tie = rcmTimeOfSupply({ ...base, supplyKind: 'GOODS', supplierDocumentDate: d('2026-08-01'), receivedOn: d('2026-08-12'), paidOn: d('2026-08-12') });
  assert.equal(tie.clause, 's.12(3)(a)');
  assert.match(received.words, /12 August 2026/);
});

test('services from a registered supplier (s.13(3)(a)/(b)): payment, or the day after 60 days from their bill', () => {
  const unpaid = rcmTimeOfSupply({ ...base, supplyKind: 'SERVICES', supplierDocumentDate: d('2026-08-12') });
  assert.deepEqual([unpaid.date, unpaid.clause], ['2026-10-12', 's.13(3)(b)']);
  const paid = rcmTimeOfSupply({ ...base, supplyKind: 'SERVICES', supplierDocumentDate: d('2026-08-12'), paidOn: d('2026-09-10') });
  assert.deepEqual([paid.date, paid.clause], ['2026-09-10', 's.13(3)(a)']);
  // The receipt date plays no part for services, and a self-invoice is not theirs to give.
  const ignored = rcmTimeOfSupply({ ...base, supplyKind: 'SERVICES', supplierDocumentDate: d('2026-08-12'), receivedOn: d('2026-08-01'), selfInvoiceOn: d('2026-08-02') });
  assert.equal(ignored.date, '2026-10-12');
});

test('services from an unregistered supplier (s.13(3)(c), Finance (No. 2) Act 2024): payment or our own invoice, never 60 days', () => {
  const nothingYet = rcmTimeOfSupply({ ...base, supplyKind: 'SERVICES', supplierIssuesInvoice: false, supplierDocumentDate: d('2026-08-31') });
  assert.deepEqual([nothingYet.date, nothingYet.clause, nothingYet.settled], ['2026-09-28', 's.13(3) first proviso', false],
    'with neither, the books date stands in; the 60 days are only for an invoice the supplier must issue');
  const selfInvoiced = rcmTimeOfSupply({ ...base, supplyKind: 'SERVICES', supplierIssuesInvoice: false, supplierDocumentDate: d('2026-08-31'), selfInvoiceOn: d('2026-09-05') });
  assert.deepEqual([selfInvoiced.date, selfInvoiced.clause, selfInvoiced.settled], ['2026-09-05', 's.13(3)(c)', true]);
  const paidFirst = rcmTimeOfSupply({ ...base, supplyKind: 'SERVICES', supplierIssuesInvoice: false, supplierDocumentDate: d('2026-08-31'), selfInvoiceOn: d('2026-09-05'), paidOn: d('2026-08-31') });
  assert.deepEqual([paidFirst.date, paidFirst.clause], ['2026-08-31', 's.13(3)(a)']);
});

test('the self-invoice reminder: in time, five days out, the last day, and the day after', () => {
  const received = d('2026-09-01'); // last day 1 October
  assert.equal(selfInvoiceDue(received, d('2026-09-25'), null).state, 'NOT_YET_DUE');
  assert.deepEqual([selfInvoiceDue(received, d('2026-09-26'), null).state, selfInvoiceDue(received, d('2026-09-26'), null).daysLeft], ['DUE_SOON', 5]);
  assert.equal(selfInvoiceDue(received, d('2026-09-30'), null).words.includes('1 day left'), true);
  assert.equal(selfInvoiceDue(received, d('2026-10-01'), null).state, 'LAST_DAY');
  const late = selfInvoiceDue(received, d('2026-10-02'), null);
  assert.deepEqual([late.state, late.daysLeft], ['OVERDUE', -1]);
  assert.match(late.words, /Issue it now/);
  assert.match(selfInvoiceDue(received, d('2026-10-02'), d('2026-10-01')).words, /within the 30 days/);
  assert.match(selfInvoiceDue(received, d('2026-10-05'), d('2026-10-02')).words, /after the 30 days/);
});

test('wrong inputs are refused before anything is posted', () => {
  assert.throws(() => checkReverseChargeEntry({ receivedOn: d('2026-09-29'), today: d('2026-09-28'), supplyKinds: ['GOODS'] }), { code: 'REVERSE_CHARGE_RECEIVED_FUTURE' });
  assert.throws(() => checkReverseChargeEntry({ receivedOn: d('2026-09-20'), today: d('2026-09-28'), supplyKinds: ['GOODS', 'SERVICES'] }), { code: 'REVERSE_CHARGE_GOODS_AND_SERVICES' });
  assert.equal(checkReverseChargeEntry({ receivedOn: d('2026-09-28'), today: d('2026-09-28'), supplyKinds: ['SERVICES', 'SERVICES'] }), 'SERVICES', 'today itself is fine');
  assert.equal(selfInvoiceNumber('2026-27', 1), 'SI/2026-27/0001');
  assert.equal(selfInvoiceNumber('2026-27', 1).length <= 16, true, 'Rule 46(b)');
  assert.throws(() => selfInvoiceNumber('2026-27', 100_000), { code: 'SELF_INVOICE_SERIES_FULL' });
});

// ------------------------------------------------------------------------------- the service

const COMPANY = '00000000-0000-4000-8000-0000000000aa' as CompanyId;
const owner = { companyId: COMPANY, userId: 'user-owner', branchId: 'branch', permissions: ['ledger.post.purchase'] } as unknown as ActorContext;
const viewer = { ...owner, permissions: [] } as unknown as ActorContext;
const party = (name: string, gstin: string | null) => ({ name, addressLines: ['1, Market Road', 'Bengaluru 560002'], gstin, stateCode: '29', stateName: 'Karnataka' });
const us = party('Sampoorna Traders', '29AAAAA0000A1ZY');

const purchase = (billId: string, overrides: Partial<ReverseChargePurchase> = {}): Omit<ReverseChargePurchase, 'companyId' | 'recordedBy' | 'recordedAt'> => ({
  billId, supplierPartyId: 'party-kabadi', supplier: party('Kabadi Traders', null), supplierRegistered: false, supplyKind: 'GOODS',
  invoiceNumber: `KT-${billId}`, invoiceDate: d('2026-09-01'), receivedOn: d('2026-09-01'), enteredOn: d('2026-09-01'), interState: false,
  lines: [{ lineNumber: 1, description: 'Copper scrap', hsnSac: '74040010', quantity: '200 KGS', unit: 'KGS', taxableValuePaise: 10_000_000n, gstRateBasisPoints: 1800, cgstPaise: 900_000n, sgstPaise: 900_000n, igstPaise: 0n, cessPaise: 0n }],
  ...overrides,
});

const serviceAt = (today: string) => {
  const events: AuditEvent[] = [];
  let next = 0;
  const register = new InMemoryReverseChargeRegister();
  const service = new ReverseChargeService({
    register, clock: fixedClock(`${today}T06:00:00.000Z`), audit: { async record(event) { events.push(event); } }, idFactory: () => `si-${next += 1}`,
  });
  return { service, register, events };
};

test('a self-invoice is issued once per purchase, numbered in its own series, and a retry returns the same one', async () => {
  const { service, events } = serviceAt('2026-09-28');
  await service.recordPurchase(owner, purchase('b1'));
  await service.recordPurchase(owner, purchase('b1')); // a retry with the same facts is a no-op
  await assert.rejects(service.recordPurchase(owner, purchase('b1', { receivedOn: d('2026-09-02') })), { code: 'REVERSE_CHARGE_ALREADY_RECORDED' });
  await service.recordPurchase(owner, purchase('b2'));

  const first = await service.issueSelfInvoice(owner, { billId: 'b1', issuedOn: d('2026-09-28'), idempotencyKey: 'k1', recipient: us, billReversed: false });
  assert.deepEqual([first.invoice.number, first.deduplicated], ['SI/2026-27/0001', false]);
  const again = await service.issueSelfInvoice(owner, { billId: 'b1', issuedOn: d('2026-09-28'), idempotencyKey: 'k1', recipient: us, billReversed: false });
  assert.deepEqual([again.invoice.number, again.deduplicated], ['SI/2026-27/0001', true]);
  const pressedAgain = await service.issueSelfInvoice(owner, { billId: 'b1', issuedOn: d('2026-09-27'), idempotencyKey: 'k-other', recipient: us, billReversed: false });
  assert.deepEqual([pressedAgain.invoice.number, pressedAgain.invoice.issuedOn, pressedAgain.deduplicated], ['SI/2026-27/0001', '2026-09-28', true]);
  await assert.rejects(service.issueSelfInvoice(owner, { billId: 'b2', issuedOn: d('2026-09-28'), idempotencyKey: 'k1', recipient: us, billReversed: false }), { code: 'SELF_INVOICE_KEY_REUSED' });
  const second = await service.issueSelfInvoice(owner, { billId: 'b2', issuedOn: d('2026-09-28'), idempotencyKey: 'k2', recipient: us, billReversed: false });
  assert.equal(second.invoice.number, 'SI/2026-27/0002');
  assert.equal(events.filter((event) => event.action === 'purchase.self_invoice_issued').length, 2, 'audited once each');
  assert.equal(first.invoice.cgstPaise + first.invoice.sgstPaise, 1_800_000n);
});

test('the self-invoice series starts again each financial year', async () => {
  const { service } = serviceAt('2027-04-02');
  await service.recordPurchase(owner, purchase('m1', { receivedOn: d('2027-03-30'), invoiceDate: d('2027-03-30') }));
  await service.recordPurchase(owner, purchase('a1', { receivedOn: d('2027-04-01'), invoiceDate: d('2027-04-01') }));
  const march = await service.issueSelfInvoice(owner, { billId: 'm1', issuedOn: d('2027-03-31'), idempotencyKey: 'm', recipient: us, billReversed: false });
  const april = await service.issueSelfInvoice(owner, { billId: 'a1', issuedOn: d('2027-04-01'), idempotencyKey: 'a', recipient: us, billReversed: false });
  assert.deepEqual([march.invoice.number, april.invoice.number], ['SI/2026-27/0001', 'SI/2027-28/0001']);
});

test('a self-invoice is refused when it is not the law\'s to give, or dated wrongly, or by someone without permission', async () => {
  const { service } = serviceAt('2026-09-28');
  await service.recordPurchase(owner, purchase('b1', { receivedOn: d('2026-09-10') }));
  await service.recordPurchase(owner, purchase('gta', { supplierRegistered: true, supplier: party('Sri Durga Roadways', '29DDDDD4444D1Z5'), supplyKind: 'SERVICES' }));
  const ask = (billId: string, issuedOn: string, actor = owner, billReversed = false) =>
    service.issueSelfInvoice(actor, { billId, issuedOn: d(issuedOn), idempotencyKey: `${billId}:${issuedOn}`, recipient: us, billReversed });
  await assert.rejects(ask('b1', '2026-09-09'), { code: 'SELF_INVOICE_BEFORE_RECEIPT' });
  await assert.rejects(ask('b1', '2026-09-29'), { code: 'SELF_INVOICE_DATE_FUTURE' });
  await assert.rejects(ask('gta', '2026-09-28'), { code: 'SELF_INVOICE_NOT_NEEDED' });
  await assert.rejects(ask('nothing', '2026-09-28'), { code: 'SELF_INVOICE_NOT_REVERSE_CHARGE' });
  await assert.rejects(ask('b1', '2026-09-28', owner, true), { code: 'SELF_INVOICE_BILL_REVERSED' });
  await assert.rejects(ask('b1', '2026-09-28', viewer), { code: 'PERMISSION_DENIED' });
  await assert.rejects(service.recordPurchase(owner, purchase('later', { receivedOn: d('2026-09-29') })), { code: 'REVERSE_CHARGE_RECEIVED_FUTURE' });
});

test('two presses at once: one self-invoice for one bill, and two bills never share a number', async () => {
  const { service } = serviceAt('2026-09-28');
  await Promise.all(['c1', 'c2', 'c3'].map((billId) => service.recordPurchase(owner, purchase(billId))));
  const same = await Promise.all([1, 2, 3].map((n) => service.issueSelfInvoice(owner, { billId: 'c1', issuedOn: d('2026-09-28'), idempotencyKey: `press-${n}`, recipient: us, billReversed: false })));
  assert.equal(new Set(same.map((result) => result.invoice.number)).size, 1);
  assert.equal(same.filter((result) => !result.deduplicated).length, 1);
  const different = await Promise.all(['c2', 'c3'].map((billId) => service.issueSelfInvoice(owner, { billId, issuedOn: d('2026-09-28'), idempotencyKey: billId, recipient: us, billReversed: false })));
  assert.deepEqual(different.map((result) => result.invoice.number).sort(), ['SI/2026-27/0002', 'SI/2026-27/0003']);
});

test('the reminder list: each unregistered purchase with its self-invoice standing, registered ones left out', async () => {
  const { service } = serviceAt('2026-09-28');
  await service.recordPurchase(owner, purchase('overdue', { receivedOn: d('2026-08-28') }));
  await service.recordPurchase(owner, purchase('lastday', { receivedOn: d('2026-08-29') }));
  await service.recordPurchase(owner, purchase('soon', { receivedOn: d('2026-09-01') }));
  await service.recordPurchase(owner, purchase('gta', { supplierRegistered: true, supplier: party('Sri Durga Roadways', '29DDDDD4444D1Z5'), supplyKind: 'SERVICES' }));
  await service.recordPurchase(owner, purchase('reversed', { receivedOn: d('2026-09-02') }));
  const rows = await service.reminders(COMPANY, d('2026-09-28'), (billId) => billId !== 'reversed');
  assert.deepEqual(rows.map((row) => [row.billId, row.due.state]), [['soon', 'DUE_SOON'], ['lastday', 'LAST_DAY'], ['overdue', 'OVERDUE']]);
  assert.equal(rows[0]?.taxPaise, 1_800_000n);
});

test('the time of supply of a recorded purchase follows its payment and its self-invoice', async () => {
  const { service } = serviceAt('2026-09-28');
  await service.recordPurchase(owner, purchase('rent', { supplyKind: 'SERVICES', invoiceDate: d('2026-08-31'), receivedOn: d('2026-08-31'), enteredOn: d('2026-09-28') }));
  assert.equal((await service.timeOfSupply(COMPANY, 'rent', null))?.clause, 's.13(3) first proviso');
  assert.equal((await service.timeOfSupply(COMPANY, 'rent', d('2026-09-02')))?.date, '2026-09-02');
  await service.issueSelfInvoice(owner, { billId: 'rent', issuedOn: d('2026-09-05'), idempotencyKey: 'rent', recipient: us, billReversed: false });
  assert.equal((await service.timeOfSupply(COMPANY, 'rent', null))?.date, '2026-09-05');
  assert.equal(await service.timeOfSupply(COMPANY, 'unknown', null), null);
});

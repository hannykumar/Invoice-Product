/**
 * Issue #289, part 2b — over the app's own HTTP endpoints: which month's GSTR-3B carries a
 * reverse-charge purchase's tax (its time of supply, CGST s.12(3) goods / s.13(3) services), the
 * self-invoice for a purchase from an unregistered supplier (s.31(3)(f), Rule 47A, 30 days), and the
 * payment voucher at the time of payment (s.31(3)(g), Rule 52). Law read 21 Oct 2026; sources in
 * packages/purchasing/src/reverse-charge-timing.ts.
 *
 * Today is 28 September 2026 throughout. Every name and figure is synthetic and belongs to nobody.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { useFixedAppClock } from '../src/app-clock.ts';
import { syntheticGstin } from '../../../packages/masters/src/fixtures.ts';

useFixedAppClock('2026-09-28T10:00:00.000Z');

const COMPANY_A = '00000000-0000-4000-8000-000000000001';

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

let owner = '';
const ok = async (path: string, body: Record<string, unknown>) => {
  const response = await request('POST', path, body, owner);
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(response.body)}`);
  return response.body;
};
const refused = async (path: string, body: Record<string, unknown>) => {
  const response = await request('POST', path, body, owner);
  assert.equal(response.status >= 400, true, `${path} should be refused: ${JSON.stringify(response.body)}`);
  return response.body;
};
/** The reverse-charge tax (CGST + SGST) GSTR-3B Table 3.1(d) carries for a month. */
const rcmTaxIn = async (period: string): Promise<number> => {
  const month = await ok('/api/gst-returns', { period });
  const threeB = month.gstr3b ?? month.workspace?.gstr3b;
  return threeB.heads.filter((head: any) => head.head === 'CGST' || head.head === 'SGST').reduce((total: number, head: any) => total + head.reverseChargeCash, 0);
};

let kabadi = '';
let landlord = '';
let transporter = '';
const scrap = (reference: string, date: string, extra: Record<string, unknown> = {}) =>
  ({ supplierId: kabadi, reference, date, lines: [{ item: 'Brass scrap', quantity: '100', rate: '400' }], ...extra });
const GTA_ANSWERS = { gta_consignment_note: 'yes', gta_exempt: 'no', gta_forward_charge: 'no' };

test('suppliers and items', async () => {
  owner = (await request('POST', '/api/auth/login', { companyId: COMPANY_A, email: 'owner@sampoorna.example.invalid', password: 'karobar-demo' })).body.sessionId;
  kabadi = (await ok('/api/suppliers', { legalName: 'Mehta Kabadi Stores', registration: 'unregistered', unregisteredBasis: 'BELOW_THRESHOLD', line1: '4, Scrap Lane', city: 'Bengaluru', pincode: '560026' })).supplier.id;
  landlord = (await ok('/api/suppliers', { legalName: 'R. Shetty (landlord)', registration: 'unregistered', unregisteredBasis: 'BELOW_THRESHOLD', line1: '9, Temple Street', city: 'Bengaluru', pincode: '560004' })).supplier.id;
  transporter = (await ok('/api/suppliers', { legalName: 'Kaveri Roadlines', registration: 'regular', gstin: syntheticGstin('29', 'KKKKK5555K'), line1: '3, Lorry Stand', city: 'Bengaluru', pincode: '560023' })).supplier.id;
  await ok('/api/items', { name: 'Brass scrap', kind: 'goods', hsnSac: '74040022', unit: 'KGS', taxKind: 'taxable', ratePercentTimes100: '1800', basis: 'Rate schedule' });
  await ok('/api/items', { name: 'Godown rent', kind: 'service', hsnSac: '997212', unit: 'NOS', taxKind: 'taxable', ratePercentTimes100: '1800', basis: 'Rate schedule' });
  await ok('/api/items', { name: 'Road freight (GTA)', kind: 'service', hsnSac: '996791', unit: 'NOS', taxKind: 'taxable', ratePercentTimes100: '1800', basis: 'Rate schedule' });
});

test('goods: the tax falls due the day they arrived (s.12(3)(a)), and day 30 of the self-invoice is today', async () => {
  const bill = scrap('MK-1', '2026-08-30', { receivedOn: '2026-08-29' });
  const preview = await ok('/api/purchases/preview', bill);
  const said = preview.effects.join(' ');
  assert.match(said, /falls due on 29 August 2026/);
  assert.match(said, /s\.12\(3\)\(a\)/);
  assert.match(said, /August 2026/);
  assert.match(said, /self-invoice/);
  assert.match(said, /Today, 28 September 2026, is the last of the 30 days/);

  const recorded = await ok('/api/purchases/record', bill);
  assert.equal(recorded.owe, 40000);
  assert.deepEqual([recorded.reverseCharge.timeOfSupply.date, recorded.reverseCharge.timeOfSupply.clause, recorded.reverseCharge.timeOfSupply.period], ['2026-08-29', 's.12(3)(a)', '2026-08']);
  assert.deepEqual([recorded.reverseCharge.selfInvoice.state, recorded.reverseCharge.selfInvoice.daysLeft], ['LAST_DAY', 0]);
  assert.equal(await rcmTaxIn('2026-08'), 7200, '18% of ₹40,000 in August, the month the scrap arrived');
});

test('the self-invoice: issued once with the Rule 46 particulars, numbered SI/2026-27/0001; a second press makes no second one', async () => {
  const list = (await request('GET', '/api/purchases/self-invoices', {}, owner)).body;
  const due = list.items.find((item: any) => item.bill === 'MK-1');
  assert.equal(due.state, 'LAST_DAY');
  assert.equal(list.toIssue >= 1, true);

  await refused('/api/purchases/self-invoice', { billId: due.billId, date: '2026-08-28' }).then((body) => assert.equal(body.code, 'SELF_INVOICE_BEFORE_RECEIPT'));
  await refused('/api/purchases/self-invoice', { billId: due.billId, date: '2026-09-29' }).then((body) => assert.equal(body.code, 'SELF_INVOICE_DATE_FUTURE'));
  await refused('/api/purchases/self-invoice', { billId: due.billId, date: '28/09/2026' }).then((body) => assert.equal(body.code, 'SELF_INVOICE_DATE'));

  const issued = await ok('/api/purchases/self-invoice', { billId: due.billId, date: '2026-09-28' });
  assert.equal(issued.number, 'SI/2026-27/0001');
  assert.equal(issued.deduplicated, false);
  assert.match(issued.effects.join(' '), /within the 30 days/);
  const page: string = issued.html;
  for (const particular of ['TAX INVOICE', 'SI/2026-27/0001', '28 September 2026', 'Mehta Kabadi Stores', 'GSTIN: Not registered', '29AAAAA0000A1ZY', '74040022', 'Brass scrap',
    'Whether tax is payable on reverse charge</th><td>Yes', 'Karnataka (29)', '9%', '₹3,600.00', 'section 31(3)(f)', 'Authorised signatory']) {
    assert.ok(page.includes(particular), `the self-invoice shows ${particular}`);
  }
  const again = await ok('/api/purchases/self-invoice', { billId: due.billId, date: '2026-09-27' });
  assert.deepEqual([again.number, again.issuedOn, again.deduplicated], ['SI/2026-27/0001', '2026-09-28', true]);
  const printed = await ok('/api/purchases/self-invoice/print', { billId: due.billId });
  assert.equal(printed.number, 'SI/2026-27/0001');
  const after = (await request('GET', '/api/purchases/self-invoices', {}, owner)).body.items.find((item: any) => item.bill === 'MK-1');
  assert.deepEqual([after.state, after.number], ['ISSUED', 'SI/2026-27/0001']);
});

test('the reminder list puts the late one first; a bill from a registered supplier needs no self-invoice', async () => {
  await ok('/api/purchases/record', scrap('MK-2', '2026-08-28', { receivedOn: '2026-08-28' })); // day 31 today
  await ok('/api/purchases/record', scrap('MK-3', '2026-09-01', { receivedOn: '2026-09-01' })); // 3 days left
  const items = (await request('GET', '/api/purchases/self-invoices', {}, owner)).body.items as any[];
  assert.deepEqual(items.map((item) => [item.bill, item.state]), [['MK-2', 'OVERDUE'], ['MK-3', 'DUE_SOON'], ['MK-1', 'ISSUED']]);
  assert.match(items[0].words, /ended on 27 September 2026/);
  const late = await ok('/api/purchases/self-invoice', { billId: items[0].billId, date: '2026-09-28' });
  assert.equal(late.number, 'SI/2026-27/0002');
  assert.match(late.effects.join(' '), /after the 30 days ended on 27 September 2026/);
});

test('wrong inputs: a date in the future, an unreadable date, goods and services mixed on one bill', async () => {
  const future = await refused('/api/purchases/preview', scrap('MK-9', '2026-09-20', { receivedOn: '2026-09-29' }));
  assert.equal(future.code, 'REVERSE_CHARGE_RECEIVED_FUTURE');
  const unreadable = await refused('/api/purchases/preview', scrap('MK-9', '2026-09-20', { receivedOn: 'yesterday' }));
  assert.equal(unreadable.code, 'PURCHASE_RECEIVED_ON');
  const mixed = await refused('/api/purchases/preview', {
    supplierId: kabadi, reference: 'MK-10', date: '2026-09-20',
    lines: [{ item: 'Brass scrap', quantity: '10', rate: '400' }, { item: 'Godown rent', quantity: '1', rate: '5000' }],
  });
  assert.equal(mixed.code, 'REVERSE_CHARGE_GOODS_AND_SERVICES');
});

test('rent from an unregistered landlord (13/2017 S.No. 5AB): the tax follows the self-invoice date (s.13(3)(c)), not the bill', async () => {
  const bill = { supplierId: landlord, reference: 'RENT-AUG', date: '2026-08-31', receivedOn: '2026-08-31', lines: [{ item: 'Godown rent', quantity: '1', rate: '20000' }] };
  const preview = await ok('/api/purchases/preview', bill);
  assert.match(preview.effects.join(' '), /date of your self-invoice, or the day you pay/);
  const recorded = await ok('/api/purchases/record', bill);
  // Neither paid nor self-invoiced yet: the proviso's date, the day it went into the books (today).
  assert.deepEqual([recorded.reverseCharge.timeOfSupply.clause, recorded.reverseCharge.timeOfSupply.date], ['s.13(3) first proviso', '2026-09-28']);
  const [august, september] = [await rcmTaxIn('2026-08'), await rcmTaxIn('2026-09')];
  // Self-invoiced on the day the rent fell due, 31 August: the tax is August's (18% of ₹20,000 = ₹3,600).
  const issued = await ok('/api/purchases/self-invoice', { billId: recorded.reverseCharge.billId, date: '2026-08-31' });
  assert.match(issued.effects.join(' '), /s\.13\(3\)\(c\)/);
  assert.equal(await rcmTaxIn('2026-08'), august + 3600);
  assert.equal(await rcmTaxIn('2026-09'), september - 3600);
});

test('GTA freight from a registered transporter: unpaid, it is not due for 60 days; paid, it falls due that day (s.13(3)(a)/(b))', async () => {
  const bill = { supplierId: transporter, reference: 'KR-71', date: '2026-08-14', lines: [{ item: 'Road freight (GTA)', quantity: '1', rate: '10000' }], reverseChargeAnswers: GTA_ANSWERS };
  const recorded = await ok('/api/purchases/record', bill);
  assert.deepEqual([recorded.reverseCharge.timeOfSupply.date, recorded.reverseCharge.timeOfSupply.clause], ['2026-10-14', 's.13(3)(b)']);
  assert.equal(recorded.reverseCharge.selfInvoice, null, 'the transporter has a GST number and issues the invoice');
  const notNeeded = await refused('/api/purchases/self-invoice', { billId: recorded.reverseCharge.billId });
  assert.equal(notNeeded.code, 'SELF_INVOICE_NOT_NEEDED');
  const august = await rcmTaxIn('2026-08');
  const september = await rcmTaxIn('2026-09');

  // Paying the transporter on 10 September brings it into September: ₹10,000 at 5% = ₹500 in 3.1(d).
  const paid = await ok('/api/payments/record', { direction: 'PAYMENT', partyId: transporter, amount: '10000', date: '2026-09-10', method: 'Bank transfer', bills: [recorded.reverseCharge.billId], requestId: 'kr-71-pay' });
  assert.equal(await rcmTaxIn('2026-08'), august);
  assert.equal(await rcmTaxIn('2026-09'), september + 500);
  // Pressed twice, recorded once: the month does not count it twice.
  await ok('/api/payments/record', { direction: 'PAYMENT', partyId: transporter, amount: '10000', date: '2026-09-10', method: 'Bank transfer', bills: [recorded.reverseCharge.billId], requestId: 'kr-71-pay' });
  assert.equal(await rcmTaxIn('2026-09'), september + 500);

  // The payment voucher made at that payment is the s.31(3)(g) voucher, with Rule 52's particulars.
  const voucher = await ok('/api/payments/voucher', { paymentId: paid.paymentId });
  for (const particular of ['PAYMENT VOUCHER', 'section 31(3)(g)', 'Rule 52', 'Kaveri Roadlines', 'Road freight (GTA)', '996791', 'CGST 2.5% + SGST 2.5%', '₹250.00 + ₹250.00', 'Signature of the supplier']) {
    assert.ok(voucher.html.includes(particular), `the payment voucher shows ${particular}`);
  }
  // Rule 52(b): sixteen characters at most — the books' PAYMENT/2026-27/… is shown in its short form.
  const short = /Voucher number<\/th><td>([^<]+)</.exec(voucher.html)?.[1] ?? '';
  assert.match(short, /^PV\/2627\/\d+$/);
  assert.ok(short.length <= 16);
  assert.ok(voucher.html.includes(`Books voucher</th><td>${paid.voucherNumber}`));
});

test('an advance paid in July on a reverse-charge purchase puts its tax in July (s.12(3)(b)); it is no longer refused', async () => {
  await ok('/api/payments/record', { direction: 'PAYMENT', partyId: kabadi, amount: '4000', date: '2026-07-20', method: 'Cash', advance: 'yes', requestId: 'mk-adv' });
  const july = await rcmTaxIn('2026-07');
  const recorded = await ok('/api/purchases/record', scrap('MK-5', '2026-08-05', { receivedOn: '2026-08-05', lines: [{ item: 'Brass scrap', quantity: '10', rate: '400' }] }));
  assert.equal(recorded.advanceUsed, 4000);
  assert.deepEqual([recorded.reverseCharge.timeOfSupply.date, recorded.reverseCharge.timeOfSupply.clause], ['2026-07-20', 's.12(3)(b)']);
  assert.equal(await rcmTaxIn('2026-07'), july + 720, '18% of ₹4,000 in July, when the advance was paid');
});

test('a retry of the same bill records it once and leaves one entry in the register', async () => {
  const bill = scrap('MK-6', '2026-09-02', { receivedOn: '2026-09-02' });
  const first = await ok('/api/purchases/record', bill);
  const second = await ok('/api/purchases/record', bill);
  assert.equal(second.deduplicated, true);
  const rows = (await request('GET', '/api/purchases/self-invoices', {}, owner)).body.items.filter((item: any) => item.bill === 'MK-6');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].billId, first.bill.id);
});

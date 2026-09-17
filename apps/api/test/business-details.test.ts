/**
 * Issue #180 — the business's own address, PIN code, phone, PAN and bank on every document.
 *
 * Each test here fails if the fix is reverted: reverting puts the godown nickname back on the bill
 * and lets a company with no address issue one.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { forgetBusinessDetails } from '../src/business-details-application.ts';

const COMPANY_A = '00000000-0000-4000-8000-000000000001';

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

const signIn = async (): Promise<string> => {
  const response = await request('POST', '/api/auth/login', { companyId: COMPANY_A, email: 'owner@sampoorna.example.invalid', password: 'karobar-demo' });
  assert.equal(response.status, 200);
  return response.body.sessionId as string;
};

/** The address the issue's own worked example uses. */
const ADDRESS = {
  legalName: 'Sampoorna Traders',
  address1: 'No. 14, 2nd Main, Peenya Industrial Area',
  city: 'Bengaluru',
  pincode: '560058',
  stateCode: '29',
  phone: '080 4000 1234',
  pan: 'AAAAA0000A',
};

const sale = { party: 'ABC Traders', item: 'Herbal Bath Soap 100g', quantity: '4', rate: '250', date: '2026-08-29', terms: '30' };

test('a business with no address cannot issue a bill, and no invoice number is spent on the refusal', async () => {
  const session = await signIn();
  // The screen must be reachable before a sale is, or there is no way out of the refusal.
  assert.equal((await request('GET', '/api/business-details', {}, session)).status, 200);
  forgetBusinessDetails(COMPANY_A);

  const refused = await request('POST', '/api/sales/record', { ...sale, reference: 'no-address-1' }, session);
  assert.equal(refused.status, 422);
  assert.equal(refused.body.code, 'BUSINESS_ADDRESS_MISSING');
  assert.equal(refused.body.message, 'Add your business address in Business details before issuing — the law requires it on every bill.');

  // A draft still works: only issuing is held back.
  assert.equal((await request('POST', '/api/sales/preview', { ...sale, reference: 'no-address-preview' }, session)).status, 200);

  const saved = await request('POST', '/api/business-details', ADDRESS, session);
  assert.equal(saved.status, 200);
  const recorded = await request('POST', '/api/sales/record', { ...sale, reference: 'no-address-2' }, session);
  assert.equal(recorded.status, 200, recorded.body.message);
  // The refused attempt consumed nothing: the first bill this company issues is still its first.
  assert.match(String(recorded.body.invoice.number), /^INV\/26-27\/0000\d\d$/);
});

test('the saved address, phone, PAN and bank details reach the printed bill, and the godown nickname does not', async () => {
  const session = await signIn();
  const saved = await request('POST', '/api/business-details', {
    ...ADDRESS,
    email: 'billing@sampoorna.example.invalid',
    bankName: 'HDFC Bank',
    accountNumber: '50200012345678',
    branch: 'Peenya',
    ifsc: 'HDFC0001234',
  }, session);
  assert.equal(saved.status, 200, saved.body.message);
  assert.equal(saved.body.bank.bankName, 'HDFC Bank');

  const recorded = await request('POST', '/api/sales/record', { ...ADDRESS, ...sale, reference: 'printed-address' }, session);
  assert.equal(recorded.status, 200, recorded.body.message);
  const printed = await request('POST', '/api/sales/print', { invoice: recorded.body.invoice.id }, session);
  assert.equal(printed.status, 200);
  const html = String(printed.body.html);

  for (const fragment of [
    'No. 14, 2nd Main, Peenya Industrial Area',
    'Bengaluru 560058',
    'Karnataka (29)',
    '29AAAAA0000A1ZY',
    'AAAAA0000A',
    '080 4000 1234',
    'HDFC Bank',
    '50200012345678',
    'HDFC0001234',
  ]) {
    assert.ok(html.includes(fragment), `the bill must print ${fragment}`);
  }
  assert.ok(!html.includes('Peenya godown'), 'the godown nickname is not an address and must not print as one');
});

test('a PAN or a state that disagrees with the GST number is refused', async () => {
  const session = await signIn();
  const wrongPan = await request('POST', '/api/business-details', { ...ADDRESS, pan: 'BBBBB1111B' }, session);
  assert.equal(wrongPan.status, 422);
  assert.equal(wrongPan.body.code, 'BUSINESS_PAN_MISMATCH');
  assert.match(String(wrongPan.body.message), /AAAAA0000A/);

  const wrongState = await request('POST', '/api/business-details', { ...ADDRESS, stateCode: '07' }, session);
  assert.equal(wrongState.status, 422);
  assert.equal(wrongState.body.code, 'BUSINESS_STATE_MISMATCH');
  assert.equal(wrongState.body.message, 'Your GST number is registered in Karnataka. The address on the bill must be in the same state.');

  const noPin = await request('POST', '/api/business-details', { ...ADDRESS, pincode: '' }, session);
  assert.equal(noPin.status, 422);
});

test('changing the address later never changes a bill already issued', async () => {
  const session = await signIn();
  assert.equal((await request('POST', '/api/business-details', ADDRESS, session)).status, 200);
  const recorded = await request('POST', '/api/sales/record', { ...sale, reference: 'frozen-address' }, session);
  assert.equal(recorded.status, 200, recorded.body.message);

  const moved = await request('POST', '/api/business-details', {
    ...ADDRESS,
    address1: 'Plot 88, Bommasandra Industrial Area',
    city: 'Anekal',
    pincode: '560099',
  }, session);
  assert.equal(moved.status, 200, moved.body.message);

  const reprinted = await request('POST', '/api/sales/print', { invoice: recorded.body.invoice.id }, session);
  const html = String(reprinted.body.html);
  assert.ok(html.includes('No. 14, 2nd Main, Peenya Industrial Area'), 'a reprint shows the address the bill was issued with');
  assert.ok(!html.includes('Bommasandra'), 'a later move must not rewrite an old bill');
});

test('a delivery challan carries the same address as the consigner', async () => {
  const session = await signIn();
  assert.equal((await request('POST', '/api/business-details', ADDRESS, session)).status, 200);
  const issued = await request('POST', '/api/challans/issue', {
    reason: 'JOB_WORK',
    date: '2026-08-29',
    customerId: 'ABC Traders',
    item: 'Herbal Bath Soap 100g',
    quantity: '4',
    rate: '250',
    reference: 'challan-address',
  }, session);
  assert.equal(issued.status, 200, issued.body.message);
  const printed = await request('POST', '/api/challans/print', { challan: issued.body.challan.id }, session);
  assert.equal(printed.status, 200, printed.body.message);
  assert.ok(String(printed.body.html).includes('No. 14, 2nd Main, Peenya Industrial Area'));
  assert.ok(!String(printed.body.html).includes('Peenya godown'));
});

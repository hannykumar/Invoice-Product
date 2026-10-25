/**
 * Issue #391 — master-data writes are made by the signed-in person, not by a shared service user.
 *
 * Reverting the fix records every bank account, customer and address against
 * `<company>:master-data`, and lets that identity approve a merge on its own.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { masterData, mastersContext } from '../src/master-data.ts';
import { useFixedAppClock } from '../src/app-clock.ts';
import { signIn } from './sign-in-helper.ts';

useFixedAppClock('2026-08-29T10:00:00.000Z');

const COMPANY_A = '00000000-0000-4000-8000-000000000001';
const SAMPOORNA_OWNER_ID = '00000000-0000-4000-8000-000000000003';
const SAMPOORNA_ACCOUNTANT_ID = '00000000-0000-4000-8000-000000000005';

const request = async (method: string, path: string, body: Record<string, unknown>, session: string) => {
  const response = await handleApi(method, path, body, `Bearer ${session}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

const ADDRESS = {
  legalName: 'Sampoorna Traders',
  address1: 'No. 14, 2nd Main, Peenya Industrial Area',
  city: 'Bengaluru',
  pincode: '560058',
  stateCode: '29',
  phone: '080 4000 1234',
  pan: 'AAAAA0000A',
};

test('a bank-account change made by the owner is recorded as made by the owner', async () => {
  const session = await signIn('owner@sampoorna.example.invalid', COMPANY_A);
  const saved = await request('POST', '/api/business-details', {
    ...ADDRESS, bankName: 'Canara Bank', accountNumber: '39110000391391', ifsc: 'CNRB0000391',
  }, session);
  assert.equal(saved.status, 200, saved.body.message);

  const account = masterData().bankAccounts(mastersContext(COMPANY_A)).find((candidate) => candidate.accountNumber === '39110000391391');
  assert.ok(account, 'the bank account is in master data');
  const history = masterData().history(mastersContext(COMPANY_A), 'bank_account', account.id);
  assert.ok(history.length > 0);
  for (const version of history) assert.equal(version.recordedBy, SAMPOORNA_OWNER_ID);
});

test('a customer added by the accountant is recorded as added by the accountant', async () => {
  const session = await signIn('accounts@sampoorna.example.invalid', COMPANY_A);
  const created = await request('POST', '/api/customers', {
    legalName: 'Actor Check Traders', registration: 'unregistered',
    line1: '3, Market Road', city: 'Bengaluru', pincode: '560002', stateCode: '29',
  }, session);
  assert.equal(created.status, 200, created.body.message);
  const id = String(created.body.customer.id);
  const versions = [
    ...masterData().history(mastersContext(COMPANY_A), 'party', id),
    ...masterData().addressesOfParty(COMPANY_A, id).flatMap((address) => masterData().history(mastersContext(COMPANY_A), 'party_address', address.id)),
  ];
  assert.ok(versions.length >= 2, 'the customer and its address were both written');
  for (const version of versions) assert.equal(version.recordedBy, SAMPOORNA_ACCOUNTANT_ID);
});

test('outside a signed-in request the system identity can make no approval, so a merge is refused', () => {
  const context = mastersContext(COMPANY_A);
  assert.equal(context.permissions.has('approval.decide'), false);
  assert.equal(context.permissions.has('access.review'), false);
  const service = masterData();
  const a = service.createParty(context, { legalName: 'Merge Left 391', role: 'customer', gstRegistrationType: 'unregistered' }, { idempotencyKey: 'merge-391-a', acknowledgeSimilar: true });
  const b = service.createParty(context, { legalName: 'Merge Right 391', role: 'customer', gstRegistrationType: 'unregistered' }, { idempotencyKey: 'merge-391-b', acknowledgeSimilar: true });
  assert.throws(() => service.mergeParties(context, a.record.id, b.record.id, { idempotencyKey: 'merge-391' }), { code: 'FORBIDDEN' });
});

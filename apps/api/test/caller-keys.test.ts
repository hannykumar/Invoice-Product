/**
 * Issue #392 — a bill, a return or an ITC answer is recorded under the key the screen made for it.
 * The server never invents one, never uses the typed reference as one, and a key that comes back
 * with a different request is refused (409) rather than answered with the earlier record.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { useFixedAppClock } from '../src/app-clock.ts';
import { sells, stockEverything } from './stock-helper.ts';
import { signIn } from './sign-in-helper.ts';

useFixedAppClock('2026-08-29T10:00:00.000Z');

const request = async (method: string, path: string, body: Record<string, unknown>, session: string) => {
  if (sells(method, path)) await stockEverything(`Bearer ${session}`);
  const response = await handleApi(method, path, body, `Bearer ${session}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

const sale = { party: 'ABC Traders', item: 'Herbal Bath Soap 100g', quantity: '2', rate: '100', date: '2026-08-29', terms: '7', reference: 'ORDER-392', approvalReason: 'Agreed with the owner' };

test('a bill with no key from the screen is refused, and nothing is started', async () => {
  const owner = await signIn();
  for (const path of ['/api/sales/preview', '/api/sales/record']) {
    const refused = await request('POST', path, sale, owner);
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'SALE_REQUEST_ID_REQUIRED');
  }
});

test('the same key with the same bill issues one bill; with a different bill it is refused', async () => {
  const owner = await signIn();
  const first = await request('POST', '/api/sales/record', { ...sale, requestId: 'key-392-a' }, owner);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const retried = await request('POST', '/api/sales/record', { ...sale, requestId: 'key-392-a' }, owner);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.invoice.id, first.body.invoice.id);
  const different = await request('POST', '/api/sales/record', { ...sale, quantity: '5', requestId: 'key-392-a' }, owner);
  assert.equal(different.status, 409, JSON.stringify(different.body));
  assert.equal(different.body.code, 'SALES_KEY_REUSED');
});

test('two real sales with the same typed order number are two bills', async () => {
  const owner = await signIn();
  const one = await request('POST', '/api/sales/record', { ...sale, reference: 'SAME-ORDER-392', requestId: 'key-392-b' }, owner);
  const two = await request('POST', '/api/sales/record', { ...sale, reference: 'SAME-ORDER-392', quantity: '3', requestId: 'key-392-c' }, owner);
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.equal(two.status, 200, JSON.stringify(two.body));
  assert.notEqual(two.body.invoice.id, one.body.invoice.id);
});

test('a return with no key is refused; the same key with a different return is refused', async () => {
  const owner = await signIn();
  const sold = await request('POST', '/api/sales/record', { ...sale, quantity: '5', requestId: 'key-392-return-sale' }, owner);
  assert.equal(sold.status, 200, JSON.stringify(sold.body));
  const back = { kind: 'SALES_RETURN', documentId: sold.body.invoice.id, lineId: 'line-1', unit: 'PCS', quantity: '1', disposition: 'ACCEPTED', reason: 'Wrong soap', date: '2026-08-29', reference: 'CN-392' };
  for (const path of ['/api/returns/preview', '/api/returns/record']) {
    const refused = await request('POST', path, back, owner);
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'RETURN_REQUEST_ID_REQUIRED');
  }
  const first = await request('POST', '/api/returns/record', { ...back, requestId: 'key-392-return' }, owner);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const retried = await request('POST', '/api/returns/record', { ...back, requestId: 'key-392-return' }, owner);
  assert.equal(retried.body.deduplicated, true);
  assert.equal(retried.body.note.id, first.body.note.id);
  const different = await request('POST', '/api/returns/record', { ...back, quantity: '2', requestId: 'key-392-return' }, owner);
  assert.equal(different.status, 409, JSON.stringify(different.body));
  assert.equal(different.body.code, 'RETURN_KEY_REUSED');
});

test('an ITC answer with no key is refused rather than given one from the clock', async () => {
  const owner = await signIn();
  const refused = await request('POST', '/api/itc/decide', { period: '2026-07', lineKey: 'any-line', decision: 'PENDING', reason: 'Asked them.' }, owner);
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'ITC_REQUEST_ID_REQUIRED');
});

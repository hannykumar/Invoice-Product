/**
 * Issue #235 — a customer's credit limit is the one the business set, and none when it set none; and
 * the "over by" figure is worked out on the whole bill, GST and freight included.
 *
 * The worked numbers, through the same endpoints the screen calls:
 *
 *   one Mehta bill   450 × ₹90 = ₹40,500, + ₹2,000 freight = ₹42,500, + 18% IGST ₹7,650 = ₹50,150
 *   first bill       owes ₹0; ₹0 + ₹50,150 = ₹50,150; limit ₹5,000; ₹50,150 − ₹5,000 = ₹45,150 over
 *   after a return   ₹50,150 + ₹50,150 − ₹47,790 (450 kg back: ₹40,500 + ₹7,290 IGST) = ₹52,510 owed
 *   next bill        600 × ₹90 = ₹54,000, + 18% IGST ₹9,720 = ₹63,720
 *                    ₹52,510 + ₹63,720 = ₹1,16,230; ₹1,16,230 − ₹5,000 = ₹1,11,230 over
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { appToday, useFixedAppClock } from '../src/app-clock.ts';

useFixedAppClock('2026-09-28T10:00:00.000Z');

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';
const SHREE_RAM = 'sampoorna:party:supplier';
const DATE = appToday();

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

const signIn = async (): Promise<string> => {
  const response = await request('POST', '/api/auth/login', { companyId: SAMPOORNA, email: 'owner@sampoorna.example.invalid', password: 'karobar-demo' });
  assert.equal(response.status, 200);
  return response.body.sessionId as string;
};

/** 3,000 kg of steel bought, so every sale here has the goods. */
const shop = (() => {
  let done: Promise<string> | null = null;
  return () => done ??= (async () => {
    const owner = await signIn();
    const bought = await request('POST', '/api/purchases/record', {
      supplierId: SHREE_RAM, reference: 'SRS-235', date: DATE,
      lines: [{ item: 'TMT Steel Bar 12mm', quantity: '3000', rate: '64', gst: '1800' }],
    }, owner);
    assert.equal(bought.status, 200, JSON.stringify(bought.body));
    return owner;
  })();
})();

const addCustomer = async (owner: string, legalName: string, gstin: string, creditLimit?: string) => {
  const added = await request('POST', '/api/customers', {
    legalName, registration: 'regular', gstin, line1: 'Plot 22, MIDC Bhosari', city: 'Pune', pincode: '411026',
    ...(creditLimit === undefined ? {} : { creditLimit }),
  }, owner);
  assert.equal(added.status, 200, JSON.stringify(added.body));
  return added.body.customer as { id: string; creditLimit: number | null };
};

const setLimit = async (owner: string, customerId: string, creditLimit: string) => {
  const found = await request('POST', '/api/customer-address', { customerId }, owner);
  assert.equal(found.status, 200, JSON.stringify(found.body));
  const corrected = await request('POST', '/api/customer-address/correct', {
    customerId, line1: found.body.address.lines[0], city: found.body.address.city, pincode: found.body.address.pincode, creditLimit,
  }, owner);
  assert.equal(corrected.status, 200, JSON.stringify(corrected.body));
  return corrected.body;
};

const sale = (customerId: string, requestId: string, quantity = '450', freight = '2000') => ({
  customerId, item: 'TMT Steel Bar 12mm', quantity, rate: '90', freight, date: DATE, terms: '30', requestId,
});

const review = async (owner: string, input: Record<string, unknown>) => {
  const reviewed = await request('POST', '/api/sales/preview', input, owner);
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  return reviewed.body;
};

const issue = async (owner: string, input: Record<string, unknown>) => {
  const sold = await request('POST', '/api/sales/record', input, owner);
  assert.equal(sold.status, 200, JSON.stringify(sold.body));
  return sold.body.invoice as { id: string; number: string; amount: number };
};

const creditLines = (reviewed: Record<string, any>): string[] =>
  (reviewed.effects as string[]).filter((line) => /limit|owes/.test(line));

test('#235: a customer nobody gave a limit is not warned about one', async () => {
  const owner = await shop();
  const customer = await addCustomer(owner, 'Deshmukh Builders', '27AAACD4321K1ZU');
  assert.equal(customer.creditLimit, null, 'no limit is made up');

  const reviewed = await review(owner, sale(customer.id, 'credit-235-nolimit'));
  assert.equal(reviewed.amount, 50150);
  assert.equal(reviewed.terms.credit.outcome, 'ALLOW');
  assert.equal(reviewed.terms.credit.limit, null);
  assert.deepEqual(creditLines(reviewed), [], 'no credit sentence on the review');
});

test('#235: a ₹5,000 limit and a ₹50,150 bill are over by ₹45,150 — GST and freight counted — and repeated reviews add nothing', async () => {
  const owner = await shop();
  const customer = await addCustomer(owner, 'Mehta Construction Supplies', '27AAACM1234K1ZN');
  const corrected = await setLimit(owner, customer.id, '5000');
  assert.match(corrected.message, /credit limit is ₹5,000\.00/);

  // Review pressed three times, each a new review of the same sale.
  for (const key of ['a', 'b', 'c']) {
    const reviewed = await review(owner, sale(customer.id, `credit-235-${key}`));
    assert.equal(reviewed.amount, 50150);
    assert.equal(reviewed.terms.credit.outcome, 'WARN', 'a warning, never a block');
    assert.equal(reviewed.terms.credit.limit, 5000);
    assert.equal(reviewed.terms.credit.outstanding, 0);
    assert.equal(reviewed.terms.credit.pending, 0, 'earlier reviews are not money owed');
    assert.equal(reviewed.terms.credit.exposure, 50150);
    assert.equal(reviewed.terms.credit.excess, 45150);
    assert.deepEqual(creditLines(reviewed), [
      'Mehta Construction Supplies owes ₹0.00. This bill is ₹50,150.00. Together ₹0.00 + ₹50,150.00 = ₹50,150.00. That is ₹50,150.00 − ₹5,000.00 = ₹45,150.00 over their ₹5,000.00 limit.',
    ]);
    assert.equal(reviewed.title, 'Sale checked');
  }

  // The last review is issued, over the limit: the warning does not stop the bill.
  const first = await issue(owner, sale(customer.id, 'credit-235-c'));
  assert.equal(first.amount, 50150);

  // The next review sees the one issued bill owed, and nothing pending from the three reviews.
  const next = await review(owner, sale(customer.id, 'credit-235-d'));
  assert.equal(next.terms.credit.outstanding, 50150);
  assert.equal(next.terms.credit.pending, 0);
  assert.equal(next.terms.credit.exposure, 100300);
  assert.equal(next.terms.credit.excess, 95300);

  // A cancelled bill is not owed.
  const cancelled = await request('POST', '/api/sales/cancel', { invoice: first.id, reason: 'made in error' }, owner);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  const afterCancel = await review(owner, sale(customer.id, 'credit-235-e'));
  assert.equal(afterCancel.terms.credit.outstanding, 0);
  assert.equal(afterCancel.terms.credit.excess, 45150);

  // Removing the limit removes the warning.
  const removed = await setLimit(owner, customer.id, '');
  assert.match(removed.message, /has no credit limit/);
  const unlimited = await review(owner, sale(customer.id, 'credit-235-f'));
  assert.equal(unlimited.terms.credit.limit, null);
  assert.deepEqual(creditLines(unlimited), []);
});

test('#235: owing ₹52,510 after a credit note, a ₹63,720 bill is over a ₹5,000 limit by ₹1,11,230', async () => {
  const owner = await shop();
  const customer = await addCustomer(owner, 'Kulkarni Steel Traders', '27AAACK5678K1Z1', '5000');
  assert.equal(customer.creditLimit, 5000, 'the limit typed on the new-customer form is kept');

  const first = await issue(owner, sale(customer.id, 'credit-235-k1'));
  await issue(owner, sale(customer.id, 'credit-235-k2'));
  const documents = await request('GET', '/api/returns/documents', {}, owner);
  const line = documents.body.documents.find((document: any) => document.id === first.id).lines[0];
  const returned = await request('POST', '/api/returns/record', {
    kind: 'SALES_RETURN', documentId: first.id, lineId: line.id, quantity: '450', unit: 'KGS',
    disposition: 'ACCEPTED', date: DATE, reference: 'credit-235-return', reason: 'Wrong grade delivered.',
  }, owner);
  assert.equal(returned.status, 200, JSON.stringify(returned.body));
  assert.equal(returned.body.note.amount, 47790);

  const reviewed = await review(owner, sale(customer.id, 'credit-235-k3', '600', ''));
  assert.equal(reviewed.amount, 63720);
  assert.equal(reviewed.terms.credit.outstanding, 52510);
  assert.equal(reviewed.terms.credit.exposure, 116230);
  assert.equal(reviewed.terms.credit.excess, 111230);
  assert.deepEqual(creditLines(reviewed), [
    'Kulkarni Steel Traders owes ₹52,510.00. This bill is ₹63,720.00. Together ₹52,510.00 + ₹63,720.00 = ₹1,16,230.00. That is ₹1,16,230.00 − ₹5,000.00 = ₹1,11,230.00 over their ₹5,000.00 limit.',
  ]);
});

test('#235: a credit limit that is not a number of rupees is refused, and nothing is saved', async () => {
  const owner = await shop();
  const refused = await request('POST', '/api/customers', {
    legalName: 'Patil Hardware', registration: 'regular', gstin: '27AAACP9876K1ZO', line1: 'Shop 4, Market Yard', city: 'Pune', pincode: '411037', creditLimit: 'five thousand',
  }, owner);
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'CUSTOMER_CREDIT_LIMIT');
  const catalogue = (await request('GET', '/api/catalogue', {}, owner)).body;
  assert.equal(catalogue.customers.some((c: { name: string }) => c.name === 'Patil Hardware'), false);
});

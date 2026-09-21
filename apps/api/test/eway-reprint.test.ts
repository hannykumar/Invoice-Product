/**
 * A defect found in the #191 work after it was merged.
 *
 * The driver's page was rebuilt from the dispatch form on every printing. The form is on the screen
 * only while somebody is standing at it, so a reprint — and every PDF, which is fetched by the
 * document's id alone and never carries a form — lost the ship-to address and the transaction type.
 * The page on the screen and the page that came out of the printer described two different journeys,
 * and the printed one disagreed with the government's record for that e-way bill number. That is the
 * discrepancy a lorry is stopped over.
 *
 * Reverting the fix makes this fail: the reprint goes back to naming the buyer's own address as the
 * delivery address and calling a Bill To - Ship To consignment "Regular".
 *
 * Every name, GST number and address below is synthetic and belongs to nobody.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';

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

const ensure = async (session: string, path: string, body: Record<string, unknown>, listKey: string, nameKey: string, name: string): Promise<string> => {
  const existing = (await request('GET', '/api/catalogue', {}, session)).body[listKey]
    .find((row: Record<string, string>) => row.name === name);
  if (existing !== undefined) return existing.id as string;
  const created = await request('POST', path, body, session);
  assert.equal(created.status, 200, created.body.message);
  return created.body[nameKey].id as string;
};

/** A Delhi buyer whose goods are delivered to somebody else in Hyderabad. */
const DELHI = {
  legalName: 'Bawana Polymers', registration: 'regular', gstin: '07EEEEE4444E1ZG',
  line1: 'Plot 7, Bawana Industrial Area', city: 'New Delhi', pincode: '110039',
};
const GRANULES = {
  name: 'LDPE Granules', kind: 'goods', hsnSac: '39011000', unit: 'KGS',
  taxKind: 'taxable', ratePercentTimes100: '1800', basis: 'The rate our accountant uses for granules',
};

/** Pulls one labelled fact out of the printed page. */
const fact = (html: string, label: string): string => {
  const found = new RegExp(`<th scope="row">${label}</th><td>(.*?)</td>`, 's').exec(html);
  assert.ok(found !== null, `the page carries a "${label}" row`);
  return found[1] as string;
};

const shipTo = (html: string): string => {
  const found = /<h4>Ship To<\/h4>\s*<p class="eway-party">(.*?)<\/p>/s.exec(html);
  assert.ok(found !== null, 'the page carries a Ship To block');
  return found[1] as string;
};

test('an e-way bill printed again says exactly what it said the first time', async () => {
  const session = await signIn();
  const customerId = await ensure(session, '/api/customers', DELHI, 'customers', 'customer', DELHI.legalName);
  const itemId = await ensure(session, '/api/items', GRANULES, 'items', 'item', GRANULES.name);

  const recorded = await request('POST', '/api/sales/record', {
    customerId, lines: [{ itemId, quantity: '1400', rate: '60' }],
    date: '2026-09-17', terms: '30', reference: 'eway-191-reprint',
  }, session);
  assert.equal(recorded.status, 200, recorded.body.message);
  const invoice = recorded.body.invoice.id as string;

  // Billed to Delhi, delivered to Hyderabad: the two part company, which is the whole point.
  const dispatch = {
    invoice, distanceKm: '1800', vehicle: 'KA01AB1234', reason: 'SUPPLY',
    shipToState: '36', shipToPlace: 'Hyderabad',
  };
  const raised = await request('POST', '/api/eway/generate', dispatch, session);
  assert.equal(raised.status, 200, JSON.stringify(raised.body));
  assert.match(String(raised.body.ewayBillNumber), /^[0-9]{12}$/);

  // Printed while the dispatch form is still on the screen.
  const first = await request('POST', '/api/eway/print', dispatch, session);
  assert.equal(first.status, 200, first.body.message);
  const atTheDesk = String(first.body.html);
  assert.equal(fact(atTheDesk, 'Transaction Type'), 'Bill To - Ship To');
  assert.match(shipTo(atTheDesk), /Hyderabad/);

  // Printed later, by the e-way bill alone — which is all the PDF route ever sends.
  const again = await request('POST', '/api/eway/print', { invoice }, session);
  assert.equal(again.status, 200, again.body.message);
  const later = String(again.body.html);

  assert.equal(fact(later, 'Transaction Type'), 'Bill To - Ship To', 'the journey does not change on a reprint');
  assert.match(shipTo(later), /Hyderabad/, 'and neither does where the goods are going');
  assert.ok(!shipTo(later).includes('New Delhi'), 'the buyer’s own address never replaces the delivery address');
  assert.equal(fact(later, 'Approx Distance'), fact(atTheDesk, 'Approx Distance'));
  assert.equal(fact(later, 'E-Way Bill No.'), fact(atTheDesk, 'E-Way Bill No.'));
});

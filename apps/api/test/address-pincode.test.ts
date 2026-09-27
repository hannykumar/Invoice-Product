/**
 * Issue #224 — no address with a PIN code from another state reaches a bill, whichever screen it
 * comes in by, and a customer's address can be corrected from the Sale screen.
 *
 * Every name, GST number and address below is synthetic and belongs to nobody.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { requireAddressInState } from '../src/delivery-application.ts';

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

const GRANULES = {
  name: 'LDPE Granules', kind: 'goods', hsnSac: '39011000', unit: 'KGS',
  taxKind: 'taxable', ratePercentTimes100: '1800', basis: 'The rate our accountant uses for granules',
};

test('a new customer whose PIN code is in another state is refused', async () => {
  const session = await signIn();
  const refused = await request('POST', '/api/customers', {
    legalName: 'Uppal Castings', registration: 'unregistered', stateCode: '36',
    line1: 'Plot 12, IDA Uppal', city: 'Hyderabad', pincode: '110039',
  }, session);
  assert.equal(refused.status, 422);
  assert.match(String(refused.body.message), /110039 is not in Telangana/);
});

test('the business’s own address with a PIN code from another state is refused', async () => {
  const session = await signIn();
  const refused = await request('POST', '/api/business-details', {
    legalName: 'Sampoorna Traders', address1: 'No. 14, 2nd Main, Peenya Industrial Area', city: 'Bengaluru', pincode: '110039',
  }, session);
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.match(String(refused.body.message), /110039 is not in Karnataka/);
});

test('an address already saved wrong is refused on a bill, and says where to correct it', () => {
  assert.throws(
    () => requireAddressInState({ stateCode: '36', pincode: '110039' }, 'Uppal Castings’s'),
    /Uppal Castings’s address is saved with PIN code 110039, which is not in Telangana\. Correct the address first — press "Correct address"/,
  );
  assert.doesNotThrow(() => requireAddressInState({ stateCode: '36', pincode: '500039' }, 'Uppal Castings’s'));
  assert.doesNotThrow(() => requireAddressInState({ stateCode: '96', pincode: '999999' }, 'An overseas buyer’s'));
});

test('a customer’s address is corrected from the Sale screen, and the next bill carries the new one', async () => {
  const session = await signIn();
  const catalogue = (await request('GET', '/api/catalogue', {}, session)).body;
  let customerId = catalogue.customers.find((row: Record<string, string>) => row.name === 'Kukatpally Moulders')?.id as string | undefined;
  if (customerId === undefined) {
    const created = await request('POST', '/api/customers', {
      legalName: 'Kukatpally Moulders', registration: 'unregistered', stateCode: '36',
      line1: 'Plot 9, IDA Kukatpally', city: 'Hyderabad', pincode: '500072',
    }, session);
    assert.equal(created.status, 200, created.body.message);
    customerId = created.body.customer.id as string;
  }
  let itemId = catalogue.items.find((row: Record<string, string>) => row.name === GRANULES.name)?.id as string | undefined;
  if (itemId === undefined) itemId = (await request('POST', '/api/items', GRANULES, session)).body.item.id as string;

  const shown = await request('POST', '/api/customer-address', { customerId }, session);
  assert.equal(shown.status, 200, shown.body.message);
  assert.equal(shown.body.address.pincode, '500072');

  const wrong = await request('POST', '/api/customer-address/correct', { customerId, pincode: '110039' }, session);
  assert.equal(wrong.status, 422);
  assert.match(String(wrong.body.message), /110039 is not in Telangana/);

  const corrected = await request('POST', '/api/customer-address/correct', { customerId, line1: 'Plot 19, IDA Kukatpally', pincode: '500037' }, session);
  assert.equal(corrected.status, 200, corrected.body.message);
  assert.match(String(corrected.body.message), /Plot 19, IDA Kukatpally, Hyderabad 500037/);

  const sale = await request('POST', '/api/sales/record', {
    customerId, lines: [{ itemId, quantity: '10', rate: '100' }], date: '2026-09-17', terms: '30', reference: 'pin-224-corrected',
  }, session);
  assert.equal(sale.status, 200, sale.body.message);
  const printed = await request('POST', '/api/sales/print', { invoice: sale.body.invoice.id }, session);
  const html = String(printed.body.html);
  assert.ok(html.includes('Plot 19, IDA Kukatpally'), 'the bill carries the corrected street');
  assert.ok(html.includes('500037'), 'and the corrected PIN');
  assert.ok(!html.includes('500072'), 'and not the old one');
});

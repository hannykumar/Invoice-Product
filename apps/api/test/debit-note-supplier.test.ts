/**
 * Issue #291 — the debit note sent to a supplier carries the supplier's address and GST number, and
 * the place of supply, as Rule 53(1A) asks. The printed note used to show only their name.
 *
 * Every name, GST number and figure below is synthetic and belongs to nobody.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { useFixedAppClock } from '../src/app-clock.ts';

useFixedAppClock('2026-09-28T10:00:00.000Z');

const COMPANY_A = '00000000-0000-4000-8000-000000000001';
const SHREE_RAM = 'sampoorna:party:supplier';

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

const text = (html: string): string => html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

test('a debit note to a supplier prints their address, GST number and the place of supply', async () => {
  const owner = (await request('POST', '/api/auth/login', { companyId: COMPANY_A, email: 'owner@sampoorna.example.invalid', password: 'karobar-demo' })).body.sessionId as string;
  const bought = await request('POST', '/api/purchases/record', {
    supplierId: SHREE_RAM, reference: 'SRS-201', date: '2026-09-27',
    lines: [{ item: 'TMT Steel Bar 12mm', quantity: '500', rate: '64', gst: '1800' }],
  }, owner);
  assert.equal(bought.status, 200, JSON.stringify(bought.body));

  const documents = (await request('GET', '/api/returns/documents', {}, owner)).body.documents;
  const bill = documents.find((d: any) => String(d.label ?? d.number ?? '').includes('SRS-201'));
  assert.ok(bill !== undefined, JSON.stringify(documents.map((d: any) => d.label ?? d.number)));
  const returned = await request('POST', '/api/returns/record', {
    kind: 'PURCHASE_RETURN', documentId: bill.id, lineId: bill.lines[0].id, quantity: '100', unit: 'KGS',
    disposition: 'ACCEPTED', date: '2026-09-28', reference: 'dn-291', reason: 'Rusted',
  }, owner);
  assert.equal(returned.status, 200, JSON.stringify(returned.body));
  assert.match(returned.body.note.number, /^DN\//);

  const printed = await request('POST', '/api/returns/print', { note: returned.body.note.id }, owner);
  assert.equal(printed.status, 200, JSON.stringify(printed.body));
  const visible = text(String(printed.body.html));
  const supplier = (await request('GET', '/api/catalogue', {}, owner)).body.suppliers.find((s: any) => s.id === SHREE_RAM);
  assert.ok(supplier?.gstin, 'the demo supplier has a GST number on record');
  assert.ok(visible.includes(supplier.gstin), `the supplier's GSTIN prints: ${visible.slice(0, 600)}`);
  for (const line of supplier.addressLines as string[]) assert.ok(visible.includes(line.split(',')[0]!.trim()), `the address line "${line}" prints`);
  assert.match(visible, /Place of Supply Karnataka \(29\)/i, 'goods delivered to us in Karnataka');
  assert.match(visible, /Total Debited ₹7,552\.00/);
});

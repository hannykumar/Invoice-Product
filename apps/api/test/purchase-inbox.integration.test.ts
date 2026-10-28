/**
 * Issue #489 — on PostgreSQL, a supplier bill uploaded to the inbox is still there after the server
 * restarts, can be corrected and recorded, shows as recorded after another restart, lands in the
 * purchases, and is invisible to another company. The real server process, as a login that is only a
 * member of `invoice_app` (row-level security applies). Synthetic names and GST numbers only.
 *
 * Needs DATABASE_URL (the owner, for migrations). Skipped locally without it; fails in CI.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { after, before } from 'node:test';
import type { ChildProcess } from 'node:child_process';
import { signInOverHttp } from './sign-in-helper.ts';
import { appDatabase, callApi, freePort, killProcess, startApi } from './processes.ts';
import { sampleBillLines, sampleBillPdf } from '../src/inbox-ocr.ts';

const url = process.env.DATABASE_URL;
if (url === undefined && process.env.CI !== undefined) throw new Error('DATABASE_URL must be set in CI so the inbox test runs.');
const skip = url === undefined && 'DATABASE_URL is not set';

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';
const KONKAN = '00000000-0000-4000-8000-000000000011';
let database: Awaited<ReturnType<typeof appDatabase>> | undefined;
let port: number;
let server: ChildProcess | undefined;
let call: ReturnType<typeof callApi>;

const start = async (): Promise<void> => { server = await startApi(database!.appUrl, port); };
const stop = async (): Promise<void> => { await killProcess(server); server = undefined; };
const signInHere = async (address: string, companyId: string): Promise<string> =>
  (await signInOverHttp(`http://127.0.0.1:${port}`, address, companyId)).split('=')[1]!;

before(async () => {
  if (url === undefined) return;
  database = await appDatabase(url);
  port = await freePort();
  call = callApi(port);
});
after(async () => { await stop(); await database?.close(); });

test('a bill added to the inbox survives a restart, is recorded once, and no other company sees it', { skip }, async () => {
  const run = randomBytes(3).toString('hex');
  const number = `PG489/${run}`;
  await start();
  const token = await signInHere('owner@sampoorna.example.invalid', SAMPOORNA);
  assert.equal((await call('POST', '/api/business-details', { legalName: 'Sampoorna Traders', address1: 'Plot 14, 2nd Phase, Peenya Industrial Area', city: 'Bengaluru', pincode: '560058', stateCode: '29' }, token)).status, 200);
  // The supplier and the item this bill is for, in this company's own lists.
  // One supplier per GST number: an earlier run's is the one the bill is suggested.
  const catalogue = await call('GET', '/api/catalogue', undefined, token);
  const known = catalogue.suppliers.find((party: Record<string, any>) => party.gstin === '27AAECS5678D1Z4');
  const supplier = known !== undefined ? { status: 200, supplier: known } : await call('POST', '/api/suppliers', { name: `Shree Ram Steels ${run}`, gstin: '27AAECS5678D1Z4', stateCode: '27', pincode: '410208', city: 'Navi Mumbai', address1: 'Plot 7, MIDC Taloja', acknowledgeSimilar: true }, token);
  assert.equal(supplier.status, 200, JSON.stringify(supplier));
  const item = await call('POST', '/api/items', { name: `TMT Steel Bar ${run}`, hsn: '72142090', unit: 'KGS', price: '64', kind: 'goods', ratePercent: '18', basis: 'Rate this business pays', effectiveFrom: '2026-04-01', acknowledgeSimilar: true }, token);
  assert.equal(item.status, 200, JSON.stringify(item));

  // A bill stored privately, then handed to the inbox.
  const bytes = Buffer.from(sampleBillPdf(sampleBillLines({
    supplierName: 'Shree Ram Steels Private Limited', supplierGstin: '27AAECS5678D1Z4', buyerGstin: '29AAAAA0000A1ZY', number, date: '21/09/2026',
    item: `TMT Steel Bar ${run}`, hsn: '72142090', quantity: '500', unit: 'KGS', rate: '64.00', taxable: '32,000.00', igst: '5,760.00', total: '37,760.00',
  }), run));
  const requested = await call('POST', '/api/files/uploads', { purpose: 'purchase_bill', fileName: 'bill.pdf', contentType: 'application/pdf', sizeBytes: bytes.length }, token);
  assert.equal(requested.status, 200, JSON.stringify(requested));
  const put = await fetch(`http://127.0.0.1:${port}${requested.upload.url}`, { method: 'PUT', headers: { ...requested.upload.headers, origin: `http://127.0.0.1:${port}` }, body: new Uint8Array(bytes) });
  assert.equal(put.status, 200);
  assert.equal((await call('POST', `/api/files/${requested.file.id}/complete`, {}, token)).status, 200);
  const added = await call('POST', '/api/purchase-inbox/upload', { fileId: requested.file.id }, token);
  assert.equal(added.status, 200, JSON.stringify(added));
  assert.equal(added.document.state, 'ready');
  const id = String(added.document.id);
  // The same file, again: one document.
  assert.equal((await call('POST', '/api/purchase-inbox/upload', { fileId: requested.file.id }, token)).document.id, id);

  await stop();
  await start();

  // After the restart the bill is still there, with its evidence, and was suggested the supplier by its GST number.
  const shown = await call('GET', `/api/purchase-inbox/${id}`, undefined, token);
  assert.equal(shown.status, 200, JSON.stringify(shown));
  assert.equal(shown.draft.fields.find((field: Record<string, any>) => field.key === 'invoiceNumber').evidence.text, `Invoice No: ${number}`);
  assert.equal(shown.draft.form.supplierId, supplier.supplier.id);

  // Corrected (the bill number as the paper bill has it), checked, recorded.
  const typed = { supplierId: supplier.supplier.id, reference: `${number}-C`, date: '2026-09-21', lines: [{ itemId: item.item.id, quantity: '500', rate: '64', gst: '1800' }] };
  const previewed = await call('POST', `/api/purchase-inbox/${id}/preview`, typed, token);
  assert.equal(previewed.status, 200, JSON.stringify(previewed));
  const recorded = await call('POST', `/api/purchase-inbox/${id}/record`, typed, token);
  assert.equal(recorded.status, 200, JSON.stringify(recorded));
  assert.deepEqual(recorded.corrections, [`Bill number: read as ${number}, recorded as ${number}-C.`]);
  assert.equal((await call('POST', `/api/purchase-inbox/${id}/record`, typed, token)).status, 409, 'a second Record is refused, not a second bill');

  await stop();
  await start();

  // Recorded, and a bill in the purchases, the stock and the books, after another restart.
  const listed = await call('GET', '/api/purchase-inbox', undefined, token);
  const row = listed.items.find((entry: Record<string, any>) => entry.id === id);
  assert.equal(row.state, 'billed');
  assert.equal(row.decision.billNumber, `${number}-C`);
  assert.equal((await call('GET', `/api/purchases/${recorded.bill.id}`, undefined, token)).status, 200);
  const reports = await call('GET', '/api/reports', undefined, token);
  assert.equal(reports.trialBalance.balanced, true);
  const owner = database!.owner;
  const rows = (await owner.query(`SELECT count(*) AS n FROM purchase_bills WHERE company_id = $1 AND invoice_number = $2`, [SAMPOORNA, `${number}-C`])).rows;
  assert.equal(String(rows[0]!.n), '1');

  // The database refuses to change or delete a decision, and another company cannot read the document or the note.
  await assert.rejects(owner.query(`UPDATE purchase_inbox_decisions SET kind = 'rejected', reason = 'x' WHERE document_id = $1`, [id]));
  await assert.rejects(owner.query(`DELETE FROM purchase_inbox_decisions WHERE document_id = $1`, [id]));
  const konkan = await signInHere('owner@konkan.example.invalid', KONKAN);
  assert.equal((await call('GET', `/api/purchase-inbox/${id}`, undefined, konkan)).status, 404);
  assert.equal((await call('POST', `/api/purchase-inbox/${id}/reject`, { reason: 'mine now' }, konkan)).status, 404);
  const theirs = await call('GET', '/api/purchase-inbox', undefined, konkan);
  assert.equal(theirs.items.some((entry: Record<string, any>) => entry.id === id), false);
});

test('setting a bill aside on PostgreSQL is kept, with its reason, across a restart', { skip }, async () => {
  const run = randomBytes(3).toString('hex');
  await stop();
  await start();
  const token = await signInHere('owner@sampoorna.example.invalid', SAMPOORNA);
  const file = JSON.stringify({
    DocDtls: { Typ: 'INV', No: `PG489/${run}`, Dt: '22/09/2026' }, SellerDtls: { Gstin: '27AAECS5678D1Z4', LglNm: 'Shree Ram Steels Private Limited' }, BuyerDtls: { Gstin: '29AAAAA0000A1ZY', LglNm: 'Sampoorna Traders' },
    ItemList: [{ SlNo: '1', PrdDesc: 'Bar', HsnCd: '72142090', Qty: 1, Unit: 'KGS', UnitPrice: 64, AssAmt: 64, GstRt: 18 }], ValDtls: { AssVal: 64, IgstVal: 11.52, TotInvVal: 75.52 },
  });
  const added = await call('POST', '/api/purchase-inbox/upload', { einvoiceJson: file, fileName: 'einvoice.json' }, token);
  assert.equal(added.status, 200, JSON.stringify(added));
  assert.equal(added.document.state, 'ready');
  const id = String(added.document.id);
  assert.equal((await call('POST', `/api/purchase-inbox/${id}/reject`, { reason: 'Wrong order' }, token)).status, 200);
  await stop();
  await start();
  const row = (await call('GET', '/api/purchase-inbox', undefined, token)).items.find((entry: Record<string, any>) => entry.id === id);
  assert.equal(row.state, 'rejected');
  assert.equal(row.decision.reason, 'Wrong order');
});

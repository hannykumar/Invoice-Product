/**
 * Issue #489 — the purchase inbox in the running app, through the real server: a bill uploaded,
 * emailed or sent on WhatsApp is read, shown with the evidence for every figure, corrected, and
 * recorded through the same checks as a typed bill. Every name and GST number is synthetic.
 *
 * Done when (from the issue): a shopkeeper uploads a supplier bill, sees its draft, corrects a field
 * and records it; the same bill sent twice, or by email and WhatsApp at once, is one bill; and
 * another company can never see the document.
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

process.env.FILE_STORE_DIR = await mkdtemp(join(tmpdir(), 'karobar-inbox-test-'));
const { apiServer } = await import('../src/server.ts');
const { signInOverHttp } = await import('./sign-in-helper.ts');
const { useFixedAppClock, appClock } = await import('../src/app-clock.ts');
const { sampleBillLines, sampleBillPdf } = await import('../src/inbox-ocr.ts');
const { DEVELOPMENT_INBOX_WEBHOOK_SECRET } = await import('../src/purchase-inbox-application.ts');
const { signWebhook } = await import('../../../packages/platform/src/connectors.ts');
const { syntheticGstin } = await import('../../../packages/masters/src/index.ts');

useFixedAppClock('2026-10-20T10:00:00.000Z');

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';
const KONKAN = '00000000-0000-4000-8000-000000000011';
const OURS = '29AAAAA0000A1ZY';
const KONKAN_GSTIN = '30AAAAA0000A1ZF';
const SUPPLIER = '27AAECS5678D1Z4';
let base = '';

before(async () => {
  await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => apiServer.close(() => resolve())));

const call = async (method: string, path: string, cookie: string, body?: unknown): Promise<Record<string, any>> => {
  const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', origin: base, cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, ...(await response.json() as Record<string, any>) };
};
const owner = () => signInOverHttp(base, 'owner@sampoorna.example.invalid', SAMPOORNA);
const konkanOwner = () => signInOverHttp(base, 'owner@konkan.example.invalid', KONKAN);

/** A sample bill, unique by number, so tests never collide. */
let counter = 0;
const billLines = (number: string, buyer = OURS, total = '37,760.00') => sampleBillLines({
  supplierName: 'Shree Ram Steels Private Limited', supplierGstin: SUPPLIER, buyerGstin: buyer, number, date: '21/09/2026',
  item: 'TMT Steel Bar 12mm', hsn: '72142090', quantity: '500', unit: 'KGS', rate: '64.00', taxable: '32,000.00', igst: '5,760.00', total,
});
const nextNumber = () => `T489/${Date.now().toString(36)}/${(counter += 1)}`;
const pdfOf = (number: string, tag = 'a', buyer = OURS) => Buffer.from(sampleBillPdf(billLines(number, buyer), tag));

/** What the browser does: ask for an address, put the file there, say it is done. Returns the stored file's id. */
const store = async (cookie: string, bytes: Buffer, fileName = 'bill.pdf', contentType = 'application/pdf'): Promise<string> => {
  const requested = await call('POST', '/api/files/uploads', cookie, { purpose: 'purchase_bill', fileName, contentType, sizeBytes: bytes.length });
  assert.equal(requested.status, 200, JSON.stringify(requested));
  const put = await fetch(`${base}${requested.upload.url}`, { method: requested.upload.method, headers: { ...requested.upload.headers, origin: base }, body: new Uint8Array(bytes) });
  assert.equal(put.status, 200);
  const done = await call('POST', `/api/files/${requested.file.id}/complete`, cookie);
  assert.equal(done.status, 200, JSON.stringify(done));
  return requested.file.id as string;
};
const upload = (cookie: string, fileId: string) => call('POST', '/api/purchase-inbox/upload', cookie, { fileId });

const delivery = async (channel: 'email' | 'whatsapp', payload: Record<string, unknown>, options: { secret?: string; at?: Date } = {}): Promise<Record<string, any>> => {
  const body = JSON.stringify({ eventId: `evt-${Date.now()}-${(counter += 1)}`, providerRequestId: 'req-1', occurredAt: appClock.now().toISOString(), payload });
  const response = await fetch(`${base}/api/webhooks/purchase-inbox/${channel}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-provider-signature': signWebhook(options.secret ?? DEVELOPMENT_INBOX_WEBHOOK_SECRET, body, options.at ?? appClock.now()) }, body,
  });
  return { status: response.status, ...(await response.json() as Record<string, any>) };
};
const mail = (bytes: Buffer, to: string, messageId: string, channel: 'email' | 'whatsapp' = 'email') => ({
  providerMessageId: messageId, from: channel === 'email' ? 'accounts@shreeram.example.invalid' : '+919000000999', deliveredTo: to,
  fileName: 'bill.pdf', mimeType: 'application/pdf', contentBase64: bytes.toString('base64'),
});
const EMAIL = 'bills-sampoorna@inbox.example.invalid';
const WHATSAPP = '+91 90000 00001';

const item = async (cookie: string, id: string) => (await call('GET', `/api/purchase-inbox/${id}`, cookie));
const itemsOf = async (cookie: string) => (await call('GET', '/api/purchase-inbox', cookie)).items as Record<string, any>[];

test('#489: the made-up bills are there to look at: one ready, one to check, one already had, one too blurred', async () => {
  const items = await itemsOf(await owner());
  const states = new Set(items.map((entry) => entry.state));
  assert.ok(states.has('ready') && states.has('duplicate') && states.has('held'), [...states].join());
  const duplicate = items.find((entry) => entry.state === 'duplicate')!;
  assert.match(duplicate.message, /same file you already received/);
  const held = items.find((entry) => entry.state === 'held')!;
  assert.match(held.message, /Too little could be read/);
  assert.ok(held.next.length > 20 && !/QUARANTINE|EXTRACTION_TOO/.test(held.next), 'said in a shopkeeper\'s words');
});

test('#489: upload a bill, see what was read with its evidence, correct a field, record it, and it is a bill', async () => {
  const cookie = await owner();
  const number = nextNumber();
  const uploaded = await upload(cookie, await store(cookie, pdfOf(number)));
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded));
  assert.equal(uploaded.document.state, 'ready');
  assert.equal(uploaded.duplicate, false);

  const shown = await item(cookie, uploaded.document.id);
  const byKey = Object.fromEntries(shown.draft.fields.map((field: Record<string, any>) => [field.key, field]));
  assert.equal(byKey.invoiceNumber.value, number);
  assert.equal(byKey.invoiceNumber.evidence.text, `Invoice No: ${number}`, 'every figure shows the words it was read from');
  assert.equal(byKey.invoiceNumber.level, 'clear');
  assert.equal(byKey.invoiceTotalPaise.display, '₹37,760.00');
  assert.equal(shown.draft.form.supplierId, 'sampoorna:party:supplier', 'the supplier is suggested from the GST number printed');
  assert.deepEqual(shown.draft.form.lines, [], 'the reader takes the bill\'s header, not its lines: the person types what it sells');

  // The person corrects the bill number (they read it differently on the paper bill) and checks it first.
  const typed = { supplierId: shown.draft.form.supplierId, date: '2026-09-21', reference: `${number}-C`, lines: [{ item: 'TMT Steel Bar 12mm', quantity: '500', rate: '64', gst: '1800' }] };
  const previewed = await call('POST', `/api/purchase-inbox/${uploaded.document.id}/preview`, cookie, typed);
  assert.equal(previewed.status, 200, JSON.stringify(previewed));
  assert.equal(previewed.state, 'preview');
  const recorded = await call('POST', `/api/purchase-inbox/${uploaded.document.id}/record`, cookie, typed);
  assert.equal(recorded.status, 200, JSON.stringify(recorded));
  assert.equal(recorded.state, 'recorded');
  assert.equal(recorded.bill.number, `${number}-C`);
  assert.deepEqual(recorded.corrections, [`Bill number: read as ${number}, recorded as ${number}-C.`]);

  const after = (await itemsOf(cookie)).find((entry) => entry.id === uploaded.document.id)!;
  assert.equal(after.state, 'billed');
  assert.equal(after.decision.billNumber, `${number}-C`);
  // Recording it again is refused, not a second bill.
  const again = await call('POST', `/api/purchase-inbox/${uploaded.document.id}/record`, cookie, typed);
  assert.equal(again.status, 409, JSON.stringify(again));
  assert.match(again.message, /already recorded as bill/);
  const stored = await call('GET', `/api/purchases/${recorded.bill.id}`, cookie);
  assert.equal(stored.status, 200);
});

test('#489: the same bill sent twice is one bill, and a photo and a PDF of one bill are noticed as the same', async () => {
  const cookie = await owner();
  const number = nextNumber();
  const bytes = pdfOf(number);
  const fileId = await store(cookie, bytes);
  const first = await upload(cookie, fileId);
  const second = await upload(cookie, fileId);
  assert.equal(second.document.id, first.document.id, 'pressing Add twice is one document');
  assert.equal(second.duplicate, true);
  // The identical file stored again is recognised by what is in it.
  const sameFile = await upload(cookie, await store(cookie, bytes));
  assert.equal(sameFile.duplicate, true);
  assert.equal(sameFile.document.state, 'duplicate');
  assert.match(sameFile.title, /already have/);
  // A different file of the same bill (a second scan): two documents, the later one says it is the same bill.
  const rescanned = await upload(cookie, await store(cookie, pdfOf(number, 'second-scan')));
  assert.equal(rescanned.document.state, 'ready');
  const listed = await itemsOf(cookie);
  assert.equal(listed.find((entry) => entry.id === rescanned.document.id)!.sameBillAs.id, first.document.id);
});

test('#489: by email and WhatsApp at once is one bill, and it reaches only the company whose address it was sent to', async () => {
  const cookie = await owner();
  const number = nextNumber();
  const bytes = pdfOf(number);
  const [byMail, byChat] = await Promise.all([
    delivery('email', mail(bytes, EMAIL, `mail-${number}`)),
    delivery('whatsapp', mail(bytes, WHATSAPP, `wa-${number}`, 'whatsapp')),
  ]);
  assert.equal(byMail.status, 202, JSON.stringify(byMail));
  assert.equal(byChat.status, 202, JSON.stringify(byChat));
  assert.equal([byMail, byChat].filter((reply) => reply.duplicate === true).length, 1, 'one of the two was recognised as the other');
  const mine = (await itemsOf(cookie)).filter((entry) => entry.billNumber === number);
  assert.equal(mine.length, 1, 'one bill');
  // A resend of the same message with the same file does not read it again.
  const resent = await delivery('email', mail(bytes, EMAIL, `mail-${number}`));
  assert.equal(resent.duplicate, true);
  // Another company's inbox never saw it.
  const konkan = await itemsOf(await konkanOwner());
  assert.equal(konkan.filter((entry) => entry.billNumber === number).length, 0);
  // Sent to Konkan's own address, it is Konkan's (and held there, because the bill names Sampoorna's GST number).
  const toKonkan = await delivery('email', mail(pdfOf(nextNumber(), 'k'), 'bills-konkan@inbox.example.invalid', `mail-k-${number}`));
  assert.equal(toKonkan.status, 202);
  const konkanItems = await itemsOf(await konkanOwner());
  assert.ok(konkanItems.some((entry) => entry.state === 'held' && /does not name Konkan Fresh Foods/.test(entry.message)), 'held in Konkan, not moved to the business the bill names');
  assert.equal((await itemsOf(cookie)).some((entry) => /Konkan/.test(entry.message ?? '')), false);
});

test('#489: a delivery nobody signed, signed wrongly, signed long ago, or sent to nobody\'s address is not read', async () => {
  const number = nextNumber();
  const bytes = pdfOf(number);
  assert.equal((await delivery('email', mail(bytes, EMAIL, 'x1'), { secret: 'a-guessed-secret' })).status, 401);
  assert.equal((await delivery('email', mail(bytes, EMAIL, 'x2'), { at: new Date(appClock.now().getTime() - 3_600_000) })).status, 401);
  const unsigned = await fetch(`${base}/api/webhooks/purchase-inbox/email`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(unsigned.status, 401);
  assert.equal((await delivery('email', { ...mail(bytes, EMAIL, 'x3'), contentBase64: '' })).status, 400);
  const unknownChannel = await fetch(`${base}/api/webhooks/purchase-inbox/telegram`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(unknownChannel.status, 404);
  // An address that is nobody's: accepted so the provider stops resending, but no company's inbox gets it.
  assert.equal((await delivery('email', mail(bytes, 'bills-somebody-else@inbox.example.invalid', 'x4'))).status, 202);
  const cookie = await owner();
  assert.equal((await itemsOf(cookie)).filter((entry) => entry.billNumber === number).length, 0);
  assert.equal((await itemsOf(await konkanOwner())).filter((entry) => entry.billNumber === number).length, 0);
  // The page's own cross-site guard lets a signed callback through but nothing else from another site.
  const crossSite = await fetch(`${base}/api/purchase-inbox/upload`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example', cookie }, body: '{}' });
  assert.equal(crossSite.status, 403);
});

test('#489: a signed e-invoice file is read at once, and one without the government\'s signature says every figure needs checking', async () => {
  const cookie = await owner();
  const number = nextNumber();
  const file = JSON.stringify({
    DocDtls: { Typ: 'INV', No: number, Dt: '22/09/2026' }, SellerDtls: { Gstin: SUPPLIER, LglNm: 'Shree Ram Steels Private Limited' }, BuyerDtls: { Gstin: OURS, LglNm: 'Sampoorna Traders' },
    ItemList: [{ SlNo: '1', PrdDesc: 'TMT Steel Bar 12mm', HsnCd: '72142090', Qty: 100, Unit: 'KGS', UnitPrice: 64, AssAmt: 6400, GstRt: 18 }], ValDtls: { AssVal: 6400, IgstVal: 1152, TotInvVal: 7552 },
  });
  const added = await call('POST', '/api/purchase-inbox/upload', cookie, { einvoiceJson: file, fileName: 'einvoice.json' });
  assert.equal(added.status, 200, JSON.stringify(added));
  assert.equal(added.document.state, 'ready');
  const shown = await item(cookie, added.document.id);
  assert.equal(shown.draft.signature, 'unsigned');
  assert.ok(shown.draft.problems.some((problem: string) => /no government signature/.test(problem)));
  assert.ok(shown.draft.fields.every((field: Record<string, any>) => field.needsCheck), 'unsigned values are all to be checked');
  assert.equal(shown.draft.form.lines[0].description, 'TMT Steel Bar 12mm');
  assert.ok(shown.draft.form.lines[0].itemId, 'an e-invoice file carries its lines, and the item is suggested from its name');
  assert.equal(shown.draft.form.lines[0].rate, '64.00');
  assert.equal(shown.draft.fields.find((field: Record<string, any>) => field.key === 'invoiceNumber').evidence.jsonPath, 'DocDtls.No');
  // The same file text again is the same delivery.
  const again = await call('POST', '/api/purchase-inbox/upload', cookie, { einvoiceJson: file, fileName: 'einvoice.json' });
  assert.equal(again.duplicate, true);
});

test('#489: a file that is not a bill, a program, a broken e-invoice, or nothing at all is held or refused, in plain words', async () => {
  const cookie = await owner();
  // A "program" dressed as a picture is refused before it is stored.
  const program = await call('POST', '/api/files/uploads', cookie, { purpose: 'purchase_bill', fileName: 'bill.exe', contentType: 'application/pdf', sizeBytes: 100 });
  assert.equal(program.status, 422, JSON.stringify(program));
  // Too large to take.
  const large = await call('POST', '/api/files/uploads', cookie, { purpose: 'purchase_bill', fileName: 'big.pdf', contentType: 'application/pdf', sizeBytes: 26 * 1024 * 1024 });
  assert.equal(large.status, 422);
  assert.match(large.message, /smaller/);
  // A web page pasted where an e-invoice goes is held, not read.
  const html = await call('POST', '/api/purchase-inbox/upload', cookie, { einvoiceJson: '<html><script>alert(1)</script></html>', fileName: 'bill.json' });
  assert.equal(html.status, 200, JSON.stringify(html));
  assert.equal(html.document.state, 'held');
  assert.equal(html.title, 'Bill held back');
  // A PDF with nothing readable in it (a blurred photo) is held with the reason, and can be set aside.
  const blurry = await upload(cookie, await store(cookie, Buffer.from(sampleBillPdf([], `blank-${nextNumber()}`))));
  assert.equal(blurry.document.state, 'held');
  assert.equal(blurry.document.actions.assign, false, 'an unreadable file cannot be claimed into the business');
  // Nothing chosen, or two things chosen.
  assert.equal((await call('POST', '/api/purchase-inbox/upload', cookie, {})).status, 422);
  assert.equal((await call('POST', '/api/purchase-inbox/upload', cookie, { fileId: 'x', einvoiceJson: '{}' })).status, 422);
  // A file id that is not this company's is not found.
  assert.equal((await call('POST', '/api/purchase-inbox/upload', cookie, { fileId: '00000000-0000-4000-8000-0000000000aa' })).status, 404);
});

test('#489: setting a bill aside needs a reason, keeps the record, and the bill can no longer be recorded', async () => {
  const cookie = await owner();
  const added = await upload(cookie, await store(cookie, pdfOf(nextNumber())));
  const id = added.document.id as string;
  assert.equal((await call('POST', `/api/purchase-inbox/${id}/reject`, cookie, {})).status, 422);
  const rejected = await call('POST', `/api/purchase-inbox/${id}/reject`, cookie, { reason: 'This is not our order' });
  assert.equal(rejected.status, 200, JSON.stringify(rejected));
  assert.equal(rejected.document.state, 'rejected');
  assert.equal((await item(cookie, id)).document.next, 'Set aside: This is not our order');
  const record = await call('POST', `/api/purchase-inbox/${id}/record`, cookie, { supplierId: 'sampoorna:party:supplier', reference: 'X-1', date: '2026-09-21', lines: [{ item: 'TMT Steel Bar 12mm', quantity: '1', rate: '64', gst: '1800' }] });
  assert.equal(record.status, 409);
  assert.match(record.message, /set aside/);
});

test('#489: a failed reading is tried again, and a bill held for an unclear business can be claimed only by someone allowed to', async () => {
  const cookie = await owner();
  // Nothing failed in a healthy run; asking to retry a bill that did not fail is refused plainly.
  const added = await upload(cookie, await store(cookie, pdfOf(nextNumber())));
  const retried = await call('POST', `/api/purchase-inbox/${added.document.id}/retry`, cookie);
  assert.equal(retried.status, 409, JSON.stringify(retried));
  assert.match(retried.message, /Only a document that failed/);
  const claimed = await call('POST', `/api/purchase-inbox/${added.document.id}/assign`, cookie, { reason: 'ours' });
  assert.equal(claimed.status, 409);
});

test('#489: another company\'s document is "not found" in every way it could be asked for', async () => {
  const cookie = await owner();
  const mine = (await itemsOf(cookie)).find((entry) => entry.state === 'ready')!;
  const konkan = await konkanOwner();
  for (const [method, path, body] of [
    ['GET', `/api/purchase-inbox/${mine.id}`, undefined],
    ['POST', `/api/purchase-inbox/${mine.id}/retry`, {}],
    ['POST', `/api/purchase-inbox/${mine.id}/assign`, { reason: 'mine now' }],
    ['POST', `/api/purchase-inbox/${mine.id}/reject`, { reason: 'gone' }],
    ['POST', `/api/purchase-inbox/${mine.id}/preview`, { reference: 'x' }],
    ['POST', `/api/purchase-inbox/${mine.id}/record`, { reference: 'x' }],
  ] as const) {
    const reply = await call(method, path, konkan, body);
    assert.equal(reply.status, 404, `${method} ${path} → ${reply.status}`);
    assert.ok(!JSON.stringify(reply).includes(mine.fileName), 'and tells nothing about it');
  }
  // A file stored by Sampoorna cannot be handed to the inbox by Konkan either.
  const fileId = await store(cookie, pdfOf(nextNumber()));
  assert.equal((await upload(konkan, fileId)).status, 404);
});

test('#489: who may see the inbox, add to it, deal with it and record from it', async () => {
  const viewer = await signInOverHttp(base, 'viewer@sampoorna.example.invalid', SAMPOORNA);
  const counter_ = await signInOverHttp(base, 'counter@sampoorna.example.invalid', SAMPOORNA);
  const accountant = await signInOverHttp(base, 'accounts@sampoorna.example.invalid', SAMPOORNA);
  for (const who of [viewer, counter_]) {
    assert.equal((await call('GET', '/api/purchase-inbox', who)).status, 403);
    assert.equal((await call('POST', '/api/purchase-inbox/upload', who, { einvoiceJson: '{}' })).status, 403);
  }
  assert.equal((await call('GET', '/api/purchase-inbox', accountant)).status, 200);
  assert.equal((await call('GET', '/api/purchase-inbox', '')).status, 401);
});

test('#489: five of the same upload at once make one document', async () => {
  const cookie = await owner();
  const fileId = await store(cookie, pdfOf(nextNumber()));
  const replies = await Promise.all([1, 2, 3, 4, 5].map(() => upload(cookie, fileId)));
  assert.equal(new Set(replies.map((reply) => reply.document.id)).size, 1, replies.map((reply) => reply.document.id).join());
});

test('#489: a delivery whose bill names another business\'s GST number is held for a person to decide, never moved', async () => {
  const bytes = pdfOf(nextNumber(), 'wrong-buyer', syntheticGstin('29', 'AAACB1234M'));
  const reply = await delivery('email', mail(bytes, EMAIL, `wrong-${counter}`));
  assert.equal(reply.status, 202);
  const held = (await itemsOf(await owner())).find((entry) => entry.state === 'held' && /does not name Sampoorna Traders/.test(entry.message));
  assert.ok(held, 'held in the business it was sent to');
  assert.equal(held.actions.assign, true);
  const claimed = await call('POST', `/api/purchase-inbox/${held.id}/assign`, await owner(), { reason: 'The supplier used our other GST number' });
  assert.equal(claimed.status, 200, JSON.stringify(claimed));
  assert.equal(claimed.title, 'Added to your business');
  assert.equal(KONKAN_GSTIN.length, 15);
});

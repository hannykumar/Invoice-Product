/**
 * Issue #298 — a session that asks in Hindi must never be answered in English. The screen sends
 * `locale: 'hi-IN'` on every call; every sentence the server sends back on the returns, sale and
 * payment screens must be Hindi in Devanagari — the owner's decision (26 Oct 2026, recorded in
 * docs/ux/00-design-principles.md §6).
 *
 * Two checks catch every wrong answer: a sentence is "English" when it carries at least two English
 * function words ("the … will", "was … saved"), and any run of three or more lowercase Latin
 * letters flags Latin script left behind — item and party names are Capitalized (so "ABC Traders"
 * and "TMT Steel Bar 12mm" trip nothing), while any stray Roman-Hindi or English word ("bikri",
 * "credit", "hai") does. Codes, amounts, GSTINs and bill numbers stay Latin by rule, and are all
 * uppercase or digits.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { sells, stockEverything } from './stock-helper.ts';
import { useFixedAppClock } from '../src/app-clock.ts';
import { signIn as signInAs } from './sign-in-helper.ts';
import { saveTurnoverBand } from './turnover-helper.ts';
import { syntheticGstin } from '../../../packages/masters/src/fixtures.ts';

useFixedAppClock('2026-08-29T10:00:00.000Z');

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';
const DATE = '2026-08-29';
const SOAP = 'Herbal Bath Soap 100g';

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  if (sells(method, path)) await stockEverything(sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

const ENGLISH = new Set([
  'the', 'is', 'are', 'will', 'was', 'were', 'has', 'have', 'be', 'been', 'this', 'that', 'with',
  'from', 'for', 'on', 'and', 'or', 'not', 'you', 'your', 'we', 'it', 'of', 'in', 'a', 'an', 'no',
  'still', 'already', 'nothing', 'saved', 'only', 'left', 'against', 'could', 'should', 'must',
  'its', 'by', 'at', 'as', 'so', 'now', 'then', 'when', 'which', 'what', 'who', 'paid',
]);
// Fields that are identifiers, codes or the government file itself — never sentences for a reader.
const SKIP = new Set([
  'id', 'ids', 'number', 'gstin', 'hsn', 'code', 'state', 'status', 'fileName', 'voucherId',
  'invoiceId', 'documentId', 'partyId', 'period', 'periodKey', 'kind', 'type', 'direction',
  'outcome', 'mode', 'method', 'payload', 'unit', 'source', 'requestId', 'companyId', 'userId',
  'customerId', 'supplierId', 'party', 'item', 'itemId', 'lineId', 'originalLineId', 'reference',
  'complianceStatus', 'periodLabel', 'path', 'view', 'action', 'needed', 'askTurnover',
  'turnoverBand', 'signatory', 'token', 'locale', 'uom', 'registration', 'pos', 'key', 'amounts',
  'sourceId', 'sourceVoucherId', 'sessionId', 'noteId', 'serial', 'version', 'paymentId',
]);

const englishProse = (s: string): boolean => {
  const words = s.match(/[a-zA-Z]+/g);
  if (words === null || words.length < 5) return false;
  const hits = words.filter((word) => ENGLISH.has(word.toLowerCase()));
  return hits.length >= 2;
};

// Lowercase Latin words allowed inside a hi-IN sentence because they are data, not prose: the
// seeded warehouse 'Peenya godown' is a name. Everything else lowercase is a leftover to fail on.
const LATIN_OK = new Set(['godown']);
const latinLeft = (s: string): string[] =>
  (s.match(/[a-zA-Z]+/g) ?? []).filter((word) => word.length >= 3 && word === word.toLowerCase() && !LATIN_OK.has(word));

const englishSentences = (value: unknown, path: string, found: string[] = []): string[] => {
  if (typeof value === 'string') {
    if (englishProse(value)) found.push(`${path}: ${value}`);
    const stray = latinLeft(value);
    if (stray.length > 0) found.push(`${path}: Latin words in a Hindi sentence — ${stray.join(', ')}: ${value}`);
    return found;
  }
  if (Array.isArray(value)) value.forEach((item, i) => englishSentences(item, `${path}[${i}]`, found));
  else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    // A bilingual pair is judged by its Hindi half: an English sentence with no 'hi-IN' beside it
    // is exactly the flattening this issue exists to stop.
    if (typeof record['en-IN'] === 'string') {
      if (typeof record['hi-IN'] !== 'string' || record['hi-IN'] === '') {
        found.push(`${path}: English sentence with no Hindi form: ${record['en-IN']}`);
      } else {
        englishSentences(record['hi-IN'], `${path}.hi-IN`, found);
      }
      return found;
    }
    for (const [key, inner] of Object.entries(record)) {
      if (!SKIP.has(key)) englishSentences(inner, `${path}.${key}`, found);
    }
  }
  return found;
};

const hindi = (body: Record<string, unknown>) => ({ ...body, locale: 'hi-IN' });

test('#298: the sale review answers a Hindi session in Hindi, never English', async () => {
  const owner = await signInAs('owner@sampoorna.example.invalid', SAMPOORNA);
  const sale = hindi({ party: 'ABC Traders', item: SOAP, quantity: '3', rate: '250', date: DATE, terms: '7', requestId: 'hindi-298-preview', approvalReason: 'Agreed with the owner' });
  const reviewed = await request('POST', '/api/sales/preview', sale, owner);
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  assert.deepEqual(englishSentences(reviewed.body, 'preview'), []);
  assert.match(reviewed.body.title, /बिक्री/);

  const recorded = await request('POST', '/api/sales/record', hindi({ ...sale, requestId: 'hindi-298-record' }), owner);
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  assert.deepEqual(englishSentences(recorded.body, 'record'), []);
});

test('#298: payment review and record answer a Hindi session in Hindi', async () => {
  const owner = await signInAs('owner@sampoorna.example.invalid', SAMPOORNA);
  const sold = await request('POST', '/api/sales/record', { party: 'ABC Traders', item: SOAP, quantity: '3', rate: '250', date: DATE, terms: '7', requestId: 'hindi-298-pay-bill', approvalReason: 'Agreed with the owner' }, owner);
  assert.equal(sold.status, 200, JSON.stringify(sold.body));
  const payment = hindi({ party: 'ABC Traders', amount: '500', date: DATE, method: 'Cash', requestId: 'hindi-298-payment' });
  const preview = await request('POST', '/api/payments/preview', payment, owner);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual(englishSentences(preview.body, 'payment.preview'), []);

  const recorded = await request('POST', '/api/payments/record', payment, owner);
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  assert.deepEqual(englishSentences(recorded.body, 'payment.record'), []);
});

test('#298: a Hindi purchase check still keeps English under en-IN (Devin Review #493-1)', async () => {
  const session = await signInAs('owner@sampoorna.example.invalid', SAMPOORNA);
  const input = { supplierId: 'sampoorna:party:supplier', reference: 'SRS-298-1', date: '2026-08-27', lines: [{ item: 'TMT Steel Bar 12mm', quantity: '10', rate: '64', gst: '1800' }] };

  const recorded = await request('POST', '/api/purchases/record', { ...input, locale: 'hi-IN' }, session);
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  const check = recorded.body.purchaseCheck as Record<string, unknown>;
  assert.ok(check);
  assert.ok(englishProse(check['en-IN'] as string), `the English side is English: ${check['en-IN']}`);
  assert.ok(!englishProse(check['hi-IN'] as string), `the Hindi side is Hindi: ${check['hi-IN']}`);
});

test('#298: a Hindi estimate refusal keeps English under en-IN (Devin Review #493-2)', async () => {
  const session = await signInAs('owner@sampoorna.example.invalid', SAMPOORNA);

  const estimate = await request('POST', '/api/sales/estimate', {
    party: 'ABC Traders', item: SOAP, quantity: '999999999', rate: '180', date: DATE, locale: 'hi-IN',
  }, session);
  assert.equal(estimate.status, 200, JSON.stringify(estimate.body));
  const refusal = (estimate.body.refusals as Record<string, unknown>[])[0];
  assert.ok(refusal, JSON.stringify(estimate.body));
  assert.ok(englishProse(refusal['en-IN'] as string), `the English side is English: ${refusal['en-IN']}`);
  assert.ok(!englishProse(refusal['hi-IN'] as string), `the Hindi side is Hindi: ${refusal['hi-IN']}`);
});

test('#298: a Hindi return confirmation is Hindi and calls the note a note (Devin Review #493-3)', async () => {
  const session = await signInAs('owner@sampoorna.example.invalid', SAMPOORNA);
  await saveTurnoverBand(session, '5_TO_10_CRORE');
  const buyer = await request('POST', '/api/customers', {
    legalName: 'Review Registered Buyer', registration: 'regular', gstin: syntheticGstin('29', 'RRSTP1234F'),
    line1: '9, Market Road', city: 'Bengaluru', pincode: '560001',
  }, session);
  assert.equal(buyer.status, 200, JSON.stringify(buyer.body));

  const sale = await request('POST', '/api/sales/record', {
    party: 'Review Registered Buyer', item: SOAP, quantity: '3', rate: '200', date: DATE,
    requestId: 'SALE-298-1', locale: 'hi-IN',
  }, session);
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  assert.equal(sale.body.eInvoice?.needed, 'YES', 'the bill is one the portal wants, so the suffix is exercised');

  const choices = await request('GET', '/api/returns/documents', {}, session);
  const bill = (choices.body.documents as Record<string, any>[]).find((document) => document.party === 'Review Registered Buyer');
  assert.ok(bill, JSON.stringify(choices.body));

  const recorded = await request('POST', '/api/returns/record', {
    kind: 'SALES_RETURN', documentId: bill.id, lineId: 'line-1', quantity: '1',
    disposition: 'ACCEPTED', reason: 'Customer brought the soap back.', date: DATE,
    reference: 'CN-298-1', requestId: 'CN-298-1', locale: 'hi-IN',
  }, session);
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  const message = recorded.body.message as string;
  assert.ok(message.length > 0);
  assert.ok(!englishProse(message), `the confirmation is Hindi, not English: ${message}`);
  assert.ok(!/This (bill|credit note|debit note)/.test(message), `no English left in: ${message}`);
  assert.match(message, /क्रेडिट नोट/, `the note is named a credit note, not a bill: ${message}`);
});

test('#298: the GST return workspace and export answer a Hindi session in Hindi', async () => {
  const owner = await signInAs('owner@sampoorna.example.invalid', SAMPOORNA);
  const workspace = await request('POST', '/api/gst-returns', hindi({ period: '2026-08' }), owner);
  assert.equal(workspace.status, 200, JSON.stringify(workspace.body));
  assert.deepEqual(englishSentences(workspace.body, 'gst.workspace'), []);

  const prepared = await request('POST', '/api/gst-returns/prepare', hindi({ period: '2026-08' }), owner);
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  const approved = await request('POST', '/api/gst-returns/approve', hindi({ period: '2026-08' }), owner);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const exported = await request('POST', '/api/gst-returns/export', hindi({ period: '2026-08', returnType: 'GSTR1' }), owner);
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  const { payload, ...sentences } = exported.body;
  assert.deepEqual(englishSentences(sentences, 'gst.export'), []);
});

test('#298: a refusal told in Hindi when the server has a Hindi form for it', async () => {
  const owner = await signInAs('owner@sampoorna.example.invalid', SAMPOORNA);
  const bought = await request('POST', '/api/purchases/record', {
    supplierId: 'sampoorna:party:supplier', reference: 'hindi-298-purchase', date: DATE,
    lines: [{ item: 'TMT Steel Bar 12mm', quantity: '1', rate: '64', gst: '1800' }],
  }, owner);
  assert.equal(bought.status, 200, JSON.stringify(bought.body));
  const open = await request('POST', '/api/payments/open-bills', hindi({ direction: 'PAYMENT', partyId: 'sampoorna:party:supplier', date: DATE }), owner);
  assert.equal(open.status, 200, JSON.stringify(open.body));
  // Paying the supplier more than the bill the money is marked for is refused; the refusal
  // carries its Hindi sentence in details, which the envelope answers with (#298).
  const refused = await request('POST', '/api/payments/preview', hindi({ direction: 'PAYMENT', partyId: 'sampoorna:party:supplier', amount: '9000', date: DATE, method: 'Cash', bills: [open.body.bills[0].id], requestId: 'hindi-298-refusal' }), owner);
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'PAYMENT_MORE_THAN_BILLS');
  assert.deepEqual(englishSentences({ message: refused.body.message }, 'refusal'), []);
});


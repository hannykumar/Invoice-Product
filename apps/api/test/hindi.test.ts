/**
 * Issue #298 — a session that asks in Hindi must never be answered in English. The screen sends
 * `locale: 'hi-IN'` on every call; every sentence the server sends back on the returns, sale and
 * payment screens must be Hindi (Roman script — the script this app chose, see
 * docs/ux/00-design-principles.md §6), not English and not Devanagari.
 *
 * The check is deliberately simple: a sentence is "English" when it carries at least two English
 * function words ("the … will", "was … saved"). Item and party names never do — "TMT Steel Bar
 * 12mm" and "ABC Traders" trip nothing — and a Roman Hindi sentence never does either.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { sells, stockEverything } from './stock-helper.ts';
import { useFixedAppClock } from '../src/app-clock.ts';
import { signIn as signInAs } from './sign-in-helper.ts';

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
  if (/[ऀ-ॿ]/.test(s)) return true; // Hindi is Roman in this app: Devanagari is as wrong as English.
  const words = s.match(/[a-zA-Z]+/g);
  if (words === null || words.length < 5) return false;
  const hits = words.filter((word) => ENGLISH.has(word.toLowerCase()));
  return hits.length >= 2;
};

const englishSentences = (value: unknown, path: string, found: string[] = []): string[] => {
  if (typeof value === 'string') {
    if (englishProse(value)) found.push(`${path}: ${value}`);
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
  assert.match(reviewed.body.title, /Bikri|bikri/);

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

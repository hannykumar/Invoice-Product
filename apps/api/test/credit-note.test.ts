/**
 * Issue #186 — the credit note a customer is given when goods come back, and the 30 November
 * deadline after which a credit note can no longer reduce GST.
 *
 * The worked example from the issue, through the running app: a bill dated 15 September 2026 for
 * 40 pieces at ₹2,100 at 18%, same state; five pieces come back on 20 September 2026.
 *
 *   taxable value credited: 5 × ₹2,100      = ₹10,500.00
 *   CGST 9%:                9% of ₹10,500   =    ₹945.00
 *   SGST 9%:                9% of ₹10,500   =    ₹945.00
 *   total credited:         10,500 + 945 + 945 = ₹12,390.00
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';
import { sells, stockEverything } from './stock-helper.ts';
import { masterData, mastersContext } from '../src/master-data.ts';
import { CREDIT_NOTE_MANDATORY_FIELDS } from '@invoice/invoice-templates';
import { checkCreditNoteDeadline, creditNoteDeadline } from '@invoice/returns';
import { isoDate } from '@invoice/kernel';

const COMPANY_A = '00000000-0000-4000-8000-000000000001';

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  // Issue #229 — these tests are about the bill, not the godown: stock the goods it sells.
  if (sells(method, path)) await stockEverything(sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  const text = Buffer.isBuffer(response.body) ? '{}' : String(response.body);
  return { status: response.status, headers: response.headers, raw: response.body, body: JSON.parse(text) as Record<string, any> };
};

const signIn = async (): Promise<string> => {
  const response = await request('POST', '/api/auth/login', { companyId: COMPANY_A, email: 'owner@sampoorna.example.invalid', password: 'karobar-demo' });
  assert.equal(response.status, 200);
  return response.body.sessionId as string;
};

const CUSTOMER = {
  legalName: 'Malleshwaram Hardware', registration: 'regular', gstin: '29HHHHH7777H1Z1',
  line1: '42, Sampige Road', city: 'Bengaluru', pincode: '560003',
};
const GOODS = {
  name: 'Brass Gate Valve 25mm', kind: 'goods', hsnSac: '84818030', unit: 'PCS',
  taxKind: 'taxable', ratePercentTimes100: '1800', basis: 'The rate our accountant uses for valves',
};

const text = (html: string): string => html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

/** Issues the bill, records the return, and hands back what the test needs. */
const saleAndReturn = async (session: string, key: string, returnDate = '2026-09-20') => {
  const catalogue = (await request('GET', '/api/catalogue', {}, session)).body;
  const customerId = catalogue.customers.find((c: { name: string }) => c.name === CUSTOMER.legalName)?.id
    ?? (await request('POST', '/api/customers', CUSTOMER, session)).body.customer.id;
  const itemId = catalogue.items.find((i: { name: string }) => i.name === GOODS.name)?.id
    ?? (await request('POST', '/api/items', GOODS, session)).body.item.id;
  const sold = await request('POST', '/api/sales/record', {
    customerId, lines: [{ itemId, quantity: '40', rate: '2100' }], date: '2026-09-15', terms: '30', reference: `cn-186-${key}`,
  }, session);
  assert.equal(sold.status, 200, sold.body.message);
  const invoice = sold.body.invoice as { id: string; number: string };
  const documents = (await request('GET', '/api/returns/documents', {}, session)).body.documents;
  const line = documents.find((d: { id: string }) => d.id === invoice.id).lines[0];
  const recorded = await request('POST', '/api/returns/record', {
    kind: 'SALES_RETURN', documentId: invoice.id, lineId: line.id, quantity: '5', unit: 'PCS',
    disposition: 'ACCEPTED', date: returnDate, reference: `cn-186-${key}-return`, reason: 'Five valves leaked on testing.',
  }, session);
  return { invoice, customerId, recorded };
};

test('the printed credit note carries every particular, against the invoice it corrects', async () => {
  const session = await signIn();
  const { invoice, recorded } = await saleAndReturn(session, 'print');
  assert.equal(recorded.status, 200, recorded.body.message);
  const note = recorded.body.note as { id: string; number: string };
  assert.match(note.number, /^CN\/26-27\/\d{7}$/);

  const printed = await request('POST', '/api/returns/print', { note: note.id }, session);
  assert.equal(printed.status, 200, printed.body.message);
  const html = String(printed.body.html);
  const visible = text(html);

  assert.ok(visible.includes('Credit Note'), 'the title');
  assert.ok(visible.includes(note.number), 'the note number');
  assert.ok(visible.includes('20 September 2026'), 'the note date');
  assert.ok(visible.includes(`Against Invoice No. ${invoice.number} dated 15 September 2026`), 'the invoice it is against, with its date');
  assert.ok(visible.includes('84818030'), 'the HSN code from the original line');
  assert.match(visible, / 5 PCS /, 'five pieces');
  assert.ok(visible.includes('10,500.00'), 'taxable value credited: 5 × ₹2,100');
  assert.match(visible, /CGST ₹945\.00/);
  assert.match(visible, /SGST ₹945\.00/);
  assert.match(visible, /Total Credited ₹12,390\.00/);
  assert.ok(visible.includes('Rupees twelve thousand three hundred and ninety only'), 'the amount in words');
  assert.ok(visible.includes('Five valves leaked on testing.'), 'the reason');
  assert.ok(visible.includes('Authorised Signatory'), 'the signature');
  assert.ok(visible.includes('Malleshwaram Hardware') && visible.includes('42, Sampige Road') && visible.includes('29HHHHH7777H1Z1'), 'the buyer, as billed');
  assert.ok(!/ORIGINAL FOR RECIPIENT|DUPLICATE FOR|TRIPLICATE FOR/.test(visible), 'no copy markings on a credit note');

  // And it is listed, with a Print action, on the Returns screen.
  const listed = (await request('GET', '/api/returns/notes', {}, session)).body.notes as { id: string; printable: boolean }[];
  assert.ok(listed.some((n) => n.id === note.id && n.printable));
});

test('every Rule 53(1A) particular is on the A4 page and on the phone page', async () => {
  const session = await signIn();
  const { invoice, recorded } = await saleAndReturn(session, 'fields');
  const note = recorded.body.note as { id: string; number: string };
  for (const format of ['A4', 'MOBILE', 'THERMAL_80MM']) {
    const html = String((await request('POST', '/api/returns/print', { note: note.id, format }, session)).body.html);
    const visible = text(html);
    const present: Record<string, boolean> = {
      'supplier.nameAddressGstin': visible.includes('No. 14, 2nd Main, Peenya Industrial Area') && visible.includes('29AAAAA0000A1ZY'),
      'document.nature': visible.includes('Credit Note'),
      'note.number': visible.includes(note.number),
      'note.date': visible.includes('20 September 2026'),
      'recipient.nameAddressGstin': visible.includes('Malleshwaram Hardware') && visible.includes('42, Sampige Road') && visible.includes('29HHHHH7777H1Z1'),
      'against.invoiceNumberAndDate': visible.includes(invoice.number) && visible.includes('15 September 2026'),
      'line.taxableValue': visible.includes('10,500.00'),
      'line.taxRate': visible.includes('18%'),
      'line.taxAmount': visible.includes('1,890.00'),
      signature: visible.includes('Authorised Signatory'),
    };
    for (const field of CREDIT_NOTE_MANDATORY_FIELDS) assert.ok(present[field.id], `${format}: ${field.id} (${field.clause}) is missing`);
  }
});

test('the note reprints as issued, even after the customer moves', async () => {
  const session = await signIn();
  const { customerId, recorded } = await saleAndReturn(session, 'reprint');
  const note = recorded.body.note as { id: string };
  masterData().addAddress(mastersContext(COMPANY_A), {
    partyId: customerId, label: 'New shop', line1: '7, New BEL Road', city: 'Bengaluru', stateCode: '29', pincode: '560094',
    gstin: CUSTOMER.gstin, use: 'both', isPrimary: true,
  }, { idempotencyKey: 'cn-186-moved' });
  const visible = text(String((await request('POST', '/api/returns/print', { note: note.id }, session)).body.html));
  assert.ok(visible.includes('42, Sampige Road'), 'the address the bill was issued to');
  assert.ok(!visible.includes('New BEL Road'), 'not the address saved afterwards');
});

test('the note downloads as a PDF', async () => {
  const session = await signIn();
  const { recorded } = await saleAndReturn(session, 'pdf');
  const note = recorded.body.note as { id: string; number: string };
  const response = await handleApi('GET', `/api/returns/${encodeURIComponent(note.id)}/pdf`, {}, `Bearer ${session}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'application/pdf');
  assert.equal(Buffer.from(response.body as Buffer).subarray(0, 4).toString(), '%PDF');
});

test('a credit note dated after 30 November of the next year is refused, and one inside the last month warns', async () => {
  const session = await signIn();
  const late = await saleAndReturn(session, 'late', '2027-12-01');
  assert.equal(late.recorded.status, 422);
  assert.equal(
    late.recorded.body.message,
    'Credit notes that reduce GST for bills of 2026-27 could only be issued up to 30 November 2027. Talk to your accountant: this return can be settled without reducing GST.',
  );

  const documents = (await request('GET', '/api/returns/documents', {}, session)).body.documents;
  const line = documents.find((d: { id: string }) => d.id === late.invoice.id).lines[0];
  const soon = await request('POST', '/api/returns/preview', {
    kind: 'SALES_RETURN', documentId: late.invoice.id, lineId: line.id, quantity: '1', unit: 'PCS',
    disposition: 'ACCEPTED', date: '2027-11-05', reference: 'cn-186-soon', reason: 'One more came back.',
  }, session);
  assert.equal(soon.status, 200, soon.body.message);
  assert.deepEqual(soon.body.warnings, ['The last day to issue a credit note that reduces GST for bills of 2026-27 is 30 November 2027.']);
});

test('the deadline is 30 November after the bill\'s financial year, and the warning names it', () => {
  // A bill of 15 September 2026 is in 2026-27, which ends on 31 March 2027; the next 30 November is 2027's.
  assert.equal(checkCreditNoteDeadline(isoDate('2026-09-15'), isoDate('2027-11-30')).late, false);
  assert.equal(checkCreditNoteDeadline(isoDate('2026-09-15'), isoDate('2027-12-01')).late, true);
  assert.equal(
    checkCreditNoteDeadline(isoDate('2026-09-15'), isoDate('2027-11-05')).warning,
    'The last day to issue a credit note that reduces GST for bills of 2026-27 is 30 November 2027.',
  );
  assert.equal(checkCreditNoteDeadline(isoDate('2026-09-15'), isoDate('2026-09-20')).warning, null);
  // Across the year boundary: 31 March 2027 is still 2026-27; 1 April 2027 starts 2027-28.
  assert.equal(creditNoteDeadline(isoDate('2027-03-31')), '2027-11-30');
  assert.equal(creditNoteDeadline(isoDate('2027-04-01')), '2028-11-30');
});

// ---------------------------------------------------------------------------- issue #232

/**
 * Issue #232 — a credit note goes on the GST return under the state of the bill it corrects.
 *
 * The full trade check's steps 3, 9 and 11: 450 KGS of TMT bar at ₹90 plus ₹2,000 freight to
 * Mehta Construction Supplies in Pune, IGST 18% on ₹42,500 = ₹7,650; 50 KGS come back, so the note
 * is 50 × ₹90 = ₹4,500 and IGST 18% of it = ₹810. Every note used to be given Karnataka, so this
 * one was called "a sale inside your own state that carries IGST".
 */
const MEHTA = {
  legalName: 'Mehta Construction Supplies', registration: 'regular', gstin: '27AAACM1234K1ZN',
  line1: 'Plot 22, MIDC Bhosari', city: 'Pune', pincode: '411026',
};

const customerIdOf = async (session: string, party: typeof MEHTA): Promise<string> =>
  (await request('GET', '/api/catalogue', {}, session)).body.customers
    .find((c: { name: string }) => c.name === party.legalName)?.id
  ?? (await request('POST', '/api/customers', party, session)).body.customer.id;

const returnFifty = async (session: string, invoiceId: string, key: string) => {
  const documents = (await request('GET', '/api/returns/documents', {}, session)).body.documents;
  const line = documents.find((d: { id: string }) => d.id === invoiceId).lines
    .find((l: { name?: string; description?: string; id: string }) => /TMT/.test(l.name ?? l.description ?? '')) ?? documents.find((d: { id: string }) => d.id === invoiceId).lines[0];
  const recorded = await request('POST', '/api/returns/record', {
    kind: 'SALES_RETURN', documentId: invoiceId, lineId: line.id, quantity: '50', unit: 'KGS',
    disposition: 'ACCEPTED', date: '2026-09-20', reference: key, reason: 'Bent bars',
  }, session);
  assert.equal(recorded.status, 200, recorded.body.message);
  return recorded.body.note as { id: string; number: string };
};

const noteRow = async (session: string, number: string) => {
  const workspace = (await request('POST', '/api/gst-returns', { period: '2026-09' }, session)).body;
  const cdnr = (workspace.sections as Record<string, any>[]).find((section) => section.id === 'CDNR');
  const row = (cdnr?.rows as Record<string, any>[] | undefined)?.find((r) => r.label === number);
  const questions = [
    ...(workspace.findings as { document: string | null; code: string; message: string }[])
      .filter((f) => f.document === number).map((f) => f.code),
    ...(workspace.exceptions as { number: string; questions: { message: string }[] }[])
      .filter((e) => e.number === number).flatMap((e) => e.questions.map((q) => q.message)),
  ];
  return { row, questions };
};

test('#232 a credit note against a Karnataka → Maharashtra bill is reported under Maharashtra, with no question', async () => {
  const session = await signIn();
  const sold = await request('POST', '/api/sales/record', {
    customerId: await customerIdOf(session, MEHTA), lines: [{ itemId: 'sampoorna:item:TMT12', quantity: '450', rate: '90' }],
    freight: '2000', date: '2026-09-17', terms: '30', reference: 'cn-232-mehta',
  }, session);
  assert.equal(sold.status, 200, sold.body.message);
  const note = await returnFifty(session, sold.body.invoice.id, 'cn-232-mehta-return');

  const { row, questions } = await noteRow(session, note.number);
  assert.deepEqual(questions, [], 'no "inside your own state but carries IGST"');
  assert.equal(row?.placeOfSupply, 'Maharashtra (27)');
  assert.equal(row?.taxableValue, -4500);
  assert.equal(row?.tax, -810);
  assert.equal(row?.rate, 18, 'the note is reported at the rate it was taxed at, not 0%');

  // The code-wise summary nets the note into the bill's own 18% row, not a row with no rate.
  const hsn = (await request('POST', '/api/gst-returns', { period: '2026-09' }, session)).body.hsn as Record<string, any>[];
  const steel = hsn.filter((r) => r.hsn === '72142090');
  assert.deepEqual(steel.map((r) => r.rate), [18]);
  assert.ok(steel[0]?.bills.includes(note.number));
});

test('#232 a credit note against a bill inside Karnataka is reported under Karnataka', async () => {
  const session = await signIn();
  const { recorded } = await saleAndReturn(session, 'pos-232-local');
  assert.equal(recorded.status, 200, recorded.body.message);
  const { row, questions } = await noteRow(session, recorded.body.note.number);
  assert.deepEqual(questions, []);
  assert.equal(row?.placeOfSupply, 'Karnataka (29)');
  assert.equal(row?.taxableValue, -10500);
  assert.equal(row?.tax, -1890);
});

test('#232 a note follows the bill\'s delivery state, not the buyer\'s GST number', async () => {
  // Mehta is registered in Maharashtra, but these bars went to a site in Gujarat. The bill counts in
  // Gujarat (24), and so does the note that corrects it.
  const session = await signIn();
  const customerId = await customerIdOf(session, MEHTA);
  const address = await request('POST', '/api/shipping-addresses', {
    customerId, label: 'Surat site', line1: 'Plot 5, Sachin GIDC', city: 'Surat', pincode: '394230', stateCode: '24',
  }, session);
  assert.equal(address.status, 200, address.body.message);
  const sold = await request('POST', '/api/sales/record', {
    customerId, lines: [{ itemId: 'sampoorna:item:TMT12', quantity: '450', rate: '90' }],
    date: '2026-09-17', terms: '30', reference: 'cn-232-surat', shipTo: 'address', shipToAddressId: address.body.address.id,
  }, session);
  assert.equal(sold.status, 200, sold.body.message);
  const note = await returnFifty(session, sold.body.invoice.id, 'cn-232-surat-return');
  const { row, questions } = await noteRow(session, note.number);
  assert.deepEqual(questions, []);
  assert.equal(row?.placeOfSupply, 'Gujarat (24)');
});

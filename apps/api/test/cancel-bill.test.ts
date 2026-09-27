/**
 * Issue #233 — a wrong bill is cancelled, never deleted, and a filed month is corrected by a credit
 * note for the whole bill.
 *
 * Before this, a second press on a still-filled sale form made an identical second bill, and there
 * was no way to cancel it: a return could credit the goods only, so the customer was left owing the
 * freight and its tax, ₹2,000 + ₹360 = ₹2,360, for a sale that never happened.
 *
 * The worked numbers, through the same endpoints the screen calls:
 *
 *   one Mehta bill       450 × ₹90 = ₹40,500, + ₹2,000 freight = ₹42,500, + 18% IGST ₹7,650 = ₹50,150
 *   made twice           cancelled with reason "made twice": number kept, Mehta owes ₹50,150 once
 *   month approved       cancel refused, credit note offered instead
 *   whole-bill note      ₹42,500 + ₹7,650 = ₹50,150, freight included, ₹0 left on the bill
 *
 * Dated today, because the business's cancellation window is counted from the bill's date to today.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleApi } from '../src/server.ts';

const SAMPOORNA = '00000000-0000-4000-8000-000000000001';
const SHREE_RAM = 'sampoorna:party:supplier';
const DATE = new Date().toISOString().slice(0, 10);
const MONTH = DATE.slice(0, 7);

const request = async (method: string, path: string, body: Record<string, unknown> = {}, sessionId?: string) => {
  const response = await handleApi(method, path, body, sessionId === undefined ? undefined : `Bearer ${sessionId}`);
  return { status: response.status, body: JSON.parse(String(response.body)) as Record<string, any> };
};

const signIn = async (): Promise<string> => {
  const response = await request('POST', '/api/auth/login', { companyId: SAMPOORNA, email: 'owner@sampoorna.example.invalid', password: 'karobar-demo' });
  assert.equal(response.status, 200);
  return response.body.sessionId as string;
};

/** 1,000 kg bought (two supplier bills of 500), and Mehta added. */
const shop = (() => {
  let done: Promise<{ owner: string; mehta: string }> | null = null;
  return () => done ??= (async () => {
    const owner = await signIn();
    for (const reference of ['SRS-101', 'SRS-102']) {
      const bought = await request('POST', '/api/purchases/record', {
        supplierId: SHREE_RAM, reference, date: DATE,
        lines: [{ item: 'TMT Steel Bar 12mm', quantity: '500', rate: '64', gst: '1800' }],
      }, owner);
      assert.equal(bought.status, 200, JSON.stringify(bought.body));
    }
    const customer = await request('POST', '/api/customers', {
      legalName: 'Mehta Construction Supplies', registration: 'regular', gstin: '27AAACM1234K1ZN',
      line1: 'Plot 22, MIDC Bhosari', city: 'Pune', pincode: '411026',
    }, owner);
    assert.equal(customer.status, 200, JSON.stringify(customer.body));
    return { owner, mehta: customer.body.customer.id as string };
  })();
})();

const mehtaSale = (mehta: string, requestId: string, quantity = '450') => ({
  customerId: mehta, item: 'TMT Steel Bar 12mm', quantity, rate: '90',
  freight: '2000', date: DATE, terms: '30', requestId,
});

const sell = async (owner: string, input: Record<string, unknown>) => {
  const sold = await request('POST', '/api/sales/record', input, owner);
  assert.equal(sold.status, 200, JSON.stringify(sold.body));
  return sold.body.invoice as { id: string; number: string; amount: number };
};

const steel = async (owner: string) =>
  (await request('GET', '/api/reports', {}, owner)).body.stock.rows
    .filter((row: any) => row.item === 'TMT Steel Bar 12mm').map((row: any) => row.closing);

const owes = async (owner: string, party: string) =>
  (await request('GET', '/api/reports', {}, owner)).body.dues.receivables.rows.find((row: any) => row.party === party);

const sequence = (number: string) => Number(number.split('/').at(-1));

test('#233: a bill made twice is cancelled — number kept, balance, stock and GST back — and the month then refuses a cancel and takes a whole-bill credit note', async () => {
  const { owner, mehta } = await shop();
  const stockBefore = await steel(owner);

  // Record pressed twice for one review: one bill.
  const first = await sell(owner, mehtaSale(mehta, 'cancel-233-first'));
  const pressedAgain = await request('POST', '/api/sales/record', mehtaSale(mehta, 'cancel-233-first'), owner);
  assert.equal(pressedAgain.body.deduplicated, true);
  assert.equal(pressedAgain.body.invoice.number, first.number);
  assert.equal(first.amount, 50150);

  // A second review of the same goods is a second, real bill: it is not refused.
  const twice = await sell(owner, mehtaSale(mehta, 'cancel-233-second'));
  assert.equal(sequence(twice.number), sequence(first.number) + 1);
  assert.equal((await owes(owner, 'Mehta Construction Supplies')).outstanding, 50150 + 50150);

  // What cancelling will do, said before anything changes.
  const preview = await request('POST', '/api/sales/cancel/preview', { invoice: twice.id }, owner);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual(preview.body.clearFirst, []);
  assert.ok(preview.body.effects.includes('Mehta Construction Supplies will owe ₹50,150.00 less.'), preview.body.effects.join('\n'));
  assert.ok(preview.body.effects.includes('450 KGS of TMT Steel Bar 12mm go back into stock.'), preview.body.effects.join('\n'));

  const noReason = await request('POST', '/api/sales/cancel', { invoice: twice.id, reason: '  ' }, owner);
  assert.equal(noReason.status, 422, JSON.stringify(noReason.body));
  assert.equal(noReason.body.code, 'SALES_REASON_REQUIRED');

  const cancelled = await request('POST', '/api/sales/cancel', { invoice: twice.id, reason: 'made twice' }, owner);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.invoice.state, 'CANCELLED');
  assert.equal(cancelled.body.invoice.number, twice.number, 'the number stays with the cancelled bill');
  const again = await request('POST', '/api/sales/cancel', { invoice: twice.id, reason: 'made twice' }, owner);
  assert.equal(again.body.deduplicated, true, 'cancelling twice changes nothing');

  // Mehta owes the first bill only; the 450 kg are back.
  assert.equal((await owes(owner, 'Mehta Construction Supplies')).outstanding, 50150);
  assert.deepEqual(await steel(owner), stockBefore.map((closing: string) => (Number(closing) - 450).toFixed(3)));

  // Reprinted, it says CANCELLED across it with the reason.
  const printed = await request('POST', '/api/sales/print', { invoice: twice.id }, owner);
  assert.equal(printed.status, 200, JSON.stringify(printed.body));
  assert.equal(printed.body.cancelled, true);
  assert.match(printed.body.html, /class="cancel-stamp"/);
  assert.match(printed.body.html, /made twice/);

  // The next bill never reuses the cancelled number.
  const next = await sell(owner, { ...mehtaSale(mehta, 'cancel-233-next', '1'), freight: '' });
  assert.equal(sequence(next.number), sequence(twice.number) + 1);
  const small = await request('POST', '/api/sales/cancel', { invoice: next.id, reason: 'test bill' }, owner);
  assert.equal(small.status, 200, JSON.stringify(small.body));

  // GST returns: the cancelled bills are counted as cancelled in documents issued, not as sales.
  const month = await request('POST', '/api/gst-returns', { period: MONTH }, owner);
  assert.equal(month.status, 200, JSON.stringify(month.body));
  const invoices = month.body.documentsIssued.find((row: any) => row.kind === 'INVOICE');
  assert.equal(invoices.cancelled, 2);
  assert.equal(invoices.total - invoices.issued, 2);
  const listed = month.body.sections.flatMap((section: any) => section.rows.flatMap((row: any) => row.sources.map((source: any) => source.number)));
  assert.ok(listed.includes(first.number));
  assert.ok(!listed.includes(twice.number), 'a cancelled bill is not a sale on the return');
  assert.ok(!listed.includes(next.number));
  // The cancelled bills' entries and their reversals cancel out inside the month, so the books are
  // not reported as holding tax "without a bill on the return".
  assert.equal(month.body.findings.some((finding: any) => /without belonging to any bill/.test(finding.message)), false, JSON.stringify(month.body.findings));

  // Once the month is approved, the first bill cannot be cancelled: the credit-note route is offered.
  const prepared = await request('POST', '/api/gst-returns/prepare', { period: MONTH }, owner);
  assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  const approved = await request('POST', '/api/gst-returns/approve', { period: MONTH, note: 'checked' }, owner);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  for (const path of ['/api/sales/cancel/preview', '/api/sales/cancel']) {
    const refused = await request('POST', path, { invoice: first.id, reason: 'wrong' }, owner);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'SALES_CANCEL_MONTH_APPROVED');
    assert.match(refused.body.message, /credit note for the whole bill/);
  }

  // The whole-bill credit note: every item and the freight. ₹42,500 + ₹7,650 = ₹50,150.
  const documents = await request('GET', '/api/returns/documents', {}, owner);
  const original = documents.body.documents.find((document: any) => document.number === first.number);
  assert.equal(original.leftToCredit, 50150);
  assert.equal(documents.body.documents.some((document: any) => document.number === twice.number), false, 'a cancelled bill takes no return');
  const whole = { kind: 'SALES_RETURN', documentId: original.id, lineId: '__whole__', date: DATE, reason: 'Order withdrawn after filing', disposition: 'ACCEPTED', reference: 'cancel-233-whole' };
  const notePreview = await request('POST', '/api/returns/preview', whole, owner);
  assert.equal(notePreview.status, 200, JSON.stringify(notePreview.body));
  assert.equal(notePreview.body.amount, 50150);
  const note = await request('POST', '/api/returns/record', whole, owner);
  assert.equal(note.status, 200, JSON.stringify(note.body));
  assert.equal(note.body.note.amount, 50150);

  const open = await request('POST', '/api/payments/open-bills', { partyId: mehta, date: DATE }, owner);
  assert.equal(open.body.bills.some((bill: any) => bill.number === first.number), false, 'nothing is left due on the bill');
  assert.equal((await owes(owner, 'Mehta Construction Supplies'))?.outstanding ?? 0, 0);

  // The note on paper keeps the freight row, and the return reports it under the goods code.
  const notes = await request('GET', '/api/returns/notes', {}, owner);
  const recorded = notes.body.notes.find((row: any) => row.id === note.body.note.id);
  assert.ok(recorded, JSON.stringify(notes.body));
  const paper = await request('POST', '/api/returns/print', { note: note.body.note.id }, owner);
  assert.match(paper.body.html, /Freight/);
  // (An approved month shows what was approved; reopened, it shows the books as they are now.)
  const reopened = await request('POST', '/api/gst-returns/reopen', { period: MONTH, reason: 'test' }, owner);
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  const after = await request('POST', '/api/gst-returns', { period: MONTH }, owner);
  const steelCode = after.body.hsn.find((row: any) => row.hsn === '72142090');
  assert.ok(steelCode.bills.includes(note.body.note.number), JSON.stringify(after.body.hsn));
  assert.equal(after.body.findings.some((finding: any) => /no goods or services code/.test(finding.message)), false);

  // No cancel after a credit note either: the note already corrects the bill.
  const withNote = await request('POST', '/api/sales/cancel', { invoice: first.id, reason: 'wrong' }, owner);
  assert.equal(withNote.status, 409, JSON.stringify(withNote.body));
  assert.equal(withNote.body.code, 'SALES_CANCEL_HAS_CREDIT_NOTE');
});

test('#233: money received against a cancelled bill stays on account for the customer, not lost', async () => {
  const { owner, mehta } = await shop();
  await request('POST', '/api/gst-returns/reopen', { period: MONTH, reason: 'test' }, owner);
  const bill = await sell(owner, mehtaSale(mehta, 'cancel-233-paid', '10'));
  const paid = await request('POST', '/api/payments/record', {
    partyId: mehta, amount: '500', date: DATE, method: 'UPI', bills: [bill.id], requestId: 'cancel-233-paid-receipt',
  }, owner);
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  const onAccountBefore = (await request('POST', '/api/payments/open-bills', { partyId: mehta, date: DATE }, owner)).body.onAccount;

  const preview = await request('POST', '/api/sales/cancel/preview', { invoice: bill.id }, owner);
  assert.ok(preview.body.effects.some((effect: string) => effect.startsWith('₹500.00 already received against this bill stays in your books as money held for Mehta Construction Supplies')), preview.body.effects.join('\n'));
  const cancelled = await request('POST', '/api/sales/cancel', { invoice: bill.id, reason: 'wrong customer' }, owner);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.onAccount.amount, 500);

  const open = await request('POST', '/api/payments/open-bills', { partyId: mehta, date: DATE }, owner);
  assert.equal(open.body.bills.some((row: any) => row.id === bill.id), false);
  assert.equal(open.body.onAccount, onAccountBefore + 500, 'the ₹500 is held for Mehta');
  assert.equal((await request('GET', '/api/reports', {}, owner)).body.trialBalance.balanced, true);
});

test('#233: a bill with a live e-invoice is cancelled only after the e-invoice is cancelled with the government', async () => {
  const { owner, mehta } = await shop();
  await request('POST', '/api/gst-returns/reopen', { period: MONTH, reason: 'test' }, owner);
  const bill = await sell(owner, mehtaSale(mehta, 'cancel-233-irn', '10'));
  const registered = await request('POST', '/api/einvoices/register', { invoice: bill.id, turnover: '80000000' }, owner);
  assert.equal(registered.status, 200, JSON.stringify(registered.body));
  assert.equal(registered.body.status, 'REGISTERED');

  const refused = await request('POST', '/api/sales/cancel', { invoice: bill.id, reason: 'made twice' }, owner);
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'SALES_CANCEL_EINVOICE_ACTIVE');
  const preview = await request('POST', '/api/sales/cancel/preview', { invoice: bill.id }, owner);
  assert.deepEqual(preview.body.clearFirst.map((row: any) => row.kind), ['EINVOICE']);

  const cancelled = await request('POST', '/api/sales/cancel', { invoice: bill.id, reason: 'made twice', cancelGovernmentDocuments: true }, owner);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.invoice.state, 'CANCELLED');
  const issued = await request('GET', '/api/einvoices/invoices', {}, owner);
  assert.equal(issued.body.invoices.some((row: any) => row.id === bill.id), false);
});

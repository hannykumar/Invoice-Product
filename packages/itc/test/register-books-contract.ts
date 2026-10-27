/**
 * Issue #366 — one contract suite for the purchase comparison's view of our own books, run against
 * the in-memory bill store (register-books-contract.test.ts) and against PostgreSQL as the
 * application role (register-books-contract.integration.test.ts).
 *
 * The books are derived from posted bills, so the suite posts bills and asks what the comparison
 * sees. Everything here is invented: no real business, GST number or person.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { CompanyId, IsoDate } from '@invoice/kernel';
import { syntheticGstin } from '../../masters/src/fixtures.ts';
import { billFor, type Scene } from '../../purchasing/test/purchasing-contract.ts';
import type { PurchaseBillRepository } from '../../purchasing/src/posting-ports.ts';
import type { PurchaseBill } from '../../purchasing/src/posting-types.ts';
import { RegisterPurchaseBooks, type PurchaseReturnSource } from '../src/register-books.ts';
import type { PurchaseReturnLike } from '../src/adapters.ts';
import { taxPeriod } from '../src/types.ts';

export interface BooksHarness {
  readonly bills: PurchaseBillRepository;
  scene(): Promise<Scene>;
  write<T>(companyId: CompanyId, work: () => Promise<T>): Promise<T>;
}

export const SUPPLIER_GSTIN = syntheticGstin('27', 'AAECS5678D');
const JULY = taxPeriod('2026-07');
const AUGUST = taxPeriod('2026-08');
const JUNE = taxPeriod('2026-06');
/** More paise than a JavaScript number can hold exactly. */
const HUGE = 9_007_199_254_740_993n;

const returnOf = (s: Scene, bill: PurchaseBill, over: Partial<PurchaseReturnLike> = {}): PurchaseReturnLike => ({
  id: crypto.randomUUID(), companyId: s.companyId, kind: 'PURCHASE_RETURN', number: 'DN/26-27/0001', documentDate: '2026-08-05',
  partyId: s.partyId, originalDocument: { id: bill.id, number: bill.invoiceNumber, date: bill.invoiceDate }, voucherId: crypto.randomUUID(),
  totals: {
    taxableValue: { minor: 10_000n }, cgst: { minor: 900n }, sgst: { minor: 900n }, utgst: { minor: 0n }, igst: { minor: 0n }, cess: { minor: 0n },
    ineligibleTax: { minor: 0n }, reverseChargeTax: { minor: 0n }, total: { minor: 11_800n },
  },
  lines: [{ quantity: { scaled: 50_000_000n, unit: 'KGS' }, supplyKind: 'GOODS' }], ...over,
});

export function registerBooksContract(label: string, harness: () => BooksHarness, skip: false | string = false): void {
  const make = (s: Scene, options: { registration?: string | null; gstin?: string | null; returns?: readonly PurchaseReturnLike[]; taxPoint?: IsoDate | null } = {}) => {
    const bills = harness().bills;
    const returns: PurchaseReturnSource = { list: async (companyId) => (options.returns ?? []).filter((note) => note.companyId === companyId) };
    return new RegisterPurchaseBooks({
      bills, returns,
      suppliers: {
        gstinOf: async (_company, party) => (party === s.partyId ? (options.gstin === undefined ? SUPPLIER_GSTIN : options.gstin) : null),
        registrationOf: async (_company, party) => (party === s.partyId ? (options.registration ?? 'regular') : null),
      },
      taxPointOf: async () => options.taxPoint ?? null,
    });
  };
  const post = (s: Scene, bill: PurchaseBill) => harness().write(s.companyId, () => harness().bills.insert(bill));

  test(`${label}: a posted bill reaches the comparison with every figure exact, from its own month on`, { skip }, async () => {
    const h = harness();
    const s = await h.scene();
    const bill = billFor(s, 1);
    await post(s, bill);
    const books = make(s);
    assert.deepEqual(await books.documentsFor(s.companyId, JUNE), [], 'a July bill is not June\'s');
    const [document] = await books.documentsFor(s.companyId, JULY);
    assert.ok(document !== undefined);
    assert.equal(document.sourceKind, 'purchase_bill');
    assert.equal(document.sourceId, bill.id);
    assert.equal(document.supplierGstin, SUPPLIER_GSTIN);
    assert.equal(document.number, bill.invoiceNumber);
    assert.equal(document.period, JULY);
    assert.equal(document.invoiceValue.minor, HUGE, 'paise above 2^53 survive');
    assert.equal(document.amounts.cgst.minor, 9_000n);
    assert.equal(document.reversed, false);
    // The same bill is still there in later months, so an unclaimed older bill is never hidden.
    assert.equal((await books.documentsFor(s.companyId, AUGUST)).length, 1);
  });

  test(`${label}: a supplier with no GST number on file travels as null, never guessed`, { skip }, async () => {
    const h = harness();
    const s = await h.scene();
    await post(s, billFor(s, 1));
    const [document] = await make(s, { gstin: null }).documentsFor(s.companyId, JULY);
    assert.equal(document?.supplierGstin, null);
  });

  test(`${label}: another company's bills are never seen`, { skip }, async () => {
    const h = harness();
    const a = await h.scene();
    const b = await h.scene();
    await post(a, billFor(a, 1));
    assert.deepEqual(await make(b).documentsFor(b.companyId, AUGUST), []);
    assert.equal((await make(a).documentsFor(a.companyId, AUGUST)).length, 1);
    // Asking for a's books under b's own context finds b's (nothing), whatever the supplier source says.
    assert.deepEqual(await make(a).documentsFor(b.companyId, AUGUST), []);
  });

  test(`${label}: a reversed bill is handed over as reversed, not dropped`, { skip }, async () => {
    const h = harness();
    const s = await h.scene();
    const bill = billFor(s, 1);
    await post(s, bill);
    await h.write(s.companyId, () => h.bills.update({ ...bill, state: 'REVERSED', reversedByVoucherId: crypto.randomUUID(), reversalReason: 'Entered twice' }));
    const [document] = await make(s).documentsFor(s.companyId, JULY);
    assert.equal(document?.reversed, true);
  });

  test(`${label}: blocked credit (s.17(5)) is counted in the tax charged and named as ineligible`, { skip }, async () => {
    const h = harness();
    const s = await h.scene();
    const bill = billFor(s, 1, {
      tax: { ...billFor(s, 1).tax, cgstPaise: 4_500n, sgstPaise: 4_500n, ineligibleItcPaise: 9_000n, ineligibleHeads: { cgstPaise: 4_500n, sgstPaise: 4_500n, igstPaise: 0n, cessPaise: 0n } },
    });
    await post(s, bill);
    const [document] = await make(s).documentsFor(s.companyId, JULY);
    assert.equal(document?.amounts.cgst.minor, 9_000n, 'what the portal shows: claimable plus blocked');
    assert.equal(document?.ineligibleItc.minor, 9_000n);
  });

  test(`${label}: a reverse-charge bill comes from its time of supply when that is the earlier month`, { skip }, async () => {
    const h = harness();
    const s = await h.scene();
    const bill = billFor(s, 1, { invoiceDate: '2026-07-20', tax: { ...billFor(s, 1).tax, reverseCharge: true } });
    await post(s, bill);
    const paidEarly = make(s, { taxPoint: '2026-06-25' as IsoDate });
    const [document] = await paidEarly.documentsFor(s.companyId, JUNE);
    assert.equal(document?.taxPointPeriod, JUNE);
    assert.deepEqual(await make(s).documentsFor(s.companyId, JUNE), [], 'with no earlier time of supply it waits for July');
  });

  test(`${label}: suppliers who file nothing that reaches GSTR-2B are marked, so the bill is not asked of the portal`, { skip }, async () => {
    const h = harness();
    const s = await h.scene();
    await post(s, billFor(s, 1));
    const [document] = await make(s, { registration: 'composition' }).documentsFor(s.companyId, JULY);
    assert.equal(document?.outsideGstr2b, true);
    const [unregistered] = await make(s, { registration: 'unregistered' }).documentsFor(s.companyId, JULY);
    assert.equal(unregistered?.inTable5, false);
  });

  test(`${label}: goods sent back are a credit note linked to their bill, from the month of the return`, { skip }, async () => {
    const h = harness();
    const s = await h.scene();
    const bill = billFor(s, 1);
    await post(s, bill);
    const sales = returnOf(s, bill, { kind: 'SALES_RETURN', number: 'CN/1' });
    const purchase = returnOf(s, bill);
    const books = make(s, { returns: [sales, purchase] });
    assert.equal((await books.documentsFor(s.companyId, JULY)).length, 1, 'August\'s return is not July\'s');
    const documents = await books.documentsFor(s.companyId, AUGUST);
    const credit = documents.find((document) => document.kind === 'CREDIT_NOTE');
    assert.equal(documents.length, 2, 'a sales return is not a purchase');
    assert.equal(credit?.original?.sourceId, bill.id);
    assert.equal(credit?.supplierName, bill.supplierName);
    assert.equal(credit?.awaitingSupplierNote, true);
  });

  test(`${label}: two readings at once give the same books`, { skip }, async () => {
    const h = harness();
    const s = await h.scene();
    for (let n = 1; n <= 5; n += 1) await post(s, billFor(s, n));
    const books = make(s);
    const readings = await Promise.all(Array.from({ length: 8 }, () => books.documentsFor(s.companyId, AUGUST)));
    for (const reading of readings) assert.deepEqual(reading, readings[0]);
    assert.equal(readings[0]?.length, 5);
  });
}

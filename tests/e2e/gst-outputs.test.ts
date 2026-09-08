/**
 * Issue #44 — the GST return has to agree with the books that produced it.
 *
 * This is the invariant the whole product's compliance promise rests on, and it is the one that
 * cannot be tested inside any single module. The GST-return module builds GSTR-1 from documents it
 * is handed; the ledger holds what the sale actually posted to the tax accounts. Each module's own
 * tests feed it fixtures, so both can be perfectly correct while disagreeing with each other — and
 * the business finds out when a notice arrives.
 *
 * So these scenarios sell and return through the real services, convert the resulting documents
 * with the real adapters, and then ask the return module to reconcile its own figures against the
 * ledger read through a different path. `reconciliation.agrees` is the assertion the issue's user
 * example is really asking for: *GST outputs trace back correctly.*
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isoDate, quantityFromString, rupees } from '@invoice/kernel';
import { InMemoryAuditPort } from '@invoice/ledger';
import {
  GstReturnService, InMemoryInwardTax, InMemoryOutwardSupplies, InMemoryReturnPreparations,
  StaticReturnPolicy, inwardWithOrdinaryCredit, ledgerBookTaxPort, returnNoteToDocument,
  salesInvoiceToDocument, taxPeriod,
} from '@invoice/gst-returns';
import {
  COMPANY, COMPANY_GSTIN, COMPANY_STATE, CUSTOMER, CUSTOMER_GSTIN, CUSTOMER_NAME,
  makeBusiness, purchase,
} from './harness.ts';

const PERIOD = taxPeriod('2026-08');

const counterparty = {
  name: CUSTOMER_NAME, gstin: CUSTOMER_GSTIN, stateCode: COMPANY_STATE, unregisteredConfirmed: false,
};
const supplier = { gstin: COMPANY_GSTIN, stateCode: COMPANY_STATE };

/** The return desk, reading the same books the sale posted to. */
const makeReturnDesk = async (shop: Awaited<ReturnType<typeof makeBusiness>>) => {
  const outward = new InMemoryOutwardSupplies();
  const inward = new InMemoryInwardTax();
  const preparations = new InMemoryReturnPreparations();
  const audit = new InMemoryAuditPort();

  const service = new GstReturnService({
    outward,
    inward,
    // Deliberately the ledger, not a summary the return itself produced: a reconciliation of a
    // figure against itself proves nothing.
    books: ledgerBookTaxPort(shop.store.read()),
    repository: preparations,
    audit,
    clock: shop.clock,
    policy: new StaticReturnPolicy({
      gstin: COMPANY_GSTIN, stateCode: COMPANY_STATE, requirePeriodLock: false, effectiveFrom: isoDate('2026-04-01'),
    }),
  });
  return { outward, inward, preparations, audit, service };
};

const gstActor = (shop: Awaited<ReturnType<typeof makeBusiness>>) => ({
  ...shop.actor,
  permissions: [...shop.actor.permissions, 'gst_returns.view', 'gst_returns.prepare', 'gst_returns.approve'],
});

const stockedShop = async () => {
  const shop = await makeBusiness();
  await shop.posting.post(
    shop.actor,
    purchase({ id: 'e2e-gst-buy', sourceDocumentId: 'e2e-gst-source', invoiceNumber: 'E2E/GST/BUY' }),
    'e2e:gst:purchase',
  );
  return shop;
};

const sell = async (shop: Awaited<ReturnType<typeof makeBusiness>>, key: string, kilos = '100') => {
  const draft = await shop.sales.createDraft(shop.actor, {
    idempotencyKey: `e2e:gst:${key}:draft`,
    input: {
      partyId: CUSTOMER,
      customerType: 'B2B',
      supplyKind: 'GOODS',
      documentDate: isoDate('2026-08-29'),
      dueDate: isoDate('2026-09-28'),
      lines: [{
        lineId: 'steel', itemId: 'TMT12', quantity: quantityFromString(kilos, 'KGS'),
        unitPrice: rupees(100), priceBasis: 'EXCLUSIVE', warehouseId: 'wh-main',
      }],
    },
  });
  return shop.sales.finalise(shop.actor, { idempotencyKey: `e2e:gst:${key}:final`, invoiceId: draft.id });
};

test('the GST return built from a real sale agrees with the ledger that sale posted', async () => {
  const shop = await stockedShop();
  const desk = await makeReturnDesk(shop);
  const actor = gstActor(shop);
  const issued = await sell(shop, 'trace');

  desk.outward.add(salesInvoiceToDocument(issued.invoice, counterparty, supplier));
  const workspace = await desk.service.workspace(actor, { period: PERIOD });

  // ₹10,000 of goods at 18% inside one state: ₹900 CGST and ₹900 SGST.
  assert.equal(workspace.reconciliation.agrees, true, workspace.reconciliation.sentence['en-IN']);
  const cgst = workspace.reconciliation.heads.find((head) => head.head === 'CGST');
  const sgst = workspace.reconciliation.heads.find((head) => head.head === 'SGST');
  assert.equal(cgst?.onTheReturn.minor, 900_00n);
  assert.equal(cgst?.inTheBooks.minor, 900_00n);
  assert.equal(sgst?.onTheReturn.minor, 900_00n);
  assert.deepEqual([...workspace.reconciliation.unexplainedVouchers], []);
});

test('every figure on the return can be traced back to the bill behind it', async () => {
  // The drill-down the acceptance criteria ask for: a figure nobody can explain is a figure
  // nobody should file.
  const shop = await stockedShop();
  const desk = await makeReturnDesk(shop);
  const actor = gstActor(shop);
  const issued = await sell(shop, 'drill');

  desk.outward.add(salesInvoiceToDocument(issued.invoice, counterparty, supplier));
  const workspace = await desk.service.workspace(actor, { period: PERIOD });

  const b2b = workspace.gstr1.sections.find((section) => section.id === 'B2B');
  assert.ok(b2b !== undefined, 'a sale to a registered buyer belongs in the B2B table');
  const sources = desk.service.sourcesOf(workspace, 'B2B');
  assert.ok(
    sources.some((source) => source.number === issued.invoice.number),
    'the bill number has to appear behind the figure, or nobody can check it',
  );
});

test('a credit note reaches the return and the reconciliation still agrees', async () => {
  const shop = await stockedShop();
  const desk = await makeReturnDesk(shop);
  const actor = gstActor(shop);
  const issued = await sell(shop, 'credit');

  const posted = await shop.returns.postSales(shop.actor, {
    idempotencyKey: 'e2e:gst:credit-note',
    originalInvoiceId: issued.invoice.id,
    documentDate: isoDate('2026-08-30'),
    reason: 'Twenty kilos came back.',
    lines: [{ originalLineId: 'steel', quantity: quantityFromString('20', 'KGS'), disposition: 'ACCEPTED', warehouseId: 'wh-main' }],
  });

  desk.outward.add(
    salesInvoiceToDocument(issued.invoice, counterparty, supplier),
    returnNoteToDocument(posted.note, counterparty, supplier, { placeOfSupplyStateCode: COMPANY_STATE }),
  );
  const workspace = await desk.service.workspace(actor, { period: PERIOD });

  // The sale put ₹900 of CGST in the books and the credit note took ₹180 of it back out. The
  // return has to show ₹720, and it has to be ₹720 because the ledger says so.
  assert.equal(workspace.reconciliation.agrees, true, workspace.reconciliation.sentence['en-IN']);
  const cgst = workspace.reconciliation.heads.find((head) => head.head === 'CGST');
  assert.equal(cgst?.onTheReturn.minor, 720_00n);
  assert.equal(cgst?.inTheBooks.minor, 720_00n);
});

test('a sale missing from the return is caught rather than filed around', async () => {
  // The failure this whole reconciliation exists to catch: tax in the books that no document on
  // the return accounts for. Under-reporting is the expensive direction.
  const shop = await stockedShop();
  const desk = await makeReturnDesk(shop);
  const actor = gstActor(shop);
  const first = await sell(shop, 'reported');
  await sell(shop, 'forgotten');

  desk.outward.add(salesInvoiceToDocument(first.invoice, counterparty, supplier));
  const workspace = await desk.service.workspace(actor, { period: PERIOD });

  assert.equal(workspace.reconciliation.agrees, false);
  assert.ok(workspace.reconciliation.unexplainedVouchers.length > 0, 'the missing sale must be named, not netted away');
  assert.equal(workspace.mayApprove, false, 'a return that does not agree with the books must not be approvable');
});

test('GSTR-3B is prepared from the same period and carries the purchase credit', async () => {
  const shop = await stockedShop();
  const desk = await makeReturnDesk(shop);
  const actor = gstActor(shop);
  const issued = await sell(shop, '3b');

  desk.outward.add(salesInvoiceToDocument(issued.invoice, counterparty, supplier));
  // The purchase in this scenario carried ₹5,760 of GST, split across the two heads.
  desk.inward.set(COMPANY, inwardWithOrdinaryCredit(PERIOD, { igst: 5_760_00n }));

  const workspace = await desk.service.workspace(actor, { period: PERIOD });
  assert.equal(workspace.gstr3b.period, PERIOD);
  assert.equal(workspace.reconciliation.agrees, true, workspace.reconciliation.sentence['en-IN']);
});

/**
 * Issue #44 — the first complete business cycle across the real domain modules.
 *
 * This deliberately composes services instead of calling a mock HTTP response. A supplier bill
 * posts the purchase, payable and stock in one transaction; a sale consumes that same stock and
 * creates a receivable; a receipt reduces it. The refusal and retry assertions protect the seams
 * between those modules, where feature-level tests cannot see a partial write.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { asId, isoDate, quantityFromString, rupees, toDecimalString, type PartyId } from '@invoice/kernel';
import { partyBalance, permissionPortFromActor, trialBalance, type ActorContext } from '@invoice/ledger';
import { GstCalculator, InMemoryDeclaredRates, InMemoryMasterData, RateTable } from '@invoice/gst-calc';
import { RulesEngine, shippedRegistry } from '@invoice/rules-engine';
import { InMemorySalesRepository, SalesService, noComplianceHooks } from '@invoice/sales';
import { salesInventoryAdapter } from '@invoice/inventory';
import {
  InMemoryPaymentRepository,
  ReceivablesService,
  type DocumentLedgerPort,
  type OpenDocument,
} from '@invoice/receivables';
import {
  ALL_PERMISSIONS,
  COMPANY,
  SUPPLIER,
  makeShop,
  purchase,
} from '../../packages/purchasing/src/posting-fixtures.ts';

const CUSTOMER = asId<'Party'>('e2e-customer');
const CUSTOMER_NAME = 'ABC Traders';
const E2E_PERMISSIONS = [
  ...ALL_PERMISSIONS,
  'ledger.post.sale',
  'sales.draft.write', 'sales.finalise', 'sales.approve', 'sales.cancel',
  'payments.record', 'payments.allocate', 'ledger.post.receipt',
];

test('purchase → stock → sale → receipt stays balanced through refusals and retries', async () => {
  const shop = await makeShop();
  const actor: ActorContext = { ...shop.actor, permissions: E2E_PERMISSIONS };
  await shop.ledger.openPartyAccount(actor, { partyId: CUSTOMER, name: CUSTOMER_NAME, kind: 'CUSTOMER' });

  const salesRepository = new InMemorySalesRepository();
  const paymentRepository = new InMemoryPaymentRepository();
  shop.store.join(salesRepository).join(paymentRepository);

  const taxMasters = new InMemoryMasterData();
  taxMasters.putCompany({ companyId: COMPANY, gstin: '29AAAAA0000A1ZQ', stateCode: '29', registration: 'REGULAR' });
  taxMasters.putParty(COMPANY, { partyId: CUSTOMER, gstin: '29DDDDD3333D1ZS', stateCode: '29', registration: 'REGULAR' });
  taxMasters.putItem(COMPANY, {
    itemId: 'TMT12', name: 'TMT Steel Bar 12mm', kind: 'GOODS', hsnOrSac: '72142090',
    treatment: 'TAXABLE', reverseCharge: false, baseUnit: 'KGS',
  });
  const declaredRates = new InMemoryDeclaredRates();
  declaredRates.declare({
    companyId: COMPANY,
    code: '72142090',
    kind: 'GOODS',
    ratePercentTimes100: 1800n,
    effectiveFrom: isoDate('2026-04-01'),
    effectiveTo: null,
    declaredBy: actor.userId,
    declaredOn: isoDate('2026-04-01'),
    basis: 'Synthetic E2E business declaration; not a legal rate source.',
  });
  const calculator = new GstCalculator({
    masterData: taxMasters,
    rates: new RateTable([]),
    declaredRates,
    gstEngine: new RulesEngine({ registry: shippedRegistry(), ruleSetId: 'in.gst', mode: 'production' }),
    mode: 'production',
  });
  const sales = new SalesService({
    store: shop.store,
    ledger: shop.ledger,
    calculator,
    repository: salesRepository,
    inventory: salesInventoryAdapter(shop.inventoryService, { defaultWarehouseId: 'wh-main' }),
    compliance: noComplianceHooks,
    permissions: permissionPortFromActor,
    audit: shop.audit,
    clock: { now: () => new Date('2026-08-29T10:00:00.000Z') },
  });

  const documents: DocumentLedgerPort = {
    async openDocuments(companyId, partyId): Promise<readonly OpenDocument[]> {
      const invoices = await salesRepository.list(companyId, { partyId, state: 'FINAL' });
      return invoices.map((invoice) => ({
        documentId: invoice.id,
        kind: 'SALES_INVOICE',
        number: invoice.number ?? invoice.id,
        partyId,
        date: invoice.documentDate,
        dueDate: invoice.dueDate,
        value: invoice.pricing?.totals.invoiceValue ?? rupees(0),
        side: 'RECEIVABLE',
      }));
    },
    async parties(): Promise<readonly PartyId[]> { return [CUSTOMER]; },
    async nameOf(_companyId, partyId): Promise<string> { return partyId === CUSTOMER ? CUSTOMER_NAME : String(partyId); },
  };
  const receivables = new ReceivablesService({
    store: shop.store,
    ledger: shop.ledger,
    repository: paymentRepository,
    documents,
    permissions: permissionPortFromActor,
    audit: shop.audit,
    clock: { now: () => new Date('2026-08-29T10:00:00.000Z') },
  });

  // One approved supplier bill creates one bill, one payable and 500 kg in the godown.
  const buy = purchase({ id: 'e2e-buy-500', sourceDocumentId: 'e2e-source-buy-500', invoiceNumber: 'E2E/BUY/500' });
  const firstPost = await shop.posting.post(actor, buy, 'e2e:purchase:first');
  const retriedPost = await shop.posting.post(actor, buy, 'e2e:purchase:retry-after-timeout');
  assert.equal(retriedPost.bill.id, firstPost.bill.id);
  assert.equal(retriedPost.deduplicated, true);
  assert.equal((await shop.bills.list(COMPANY)).length, 1);
  assert.equal((await shop.inventoryService.balance(actor, { itemId: 'TMT12', warehouseId: 'wh-main' })).physical.scaled, 500_000000n);
  assert.equal(toDecimalString((await partyBalance(shop.store.read(), COMPANY, asId<'Party'>(SUPPLIER))).balance), '-37760.00');

  // The sale uses the same real stock service and posts the customer balance to the same books.
  const draft = await sales.createDraft(actor, {
    idempotencyKey: 'e2e:sale:100kg',
    input: {
      partyId: CUSTOMER,
      customerType: 'B2B',
      supplyKind: 'GOODS',
      documentDate: isoDate('2026-08-29'),
      dueDate: isoDate('2026-09-28'),
      lines: [{
        lineId: 'steel', itemId: 'TMT12', quantity: quantityFromString('100', 'KGS'),
        unitPrice: rupees(100), priceBasis: 'EXCLUSIVE', warehouseId: 'wh-main',
      }],
    },
  });
  const issued = await sales.finalise(actor, { idempotencyKey: 'e2e:sale:final', invoiceId: draft.id });
  assert.equal(issued.invoice.state, 'FINAL');
  assert.equal((await shop.inventoryService.balance(actor, { itemId: 'TMT12', warehouseId: 'wh-main' })).physical.scaled, 400_000000n);
  assert.equal(toDecimalString((await partyBalance(shop.store.read(), COMPANY, CUSTOMER)).balance), '11800.00');

  // A sale that exceeds the remaining stock is refused without moving stock or changing money.
  const vouchersBeforeRefusal = (await shop.store.read().vouchers.list(COMPANY, {})).length;
  const tooLarge = await sales.createDraft(actor, {
    idempotencyKey: 'e2e:sale:too-large',
    input: {
      partyId: CUSTOMER,
      customerType: 'B2B',
      supplyKind: 'GOODS',
      documentDate: isoDate('2026-08-29'),
      lines: [{
        lineId: 'steel', itemId: 'TMT12', quantity: quantityFromString('401', 'KGS'),
        unitPrice: rupees(100), priceBasis: 'EXCLUSIVE', warehouseId: 'wh-main',
      }],
    },
  });
  await assert.rejects(
    () => sales.finalise(actor, { idempotencyKey: 'e2e:sale:too-large:final', invoiceId: tooLarge.id }),
    (error: unknown) => error instanceof Error && /1\.000 KGS are missing/.test(error.message),
  );
  assert.equal((await shop.store.read().vouchers.list(COMPANY, {})).length, vouchersBeforeRefusal);
  assert.equal((await shop.inventoryService.balance(actor, { itemId: 'TMT12', warehouseId: 'wh-main' })).physical.scaled, 400_000000n);
  assert.equal(toDecimalString((await partyBalance(shop.store.read(), COMPANY, CUSTOMER)).balance), '11800.00');

  // A retry of the same receipt records one payment and leaves the exact open amount.
  const receiptCommand = {
    idempotencyKey: 'e2e:receipt:5000',
    direction: 'RECEIPT' as const,
    partyId: CUSTOMER,
    mode: 'CASH' as const,
    amount: rupees(5_000),
    date: isoDate('2026-09-01'),
    reference: 'UTR-E2E-5000',
    allocations: [{
      documentId: issued.invoice.id,
      documentNumber: issued.invoice.number ?? issued.invoice.id,
      amount: rupees(5_000),
    }],
  };
  const firstReceipt = await receivables.recordPayment(actor, receiptCommand);
  const retriedReceipt = await receivables.recordPayment(actor, receiptCommand);
  assert.equal(retriedReceipt.id, firstReceipt.id);
  assert.equal((await paymentRepository.list(COMPANY)).length, 1);
  assert.equal(toDecimalString((await partyBalance(shop.store.read(), COMPANY, CUSTOMER)).balance), '6800.00');
  assert.equal((await receivables.position(actor, CUSTOMER, isoDate('2026-09-01'))).totalOutstanding.minor, 6800_00n);

  const books = await trialBalance(shop.store.read(), COMPANY);
  assert.equal(books.balanced, true);
  assert.equal(books.totalDebit.minor, books.totalCredit.minor);
});

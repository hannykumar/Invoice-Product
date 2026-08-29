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
import { partyBalance, permissionPortFromActor, trialBalance, type Account, type ActorContext } from '@invoice/ledger';
import { GstCalculator, InMemoryDeclaredRates, InMemoryMasterData, RateTable } from '@invoice/gst-calc';
import { RulesEngine, shippedRegistry } from '@invoice/rules-engine';
import { InMemorySalesRepository, SalesService, noComplianceHooks } from '@invoice/sales';
import { salesInventoryAdapter } from '@invoice/inventory';
import { BankReconciliationService, fromBankTransaction, fromPayment } from '@invoice/bank-reconciliation';
import { DelimitedStatementParser, StatementImportService, type RequestContext } from '../../packages/platform/src/index.ts';
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
  await shop.store.transaction(COMPANY, async (uow) => {
    const bankHeading = await uow.accounts.findByCode(COMPANY, '1120');
    assert.ok(bankHeading, 'the standard chart must have a bank-account heading');
    const bankAccount: Account = {
      id: asId<'Account'>(`${COMPANY}:acc:1121`),
      companyId: COMPANY,
      code: '1121',
      name: 'Current bank account',
      type: 'ASSET',
      parentId: bankHeading.id,
      isGroup: false,
      active: true,
      partyId: null,
      systemRole: null,
    };
    await uow.accounts.insertMany([bankAccount]);
  });

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

  // A retry of the same bank receipt records one payment and leaves the exact open amount.
  const receiptCommand = {
    idempotencyKey: 'e2e:receipt:5000',
    direction: 'RECEIPT' as const,
    partyId: CUSTOMER,
    mode: 'BANK_TRANSFER' as const,
    bankAccountCode: '1121',
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

  // The bank's CSV is normalized, then reconciled against the payment the books actually hold.
  const importContext: RequestContext = {
    companyId: COMPANY,
    branchId: String(actor.branchId),
    actorId: actor.userId,
    sessionId: 'e2e-bank-session',
    permissions: new Set(['bank.statement.import', 'bank.balance.read']),
  };
  const imports = new StatementImportService([new DelimitedStatementParser()]);
  const statement = await imports.import(importContext, {
    format: 'csv',
    fileName: 'e2e-bank.csv',
    content: 'Date,Description,Debit,Credit,Reference\n01/09/2026,NEFT from ABC Traders,,5000.00,UTR-E2E-5000',
  }, { openingBalancePaise: 0n, closingBalancePaise: 5000_00n });
  assert.equal(statement.status, 'ready');
  assert.equal(statement.balanceStatus, 'matched');

  const [bankTransaction] = imports.transactionsFor(importContext, statement.id);
  assert.ok(bankTransaction);
  const bookPayment = fromPayment(firstReceipt);
  assert.ok(bookPayment, 'a cleared bank transfer must be visible to reconciliation');
  const reconciliationContext = {
    companyId: COMPANY,
    actorId: actor.userId,
    permissions: new Set(['bank.reconcile', 'bank.reconcile.confirm']),
  };
  const reconciliation = new BankReconciliationService(undefined, () => new Date('2026-09-01T12:00:00.000Z'));
  const matched = reconciliation.reconcile(reconciliationContext, [fromBankTransaction(bankTransaction)], [bookPayment]);
  assert.equal(matched.matches.length, 1);
  assert.equal(matched.matches[0]?.status, 'AUTO_MATCHED');
  assert.equal(matched.exceptions.length, 0);
  assert.deepEqual(reconciliation.auditFor(reconciliationContext, matched.matches[0]!.id).map((event) => event.action), ['reconciliation.auto_matched']);

  // Money visible only at the bank becomes review work. Importing and reconciling it never invents
  // a receipt or changes the ledger behind the user's back.
  const vouchersBeforeUnmatchedBankLine = (await shop.store.read().vouchers.list(COMPANY, {})).length;
  const customerBeforeUnmatchedBankLine = (await partyBalance(shop.store.read(), COMPANY, CUSTOMER)).balance.minor;
  const unexplained = await imports.import(importContext, {
    format: 'csv',
    fileName: 'e2e-unexplained-bank-money.csv',
    content: 'Date,Description,Debit,Credit,Reference\n02/09/2026,Unknown incoming transfer,,250.00,UTR-UNKNOWN-250',
  });
  const unexplainedLines = imports.transactionsFor(importContext, unexplained.id).map(fromBankTransaction);
  const needsReview = reconciliation.reconcile(reconciliationContext, unexplainedLines, []);
  assert.ok(needsReview.exceptions.some((item) => item.kind === 'MISSING_BOOK'));
  assert.equal(needsReview.suggestedPayments.length, 1, 'the product suggests work; it does not post it');
  assert.equal((await shop.store.read().vouchers.list(COMPANY, {})).length, vouchersBeforeUnmatchedBankLine);
  assert.equal((await partyBalance(shop.store.read(), COMPANY, CUSTOMER)).balance.minor, customerBeforeUnmatchedBankLine);

  const books = await trialBalance(shop.store.read(), COMPANY);
  assert.equal(books.balanced, true);
  assert.equal(books.totalDebit.minor, books.totalCredit.minor);
});

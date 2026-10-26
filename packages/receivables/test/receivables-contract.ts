/**
 * Issue #366 — one contract for where payments and advances are kept, run against the in-memory
 * stores (receivables-contract.test.ts) and against PostgreSQL (receivables-contract.integration.test.ts).
 *
 * The same assertions, through the repositories directly and through the real ReceivablesService
 * and AdvanceService on a real ledger, hold for both. Only synthetic data: every test makes its own
 * company with fresh uuids.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainError, fixedClock, isoDate, money, type AccountId, type CompanyId, type IsoDate, type Money, type PartyId, type UserId, type VoucherId } from '@invoice/kernel';
import { buildDefaultChart, InMemoryAuditPort, LedgerService, permissionPortFromActor, type Account, type ActorContext, type LedgerStore } from '@invoice/ledger';
import type { PreSaleDocument } from '@invoice/sales';
import { AdvanceService, type AdvanceReceipt, type AdvanceRepository } from '../src/advance.ts';
import type { Payment } from '../src/model.ts';
import type { PaymentRepository } from '../src/ports.ts';
import { ReceivablesService } from '../src/service.ts';
import { FakeDocuments } from './fixtures.ts';

export interface ShopIds {
  companyId: string; branch: string; userId: string; customer: string; supplier: string; item: string; warehouse: string;
}

/** Where the records live. A fresh one for each test. */
export interface World {
  store: LedgerStore;
  payments: PaymentRepository;
  advances: AdvanceRepository;
  /** One unit of work for the company: everything in it is saved together or not at all. */
  unit<T>(companyId: string, work: () => Promise<T>): Promise<T>;
  /** The company and its branch, the clerk, the customer and the supplier, wherever the backend needs them to exist. */
  seedCompany(ids: ShopIds): Promise<void>;
  /** An issued sales bill of ₹354.00, with what it is owed (`document_settlements` on PostgreSQL). */
  seedBill(ids: ShopIds, billId: string, number: string, voucherId: string): Promise<void>;
  seedProforma(ids: ShopIds, proformaId: string, number: string): Promise<void>;
  /** What the database says has been paid of a bill; undefined where only the service knows. */
  settled?(companyId: string, billId: string): Promise<bigint | undefined>;
}

const PERMISSIONS = [
  'ledger.setup', 'ledger.post.receipt', 'ledger.post.payment', 'ledger.post.journal', 'ledger.reverse',
  'payments.record', 'payments.allocate', 'payments.reverse', 'payments.write_off',
];
const BILL = 35_400n;
const on = (date: string): IsoDate => isoDate(date);
const paise = (minor: bigint): Money => money(minor);
const refusedWith = (code: string) => (error: unknown): boolean => {
  assert.ok(error instanceof DomainError, `expected a DomainError, got ${String(error)}`);
  assert.equal(error.code, code, error.message);
  return true;
};
const byId = <T extends { id: string }>(rows: readonly T[]): T[] => [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));

/** A synthetic shop with books, a customer, a supplier, a bank account and a proforma, on whichever backend. */
const openShop = async (world: World) => {
  const ids: ShopIds = {
    companyId: crypto.randomUUID(), branch: crypto.randomUUID(), userId: crypto.randomUUID(), customer: crypto.randomUUID(), supplier: crypto.randomUUID(),
    item: crypto.randomUUID(), warehouse: crypto.randomUUID(),
  };
  await world.seedCompany(ids);
  const companyId = ids.companyId as CompanyId;
  // A real branch: the ledger's PostgreSQL store keeps a voucher's branch as a uuid and has no 'main'.
  const actor: ActorContext = { companyId, branchId: ids.branch as ActorContext['branchId'], userId: ids.userId as UserId, permissions: PERMISSIONS };
  const clock = fixedClock('2026-04-12T10:00:00.000Z');
  const audit = new InMemoryAuditPort();
  const ledger = new LedgerService({ store: world.store, permissions: permissionPortFromActor, audit, clock });
  const codes = new Map<string, AccountId>();
  const accountFor = (code: string): AccountId => {
    if (!codes.has(code)) codes.set(code, crypto.randomUUID() as AccountId);
    return codes.get(code) as AccountId;
  };
  const bank: Account = {
    id: accountFor('1121'), companyId, code: '1121', name: 'Synthetic Bank Current Account', type: 'ASSET', parentId: accountFor('1120'),
    isGroup: false, active: true, partyId: null, systemRole: null,
  };
  await ledger.initialiseCompany(actor, { booksStartDate: on('2026-04-01'), accounts: [...buildDefaultChart(companyId, accountFor), bank] });
  const customerAccount = await ledger.openPartyAccount(actor, { partyId: ids.customer, name: 'Synthetic Customer', kind: 'CUSTOMER' });
  await ledger.openPartyAccount(actor, { partyId: ids.supplier, name: 'Synthetic Supplier', kind: 'SUPPLIER' });
  // A ledger entry for the bills to point at.
  const entry = await ledger.postVoucher(actor, {
    idempotencyKey: 'sales-entry', type: 'JOURNAL', date: on('2026-04-10'), narration: 'Synthetic sales', lines: [
      { accountId: customerAccount.id, partyId: ids.customer, debit: paise(BILL), credit: paise(0n) },
      { accountId: accountFor('4100'), debit: paise(0n), credit: paise(BILL) },
    ],
  });
  const voucherId = entry.voucher.id;

  const documents = new FakeDocuments();
  const open: Parameters<FakeDocuments['set']>[0] = [];
  const receivables = new ReceivablesService({ store: world.store, ledger, repository: world.payments, documents, permissions: permissionPortFromActor, audit, clock });
  const proformas = new Map<string, PreSaleDocument>();
  const advances = new AdvanceService({
    store: world.store, ledger, receivables, proformas: { findById: async (_c, id) => proformas.get(id) ?? null },
    repository: world.advances, permissions: permissionPortFromActor, audit, clock,
  });
  let bills = 0;
  /** An issued bill of ₹354.00 to the customer. */
  const issueBill = async () => {
    const id = crypto.randomUUID();
    const number = `INV/26-27/${String((bills += 1)).padStart(6, '0')}`;
    await world.seedBill(ids, id, number, voucherId);
    open.push({ documentId: id, kind: 'SALES_INVOICE', number, partyId: ids.customer as PartyId, date: on('2026-04-10'), dueDate: on('2026-05-10'), value: paise(BILL), side: 'RECEIVABLE' });
    documents.set(open);
    return { id, number };
  };
  /** A supplier's bill of ₹354.00. Purchase bills have no settlement row yet (sales-schema-v1, "Known limits"). */
  const supplierBill = () => {
    const id = crypto.randomUUID();
    open.push({ documentId: id, kind: 'PURCHASE_INVOICE', number: `SUP-${id.slice(0, 6)}`, partyId: ids.supplier as PartyId, date: on('2026-04-10'), dueDate: null, value: paise(BILL), side: 'PAYABLE' });
    documents.set(open);
    return open.at(-1) as (typeof open)[number];
  };
  /** A proforma for one repair job: ₹10,000.00 and 18% GST, ₹11,800.00. */
  const proforma = async (): Promise<PreSaleDocument> => {
    const id = crypto.randomUUID();
    const number = `PI/26-27/${String(proformas.size + 1).padStart(7, '0')}`;
    await world.seedProforma(ids, id, number);
    const document = {
      id, companyId, kind: 'PROFORMA', state: 'ISSUED', number, documentDate: on('2026-04-05'), partyId: ids.customer, supplyKind: 'SERVICES', invoice: null,
      pricing: {
        placeOfSupplyStateCode: '07',
        totals: { invoiceValue: paise(1_180_000n) },
        lines: [{ kind: 'GOODS', itemName: 'Crate repair work', hsnOrSac: '9987', ratePercentTimes100: 1800n, reverseCharge: false, lineTotal: paise(1_180_000n),
          cgst: paise(90_000n), sgst: paise(90_000n), utgst: paise(0n), igst: paise(0n), cess: paise(0n) }],
      },
    } as unknown as PreSaleDocument;
    proformas.set(id, document);
    return document;
  };
  const invoiced = (document: PreSaleDocument, bill: { id: string; number: string }): PreSaleDocument => {
    const next = { ...document, state: 'INVOICED', invoice: { invoiceId: bill.id, invoiceNumber: bill.number, invoiceDate: on('2026-04-10') } } as unknown as PreSaleDocument;
    proformas.set(document.id, next);
    return next;
  };

  /** A payment as the service would write it, for the repository-level tests. Branch 'main' is the services' "no branch". */
  const payment = (over: Partial<Payment> = {}): Payment => {
    const id = crypto.randomUUID();
    return {
      id, companyId, branchId: 'main' as Payment['branchId'], direction: 'RECEIPT', partyId: ids.customer as PartyId, mode: 'CASH', amount: paise(10_000n),
      date: on('2026-04-11'), reference: null, bankAccountCode: null, cheque: null, allocations: [], refundOf: null, state: 'RECORDED',
      voucherId, reversalVoucherId: null, reversalReason: null, narration: null, recordedBy: ids.userId as UserId,
      recordedAt: '2026-04-11T10:00:00.000Z', idempotencyKey: `pay:${id}`, version: 1, ...over,
    };
  };
  let advancesMade = 0;
  const advance = (paymentId: string, proformaId: string, over: Partial<AdvanceReceipt> = {}): AdvanceReceipt => {
    const id = crypto.randomUUID();
    return {
      id, companyId, branchId: 'main' as AdvanceReceipt['branchId'], number: `RV/26-27/${String((advancesMade += 1)).padStart(5, '0')}`,
      financialYear: '2026-27', date: on('2026-04-06'), proformaId, proformaNumber: 'PI/26-27/0000001', partyId: ids.customer as PartyId,
      supplyKind: 'SERVICES', placeOfSupplyStateCode: '07', description: 'Crate repair work (SAC 9987)', amount: paise(1_180_000n),
      tax: {
        lines: [
          { ratePercentTimes100: 1800n, reverseCharge: false, taxableValue: paise(1_000_000n), cgst: paise(90_000n), sgst: paise(90_000n), utgst: paise(0n), igst: paise(0n), cess: paise(0n) },
          { ratePercentTimes100: null, reverseCharge: true, taxableValue: paise(5_000n), cgst: paise(0n), sgst: paise(0n), utgst: paise(0n), igst: paise(0n), cess: paise(0n) },
        ],
        taxableValue: paise(1_005_000n), cgst: paise(90_000n), sgst: paise(90_000n), utgst: paise(0n), igst: paise(0n), cess: paise(0n), totalTax: paise(180_000n),
      },
      paymentId, taxVoucherId: voucherId as VoucherId, application: null, refund: null, recordedBy: ids.userId as UserId,
      recordedAt: '2026-04-06T09:30:00.000Z', idempotencyKey: `advance:${id}`, version: 1, ...over,
    };
  };
  const unit = <T>(work: () => Promise<T>) => world.unit(ids.companyId, work);
  return { ids, companyId, actor, ledger, receivables, advances, documents, issueBill, supplierBill, proforma, invoiced, payment, advance, unit, voucherId };
};

export function receivablesContract(label: string, makeWorld: () => World, skip: false | string = false): void {
  const shop = async () => {
    const world = makeWorld();
    return { world, ...(await openShop(world)) };
  };

  test(`${label}: a payment reads back exactly as written, cheque history, allocations and all`, { skip }, async () => {
    const s = await shop();
    const bill = await s.issueBill();
    const cheque = s.payment({
      mode: 'CHEQUE', amount: paise(9_007_199_254_740_993n), reference: 'Counter receipt 41', bankAccountCode: '1121', narration: 'Synthetic cheque',
      branchId: 'main' as Payment['branchId'],
      cheque: { number: '000123', chequeDate: on('2026-04-11'), bankName: null, history: [
        { state: 'PENDING', on: on('2026-04-11'), by: s.ids.userId as UserId, at: '2026-04-11T10:00:00.123Z', note: null },
        { state: 'DEPOSITED', on: on('2026-04-12'), by: s.ids.userId as UserId, at: '2026-04-12T09:00:00.000Z', note: 'Paid in at the counter' },
      ] },
      allocations: [{ documentId: bill.id, documentNumber: bill.number, amount: paise(35_000n) }],
    });
    const advanceToSupplier = s.payment({
      direction: 'PAYMENT', partyId: s.ids.supplier as PartyId, amount: paise(50_000n), advanceToSupplier: true,
      advanceParticulars: { purchaseOrder: { number: 'PO-17', date: on('2026-04-01') }, supplierReceiptVoucher: null },
    });
    await s.unit(async () => { await s.world.payments.insert(cheque); await s.world.payments.insert(advanceToSupplier); });

    assert.deepEqual(await s.world.payments.findById(s.companyId, cheque.id), cheque);
    assert.deepEqual(await s.world.payments.findByIdempotencyKey(s.companyId, cheque.idempotencyKey), cheque);
    assert.deepEqual(await s.world.payments.findById(s.companyId, advanceToSupplier.id), advanceToSupplier);
    assert.deepEqual(byId(await s.world.payments.list(s.companyId)), byId([cheque, advanceToSupplier]));
    assert.deepEqual(await s.world.payments.listForParty(s.companyId, s.ids.supplier as PartyId), [advanceToSupplier]);
    assert.equal(await s.world.payments.findById(s.companyId, crypto.randomUUID()), null, 'not found');
    assert.equal(await s.world.payments.findByIdempotencyKey(s.companyId, 'never-used'), null);
    assert.equal(await s.world.settled?.(s.companyId, bill.id) ?? 35_000n, 35_000n);
  });

  test(`${label}: a repeated key is refused, and a unit of work that fails leaves nothing behind`, { skip }, async () => {
    const s = await shop();
    const first = s.payment();
    await s.unit(() => s.world.payments.insert(first));
    await assert.rejects(s.unit(() => s.world.payments.insert({ ...s.payment(), idempotencyKey: first.idempotencyKey })), refusedWith('PAYMENT_DUPLICATE'));

    const lost = s.payment();
    await assert.rejects(s.unit(async () => { await s.world.payments.insert(lost); throw new Error('the till lost power'); }), /lost power/);
    assert.equal(await s.world.payments.findById(s.companyId, lost.id), null);
    assert.deepEqual(await s.world.payments.list(s.companyId), [first]);
  });

  test(`${label}: an update against a stale version or a missing payment is refused`, { skip }, async () => {
    const s = await shop();
    const p = s.payment();
    await s.unit(() => s.world.payments.insert(p));
    await assert.rejects(s.unit(() => s.world.payments.update({ ...p, version: 3 }, 2)), refusedWith('PAYMENT_CONCURRENT_EDIT'));
    await assert.rejects(s.unit(() => s.world.payments.update({ ...s.payment(), version: 2 }, 1)), refusedWith('PAYMENT_NOT_FOUND'));
    assert.deepEqual(await s.world.payments.findById(s.companyId, p.id), p, 'nothing changed');
  });

  test(`${label}: one company cannot read or change another company's payments and advances`, { skip }, async () => {
    const world = makeWorld();
    const [a, b] = [await openShop(world), await openShop(world)];
    const p = a.payment();
    const proforma = await a.proforma();
    const adv = a.advance(p.id, proforma.id);
    await a.unit(async () => { await world.payments.insert(p); await world.advances.insert(adv); });
    assert.equal(await world.payments.findById(b.companyId, p.id), null);
    assert.equal(await world.payments.findByIdempotencyKey(b.companyId, p.idempotencyKey), null);
    assert.deepEqual(await world.payments.list(b.companyId), []);
    assert.deepEqual(await world.payments.listForParty(b.companyId, a.ids.customer as PartyId), []);
    await assert.rejects(b.unit(() => world.payments.update({ ...p, companyId: b.companyId, version: 2 }, 1)), refusedWith('PAYMENT_NOT_FOUND'));
    assert.equal(await world.advances.findById(b.companyId, adv.id), null);
    assert.equal(await world.advances.findByIdempotencyKey(b.companyId, adv.idempotencyKey), null);
    assert.deepEqual(await world.advances.list(b.companyId), []);
    await assert.rejects(b.unit(() => world.advances.update({ ...adv, companyId: b.companyId, version: 2 }, 1)), refusedWith('ADVANCE_NOT_FOUND'));
    assert.deepEqual(await world.payments.findById(a.companyId, p.id), p, 'still there for its own company');
  });

  test(`${label}: pages of payments and advances return every row exactly once`, { skip }, async () => {
    const s = await shop();
    const proforma = await s.proforma();
    const payments = Array.from({ length: 5 }, () => s.payment());
    const advances = payments.slice(0, 3).map((p) => s.advance(p.id, proforma.id));
    await s.unit(async () => {
      for (const p of payments) await s.world.payments.insert(p);
      for (const a of advances) await s.world.advances.insert(a);
    });
    const walk = async <T extends { id: string }>(read: (after?: string) => Promise<T[]>) => {
      const seen: T[] = [];
      for (let page = await read(); page.length > 0; page = await read(page.at(-1)?.id)) {
        assert.ok(page.length <= 2);
        seen.push(...page);
      }
      return seen;
    };
    const all = await walk((after) => s.world.payments.list(s.companyId, { limit: 2, ...(after === undefined ? {} : { after }) }));
    assert.deepEqual(all, byId(payments), 'every payment once, in id order');
    assert.deepEqual(await walk((after) => s.world.payments.listForParty(s.companyId, s.ids.customer as PartyId, { limit: 2, ...(after === undefined ? {} : { after }) })), byId(payments));
    assert.deepEqual(await walk((after) => s.world.advances.list(s.companyId, { proformaId: proforma.id }, { limit: 2, ...(after === undefined ? {} : { after }) })), byId(advances));
    assert.equal((await s.world.payments.list(s.companyId)).length, 5, 'without a page, everything');
  });

  test(`${label}: an advance reads back exactly, gains its application and its refund once, and refuses a stale version`, { skip }, async () => {
    const s = await shop();
    const bill = await s.issueBill();
    const proforma = await s.proforma();
    const [moneyIn, moneyOut, goodsMoney] = [s.payment({ amount: paise(1_180_000n) }), s.payment({ direction: 'PAYMENT', amount: paise(1_000_000n) }), s.payment()];
    const services = s.advance(moneyIn.id, proforma.id);
    const goods = s.advance(goodsMoney.id, proforma.id, { supplyKind: 'GOODS', tax: null, taxVoucherId: null, amount: paise(10_000n) });
    await s.unit(async () => {
      for (const p of [moneyIn, moneyOut, goodsMoney]) await s.world.payments.insert(p);
      await s.world.advances.insert(services);
      await s.world.advances.insert(goods);
    });
    assert.deepEqual(await s.world.advances.findById(s.companyId, services.id), services);
    assert.deepEqual(await s.world.advances.findByIdempotencyKey(s.companyId, goods.idempotencyKey), goods);
    assert.deepEqual(byId(await s.world.advances.list(s.companyId, { proformaId: proforma.id })), byId([services, goods]));
    assert.deepEqual(await s.world.advances.list(s.companyId, { proformaId: crypto.randomUUID() }), []);
    await assert.rejects(s.unit(() => s.world.advances.insert({ ...s.advance(moneyIn.id, proforma.id), idempotencyKey: services.idempotencyKey })), refusedWith('ADVANCE_DUPLICATE'));

    const zero = { cgst: paise(0n), sgst: paise(0n), utgst: paise(0n), igst: paise(0n), cess: paise(0n) };
    const applied: AdvanceReceipt = {
      ...services, version: 2,
      application: { invoiceId: bill.id, invoiceNumber: bill.number, invoiceDate: on('2026-04-10'), amount: paise(35_400n), taxSetOff: { ...zero, cgst: paise(2_700n), sgst: paise(2_700n) }, voucherId: null, by: s.ids.userId as UserId, at: '2026-04-10T12:00:00.000Z' },
    };
    await s.unit(() => s.world.advances.update(applied, 1));
    await assert.rejects(s.unit(() => s.world.advances.update({ ...applied, version: 3 }, 1)), refusedWith('ADVANCE_CONCURRENT_EDIT'));
    await assert.rejects(s.unit(() => s.world.advances.update({ ...goods, id: crypto.randomUUID(), version: 2 }, 1)), refusedWith('ADVANCE_NOT_FOUND'));
    const refunded: AdvanceReceipt = {
      ...applied, version: 3,
      refund: { number: 'RFV/26-27/00001', date: on('2026-04-12'), amount: paise(1_144_600n), taxRefunded: { ...zero, cgst: paise(87_300n), sgst: paise(87_300n) }, paymentId: moneyOut.id, voucherId: s.voucherId, reason: 'Job cancelled', by: s.ids.userId as UserId, at: '2026-04-12T12:00:00.000Z' },
    };
    await s.unit(() => s.world.advances.update(refunded, 2));
    assert.deepEqual(await s.world.advances.findById(s.companyId, services.id), refunded);
    assert.deepEqual(await s.world.advances.findById(s.companyId, goods.id), goods, 'the other advance is untouched');
  });

  test(`${label}: a cheque goes from pending to deposited to cleared, keeping every step and its allocation`, { skip }, async () => {
    const s = await shop();
    const bill = await s.issueBill();
    const recorded = await s.receivables.recordPayment(s.actor, {
      idempotencyKey: 'cheque-1', direction: 'RECEIPT', partyId: s.ids.customer as PartyId, mode: 'CHEQUE', amount: paise(BILL), date: on('2026-04-11'),
      cheque: { number: '004512', chequeDate: on('2026-04-11'), bankName: 'Synthetic Co-operative Bank' },
      allocations: [{ documentId: bill.id, documentNumber: bill.number, amount: paise(BILL) }],
    });
    assert.deepEqual(await s.receivables.payment(s.actor, recorded.id), recorded);
    assert.equal(await s.world.settled?.(s.companyId, bill.id) ?? BILL, BILL);
    const deposited = await s.receivables.recordChequeEvent(s.actor, recorded.id, 'DEPOSITED', { on: on('2026-04-12') }, recorded.version);
    const cleared = await s.receivables.recordChequeEvent(s.actor, recorded.id, 'CLEARED', { on: on('2026-04-14'), bankAccountCode: '1121' }, deposited.version);
    const read = await s.receivables.payment(s.actor, recorded.id);
    assert.deepEqual(read, cleared);
    assert.deepEqual(read?.cheque?.history.map((e) => e.state), ['PENDING', 'DEPOSITED', 'CLEARED']);
    assert.deepEqual(read?.allocations, recorded.allocations);
    const position = await s.receivables.position(s.actor, s.ids.customer as PartyId, on('2026-04-14'));
    assert.equal(position.chequesNotCleared.minor, 0n);
    assert.equal(position.totalOutstanding.minor, 0n);
    // A retry of the original command finds the same payment.
    assert.deepEqual(await s.receivables.recordPayment(s.actor, {
      idempotencyKey: 'cheque-1', direction: 'RECEIPT', partyId: s.ids.customer as PartyId, mode: 'CHEQUE', amount: paise(BILL), date: on('2026-04-11'),
      cheque: { number: '004512', chequeDate: on('2026-04-11') },
    }), read);
  });

  test(`${label}: a bounced cheque releases what it settled, and the bill is owed again`, { skip }, async () => {
    const s = await shop();
    const bill = await s.issueBill();
    const recorded = await s.receivables.recordPayment(s.actor, {
      idempotencyKey: 'cheque-2', direction: 'RECEIPT', partyId: s.ids.customer as PartyId, mode: 'CHEQUE', amount: paise(BILL), date: on('2026-04-11'),
      cheque: { number: '004513', chequeDate: on('2026-04-11') },
      allocations: [{ documentId: bill.id, documentNumber: bill.number, amount: paise(BILL) }],
    });
    const bounced = await s.receivables.recordChequeEvent(s.actor, recorded.id, 'BOUNCED', { on: on('2026-04-13'), note: 'Insufficient funds' }, recorded.version);
    const read = await s.receivables.payment(s.actor, recorded.id);
    assert.deepEqual(read, bounced);
    assert.equal(read?.state, 'REVERSED');
    assert.equal(read?.reversalReason, 'Insufficient funds');
    assert.deepEqual(read?.allocations, []);
    assert.deepEqual(read?.cheque?.history.map((e) => [e.state, e.note]), [['PENDING', null], ['BOUNCED', 'Insufficient funds']]);
    assert.equal(await s.world.settled?.(s.companyId, bill.id) ?? 0n, 0n);
    assert.equal((await s.receivables.position(s.actor, s.ids.customer as PartyId, on('2026-04-13'))).totalOutstanding.minor, BILL);
  });

  test(`${label}: an undone payment releases its bills, says why, and undoing it again changes nothing`, { skip }, async () => {
    const s = await shop();
    const bill = await s.issueBill();
    const recorded = await s.receivables.recordPayment(s.actor, {
      idempotencyKey: 'cash-1', direction: 'RECEIPT', partyId: s.ids.customer as PartyId, mode: 'CASH', amount: paise(50_000n), date: on('2026-04-11'),
      allocations: [{ documentId: bill.id, documentNumber: bill.number, amount: paise(20_000n) }],
    });
    const reversed = await s.receivables.reversePayment(s.actor, recorded.id, { on: on('2026-04-12'), reason: 'Entered twice' });
    assert.deepEqual(await s.receivables.payment(s.actor, recorded.id), reversed);
    assert.equal(reversed.state, 'REVERSED');
    assert.deepEqual(reversed.allocations, []);
    assert.deepEqual(await s.receivables.reversePayment(s.actor, recorded.id, { on: on('2026-04-12'), reason: 'Entered twice' }), reversed);
    assert.equal(await s.world.settled?.(s.companyId, bill.id) ?? 0n, 0n);
  });

  test(`${label}: re-deciding which bills a payment settles releases the old choice and keeps what did not change`, { skip }, async () => {
    const s = await shop();
    const [first, second] = [await s.issueBill(), await s.issueBill()];
    const recorded = await s.receivables.recordPayment(s.actor, {
      idempotencyKey: 'cash-2', direction: 'RECEIPT', partyId: s.ids.customer as PartyId, mode: 'CASH', amount: paise(BILL), date: on('2026-04-11'),
      allocations: [{ documentId: first.id, documentNumber: first.number, amount: paise(BILL) }],
    });
    const moved = await s.receivables.allocate(s.actor, recorded.id, [
      { documentId: first.id, documentNumber: first.number, amount: paise(10_000n) },
      { documentId: second.id, documentNumber: second.number, amount: paise(25_400n) },
    ], recorded.version);
    assert.deepEqual(await s.receivables.payment(s.actor, recorded.id), moved);
    assert.equal(await s.world.settled?.(s.companyId, first.id) ?? 10_000n, 10_000n);
    assert.equal(await s.world.settled?.(s.companyId, second.id) ?? 25_400n, 25_400n);
  });

  test(`${label}: a supplier's advance is taken off their bill once, however often it is asked`, { skip }, async () => {
    const s = await shop();
    const paid = await s.receivables.recordPayment(s.actor, {
      idempotencyKey: 'advance-out', direction: 'PAYMENT', partyId: s.ids.supplier as PartyId, mode: 'BANK_TRANSFER', bankAccountCode: '1121', amount: paise(100_000n), date: on('2026-04-08'),
      advanceToSupplier: true, advanceParticulars: { purchaseOrder: null, supplierReceiptVoucher: { number: 'SRV-9', date: on('2026-04-08') } },
    });
    assert.deepEqual(await s.receivables.payment(s.actor, paid.id), paid);
    const bill = s.supplierBill();
    const command = { partyId: s.ids.supplier as PartyId, documentId: bill.documentId, documentNumber: bill.number, amount: paise(BILL), date: on('2026-04-10'), idempotencyKey: 'use-1' };
    const uses = await s.receivables.useSupplierAdvance(s.actor, command);
    assert.deepEqual(uses.map((u) => [u.paymentId, u.amount.minor]), [[paid.id, BILL]]);
    const read = await s.receivables.payment(s.actor, paid.id);
    assert.deepEqual(read?.allocations, [{ documentId: bill.documentId, documentNumber: bill.number, amount: paise(BILL), adjustedFromAdvance: true }]);
    assert.equal(read?.version, 2);
    assert.deepEqual(await s.receivables.useSupplierAdvance(s.actor, command), [{ paymentId: paid.id, amount: paise(BILL), voucherId: null }]);
    assert.equal((await s.receivables.position(s.actor, s.ids.supplier as PartyId, on('2026-04-10'))).advancesPaid.minor, 100_000n - BILL);
  });

  test(`${label}: an advance against a proforma is recorded, applied to its bill, and the rest refunded`, { skip }, async () => {
    const s = await shop();
    const bill = await s.issueBill();
    const proforma = await s.proforma();
    const recorded = await s.advances.record(s.actor, { idempotencyKey: 'adv-1', proformaId: proforma.id, amount: paise(1_180_000n), date: on('2026-04-06'), mode: 'CASH' });
    assert.equal(recorded.number, 'RV/26-27/00001');
    assert.equal(recorded.tax?.totalTax.minor, 180_000n);
    assert.deepEqual(await s.world.advances.findById(s.companyId, recorded.id), recorded);
    assert.deepEqual(await s.advances.record(s.actor, { idempotencyKey: 'adv-1', proformaId: proforma.id, amount: paise(1_180_000n), date: on('2026-04-06'), mode: 'CASH' }), recorded, 'a retry is the same voucher');

    await s.advances.applyToInvoice(s.actor, s.invoiced(proforma, bill));
    const applied = await s.world.advances.findById(s.companyId, recorded.id);
    assert.equal(applied?.application?.amount.minor, BILL, 'the bill took only what it was owed');
    assert.equal(applied?.version, 2);
    assert.equal(await s.world.settled?.(s.companyId, bill.id) ?? BILL, BILL);

    const refunded = await s.advances.refund(s.actor, { idempotencyKey: 'refund-1', advanceId: recorded.id, reason: 'Rest of the job cancelled', date: on('2026-04-12'), mode: 'CASH' });
    assert.equal(refunded.refund?.number, 'RFV/26-27/00001');
    assert.equal(refunded.refund?.amount.minor, 1_180_000n - BILL);
    assert.deepEqual(await s.world.advances.findById(s.companyId, recorded.id), refunded);
    assert.deepEqual(await s.advances.forProforma(s.actor, proforma.id), [refunded]);
    const refundPayment = await s.receivables.payment(s.actor, refunded.refund?.paymentId as string);
    assert.equal(refundPayment?.refundOf, recorded.paymentId);
  });

  test(`${label}: two people applying one payment at the same moment never settle more than it`, { skip }, async () => {
    const s = await shop();
    const [first, second] = [await s.issueBill(), await s.issueBill()];
    const recorded = await s.receivables.recordPayment(s.actor, {
      idempotencyKey: 'cash-3', direction: 'RECEIPT', partyId: s.ids.customer as PartyId, mode: 'CASH', amount: paise(BILL), date: on('2026-04-11'),
    });
    const outcomes = await Promise.allSettled([first, second].map((bill) =>
      s.receivables.allocate(s.actor, recorded.id, [{ documentId: bill.id, documentNumber: bill.number, amount: paise(BILL) }], recorded.version)));
    assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
    const refused = outcomes.find((o) => o.status === 'rejected');
    assert.ok(refused !== undefined && refusedWith('PAYMENT_CONCURRENT_EDIT')((refused as PromiseRejectedResult).reason));
    const read = await s.receivables.payment(s.actor, recorded.id);
    assert.equal(read?.allocations.reduce((t, a) => t + a.amount.minor, 0n), BILL);
    const settled = [await s.world.settled?.(s.companyId, first.id), await s.world.settled?.(s.companyId, second.id)];
    if (settled[0] !== undefined) assert.deepEqual(settled.sort(), [0n, BILL]);
  });

  // Issue #295 — the bill can also be settled without money: TDS the customer deducted (a
  // receivable from the government, never the customer's debt), a discount allowed, or a small
  // balance written off. Each books its own account and frees the bill.
  test(`${label}: TDS deducted, a discount and a write-off settle bills, and the receipt carries them`, { skip }, async () => {
    const s = await shop();
    const [tdsBill, discountBill, smallBill] = [await s.issueBill(), await s.issueBill(), await s.issueBill()];
    const recorded = await s.receivables.recordPayment(s.actor, {
      idempotencyKey: 'settle-1', direction: 'RECEIPT', partyId: s.ids.customer as PartyId, mode: 'BANK_TRANSFER', bankAccountCode: '1121',
      amount: paise(3n * BILL - 5_000n - 2_000n - 60n), date: on('2026-04-11'),
      allocations: [
        { documentId: tdsBill.id, documentNumber: tdsBill.number, amount: paise(BILL - 5_000n) },
        { documentId: discountBill.id, documentNumber: discountBill.number, amount: paise(BILL - 2_000n) },
        { documentId: smallBill.id, documentNumber: smallBill.number, amount: paise(BILL - 60n) },
      ],
      settlements: [
        { documentId: tdsBill.id, documentNumber: tdsBill.number, kind: 'TDS_DEDUCTED', amount: paise(5_000n), tdsSection: '194Q', tdsQuarter: 'Q1-2026-27', tdsCertificate: null },
        { documentId: discountBill.id, documentNumber: discountBill.number, kind: 'DISCOUNT_ALLOWED', amount: paise(2_000n) },
        { documentId: smallBill.id, documentNumber: smallBill.number, kind: 'BALANCE_WRITTEN_OFF', amount: paise(60n) },
      ],
      writeOffLimit: paise(100n),
    });
    const read = await s.receivables.payment(s.actor, recorded.id);
    assert.equal(read?.settlements?.length, 3);
    const position = await s.receivables.position(s.actor, s.ids.customer as PartyId, on('2026-04-11'));
    assert.equal(position.totalOutstanding.minor, 0n, 'the three bills are settled, not partly owed');
    // The cash received is only the money: allocations, never the adjustments.
    assert.equal(recorded.allocations.reduce((t, a) => t + a.amount.minor, 0n), 3n * BILL - 5_000n - 2_000n - 60n);
    // The TDS receivable report carries the deduction with its quarter.
    const tds = await s.receivables.tdsReceivable(s.actor);
    assert.equal(tds.length, 1);
    assert.equal(tds[0]?.settlement.amount.minor, 5_000n);
    assert.equal(tds[0]?.settlement.tdsQuarter, 'Q1-2026-27');
    // A retry of the same command finds the same payment and never settles twice.
    assert.deepEqual(await s.receivables.recordPayment(s.actor, { idempotencyKey: 'settle-1', direction: 'RECEIPT', partyId: s.ids.customer as PartyId, mode: 'BANK_TRANSFER', amount: paise(1n), date: on('2026-04-11') }), read);
  });

  test(`${label}: undoing a receipt releases its settlements, and the bills are owed again`, { skip }, async () => {
    const s = await shop();
    const bill = await s.issueBill();
    const recorded = await s.receivables.recordPayment(s.actor, {
      idempotencyKey: 'settle-undo', direction: 'RECEIPT', partyId: s.ids.customer as PartyId, mode: 'CASH', amount: paise(BILL - 500n), date: on('2026-04-11'),
      allocations: [{ documentId: bill.id, documentNumber: bill.number, amount: paise(BILL - 500n) }],
      settlements: [{ documentId: bill.id, documentNumber: bill.number, kind: 'TDS_DEDUCTED', amount: paise(500n), tdsSection: '194C', tdsQuarter: 'Q1-2026-27', tdsCertificate: null }],
    });
    assert.equal((await s.receivables.position(s.actor, s.ids.customer as PartyId, on('2026-04-11'))).totalOutstanding.minor, 0n);
    const reversed = await s.receivables.reversePayment(s.actor, recorded.id, { on: on('2026-04-12'), reason: 'Entered on the wrong day' });
    assert.equal(reversed.settlements, undefined, 'the released settlements fall away entirely');
    assert.equal((await s.receivables.position(s.actor, s.ids.customer as PartyId, on('2026-04-12'))).totalOutstanding.minor, BILL);
    assert.equal((await s.receivables.tdsReceivable(s.actor)).length, 0, 'an undone receipt owes no TDS back');
  });

  test(`${label}: the rules on a settlement are refused before anything is kept`, { skip }, async () => {
    const s = await shop();
    const bill = await s.issueBill();
    const base = { direction: 'RECEIPT' as const, partyId: s.ids.customer as PartyId, mode: 'CASH' as const, amount: paise(BILL), date: on('2026-04-11') };
    // TDS without its section.
    await assert.rejects(() => s.receivables.recordPayment(s.actor, {
      ...base, idempotencyKey: 'bad-tds',
      settlements: [{ documentId: bill.id, documentNumber: bill.number, kind: 'TDS_DEDUCTED', amount: paise(100n), tdsSection: null, tdsQuarter: null, tdsCertificate: null }],
    }), refusedWith('TDS_SECTION_REQUIRED'));
    // A write-off past the owner's limit.
    await assert.rejects(() => s.receivables.recordPayment(s.actor, {
      ...base, idempotencyKey: 'bad-write-off', writeOffLimit: paise(100n),
      settlements: [{ documentId: bill.id, documentNumber: bill.number, kind: 'BALANCE_WRITTEN_OFF', amount: paise(10_001n) }],
    }), refusedWith('WRITE_OFF_OVER_LIMIT'));
    // More settled than is owed.
    await assert.rejects(() => s.receivables.recordPayment(s.actor, {
      ...base, idempotencyKey: 'bad-total', writeOffLimit: paise(BILL),
      allocations: [{ documentId: bill.id, documentNumber: bill.number, amount: paise(BILL) }],
      settlements: [{ documentId: bill.id, documentNumber: bill.number, kind: 'DISCOUNT_ALLOWED', amount: paise(1n) }],
    }), refusedWith('SETTLEMENT_EXCEEDS_OUTSTANDING'));
    // A bill nobody knows.
    await assert.rejects(() => s.receivables.recordPayment(s.actor, {
      ...base, idempotencyKey: 'bad-bill',
      settlements: [{ documentId: 'ghost', documentNumber: 'GHOST-1', kind: 'DISCOUNT_ALLOWED', amount: paise(1n) }],
    }), refusedWith('SETTLEMENT_UNKNOWN_DOCUMENT'));
    // Any of them on money paid out.
    await assert.rejects(() => s.receivables.recordPayment(s.actor, {
      idempotencyKey: 'bad-paid', direction: 'PAYMENT', partyId: s.ids.supplier as PartyId, mode: 'CASH', amount: paise(100n), date: on('2026-04-11'),
      settlements: [{ documentId: bill.id, documentNumber: bill.number, kind: 'BALANCE_WRITTEN_OFF', amount: paise(50n) }],
    }), refusedWith('SETTLEMENT_ON_MONEY_PAID'));
    // A write-off needs the write-off permission even when it arrives on a receipt.
    const clerk: ActorContext = { ...s.actor, permissions: s.actor.permissions.filter((p) => p !== 'payments.write_off') };
    await assert.rejects(() => s.receivables.recordPayment(clerk, {
      ...base, idempotencyKey: 'clerk-write-off', writeOffLimit: paise(BILL),
      settlements: [{ documentId: bill.id, documentNumber: bill.number, kind: 'BALANCE_WRITTEN_OFF', amount: paise(50n) }],
    }), refusedWith('PERMISSION_DENIED'));
    // Nothing was kept.
    assert.equal((await s.receivables.paymentsFor(s.actor, s.ids.customer as PartyId)).filter((p) => p.idempotencyKey.startsWith('bad-')).length, 0);
  });
}

export type Shop = Awaited<ReturnType<typeof openShop>>;
export { openShop };

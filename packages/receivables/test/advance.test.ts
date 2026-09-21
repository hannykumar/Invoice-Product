/**
 * Issue #165 — money received against a proforma, checked against the issue's four "done when"s,
 * on the real ledger, the real sales till, the real proforma service and the real receivables:
 *
 *  - an advance against a proforma gets a receipt voucher in its own series, with Rule 50's particulars;
 *  - for services the GST on it is worked out and owed; for goods the voucher says none is due;
 *  - linking the tax invoice applies the advance and sets that tax off, never charging it twice;
 *  - if no invoice follows, a refund voucher pays it back and takes the tax back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, fixedClock, formatINR, type AccountId, type Money } from '@invoice/kernel';
import { InMemoryAuditPort, permissionPortFromActor, type SystemAccountRole } from '@invoice/ledger';
import type { DraftInvoiceInput, PreSaleInput } from '@invoice/sales';
import { ABC, GURUGRAM, actorWith, inr, on, qty } from '../../sales/test/fixtures.ts';
import { makeSalesCounter, PRESALE_PERMISSIONS_FOR_TESTS, type SalesCounter } from '../../sales/test/presale-fixtures.ts';
import { InMemoryPaymentRepository } from '../src/repository.ts';
import { ReceivablesService } from '../src/service.ts';
import { AdvanceService, InMemoryAdvanceRepository, GOODS_ADVANCE_NO_TAX } from '../src/advance.ts';
import type { DocumentLedgerPort } from '../src/ports.ts';

const PERMISSIONS = [...PRESALE_PERMISSIONS_FOR_TESTS, 'ledger.post.receipt', 'ledger.post.payment', 'payments.record', 'payments.allocate'];

const refusedWith = (code: string) => (error: unknown): boolean => {
  assert.ok(error instanceof DomainError, `expected a DomainError, got ${String(error)}`);
  assert.equal(error.code, code, error.message);
  return true;
};

interface Shop {
  counter: SalesCounter;
  advances: AdvanceService;
  receivables: ReceivablesService;
  actor: ReturnType<typeof actorWith>;
  /** Debit less credit across every entry in the books. */
  balance: (role: SystemAccountRole) => Promise<bigint>;
  journalCount: () => Promise<number>;
}

const open = async (): Promise<Shop> => {
  let advances: AdvanceService | undefined;
  const counter = await makeSalesCounter({
    permissions: PERMISSIONS,
    advances: { applyToInvoice: (actor, proforma) => (advances as AdvanceService).applyToInvoice(actor, proforma) },
  });
  const { till } = counter;
  const payments = new InMemoryPaymentRepository();
  till.store.join(payments);
  const documents: DocumentLedgerPort = {
    async openDocuments(companyId, partyId) {
      return (await till.repository.list(companyId, { state: 'FINAL', partyId })).map((i) => ({
        documentId: i.id, kind: 'SALES_INVOICE' as const, number: i.number as string, partyId, date: i.documentDate,
        dueDate: null, value: i.pricing?.totals.invoiceValue as Money, side: 'RECEIVABLE' as const,
      }));
    },
    parties: async () => [],
    nameOf: async () => 'ABC Traders',
  };
  const clock = fixedClock('2026-05-12T11:04:00.000Z');
  const receivables = new ReceivablesService({ store: till.store, ledger: till.ledger, repository: payments, documents, permissions: permissionPortFromActor, audit: new InMemoryAuditPort(), clock });
  const repository = new InMemoryAdvanceRepository();
  till.store.join(repository);
  let n = 0;
  advances = new AdvanceService({
    store: till.store, ledger: till.ledger, receivables, proformas: counter.repository, repository,
    permissions: permissionPortFromActor, audit: counter.audit, clock, idFactory: () => `adv-${(n += 1)}`,
  });
  const vouchers = () => till.store.transaction(till.actor.companyId, async (uow) => uow.vouchers.list(till.actor.companyId, {}));
  return {
    counter, advances, receivables, actor: counter.actor,
    async balance(role) {
      const account: AccountId = till.account(role);
      return (await vouchers()).flatMap((v) => v.lines).filter((l) => l.accountId === account).reduce((t, l) => t + l.debit.minor - l.credit.minor, 0n);
    },
    journalCount: async () => (await vouchers()).length,
  };
};

/** One crate repair job at ₹10,000 before GST: ₹11,800 with 18%. */
const repairJob = (overrides: Partial<PreSaleInput> = {}): PreSaleInput => ({
  partyId: ABC,
  customerType: 'B2B',
  supplyKind: 'SERVICES',
  documentDate: on('2026-05-10'),
  lines: [{ lineId: 'l1', itemId: 'REPAIR', quantity: qty('1', 'JOB'), unitPrice: inr(10_000), priceBasis: 'EXCLUSIVE' }],
  purpose: 'Advance for the May repair of all crates',
  ...overrides,
});

const proformaFor = (shop: Shop, key: string, input: PreSaleInput) =>
  shop.counter.presale.issue(shop.actor, { kind: 'PROFORMA', idempotencyKey: key, input });

const bill = async (shop: Shop, key: string, input: Partial<DraftInvoiceInput>) => {
  const { till } = shop.counter;
  const draft = await till.service.createDraft(shop.actor, {
    idempotencyKey: `inv-${key}`,
    input: {
      partyId: ABC, customerType: 'B2B', supplyKind: 'SERVICES', documentDate: on('2026-05-12'),
      lines: [{ lineId: 'l1', itemId: 'REPAIR', quantity: qty('1', 'JOB'), unitPrice: inr(10_000), priceBasis: 'EXCLUSIVE' }],
      ...input,
    },
  });
  return (await till.service.finalise(shop.actor, { idempotencyKey: `fin-${key}`, invoiceId: draft.id })).invoice;
};

const take = (shop: Shop, key: string, proformaId: string, amount: Money) =>
  shop.advances.record(shop.actor, { idempotencyKey: key, proformaId, amount, date: on('2026-05-11'), mode: 'CASH' });

test('an advance for services gets a receipt voucher, and the GST in it is owed now', async () => {
  const shop = await open();
  const proforma = await proformaFor(shop, 'p', repairJob());
  assert.equal(formatINR(proforma.pricing.totals.invoiceValue), '₹11,800.00');

  const advance = await take(shop, 'a1', proforma.id, inr(11_800));
  assert.equal(advance.number, 'RV/26-27/00001');
  assert.equal(advance.proformaNumber, proforma.number);
  assert.equal(advance.partyId, ABC);
  assert.equal(advance.description, `Crate repair work (SAC 9987) — advance against proforma ${proforma.number}`);
  assert.equal(advance.placeOfSupplyStateCode, '07');
  // ₹11,800 includes the tax: ₹10,000 and ₹1,800, split CGST and SGST because Delhi sells to Delhi.
  assert.equal(formatINR(advance.tax?.taxableValue as Money), '₹10,000.00');
  assert.equal(formatINR(advance.tax?.cgst as Money), '₹900.00');
  assert.equal(formatINR(advance.tax?.sgst as Money), '₹900.00');
  assert.equal(advance.tax?.igst.minor, 0n);
  assert.deepEqual(advance.tax?.lines.map((l) => [l.ratePercentTimes100, l.reverseCharge]), [[1800n, false]]);

  // The books: the money is in the till, the customer holds it on account, the tax is owed.
  assert.equal(await shop.balance('CASH_IN_HAND'), 1_180_000n);
  assert.equal(await shop.balance('OUTPUT_CGST'), -90_000n);
  assert.equal(await shop.balance('OUTPUT_SGST'), -90_000n);
  assert.equal(await shop.balance('GST_ON_ADVANCES'), 180_000n);
  assert.equal(formatINR((await shop.receivables.position(shop.actor, ABC, on('2026-05-11'))).onAccount), '₹11,800.00');

  // A retry is the same voucher: no second number, no second entry.
  const entries = await shop.journalCount();
  assert.equal((await take(shop, 'a1', proforma.id, inr(11_800))).number, 'RV/26-27/00001');
  assert.equal(await shop.journalCount(), entries);
});

test('an advance for goods owes no GST, and its voucher says so', async () => {
  const shop = await open();
  const proforma = await proformaFor(shop, 'p', {
    partyId: ABC, customerType: 'B2B', supplyKind: 'GOODS', documentDate: on('2026-05-10'), purpose: 'Advance for 40 crates',
    lines: [{ lineId: 'l1', itemId: 'CRATE-P', quantity: qty('40', 'PCS'), unitPrice: inr(210), priceBasis: 'EXCLUSIVE' }],
  });
  const advance = await take(shop, 'g1', proforma.id, inr(5_000));
  assert.equal(advance.tax, null);
  assert.equal(advance.taxVoucherId, null);
  assert.equal(advance.description, `Plastic crate (HSN 3923) — advance against proforma ${proforma.number}`);
  assert.match(GOODS_ADVANCE_NO_TAX['en-IN'], /Notification 66\/2017-Central Tax/);
  assert.equal(await shop.balance('GST_ON_ADVANCES'), 0n);
  assert.equal(await shop.balance('OUTPUT_CGST'), 0n);
  // The second advance takes the next number in the voucher's own series.
  assert.equal((await take(shop, 'g2', proforma.id, inr(1_000))).number, 'RV/26-27/00002');
});

test('linking the tax invoice applies the advance and sets off its tax, so GST is charged once', async () => {
  const shop = await open();
  const proforma = await proformaFor(shop, 'p', repairJob());
  const advance = await take(shop, 'a1', proforma.id, inr(11_800));
  const invoice = await bill(shop, 'full', {});

  await shop.counter.presale.linkInvoice(shop.actor, { proformaId: proforma.id, invoiceId: invoice.id });
  const [applied] = await shop.advances.forProforma(shop.actor, proforma.id);
  assert.equal(applied?.application?.invoiceNumber, invoice.number);
  assert.equal(formatINR(applied?.application?.amount as Money), '₹11,800.00');

  // The invoice charged ₹900 + ₹900 again; the advance's ₹900 + ₹900 were set off against it.
  assert.equal(await shop.balance('OUTPUT_CGST'), -90_000n);
  assert.equal(await shop.balance('OUTPUT_SGST'), -90_000n);
  assert.equal(await shop.balance('GST_ON_ADVANCES'), 0n);
  const position = await shop.receivables.position(shop.actor, ABC, on('2026-05-12'));
  assert.equal(position.documents.find((d) => d.document.documentId === invoice.id)?.status, 'SETTLED');
  assert.equal(position.onAccount.minor, 0n);

  // Linking again changes nothing.
  const entries = await shop.journalCount();
  await shop.counter.presale.linkInvoice(shop.actor, { proformaId: proforma.id, invoiceId: invoice.id });
  assert.equal(await shop.journalCount(), entries);
  assert.equal((await shop.advances.forProforma(shop.actor, proforma.id))[0]?.version, applied?.version);

  // Nothing is left to refund, and a billed proforma takes no more advances.
  await assert.rejects(shop.advances.refund(shop.actor, { advanceId: advance.id, idempotencyKey: 'r', date: on('2026-05-13'), mode: 'CASH', reason: 'x' }), refusedWith('ADVANCE_NOTHING_TO_REFUND'));
  await assert.rejects(take(shop, 'late', proforma.id, inr(100)), refusedWith('ADVANCE_PROFORMA_INVOICED'));
});

test('a bill smaller than the advance takes only what it owes; the rest, with its tax, is refunded', async () => {
  const shop = await open();
  const proforma = await proformaFor(shop, 'p', repairJob());
  const advance = await take(shop, 'a1', proforma.id, inr(11_800));
  // Half the job was done: ₹5,000 + ₹900 GST.
  const invoice = await bill(shop, 'half', { lines: [{ lineId: 'l1', itemId: 'REPAIR', quantity: qty('1', 'JOB'), unitPrice: inr(5_000), priceBasis: 'EXCLUSIVE' }] });
  await shop.counter.presale.linkInvoice(shop.actor, { proformaId: proforma.id, invoiceId: invoice.id });

  const [applied] = await shop.advances.forProforma(shop.actor, proforma.id);
  assert.equal(formatINR(applied?.application?.amount as Money), '₹5,900.00');
  assert.equal(formatINR(applied?.application?.taxSetOff.cgst as Money), '₹450.00');
  assert.equal(await shop.balance('GST_ON_ADVANCES'), 90_000n);
  assert.equal(formatINR((await shop.receivables.position(shop.actor, ABC, on('2026-05-12'))).onAccount), '₹5,900.00');

  const refunded = await shop.advances.refund(shop.actor, { advanceId: advance.id, idempotencyKey: 'r1', date: on('2026-05-14'), mode: 'CASH', reason: 'The rest of the job was cancelled' });
  assert.equal(refunded.refund?.number, 'RFV/26-27/00001');
  assert.equal(formatINR(refunded.refund?.amount as Money), '₹5,900.00');
  assert.equal(formatINR(refunded.refund?.taxRefunded.sgst as Money), '₹450.00');
  // Everything nets: the tax owed is the bill's, the held tax is gone, the customer holds nothing.
  assert.equal(await shop.balance('OUTPUT_CGST'), -45_000n);
  assert.equal(await shop.balance('GST_ON_ADVANCES'), 0n);
  assert.equal(await shop.balance('CASH_IN_HAND'), 590_000n);
  assert.equal((await shop.receivables.position(shop.actor, ABC, on('2026-05-14'))).onAccount.minor, 0n);
});

test('when no invoice follows, a refund voucher pays the advance back and takes the tax back', async () => {
  const shop = await open();
  const proforma = await proformaFor(shop, 'p', repairJob({ partyId: GURUGRAM }));
  const advance = await take(shop, 'a1', proforma.id, inr(5_900));
  // Delhi to Haryana: IGST.
  assert.equal(formatINR(advance.tax?.igst as Money), '₹900.00');
  assert.equal(advance.tax?.cgst.minor, 0n);
  assert.equal(await shop.balance('OUTPUT_IGST'), -90_000n);

  await shop.counter.presale.cancel(shop.actor, { id: proforma.id, reason: 'The customer called the job off' });
  await assert.rejects(take(shop, 'a2', proforma.id, inr(100)), refusedWith('ADVANCE_PROFORMA_CANCELLED'));
  await assert.rejects(shop.advances.refund(shop.actor, { advanceId: advance.id, idempotencyKey: 'r', date: on('2026-05-14'), mode: 'CASH', reason: ' ' }), refusedWith('ADVANCE_REFUND_REASON_REQUIRED'));

  const refunded = await shop.advances.refund(shop.actor, { advanceId: advance.id, idempotencyKey: 'r', date: on('2026-05-14'), mode: 'CASH', reason: 'Job called off' });
  assert.equal(refunded.refund?.number, 'RFV/26-27/00001');
  assert.equal(formatINR(refunded.refund?.amount as Money), '₹5,900.00');
  assert.equal(await shop.balance('OUTPUT_IGST'), 0n);
  assert.equal(await shop.balance('GST_ON_ADVANCES'), 0n);
  assert.equal(await shop.balance('CASH_IN_HAND'), 0n);
  assert.equal((await shop.receivables.position(shop.actor, GURUGRAM, on('2026-05-14'))).onAccount.minor, 0n);

  // Asking again returns the same refund voucher rather than paying twice.
  const entries = await shop.journalCount();
  assert.equal((await shop.advances.refund(shop.actor, { advanceId: advance.id, idempotencyKey: 'r2', date: on('2026-05-14'), mode: 'CASH', reason: 'again' })).refund?.number, 'RFV/26-27/00001');
  assert.equal(await shop.journalCount(), entries);
});

test('what an advance cannot be: more than the proforma asked, zero, dated before it, or against a quotation', async () => {
  const shop = await open();
  const proforma = await proformaFor(shop, 'p', repairJob());
  await take(shop, 'a1', proforma.id, inr(10_000));
  await assert.rejects(take(shop, 'a2', proforma.id, inr(1_801)), refusedWith('ADVANCE_MORE_THAN_PROFORMA'));
  await assert.rejects(take(shop, 'a3', proforma.id, inr(0)), refusedWith('ADVANCE_AMOUNT_NOT_POSITIVE'));
  await assert.rejects(
    shop.advances.record(shop.actor, { idempotencyKey: 'a4', proformaId: proforma.id, amount: inr(1), date: on('2026-05-09'), mode: 'CASH' }),
    refusedWith('ADVANCE_BEFORE_PROFORMA'),
  );
  const quotation = await shop.counter.presale.issue(shop.actor, { kind: 'QUOTATION', idempotencyKey: 'q', input: repairJob({ purpose: null }) });
  await assert.rejects(take(shop, 'a5', quotation.id, inr(1)), refusedWith('ADVANCE_NOT_A_PROFORMA'));
  // A refused advance took no money: only the first one is on account.
  assert.equal(formatINR((await shop.receivables.position(shop.actor, ABC, on('2026-05-11'))).onAccount), '₹10,000.00');
});

test('someone who may not record money cannot take an advance', async () => {
  const shop = await open();
  const proforma = await proformaFor(shop, 'p', repairJob());
  const clerk = actorWith(PRESALE_PERMISSIONS_FOR_TESTS);
  await assert.rejects(
    shop.advances.record(clerk, { idempotencyKey: 'a', proformaId: proforma.id, amount: inr(100), date: on('2026-05-11'), mode: 'CASH' }),
    refusedWith('PERMISSION_DENIED'),
  );
});

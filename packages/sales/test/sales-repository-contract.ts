/**
 * Issue #366 — one contract for the sales repositories (bills, quotations and proformas, delivery
 * challans), run against the in-memory stores (sales-repository-contract.test.ts) and against
 * PostgreSQL (sales-repository-contract.integration.test.ts). Synthetic data only.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { money, quantityFromString, type CompanyId, type IsoDate, type Money, type PartyId, type UserId, type VoucherId } from '@invoice/kernel';
import type { ComputedTaxLine } from '@invoice/gst-calc';
import type { ChallanRepository } from '../src/challan-repository.ts';
import type { DeliveryChallan } from '../src/challan-model.ts';
import type { InvoicePricing, SalesInvoice, SalesInvoiceLineInput } from '../src/model.ts';
import type { SalesRepository } from '../src/ports.ts';
import type { PreSaleDocument } from '../src/presale-model.ts';
import type { PreSaleRepository } from '../src/presale-repository.ts';

/** A company wherever the implementation keeps one: a person, a customer, two items, a godown and two posted ledger entries. */
export interface SalesShop {
  readonly companyId: CompanyId;
  readonly userId: UserId;
  readonly partyId: PartyId;
  readonly itemIds: readonly [string, string];
  readonly warehouseId: string;
  readonly vouchers: readonly [VoucherId, VoucherId];
}

export interface SalesHarness {
  readonly sales: SalesRepository;
  readonly presale: PreSaleRepository;
  readonly challans: ChallanRepository;
  shop(): Promise<SalesShop>;
  /** One unit of work of that company: everything in `work` is saved together, or nothing is. */
  unit<T>(companyId: CompanyId, work: () => Promise<T>): Promise<T>;
  /** True where a write outside a unit of work must be refused (PostgreSQL). */
  readonly writesNeedUnitOfWork: boolean;
  /** What the customer owes on a bill, where the implementation keeps it (PostgreSQL's `document_settlements`). */
  settlement?(companyId: CompanyId, invoiceId: string): Promise<{ value: bigint; cancelled: boolean; party: string } | null>;
}

const inr = (paise: number): Money => money(BigInt(paise));
const code = (...expected: string[]) => (error: unknown) => expected.includes((error as { code?: string }).code ?? '');
const byId = <T extends { id: string }>(rows: readonly T[]): T[] => [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
const AT = '2026-04-10T11:04:00.000Z';
const say = { 'en-IN': 'Synthetic explanation.', 'hi-IN': 'Synthetic explanation.' };

const computed = (over: Partial<ComputedTaxLine> & Pick<ComputedTaxLine, 'lineId' | 'itemId' | 'taxableValue' | 'cgst' | 'sgst'>): ComputedTaxLine => ({
  itemName: 'Plastic crate', hsnOrSac: '3923', kind: 'GOODS', chargeKind: null, treatment: 'TAXABLE', quantity: quantityFromString('1', 'NOS'),
  unitPrice: over.taxableValue, grossAmount: over.taxableValue, discountAmount: inr(0), chargesShare: inr(0), ratePercentTimes100: 1800n,
  utgst: inr(0), igst: inr(0), cess: inr(0), totalTax: inr(Number(over.cgst.minor + over.sgst.minor)),
  lineTotal: inr(Number(over.taxableValue.minor + over.cgst.minor + over.sgst.minor)), reverseCharge: false, rateSourceRef: 'synthetic-rate-1',
  rateReviewState: null, rateBasis: 'REGISTER', rateDeclaredBy: null, rateDeclaredBasis: null, explanation: say, ...over,
});

/** Two lines as typed — 10% off one, ₹5 off the other — and the bill's ₹50 freight. */
const typedLines = (shop: SalesShop): SalesInvoiceLineInput[] => [
  { lineId: 'l1', itemId: shop.itemIds[0], quantity: quantityFromString('3', 'PCS'), unitPrice: inr(10_000), priceBasis: 'EXCLUSIVE',
    discount: { kind: 'PERCENT', percentTimes100: 1000n }, warehouseId: shop.warehouseId, note: 'Blue ones' },
  { lineId: 'l2', itemId: shop.itemIds[1], quantity: quantityFromString('2.5', 'KGS'), unitPrice: inr(4_000), priceBasis: 'INCLUSIVE',
    discount: { kind: 'AMOUNT', amount: inr(500) } },
];

/** What the calculator made of them: ₹415.00 taxable, ₹62.35 tax, 65 paise rounding, ₹478.00. Every figure is a bigint. */
const pricingOf = (shop: SalesShop): InvoicePricing => ({
  placeOfSupplyStateCode: '07', split: 'CGST_SGST', mayChargeGst: true,
  lines: [
    computed({ lineId: 'l1', itemId: shop.itemIds[0], quantity: quantityFromString('3', 'PCS'), taxableValue: inr(27_000), cgst: inr(2_430), sgst: inr(2_430), discountAmount: inr(3_000) }),
    computed({ lineId: 'l2', itemId: shop.itemIds[1], itemName: 'Loose rice', hsnOrSac: '1006', quantity: quantityFromString('2.5', 'KGS'), taxableValue: inr(9_500), cgst: inr(238), sgst: inr(237), ratePercentTimes100: 500n }),
    computed({ lineId: 'charge:freight:0', itemId: 'charge:freight', itemName: 'Freight', hsnOrSac: null, kind: 'CHARGE', chargeKind: 'FREIGHT', taxableValue: inr(5_000), cgst: inr(450), sgst: inr(450), chargesShare: inr(5_000), rateSourceRef: null, rateBasis: null }),
  ],
  totals: { taxableValue: inr(41_500), cgst: inr(3_118), sgst: inr(3_117), utgst: inr(0), igst: inr(0), cess: inr(0), totalTax: inr(6_235), reverseChargeTax: inr(0), beforeRounding: inr(47_735), roundOff: inr(65), invoiceValue: inr(47_800) },
  explanation: say,
  decisions: [{ ruleId: 'in.gst.place-of-supply', ruleVersion: '2026.1', topic: 'place_of_supply' }, { ruleId: null, ruleVersion: null, topic: 'rate' }],
});

export const draftBill = (shop: SalesShop, over: Partial<SalesInvoice> = {}): SalesInvoice => {
  const id = crypto.randomUUID();
  return {
    id, companyId: shop.companyId, branchId: 'main' as SalesInvoice['branchId'], state: 'DRAFT', number: null, financialYear: null,
    documentDate: '2026-04-10' as IsoDate, dueDate: null, partyId: shop.partyId, customerType: 'B2B', supplyKind: 'GOODS',
    deliveryStateCode: null, placeOfSupplyStateCode: null, lines: typedLines(shop), freight: inr(5_000), otherCharges: inr(0),
    roundToWholeRupee: true, narration: null, zeroRated: 'WITH_TAX', pricing: null,
    problems: [{ code: 'SALES_STOCK_SHORT', lineId: 'l1', message: say, messageId: 'stock.not_enough' }],
    voucherId: null, cancellationVoucherId: null, createdBy: shop.userId, createdAt: AT, finalisedBy: null, finalisedAt: null,
    cancelledBy: null, cancelledAt: null, cancelReason: null, approvedBy: null, approvedAt: null, idempotencyKey: `bill:${id}`, version: 1, ...over,
  };
};

/** The draft priced and issued, as `SalesService.finalise` leaves it. */
export const issued = (shop: SalesShop, bill: SalesInvoice, number: string): SalesInvoice => ({
  ...bill, state: 'FINAL', number, financialYear: '2026-27', placeOfSupplyStateCode: '07', dueDate: '2026-05-10' as IsoDate,
  pricing: pricingOf(shop), problems: [], voucherId: shop.vouchers[0], finalisedBy: shop.userId, finalisedAt: '2026-04-10T11:05:30.125Z',
  approvedBy: shop.userId, approvedAt: '2026-04-10T11:05:00.000Z', version: bill.version + 1,
});

const presaleDoc = (shop: SalesShop, over: Partial<PreSaleDocument> = {}): PreSaleDocument => {
  const id = crypto.randomUUID();
  return {
    id, companyId: shop.companyId, branchId: 'main' as PreSaleDocument['branchId'], kind: 'QUOTATION', state: 'ISSUED',
    number: `QT/26-27/${id.slice(0, 5)}`, financialYear: '2026-27', documentDate: '2026-04-08' as IsoDate, validUntil: '2026-04-30' as IsoDate,
    partyId: shop.partyId, customerType: 'B2B', supplyKind: 'GOODS', deliveryStateCode: '07', placeOfSupplyStateCode: null,
    lines: typedLines(shop), freight: inr(5_000), otherCharges: inr(0), roundToWholeRupee: true, pricing: pricingOf(shop),
    declaredRateNotice: null, terms: 'Prices hold for three weeks.', narration: null, purpose: null, buyerOrderNumber: null, paymentTerms: null,
    sale: null, invoice: null, createdBy: shop.userId, createdAt: AT, cancelledBy: null, cancelledAt: null, cancelReason: null,
    idempotencyKey: `presale:${id}`, version: 1, ...over,
  };
};

const challanDoc = (shop: SalesShop, over: Partial<DeliveryChallan> = {}): DeliveryChallan => {
  const id = crypto.randomUUID();
  return {
    id, companyId: shop.companyId, branchId: 'main' as DeliveryChallan['branchId'], state: 'ISSUED', number: `DC/26-27/${id.slice(0, 5)}`,
    financialYear: '2026-27', documentDate: '2026-04-09' as IsoDate, partyId: shop.partyId, reason: 'LIQUID_GAS', reasonNote: null,
    deliveryStateCode: null, fromStateCode: '07', toStateCode: '07', interState: false, placeOfSupplyStateCode: '07', showsTax: true, split: 'CGST_SGST',
    lines: [
      { lineId: 'c1', itemId: shop.itemIds[0], itemName: 'Plastic crate', hsnOrSac: '3923', quantity: quantityFromString('3', 'PCS'), quantityProvisional: true,
        unitPrice: inr(10_000), taxableValue: inr(30_000), ratePercentTimes100: 1800n, cgst: inr(2_700), sgst: inr(2_700), utgst: inr(0), igst: inr(0), cess: inr(0),
        exemptSupply: false, warehouseId: shop.warehouseId },
      { lineId: 'c2', itemId: shop.itemIds[1], itemName: 'Loose rice', hsnOrSac: '1006', quantity: quantityFromString('0.000001', 'KGS'), quantityProvisional: false,
        unitPrice: inr(0), taxableValue: inr(0), ratePercentTimes100: null, cgst: inr(0), sgst: inr(0), utgst: inr(0), igst: inr(0), cess: inr(0),
        exemptSupply: true, warehouseId: null },
    ],
    totals: { taxableValue: inr(30_000), cgst: inr(2_700), sgst: inr(2_700), utgst: inr(0), igst: inr(0), cess: inr(0), totalTax: inr(5_400) },
    declaredRateNotice: { 'en-IN': 'A rate on this challan was given by the business.', 'hi-IN': 'Synthetic.' }, narration: 'Synthetic challan',
    ewayBill: null, invoice: null, createdBy: shop.userId, createdAt: AT, cancelledBy: null, cancelledAt: null, cancelReason: null,
    idempotencyKey: `challan:${id}`, version: 1, ...over,
  };
};

export function salesRepositoryContract(label: string, harness: () => SalesHarness, skip: false | string = false): void {
  const setUp = async () => {
    const h = harness();
    const shop = await h.shop();
    const write = <T>(work: () => Promise<T>) => h.unit(shop.companyId, work);
    /** An issued bill in the books, for the documents that point at one. */
    const issuedBill = async (number: string) => {
      const draft = draftBill(shop);
      await write(() => h.sales.insert(draft));
      const bill = issued(shop, draft, number);
      await write(() => h.sales.update(bill, draft.version));
      return bill;
    };
    return { h, shop, write, issuedBill };
  };

  test(`${label}: a draft reads back exactly, its lines are replaced when it is edited, and issued it reads back field for field`, { skip }, async () => {
    const { h, shop, write } = await setUp();
    const draft = draftBill(shop);
    await write(() => h.sales.insert(draft));
    assert.deepEqual(await h.sales.findById(shop.companyId, draft.id), draft);
    assert.deepEqual(await h.sales.findByIdempotencyKey(shop.companyId, draft.idempotencyKey), draft);

    // Edited: a line dropped, one changed, one added; then priced while still a draft.
    const { note: _note, discount: _discount, ...plain } = typedLines(shop)[0] as SalesInvoiceLineInput;
    const edited: SalesInvoice = {
      ...draft, version: 2, narration: 'Customer called back', problems: [],
      lines: [{ ...(typedLines(shop)[1] as SalesInvoiceLineInput), lineId: 'l3', quantity: quantityFromString('7', 'KGS') }, { ...plain, unitPrice: inr(9_999) }],
    };
    await write(() => h.sales.update(edited, 1));
    const read = await h.sales.findById(shop.companyId, draft.id);
    assert.deepEqual(read?.lines.map((l) => l.lineId), ['l3', 'l1']);
    assert.deepEqual(read, edited);
    const priced: SalesInvoice = { ...draft, version: 3, pricing: pricingOf(shop), problems: [] };
    await write(() => h.sales.update(priced, 2));
    assert.deepEqual(await h.sales.findById(shop.companyId, draft.id), priced);

    const bill = issued(shop, priced, 'INV/26-27/000001');
    await write(() => h.sales.update(bill, 3));
    const back = await h.sales.findById(shop.companyId, draft.id);
    assert.deepEqual(back, bill);
    assert.equal(typeof back?.pricing?.lines[0]?.ratePercentTimes100, 'bigint');
    assert.equal(back?.pricing?.totals.invoiceValue.minor, 47_800n);
    assert.deepEqual(await h.sales.findByNumber(shop.companyId, 'INV/26-27/000001'), bill);
    assert.equal(await h.sales.findByNumber(shop.companyId, 'INV/26-27/000002'), null);
    if (h.settlement !== undefined) assert.deepEqual(await h.settlement(shop.companyId, bill.id), { value: 47_800n, cancelled: false, party: shop.partyId });

    const cancelled: SalesInvoice = { ...bill, state: 'CANCELLED', cancellationVoucherId: shop.vouchers[1], cancelledBy: shop.userId, cancelledAt: '2026-04-11T09:00:00.000Z', cancelReason: 'Wrong customer.', version: bill.version + 1 };
    await write(() => h.sales.update(cancelled, bill.version));
    assert.deepEqual(await h.sales.findById(shop.companyId, draft.id), cancelled);
    if (h.settlement !== undefined) assert.deepEqual(await h.settlement(shop.companyId, bill.id), { value: 47_800n, cancelled: true, party: shop.partyId });
  });

  test(`${label}: a bill started twice, a number used twice, a stale version and a missing bill are refused`, { skip }, async () => {
    const { h, shop, write, issuedBill } = await setUp();
    const draft = draftBill(shop);
    await write(() => h.sales.insert(draft));
    await assert.rejects(write(() => h.sales.insert({ ...draftBill(shop), idempotencyKey: draft.idempotencyKey })), code('SALES_DUPLICATE_INVOICE'));
    await assert.rejects(write(() => h.sales.insert({ ...draft, idempotencyKey: 'another key' })), code('SALES_DUPLICATE_INVOICE'));
    await assert.rejects(write(() => h.sales.update({ ...draft, version: 2 }, 0)), code('SALES_CONCURRENT_EDIT'));
    await assert.rejects(write(() => h.sales.update({ ...draft, id: crypto.randomUUID() }, 1)), code('SALES_INVOICE_NOT_FOUND'));
    await issuedBill('INV/26-27/000007');
    await assert.rejects(write(() => h.sales.update(issued(shop, draft, 'INV/26-27/000007'), 1)), code('SALES_DUPLICATE_NUMBER'));
    assert.deepEqual(await h.sales.findById(shop.companyId, draft.id), draft, 'a refused change changed nothing');
  });

  test(`${label}: an unissued bill is discarded; an issued one stays`, { skip }, async () => {
    const { h, shop, write, issuedBill } = await setUp();
    const draft = draftBill(shop);
    await write(() => h.sales.insert(draft));
    await write(() => h.sales.remove(shop.companyId, draft.id));
    assert.equal(await h.sales.findById(shop.companyId, draft.id), null);
    await write(() => h.sales.remove(shop.companyId, draft.id));
    const bill = await issuedBill('INV/26-27/000001');
    await assert.rejects(write(() => h.sales.remove(shop.companyId, bill.id)), code('SALES_ISSUED_NOT_REMOVABLE'));
    assert.deepEqual(await h.sales.findById(shop.companyId, bill.id), bill);
  });

  test(`${label}: bills are listed by customer and state, and page by page each exactly once`, { skip }, async () => {
    const { h, shop, write, issuedBill } = await setUp();
    const drafts = Array.from({ length: 4 }, () => draftBill(shop));
    for (const d of drafts) await write(() => h.sales.insert(d));
    const bill = await issuedBill('INV/26-27/000001');
    const all = [...drafts, bill];
    assert.deepEqual(byId(await h.sales.list(shop.companyId)), byId(all));
    assert.deepEqual(await h.sales.list(shop.companyId, { state: 'FINAL' }), [bill]);
    assert.deepEqual(await h.sales.list(shop.companyId, { partyId: crypto.randomUUID() }), []);
    const seen: SalesInvoice[] = [];
    for (let after: string | undefined; ;) {
      const page = await h.sales.list(shop.companyId, {}, { limit: 2, ...(after === undefined ? {} : { after }) });
      if (page.length === 0) break;
      assert.ok(page.length <= 2);
      seen.push(...page);
      after = page.at(-1)?.id;
    }
    assert.deepEqual(seen, byId(all), 'every bill once, in id order');
  });

  test(`${label}: quotations and proformas read back exactly, are closed by a sale or a bill, and refuse a repeat, a stale version and a missing document`, { skip }, async () => {
    const { h, shop, write, issuedBill } = await setUp();
    const quote = presaleDoc(shop);
    await write(() => h.presale.insert(quote));
    assert.deepEqual(await h.presale.findById(shop.companyId, quote.id), quote);
    assert.deepEqual(await h.presale.findByIdempotencyKey(shop.companyId, quote.idempotencyKey), quote);
    await assert.rejects(write(() => h.presale.insert({ ...presaleDoc(shop), idempotencyKey: quote.idempotencyKey })), code('PRESALE_DUPLICATE'));
    await assert.rejects(write(() => h.presale.insert({ ...presaleDoc(shop), number: quote.number })), code('PRESALE_DUPLICATE_NUMBER'));

    const sale = crypto.randomUUID();
    const converted: PreSaleDocument = { ...quote, state: 'CONVERTED', sale: { invoiceId: sale, convertedBy: shop.userId, convertedAt: '2026-04-09T10:00:00.000Z' }, version: 2 };
    await write(() => h.presale.update(converted, 1));
    assert.deepEqual(await h.presale.findById(shop.companyId, quote.id), converted);
    await assert.rejects(write(() => h.presale.update({ ...converted, version: 3 }, 1)), code('PRESALE_CONCURRENT_EDIT'));
    await assert.rejects(write(() => h.presale.update({ ...converted, id: crypto.randomUUID() }, 2)), code('PRESALE_NOT_FOUND'));

    const bill = await issuedBill('INV/26-27/000001');
    const proforma = presaleDoc(shop, { kind: 'PROFORMA', number: 'PI/26-27/00001', purpose: 'Advance for crates', buyerOrderNumber: 'PO-9', paymentTerms: 'Half now', validUntil: null, branchId: 'main' as PreSaleDocument['branchId'] });
    await write(() => h.presale.insert(proforma));
    const billed: PreSaleDocument = {
      ...proforma, state: 'INVOICED', version: 2,
      invoice: { invoiceId: bill.id, invoiceNumber: 'INV/26-27/000001', invoiceDate: '2026-04-10' as IsoDate, linkedBy: shop.userId, linkedAt: '2026-04-10T12:00:00.000Z', differences: ['The bill is for 2 crates fewer.'] },
    };
    await write(() => h.presale.update(billed, 1));
    assert.deepEqual(await h.presale.findById(shop.companyId, proforma.id), billed);
    assert.deepEqual(await h.presale.list(shop.companyId, { invoiceId: bill.id }), [billed]);
    assert.deepEqual(await h.presale.list(shop.companyId, { invoiceId: sale }), [converted]);
    assert.deepEqual(await h.presale.list(shop.companyId, { kind: 'PROFORMA', state: 'INVOICED', partyId: shop.partyId }), [billed]);
    const pages = [...await h.presale.list(shop.companyId, {}, { limit: 1 })];
    pages.push(...await h.presale.list(shop.companyId, {}, { limit: 5, after: pages[0]?.id as string }));
    assert.deepEqual(pages, byId([converted, billed]));
  });

  test(`${label}: delivery challans read back exactly, take an e-way bill and their bill, and refuse a repeat, a stale version and a missing challan`, { skip }, async () => {
    const { h, shop, write, issuedBill } = await setUp();
    const challan = challanDoc(shop);
    await write(() => h.challans.insert(challan));
    assert.deepEqual(await h.challans.findById(shop.companyId, challan.id), challan);
    assert.deepEqual(await h.challans.findByNumber(shop.companyId, challan.number), challan);
    assert.deepEqual(await h.challans.findByIdempotencyKey(shop.companyId, challan.idempotencyKey), challan);
    await assert.rejects(write(() => h.challans.insert({ ...challanDoc(shop), number: challan.number })), code('CHALLAN_DUPLICATE_NUMBER'));
    await assert.rejects(write(() => h.challans.insert({ ...challanDoc(shop), idempotencyKey: challan.idempotencyKey })), code('CHALLAN_DUPLICATE'));

    const moving: DeliveryChallan = { ...challan, version: 2, ewayBill: { number: '123456789012', date: null, transporter: null, vehicleNumber: null, source: 'TYPED', recordedBy: shop.userId, recordedAt: '2026-04-09T08:00:00.000Z' } };
    await write(() => h.challans.update(moving, 1));
    assert.deepEqual(await h.challans.findById(shop.companyId, challan.id), moving);
    await assert.rejects(write(() => h.challans.update({ ...moving, version: 3 }, 1)), code('CHALLAN_CONCURRENT_EDIT'));
    await assert.rejects(write(() => h.challans.update({ ...moving, id: crypto.randomUUID() }, 2)), code('CHALLAN_NOT_FOUND'));

    const bill = await issuedBill('INV/26-27/000001');
    const billed: DeliveryChallan = { ...moving, state: 'INVOICED', version: 3, invoice: { invoiceId: bill.id, invoiceNumber: 'INV/26-27/000001', invoiceDate: '2026-04-10' as IsoDate, linkedBy: shop.userId, linkedAt: '2026-04-10T12:00:00.000Z', differences: [] } };
    await write(() => h.challans.update(billed, 2));
    assert.deepEqual(await h.challans.findById(shop.companyId, challan.id), billed);
    const other = challanDoc(shop, { reason: 'JOB_WORK', showsTax: false, split: null, placeOfSupplyStateCode: null, declaredRateNotice: null });
    await write(() => h.challans.insert(other));
    const cancelled: DeliveryChallan = { ...other, state: 'CANCELLED', cancelledBy: shop.userId, cancelledAt: '2026-04-09T09:00:00.000Z', cancelReason: 'Goods never left.', version: 2 };
    await write(() => h.challans.update(cancelled, 1));
    assert.deepEqual(await h.challans.list(shop.companyId, { invoiceId: bill.id }), [billed]);
    assert.deepEqual(await h.challans.list(shop.companyId, { state: 'CANCELLED', partyId: shop.partyId }), [cancelled]);
    const first = await h.challans.list(shop.companyId, {}, { limit: 1 });
    const rest = await h.challans.list(shop.companyId, {}, { limit: 1, after: first[0]?.id as string });
    assert.deepEqual([...first, ...rest, ...await h.challans.list(shop.companyId, {}, { limit: 1, after: rest[0]?.id as string })], byId([billed, cancelled]));
  });

  test(`${label}: one company cannot read or change another company's bills, quotations or challans`, { skip }, async () => {
    const mine = await setUp();
    const theirs = await mine.h.shop();
    const draft = draftBill(mine.shop);
    const quote = presaleDoc(mine.shop);
    const challan = challanDoc(mine.shop);
    await mine.write(async () => { await mine.h.sales.insert(draft); await mine.h.presale.insert(quote); await mine.h.challans.insert(challan); });
    const { h } = mine;
    assert.equal(await h.sales.findById(theirs.companyId, draft.id), null);
    assert.equal(await h.sales.findByIdempotencyKey(theirs.companyId, draft.idempotencyKey), null);
    assert.deepEqual(await h.sales.list(theirs.companyId), []);
    assert.equal(await h.presale.findById(theirs.companyId, quote.id), null);
    assert.deepEqual(await h.presale.list(theirs.companyId), []);
    assert.equal(await h.challans.findById(theirs.companyId, challan.id), null);
    assert.equal(await h.challans.findByNumber(theirs.companyId, challan.number), null);
    const asTheirs = <T>(work: () => Promise<T>) => h.unit(theirs.companyId, work);
    await assert.rejects(asTheirs(() => h.sales.update({ ...draft, companyId: theirs.companyId, version: 2 }, 1)), code('SALES_INVOICE_NOT_FOUND'));
    await asTheirs(() => h.sales.remove(theirs.companyId, draft.id));
    await assert.rejects(asTheirs(() => h.presale.update({ ...quote, companyId: theirs.companyId, version: 2 }, 1)), code('PRESALE_NOT_FOUND'));
    await assert.rejects(asTheirs(() => h.challans.update({ ...challan, companyId: theirs.companyId, version: 2 }, 1)), code('CHALLAN_NOT_FOUND'));
    assert.deepEqual(await h.sales.findById(mine.shop.companyId, draft.id), draft);
  });

  test(`${label}: a unit of work that fails leaves nothing behind`, { skip }, async () => {
    const { h, shop, write } = await setUp();
    const draft = draftBill(shop);
    const quote = presaleDoc(shop);
    const challan = challanDoc(shop);
    await assert.rejects(write(async () => {
      await h.sales.insert(draft);
      await h.presale.insert(quote);
      await h.challans.insert(challan);
      throw new Error('the till lost power');
    }), /the till lost power/);
    assert.equal(await h.sales.findById(shop.companyId, draft.id), null);
    assert.equal(await h.presale.findById(shop.companyId, quote.id), null);
    assert.equal(await h.challans.findById(shop.companyId, challan.id), null);
  });

  test(`${label}: a write outside a unit of work is refused, not saved on its own`, { skip }, async () => {
    const { h, shop, write } = await setUp();
    if (!h.writesNeedUnitOfWork) return;
    const draft = draftBill(shop);
    await assert.rejects(h.sales.insert(draft), code('NO_UNIT_OF_WORK'));
    await assert.rejects(h.presale.insert(presaleDoc(shop)), code('NO_UNIT_OF_WORK'));
    await assert.rejects(h.challans.insert(challanDoc(shop)), code('NO_UNIT_OF_WORK'));
    await write(() => h.sales.insert(draft));
    await assert.rejects(h.sales.update({ ...draft, version: 2 }, 1), code('NO_UNIT_OF_WORK'));
    await assert.rejects(h.sales.remove(shop.companyId, draft.id), code('NO_UNIT_OF_WORK'));
    assert.deepEqual(await h.sales.findById(shop.companyId, draft.id), draft);
  });
}

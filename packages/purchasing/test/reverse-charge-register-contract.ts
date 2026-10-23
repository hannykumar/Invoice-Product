/**
 * Issue #289, part 2b — one contract for the reverse-charge register, run against memory
 * (reverse-charge-register.test.ts) and PostgreSQL as the application role
 * (reverse-charge-register.integration.test.ts). Every company, person and figure is invented.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { isoDate, type CompanyId } from "@invoice/kernel";
import type { ReverseChargePurchase, ReverseChargeRegisterRepository, SelfInvoice } from "../src/reverse-charge-register.ts";

export interface RegisterScene { readonly companyId: CompanyId; readonly userId: string; readonly partyId: string }

export interface RegisterHarness {
  readonly register: ReverseChargeRegisterRepository;
  scene(): Promise<RegisterScene>;
  /** A posted bill the register can point at, wherever the implementation keeps bills. */
  bill(scene: RegisterScene, n: number): Promise<string>;
  write<T>(companyId: CompanyId, work: () => Promise<T>): Promise<T>;
}

const code = (...expected: string[]) => (error: unknown) => expected.includes((error as { code?: string }).code ?? "");
/** Above 2^53, so a figure that went through a float would come back wrong. */
const HUGE = 9_007_199_254_740_993n;
const party = { name: "Synthetic Kabadi Stores", addressLines: ["1, Scrap Lane", "Bengaluru 560026"], gstin: null, stateCode: "29", stateName: "Karnataka" };

export const purchaseFor = (s: RegisterScene, billId: string, extra: Partial<ReverseChargePurchase> = {}): ReverseChargePurchase => ({
  companyId: s.companyId, billId, supplierPartyId: s.partyId, supplier: party, supplierRegistered: false, supplyKind: "GOODS",
  invoiceNumber: `SKS-${billId.slice(0, 6)}`, invoiceDate: isoDate("2026-09-01"), receivedOn: isoDate("2026-09-02"), enteredOn: isoDate("2026-09-03"),
  interState: false,
  lines: [{ lineNumber: 1, description: "Copper scrap", hsnSac: "74040010", quantity: "200 KGS", unit: "KGS", taxableValuePaise: HUGE,
    gstRateBasisPoints: 1800, cgstPaise: 9_000n, sgstPaise: 9_000n, igstPaise: 0n, cessPaise: 0n }],
  recordedBy: s.userId, recordedAt: new Date(Date.UTC(2026, 8, 3, 6, 0, 0, 123)).toISOString(), ...extra,
});

export const selfInvoiceFor = (s: RegisterScene, purchase: ReverseChargePurchase, sequence: number, extra: Partial<SelfInvoice> = {}): SelfInvoice => ({
  id: crypto.randomUUID(), companyId: s.companyId, billId: purchase.billId, number: `SI/2026-27/${String(sequence).padStart(4, "0")}`,
  financialYear: "2026-27", sequence, issuedOn: isoDate("2026-09-05"), receivedOn: purchase.receivedOn, supplier: purchase.supplier,
  recipient: { ...party, name: "Synthetic Buyer", gstin: "29AAAAA0000A1ZY" }, placeOfSupply: { stateCode: "29", stateName: "Karnataka" },
  interState: false, lines: purchase.lines, taxableValuePaise: HUGE, cgstPaise: 9_000n, sgstPaise: 9_000n, igstPaise: 0n, cessPaise: 0n,
  issuedBy: s.userId, issuedAt: new Date(Date.UTC(2026, 8, 5, 6, 0, 0, 456)).toISOString(), idempotencyKey: `key-${purchase.billId}`, ...extra,
});

export const reverseChargeRegisterContract = (name: string, harness: () => RegisterHarness, skip: string | false = false): void => {
  test(`${name}: a purchase and its self-invoice come back exactly, paise above 2^53 included`, { skip }, async () => {
    const h = harness();
    const s = await h.scene();
    const purchase = purchaseFor(s, await h.bill(s, 1));
    await h.write(s.companyId, () => h.register.insertPurchase(purchase));
    assert.deepEqual(await h.register.purchaseFor(s.companyId, purchase.billId), purchase);
    assert.deepEqual(await h.register.purchases(s.companyId), [purchase]);
    const invoice = selfInvoiceFor(s, purchase, 1);
    await h.write(s.companyId, () => h.register.insertSelfInvoice(invoice));
    assert.deepEqual(await h.register.selfInvoiceFor(s.companyId, purchase.billId), invoice);
    assert.deepEqual(await h.register.selfInvoiceByKey(s.companyId, invoice.idempotencyKey), invoice);
    assert.equal(await h.register.lastSelfInvoiceSequence(s.companyId, "2026-27"), 1);
    assert.equal(await h.register.lastSelfInvoiceSequence(s.companyId, "2027-28"), 0);
  });

  test(`${name}: one entry per bill, one self-invoice per bill, and no number twice in a year`, { skip }, async () => {
    const h = harness();
    const s = await h.scene();
    const first = purchaseFor(s, await h.bill(s, 2));
    const second = purchaseFor(s, await h.bill(s, 3));
    await h.write(s.companyId, async () => { await h.register.insertPurchase(first); await h.register.insertPurchase(second); });
    await assert.rejects(h.write(s.companyId, () => h.register.insertPurchase({ ...first, receivedOn: isoDate("2026-09-04") })), code("REVERSE_CHARGE_ALREADY_RECORDED"));
    await h.write(s.companyId, () => h.register.insertSelfInvoice(selfInvoiceFor(s, first, 1)));
    await assert.rejects(h.write(s.companyId, () => h.register.insertSelfInvoice(selfInvoiceFor(s, first, 2, { idempotencyKey: "other" }))), code("SELF_INVOICE_ALREADY_ISSUED"));
    await assert.rejects(h.write(s.companyId, () => h.register.insertSelfInvoice(selfInvoiceFor(s, second, 1))), code("SELF_INVOICE_NUMBER_TAKEN"));
    await h.write(s.companyId, () => h.register.insertSelfInvoice(selfInvoiceFor(s, second, 2)));
    assert.deepEqual((await h.register.selfInvoices(s.companyId)).map((row) => row.number), ["SI/2026-27/0001", "SI/2026-27/0002"]);
  });

  test(`${name}: one company never sees another's register`, { skip }, async () => {
    const h = harness();
    const a = await h.scene();
    const b = await h.scene();
    const purchase = purchaseFor(a, await h.bill(a, 4));
    await h.write(a.companyId, () => h.register.insertPurchase(purchase));
    assert.equal(await h.register.purchaseFor(b.companyId, purchase.billId), null);
    assert.deepEqual(await h.register.purchases(b.companyId), []);
    assert.equal(await h.register.lastSelfInvoiceSequence(b.companyId, "2026-27"), 0);
  });
};

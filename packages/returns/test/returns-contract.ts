/**
 * Issue #366 — one contract suite for the return-note repository, run against the in-memory store
 * (returns-contract.test.ts) and against PostgreSQL as an `invoice_app` login
 * (returns-contract.integration.test.ts). Synthetic data only.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isoDate, money, type CompanyId, type PartyId, type UserId, type VoucherId } from '@invoice/kernel';
import type { ReturnNote, ReturnNoteLine, ReturnNoteRepository, ReturnTaxAmounts } from '../src/index.ts';

export interface ReturnsHarness {
  readonly repository: ReturnNoteRepository;
  /** One action: committed when `work` resolves, rolled back when it throws. */
  unitOfWork<T>(companyId: CompanyId, work: () => Promise<T>): Promise<T>;
  /** A fresh company with a customer, an item, a godown and a clerk, wherever the store keeps them. */
  company(): Promise<{ companyId: CompanyId; partyId: PartyId; itemId: string; warehouseId: string; userId: UserId }>;
}

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
const amounts = (taxable: bigint, tax: bigint): ReturnTaxAmounts => ({
  taxableValue: money(taxable), cgst: money(tax), sgst: money(tax), utgst: money(0n), igst: money(0n), cess: money(0n),
  ineligibleTax: money(0n), reverseChargeTax: money(0n), total: money(taxable + 2n * tax),
});

type Scene = Awaited<ReturnType<ReturnsHarness['company']>>;
const note = (scene: Scene, over: Partial<ReturnNote> = {}): ReturnNote => {
  const goods: ReturnNoteLine = {
    originalLineId: 'line-1', itemId: scene.itemId, description: 'Synthetic steel bars', supplyKind: 'GOODS',
    quantity: { scaled: 12_345678n, unit: 'KGS' }, disposition: 'DAMAGED', warehouseId: scene.warehouseId, batchId: null,
    serialNumbers: ['SN-1', 'SN-2'], replacementSerialNumbers: [], amounts: amounts(9_007_199_254_740_993n, 81_064_793_292_668n),
    hsnOrSac: '7214', ratePercentTimes100: 1800n, unitPrice: money(72_960_000n),
  };
  // Issue #233 — a returned freight charge: not a master record, stored by its kind.
  const freight: ReturnNoteLine = {
    originalLineId: 'line-2', itemId: 'charge:freight', description: 'Freight', supplyKind: 'SERVICES',
    quantity: { scaled: 1_000000n, unit: 'NOS' }, disposition: 'ACCEPTED', warehouseId: null, batchId: null,
    serialNumbers: [], replacementSerialNumbers: [], amounts: amounts(50_000n, 4_500n),
    hsnOrSac: null, ratePercentTimes100: null, unitPrice: null,
  };
  const id = over.id ?? crypto.randomUUID();
  return {
    id, companyId: scene.companyId, kind: 'SALES_RETURN', number: `CN/26-27/${id.slice(0, 7)}`, documentDate: isoDate('2026-04-10'),
    originalDocument: { id: 'sale-1', number: 'INV/26-27/0000001', date: isoDate('2026-04-05') }, partyId: scene.partyId,
    reason: 'Bars bent in transit', lines: [goods, freight], totals: amounts(9_007_199_254_790_993n, 81_064_793_297_168n),
    voucherId: crypto.randomUUID() as VoucherId, complianceStatus: 'PENDING_ADJUSTMENT', createdBy: scene.userId,
    createdAt: '2026-04-10T05:30:00.123Z', idempotencyKey: `key-${id}`, summary: 'A synthetic credit note.', supplierCreditNote: null,
    ...over,
  };
};

export function returnsContract(label: string, harness: () => ReturnsHarness, skip: false | string = false): void {
  const setup = async () => {
    const h = harness();
    const scene = await h.company();
    const insert = (n: ReturnNote) => h.unitOfWork(scene.companyId, () => h.repository.insert(n));
    return { h, scene, insert, repo: h.repository };
  };

  test(`${label}: a note round-trips exactly — paise past 2^53, quantities, dates, nulls, serials and a charge line`, { skip }, async () => {
    const { scene, insert, repo } = await setup();
    const saved = note(scene);
    await insert(saved);
    assert.deepEqual(await repo.findById(scene.companyId, saved.id), saved);
    assert.deepEqual(await repo.findByIdempotencyKey(scene.companyId, saved.idempotencyKey), saved);
    assert.deepEqual(await repo.listForOriginal(scene.companyId, 'sale-1'), [saved]);
    assert.deepEqual(await repo.list(scene.companyId), [saved]);
    assert.equal((await repo.findById(scene.companyId, saved.id))?.lines[1]?.itemId, 'charge:freight');
  });

  test(`${label}: "not found" is null for a read and RETURN_NOTE_NOT_FOUND for a change`, { skip }, async () => {
    const { h, scene, repo } = await setup();
    const missing = crypto.randomUUID();
    assert.equal(await repo.findById(scene.companyId, missing), null);
    assert.equal(await repo.findByIdempotencyKey(scene.companyId, 'no-such-key'), null);
    assert.deepEqual(await repo.listForOriginal(scene.companyId, 'no-such-bill'), []);
    await assert.rejects(h.unitOfWork(scene.companyId, () => repo.setSupplierCreditNote(scene.companyId, missing, { number: 'S-1', date: isoDate('2026-04-12') })), code('RETURN_NOTE_NOT_FOUND'));
  });

  test(`${label}: a repeated id, idempotency key or number is RETURN_NOTE_DUPLICATE and leaves the first note alone`, { skip }, async () => {
    const { scene, insert, repo } = await setup();
    const first = note(scene);
    await insert(first);
    await assert.rejects(insert(note(scene, { id: first.id, number: 'CN/26-27/other', idempotencyKey: 'other' })), code('RETURN_NOTE_DUPLICATE'));
    await assert.rejects(insert(note(scene, { idempotencyKey: first.idempotencyKey })), code('RETURN_NOTE_DUPLICATE'));
    await assert.rejects(insert(note(scene, { number: first.number })), code('RETURN_NOTE_DUPLICATE'));
    assert.deepEqual(await repo.list(scene.companyId), [first]);
  });

  test(`${label}: the supplier's credit note is recorded on a purchase return, and only there`, { skip }, async () => {
    const { h, scene, insert, repo } = await setup();
    const debit = note(scene, { kind: 'PURCHASE_RETURN', number: 'DN/26-27/0000001' });
    const credit = note(scene);
    await insert(debit);
    await insert(credit);
    const reference = { number: 'SUP-CN-7', date: isoDate('2026-04-12') };
    const updated = await h.unitOfWork(scene.companyId, () => repo.setSupplierCreditNote(scene.companyId, debit.id, reference));
    assert.deepEqual(updated, { ...debit, supplierCreditNote: reference });
    assert.deepEqual(await repo.findById(scene.companyId, debit.id), { ...debit, supplierCreditNote: reference });
    await assert.rejects(h.unitOfWork(scene.companyId, () => repo.setSupplierCreditNote(scene.companyId, credit.id, reference)), code('RETURN_NOTE_NOT_FOUND'));
  });

  test(`${label}: one company cannot read or change another company's notes`, { skip }, async () => {
    const a = await setup();
    const b = await setup();
    const saved = note(a.scene);
    await a.insert(saved);
    assert.equal(await a.repo.findById(b.scene.companyId, saved.id), null);
    assert.equal(await a.repo.findByIdempotencyKey(b.scene.companyId, saved.idempotencyKey), null);
    assert.deepEqual(await a.repo.listForOriginal(b.scene.companyId, 'sale-1'), []);
    assert.deepEqual(await a.repo.list(b.scene.companyId), []);
    const reference = { number: 'SUP-CN-7', date: isoDate('2026-04-12') };
    await assert.rejects(a.h.unitOfWork(b.scene.companyId, () => a.repo.setSupplierCreditNote(b.scene.companyId, saved.id, reference)), code('RETURN_NOTE_NOT_FOUND'));
    assert.deepEqual(await a.repo.findById(a.scene.companyId, saved.id), saved);
  });

  test(`${label}: a rolled-back action leaves nothing behind`, { skip }, async () => {
    const { h, scene, repo } = await setup();
    const lost = note(scene);
    await assert.rejects(h.unitOfWork(scene.companyId, async () => {
      await repo.insert(lost);
      throw new Error('the voucher failed');
    }), /the voucher failed/);
    assert.equal(await repo.findById(scene.companyId, lost.id), null);
    assert.deepEqual(await repo.list(scene.companyId), []);
  });

  test(`${label}: pages return every note exactly once, in id order`, { skip }, async () => {
    const { scene, insert, repo } = await setup();
    const notes = Array.from({ length: 5 }, () => note(scene));
    const other = note(scene, { originalDocument: { id: 'sale-2', number: 'INV/26-27/0000002', date: isoDate('2026-04-06') } });
    for (const n of [...notes, other]) await insert(n);
    const walk = async (read: (after?: string) => Promise<ReturnNote[]>) => {
      const seen: string[] = [];
      for (let after: string | undefined, page = await read(); page.length > 0; page = await read(after)) {
        assert.ok(page.length <= 2);
        seen.push(...page.map((n) => n.id));
        after = page.at(-1)?.id;
      }
      return seen;
    };
    const ids = (list: ReturnNote[]) => list.map((n) => n.id).sort();
    assert.deepEqual(await walk((after) => repo.list(scene.companyId, { limit: 2, ...(after === undefined ? {} : { after }) })), ids([...notes, other]));
    assert.deepEqual(await walk((after) => repo.listForOriginal(scene.companyId, 'sale-1', { limit: 2, ...(after === undefined ? {} : { after }) })), ids(notes));
    assert.deepEqual((await repo.list(scene.companyId, { limit: 3 }))[0], (await repo.list(scene.companyId, { limit: 1 }))[0], 'a page carries whole notes');
    assert.equal((await repo.list(scene.companyId)).length, 6, 'without a page, everything');
    await assert.rejects(repo.list(scene.companyId, { limit: 0 }), code('RETURN_PAGE_LIMIT_INVALID'));
    await assert.rejects(repo.list(scene.companyId, { limit: 501 }), code('RETURN_PAGE_LIMIT_INVALID'));
  });
}

/**
 * Issue #366 — one contract for the reconciliation stores, run against memory
 * (reconciliation-contract.test.ts) and PostgreSQL as the application role (….integration.test.ts).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { BankReconciliationService, type BankLine, type BookPayment, type ReconciliationStore } from '../src/index.ts';

export interface ReconciliationHarness { readonly store: ReconciliationStore; company(): Promise<string> }

const ALL = new Set(['bank.reconcile', 'bank.reconcile.confirm']);
const ctx = (companyId: string, permissions: ReadonlySet<string> = ALL) => ({ companyId, actorId: 'owner-1', permissions });
const bank = (companyId: string, id: string, amountPaise: bigint, reference: string | null = `REF-${id}`): BankLine =>
  ({ id, companyId, bookedOn: '2026-08-20', direction: 'RECEIPT', amountPaise, description: 'NEFT ABC', reference, fingerprint: `fp-${id}` });
const book = (companyId: string, id: string, amountPaise: bigint, reference: string | null = `REF-${id}`): BookPayment =>
  ({ id, companyId, direction: 'RECEIPT', amountPaise, date: '2026-08-20', reference });
const NOW = () => new Date('2026-08-21T10:00:00.000Z');

export function reconciliationContract(name: string, make: () => ReconciliationHarness, skip: string | false = false): void {
  test(`${name}: running reconcile again over matched lines makes no second match and no false exceptions`, { skip }, async () => {
    const h = make();
    const service = new BankReconciliationService(undefined, NOW, h.store);
    const a = await h.company();
    const first = await service.reconcile(ctx(a), [bank(a, 'one', 30_000_00n)], [book(a, 'one', 30_000_00n)]);
    assert.equal(first.matches[0]?.status, 'AUTO_MATCHED');
    const again = await Promise.all([1, 2].map(() => service.reconcile(ctx(a), [bank(a, 'one', 30_000_00n)], [book(a, 'one', 30_000_00n)])));
    for (const run of again) { assert.deepEqual(run.matches, []); assert.deepEqual(run.exceptions, []); }
    assert.deepEqual((await service.auditFor(ctx(a), first.matches[0]!.id)).map((e) => e.action), ['reconciliation.auto_matched']);
  });

  test(`${name}: two people confirming overlapping candidates at once: exactly one wins`, { skip }, async () => {
    const h = make();
    const service = new BankReconciliationService(undefined, NOW, h.store);
    const a = await h.company();
    const run = await service.reconcile(ctx(a), [bank(a, 'b', 30_000_00n, null)], [book(a, 'p1', 30_000_00n, null), book(a, 'p2', 30_000_00n, null)]);
    assert.equal(run.exceptions[0]?.kind, 'AMBIGUOUS');
    const settled = await Promise.allSettled(run.candidates.map((c) => service.confirm(ctx(a), c.id)));
    assert.equal(settled.filter((s) => s.status === 'fulfilled').length, 1);
    assert.match(String((settled.find((s) => s.status === 'rejected') as PromiseRejectedResult).reason), /already matched/);
  });

  test(`${name}: an undo is kept once, audited once, and the pair can then be confirmed afresh`, { skip }, async () => {
    const h = make();
    const service = new BankReconciliationService(undefined, NOW, h.store);
    const a = await h.company();
    const run = await service.reconcile(ctx(a), [bank(a, 'b', 500n, null)], [book(a, 'p1', 500n, null), book(a, 'p2', 500n, null)]);
    const chosen = await service.confirm(ctx(a), run.candidates[0]!.id);
    assert.equal(chosen.candidateId, run.candidates[0]!.id);
    const undone = await Promise.all([service.unmatch(ctx(a), chosen.id, 'Wrong customer.'), service.unmatch(ctx(a), chosen.id, 'Wrong customer.')]);
    assert.deepEqual(undone.map((m) => m.status), ['UNMATCHED', 'UNMATCHED']);
    const events = await service.auditFor(ctx(a), chosen.id, { limit: 1 });
    const more = await service.auditFor(ctx(a), chosen.id, { after: events[0]!.id });
    assert.deepEqual([...events, ...more].map((e) => e.action), ['reconciliation.confirmed', 'reconciliation.unmatched']);
    const again = await service.confirm(ctx(a), run.candidates[1]!.id);
    assert.notEqual(again.id, chosen.id);
  });

  test(`${name}: another company finds no candidate, match or audit, and wrong input is refused`, { skip }, async () => {
    const h = make();
    const service = new BankReconciliationService(undefined, NOW, h.store);
    const [a, b] = [await h.company(), await h.company()];
    const run = await service.reconcile(ctx(a), [bank(a, 'one', 100n)], [book(a, 'one', 100n)]);
    const matchId = run.matches[0]!.id;
    await assert.rejects(service.confirm(ctx(b), run.candidates[0]!.id), /not found/);
    await assert.rejects(service.unmatch(ctx(b), matchId, 'reason'), /not found/);
    assert.deepEqual(await service.auditFor(ctx(b), matchId), []);
    await assert.rejects(service.reconcile(ctx(b), [bank(a, 'x', 1n)], []), /another company/);
    await assert.rejects(service.reconcile(ctx(a), [bank(a, 'x', 0n)], []), /above zero/);
    await assert.rejects(service.unmatch(ctx(a), matchId, '  '), /explain/);
    await assert.rejects(service.unmatch(ctx(a), 'not-a-match', 'reason'), /not found/);
    await assert.rejects(service.confirm(ctx(a, new Set(['bank.reconcile'])), run.candidates[0]!.id), /permission/);
    assert.equal((await service.auditFor(ctx(a), matchId)).length, 1);
  });
}

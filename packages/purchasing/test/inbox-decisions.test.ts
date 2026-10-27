// Issue #489 — what a person decided about an inbox document is kept once and never changed.
import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryInboxDecisionStore, type InboxDecision } from "../src/inbox-decisions.ts";

const base = { companyId: "company-a", documentId: "doc-1", decidedBy: "user-1", decidedAt: "2026-10-27T10:00:00.000Z" } as const;
const billed: InboxDecision = { ...base, kind: "billed", billNumber: "SRS/1", supplierName: "Shree Ram Steels" };
const rejected: InboxDecision = { ...base, kind: "rejected", reason: "Not our order" };

test("the first decision is kept; the same decision again is the same one", async () => {
  const store = new InMemoryInboxDecisionStore();
  assert.deepEqual(await store.record(billed), billed);
  assert.deepEqual(await store.record({ ...billed, decidedBy: "user-2" }), billed, "pressing Record twice is one bill");
});

test("a bill is never set aside afterwards, and a set-aside bill is never billed", async () => {
  const store = new InMemoryInboxDecisionStore();
  await store.record(billed);
  await assert.rejects(store.record(rejected), /already recorded as bill SRS\/1/);
  const other = new InMemoryInboxDecisionStore();
  await other.record(rejected);
  await assert.rejects(other.record(billed), /already set aside/);
});

test("a rejection needs a reason and a bill needs its number", async () => {
  const store = new InMemoryInboxDecisionStore();
  await assert.rejects(store.record({ ...rejected, reason: "  " }), /needs a reason/);
  await assert.rejects(store.record({ ...billed, billNumber: "" }), /needs its bill number/);
});

test("decisions are per company: another company's document id finds nothing", async () => {
  const store = new InMemoryInboxDecisionStore();
  await store.record(billed);
  assert.equal((await store.forDocuments("company-b", ["doc-1"])).size, 0);
  assert.equal((await store.forDocuments("company-a", ["doc-1", "doc-2"])).size, 1);
});

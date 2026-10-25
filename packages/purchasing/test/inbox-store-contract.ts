/**
 * Issue #366 — one contract suite for the purchase inbox's store (inbox-store.ts), run in memory
 * (inbox-store-contract.test.ts) and on PostgreSQL as the application role
 * (inbox-store-contract.integration.test.ts). Lane owner: GPT 3.
 *
 * Every test makes its own companies, so files can run side by side against one database.
 * Everything here is invented: no real business, GST number or person.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { syntheticGstin } from "../../masters/src/fixtures.ts";
import { AuditLog, PlatformCommandService } from "../../platform/src/index.ts";
import type { RequestContext } from "../../platform/src/types.ts";
import { MockOcrAdapter } from "../src/ocr.ts";
import { PurchaseInboxService } from "../src/inbox.ts";
import type { InboxStore } from "../src/inbox-store.ts";
import type { CompanyRoutingProfile } from "../src/routing.ts";
import type { ExtractionDraft, InboundDocument } from "../src/inbox-types.ts";

export interface InboxHarness {
  readonly store: InboxStore;
  /** A new company, wherever the implementation keeps companies. */
  company(): Promise<string>;
  /** One business action: committed when `work` resolves, nothing left when it throws. */
  write<T>(companyId: string, work: () => Promise<T>): Promise<T>;
  /** True where a write outside `write` must be refused (PostgreSQL). */
  readonly requiresUnitOfWork: boolean;
}

const code = (...expected: string[]) => (error: unknown) => expected.includes((error as { code?: string }).code ?? "");
/** Above 2^53, so a figure that went through a float would come back wrong. */
const HUGE = 9_007_199_254_740_993n;
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const at = (second: number): string => new Date(Date.UTC(2026, 6, 21, 10, 0, second, 123)).toISOString();

export const documentFor = (companyId: string, n: number, extra: Partial<InboundDocument> = {}): InboundDocument => ({
  id: randomUUID(), companyId, branchId: `branch-${n}`, channel: "email",
  sender: { channel: "email", address: "accounts@supplier.example", displayName: "Synthetic Steels", providerMessageId: `<m-${n}@supplier.example>` },
  attachment: { id: `att-${n}`, fileName: `bill-${n}.pdf`, declaredMimeType: "application/pdf", sizeBytes: 240_000 + n, sha256: sha(`file-${n}-${companyId}`), storageKey: `s3://inbox/${companyId}/${n}`, pageCount: 2 },
  receivedAt: at(n), status: "screening", attempts: 1,
  routing: { basis: "channel_binding", evidence: "Received on bills@shop.example", confidence: 0.7, rejected: [{ companyId: "other", why: "not its address" }] },
  ...extra,
});

const draftFor = (document: InboundDocument): ExtractionDraft => ({
  id: randomUUID(), companyId: document.companyId, documentId: document.id, source: "ocr",
  supplierGstin: { value: syntheticGstin("27", "AAECS5678D"), confidence: 0.95, evidence: { page: 1, text: "GSTIN: …", box: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 } } },
  invoiceNumber: { value: "SRS/2026/0042", confidence: 0.9, evidence: { page: 1, text: "Invoice No: SRS/2026/0042" } },
  invoiceDate: { value: "2026-07-21", confidence: 0.6, evidence: { page: 1, text: "21/07/2026" }, warning: "Could be read either way." },
  invoiceTotalPaise: { value: HUGE, confidence: 0.92, evidence: { page: 1, text: "Grand Total" } },
  lines: [{ description: { value: "TMT bar", confidence: 0.9, evidence: { page: 1, text: "TMT bar" } }, ratePaise: { value: HUGE - 1n, confidence: 0.8, evidence: { page: 0, text: "64", jsonPath: "ItemList[0].UnitPrice" } } }],
  fieldsNeedingReview: ["invoiceDate"], arithmeticProblems: [], createdAt: at(30),
});

const keys = (n: number) => ({ messageKey: `email:delivery:email:bills@shop.example:<m-${n}>:${sha(String(n))}`, intakeKey: `intake-${n}` });

export function inboxStoreContract(name: string, harness: () => InboxHarness, skip: string | false = false): void {
  test(`${name}: a stored document comes back exactly as written, and only its moving parts change`, { skip }, async () => {
    const h = harness();
    const a = await h.company();
    const full = documentFor(a, 1);
    const bare: InboundDocument = { id: randomUUID(), companyId: a, channel: "api", sender: { channel: "api", address: "user-1" },
      attachment: { id: "att-b", fileName: "b.json", declaredMimeType: "application/json", sizeBytes: 0, sha256: sha("bare"), storageKey: "s3://b" },
      receivedAt: at(2), status: "received", attempts: 1 };
    await h.write(a, async () => {
      await h.store.insertDocument(full, keys(1));
      await h.store.insertDocument(bare, { messageKey: null, intakeKey: "intake-bare" });
    });
    assert.deepEqual(await h.store.document(a, full.id), full);
    assert.deepEqual(await h.store.document(a, bare.id), bare);
    assert.equal(await h.store.intakeKey(a, full.id), "intake-1");
    assert.deepEqual(await h.store.documentByMessageKey(a, keys(1).messageKey), full);

    const held: InboundDocument = { ...full, status: "quarantined", quarantineReason: "COMPANY_MISMATCH", statusMessage: "Held.", attempts: 2 };
    await h.write(a, () => h.store.updateDocument(held));
    assert.deepEqual(await h.store.document(a, full.id), held);
    // The hold lifted: its reason goes, as the service does it.
    const { quarantineReason: _gone, ...rest } = held;
    const assigned: InboundDocument = { ...rest, status: "received", routing: { basis: "explicit_company", evidence: "Assigned by owner: ours", confidence: 1 } };
    await h.write(a, () => h.store.updateDocument(assigned));
    assert.deepEqual(await h.store.document(a, full.id), assigned);
    await assert.rejects(h.write(a, () => h.store.updateDocument({ ...bare, id: randomUUID() })), code("INBOX_DOCUMENT_UNKNOWN"));
    assert.equal(await h.store.document(a, randomUUID()), null);
    assert.equal(await h.store.document(a, "not-an-id"), null);
    assert.equal(await h.store.intakeKey(a, randomUUID()), null);
  });

  test(`${name}: the inbox lists oldest first, by status, and page by page`, { skip }, async () => {
    const h = harness();
    const a = await h.company();
    const docs = [3, 1, 2, 4].map((n) => documentFor(a, n, n % 2 === 0 ? { status: "failed" } : {}));
    await h.write(a, async () => { for (const [i, d] of docs.entries()) await h.store.insertDocument(d, { messageKey: null, intakeKey: `k-${i}` }); });
    const ordered = [...docs].sort((x, y) => (x.receivedAt < y.receivedAt ? -1 : 1));
    assert.deepEqual(await h.store.documents(a), ordered);
    assert.deepEqual((await h.store.documents(a, "failed")).map((d) => d.id), ordered.filter((d) => d.status === "failed").map((d) => d.id));
    const first = await h.store.documents(a, undefined, { limit: 3 });
    const second = await h.store.documents(a, undefined, { limit: 3, after: first.at(-1)?.id as string });
    assert.deepEqual([...first, ...second], ordered);
    assert.deepEqual(await h.store.documents(a, "failed", { limit: 1, after: ordered.filter((d) => d.status === "failed")[0]?.id as string }),
      ordered.filter((d) => d.status === "failed").slice(1));
    assert.deepEqual(await h.store.documents(a, undefined, { limit: 3, after: randomUUID() }), []);
    assert.deepEqual(await h.store.documents(a, undefined, { limit: 3, after: "nonsense" }), []);
    await assert.rejects(h.store.documents(a, undefined, { limit: 0 }), code("PAGE_LIMIT_INVALID"));
  });

  test(`${name}: one document per redelivered message (#406), per company, even when two arrive at once`, { skip }, async () => {
    const h = harness();
    const [a, b] = [await h.company(), await h.company()];
    const twins = [documentFor(a, 1), documentFor(a, 1)];
    const settled = await Promise.allSettled(twins.map((d) => h.write(a, () => h.store.insertDocument(d, keys(1)))));
    assert.deepEqual(settled.map((s) => s.status).sort(), ["fulfilled", "rejected"]);
    assert.ok(code("INBOX_DOCUMENT_DUPLICATE")((settled.find((s) => s.status === "rejected") as PromiseRejectedResult).reason));
    assert.equal((await h.store.documents(a)).length, 1);
    // The same key in another company is that company's own document; no key never clashes.
    await h.write(b, () => h.store.insertDocument(documentFor(b, 1), keys(1)));
    await h.write(a, async () => {
      await h.store.insertDocument(documentFor(a, 2), { messageKey: null, intakeKey: "x" });
      await h.store.insertDocument(documentFor(a, 3), { messageKey: null, intakeKey: "y" });
    });
    await assert.rejects(h.write(a, () => h.store.insertDocument(twins[0] as InboundDocument, keys(9))), code("INBOX_DOCUMENT_DUPLICATE"));
    assert.equal((await h.store.documents(a)).length, 3);
    assert.equal((await h.store.documentByMessageKey(b, keys(1).messageKey))?.companyId, b);
    assert.equal(await h.store.documentByMessageKey(a, "no-such-key"), null);
  });

  test(`${name}: the first document of a company to hold a file keeps it`, { skip }, async () => {
    const h = harness();
    const [a, b] = [await h.company(), await h.company()];
    const [first, second] = [documentFor(a, 1), documentFor(a, 2)];
    const other = documentFor(b, 3);
    const file = sha("same file");
    await h.write(a, async () => {
      await h.store.insertDocument(first, keys(1));
      await h.store.insertDocument(second, keys(2));
      assert.equal(await h.store.claimContent(a, file, first.id), first.id);
      assert.equal(await h.store.claimContent(a, file, second.id), first.id);
      assert.equal(await h.store.claimContent(a, file, first.id), first.id);
    });
    await h.write(b, async () => {
      await h.store.insertDocument(other, keys(3));
      assert.equal(await h.store.claimContent(b, file, other.id), other.id);
    });
    // A claim for a document this company does not have is refused, not recorded.
    await assert.rejects(h.write(b, () => h.store.claimContent(b, sha("x"), first.id)), code("INBOX_DOCUMENT_UNKNOWN"));
  });

  test(`${name}: a draft keeps every figure exactly, and there is one per document`, { skip }, async () => {
    const h = harness();
    const a = await h.company();
    const document = documentFor(a, 1);
    const draft = draftFor(document);
    await h.write(a, async () => { await h.store.insertDocument(document, keys(1)); await h.store.insertDraft(draft); });
    const back = await h.store.draftFor(a, document.id);
    assert.deepEqual(back, draft);
    assert.equal(back?.invoiceTotalPaise?.value, HUGE);
    await assert.rejects(h.write(a, () => h.store.insertDraft({ ...draft, id: randomUUID() })), code("INBOX_DRAFT_DUPLICATE"));
    await assert.rejects(h.write(a, () => h.store.insertDraft(draftFor(documentFor(a, 2)))), code("INBOX_DOCUMENT_UNKNOWN"));
    assert.equal(await h.store.draftFor(a, randomUUID()), null);
  });

  test(`${name}: another company sees and changes nothing`, { skip }, async () => {
    const h = harness();
    const [a, b] = [await h.company(), await h.company()];
    const document = documentFor(a, 1);
    await h.write(a, async () => { await h.store.insertDocument(document, keys(1)); await h.store.insertDraft(draftFor(document)); });
    assert.equal(await h.store.document(b, document.id), null);
    assert.deepEqual(await h.store.documents(b), []);
    assert.equal(await h.store.documentByMessageKey(b, keys(1).messageKey), null);
    assert.equal(await h.store.intakeKey(b, document.id), null);
    assert.equal(await h.store.draftFor(b, document.id), null);
    await assert.rejects(h.write(b, () => h.store.updateDocument({ ...document, companyId: b, status: "failed" })), code("INBOX_DOCUMENT_UNKNOWN"));
    assert.equal((await h.store.document(a, document.id))?.status, "screening");
  });

  test(`${name}: a failed action leaves nothing behind`, { skip }, async () => {
    const h = harness();
    const a = await h.company();
    const document = documentFor(a, 1);
    await assert.rejects(h.write(a, async () => {
      await h.store.insertDocument(document, keys(1));
      await h.store.claimContent(a, document.attachment.sha256, document.id);
      await h.store.insertDraft(draftFor(document));
      throw new Error("stop");
    }), /stop/);
    assert.equal(await h.store.document(a, document.id), null);
    assert.equal(await h.store.draftFor(a, document.id), null);
    assert.equal(await h.store.documentByMessageKey(a, keys(1).messageKey), null);
  });

  test(`${name}: no write is saved outside the action's transaction`, { skip }, async () => {
    const h = harness();
    if (!h.requiresUnitOfWork) return; // memory has no transaction to require
    const a = await h.company();
    const document = documentFor(a, 1);
    for (const [label, attempt] of [
      ["insertDocument", () => h.store.insertDocument(document, keys(1))],
      ["updateDocument", () => h.store.updateDocument(document)],
      ["claimContent", () => h.store.claimContent(a, document.attachment.sha256, document.id)],
      ["insertDraft", () => h.store.insertDraft(draftFor(document))],
    ] as const) await assert.rejects(attempt(), code("NO_UNIT_OF_WORK"), label);
    assert.deepEqual(await h.store.documents(a), []);
  });

  // ------------------------------------------------------------------ through the service

  const serviceFor = async (h: InboxHarness) => {
    const companies: CompanyRoutingProfile[] = [];
    for (const [n, state] of [[1, "29"], [2, "27"]] as const) {
      companies.push({ companyId: await h.company(), legalName: `Synthetic Traders ${n}`, gstins: [syntheticGstin(state, `AAACB${n}234M`)],
        emailAliases: [`bills-${n}@shop.example`, "shared@shop.example"], whatsappNumbers: [], ownerId: "owner-1" });
    }
    const audit = new AuditLog();
    const make = () => new PurchaseInboxService(new PlatformCommandService(audit, []), audit, new MockOcrAdapter({}), companies,
      { store: h.store, unitOfWork: (companyId, work) => h.write(companyId, work) });
    return { companies, make, service: make() };
  };
  const einvoice = (buyer: string, number = "SRS/2026/0042") => JSON.stringify({
    Version: "1.1", DocDtls: { Typ: "INV", No: number, Dt: "21/07/2026" },
    SellerDtls: { Gstin: syntheticGstin("27", "AAECS5678D"), LglNm: "Synthetic Steels" }, BuyerDtls: { Gstin: buyer, LglNm: "Buyer" },
    ItemList: [{ SlNo: "1", PrdDesc: "TMT bar", HsnCd: "72142090", Qty: 500, Unit: "KGS", UnitPrice: 64, AssAmt: 32000, GstRt: 18 }],
    ValDtls: { AssVal: 32000, IgstVal: 5760, TotInvVal: 37760 },
  });
  const delivery = (company: CompanyRoutingProfile, alias: string, number = "SRS/2026/0042", messageId = "<m-1@supplier.example>") => ({
    channel: "email" as const, sender: { channel: "email" as const, address: "accounts@supplier.example", providerMessageId: messageId },
    attachment: { id: "att-1", fileName: "einvoice.json", declaredMimeType: "application/json", sizeBytes: 0, sha256: "", storageKey: "s3://inbox/1" },
    bytes: new Uint8Array(Buffer.from(einvoice(company.gstins[0] as string, number))), scanVerdict: "clean" as const, deliveredTo: alias,
    idempotencyKey: `intake-${messageId}`,
  });
  const contextOf = (companyId: string): RequestContext => ({ companyId, branchId: companyId, actorId: "owner", permissions: new Set(["purchase.inbox.manage"]), sessionId: "s" });

  test(`${name}: a routed document is stored in its company, and a redelivery is the same document`, { skip }, async () => {
    const h = harness();
    const { companies, service } = await serviceFor(h);
    const [one, two] = companies as [CompanyRoutingProfile, CompanyRoutingProfile];
    const first = await service.receive(delivery(one, "bills-1@shop.example"));
    assert.equal(first.document.status, "draft_ready");
    assert.equal(first.document.companyId, one.companyId);
    assert.deepEqual(await service.inbox(contextOf(one.companyId)), [first.document]);
    assert.deepEqual(await service.draft(contextOf(one.companyId), first.document.id), first.draft);
    assert.deepEqual(await service.inbox(contextOf(two.companyId)), []);
    const again = await service.receive(delivery(one, "bills-1@shop.example"));
    assert.equal(again.duplicate, true);
    assert.deepEqual(again.document, first.document);
    assert.deepEqual(again.draft, first.draft);
    // The same file under another message id is caught by the file itself, and kept as discarded.
    const copy = await service.receive(delivery(one, "bills-1@shop.example", "SRS/2026/0042", "<m-2@supplier.example>"));
    assert.equal(copy.document.status, "discarded");
    assert.equal(copy.document.duplicateOfId, first.document.id);
    assert.equal((await service.inbox(contextOf(one.companyId))).length, 2);
  });

  test(`${name}: two identical messages at once, on two servers, store exactly one document`, { skip }, async () => {
    const h = harness();
    const { companies, make } = await serviceFor(h);
    const one = companies[0] as CompanyRoutingProfile;
    const results = await Promise.all([make(), make()].map((service) => service.receive(delivery(one, "bills-1@shop.example"))));
    const stored = await h.store.documents(one.companyId);
    assert.equal(stored.length, 1);
    assert.deepEqual(results.map((r) => r.duplicate).sort(), [false, true]);
    assert.ok(results.every((r) => r.document.id === stored[0]?.id));
  });

  test(`${name}: a document on a shared address is stored only once a company claims it`, { skip }, async () => {
    const h = harness();
    const { companies, service } = await serviceFor(h);
    const [one, two] = companies as [CompanyRoutingProfile, CompanyRoutingProfile];
    const held = await service.receive(delivery(one, "shared@shop.example"));
    assert.equal(held.document.quarantineReason, "COMPANY_NOT_IDENTIFIED");
    assert.deepEqual(await h.store.documents(one.companyId), []);
    const claimed = await service.assignCompany(contextOf(one.companyId), held.document.id, "our supplier");
    assert.deepEqual(await h.store.document(one.companyId, held.document.id), claimed);
    assert.deepEqual(await h.store.documents(two.companyId), []);
    // A resend of that message finds the claimed document, wherever it went.
    const again = await service.receive(delivery(one, "shared@shop.example"));
    assert.equal(again.duplicate, true);
    assert.equal(again.document.id, held.document.id);
  });
}

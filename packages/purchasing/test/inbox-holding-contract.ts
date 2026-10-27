/**
 * Issue #488 — one contract suite for the purchase inbox's pre-tenant holding (inbox-holding.ts),
 * run in memory (inbox-holding-contract.test.ts) and on PostgreSQL as the application role
 * (inbox-holding-contract.integration.test.ts). Lane owner: GPT 3.
 *
 * The second half drives the whole service over the holding: a message held for a shared address,
 * a file waiting for the virus scanner and a document being screened all outlive a "restart" — a
 * second service built over the same holding and store, which is all a restart leaves behind.
 * Everything is invented: no real business, GST number or person.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { syntheticGstin } from "../../masters/src/fixtures.ts";
import { AuditLog, PlatformCommandService } from "../../platform/src/index.ts";
import type { Permission, RequestContext } from "../../platform/src/types.ts";
import { MockOcrAdapter, pageFromLines } from "../src/index.ts";
import { PurchaseInboxService } from "../src/inbox.ts";
import { sweepInboxHolding, UNROUTED } from "../src/inbox-holding.ts";
import type { HeldRecord, InboxHolding } from "../src/inbox-holding.ts";
import type { InboxStore } from "../src/inbox-store.ts";
import type { InboundDocument } from "../src/inbox-types.ts";
import type { CompanyRoutingProfile } from "../src/routing.ts";

export interface HoldingHarness {
  /** A handle onto the holding. Every call returns one onto the same rows, as a restarted process would. */
  holding(): InboxHolding;
  /** The routed documents' store, shared the same way. */
  store(): InboxStore;
  /** A new company, wherever the implementation keeps companies. */
  company(): Promise<string>;
  /** One business action: committed when `work` resolves, nothing left when it throws. */
  write<T>(companyId: string, work: () => Promise<T>): Promise<T>;
  /** True where a durable database holds the rows, so a rollback really restores them. */
  readonly transactional: boolean;
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "latin1"));
const SUPPLIER_GSTIN = syntheticGstin("27", "AAECS5678D");
const BUYER_GSTIN = syntheticGstin("29", "AAACB1234M");

/** A small but real one-page PDF, which is what screening opens (#401). */
const makePdf = (tag: string): Uint8Array => {
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj",
    `4 0 obj << /Length 20 >> stream\n% ${tag}\nendstream endobj`,
  ];
  let pdf = "%PDF-1.7\n";
  const offsets: number[] = [];
  for (const object of objects) { offsets.push(pdf.length); pdf += `${object}\n`; }
  const xrefAt = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  return bytes(pdf);
};

const INVOICE_PAGE = pageFromLines(1, [
  "SHREE RAM STEELS PRIVATE LIMITED", `GSTIN: ${SUPPLIER_GSTIN}`, "TAX INVOICE", "Invoice No: SRS/2026/0042", "Invoice Date: 21/07/2026",
  "Bill To: Synthetic Buyer", `GSTIN: ${BUYER_GSTIN}`, "TMT Steel Bar 12mm   HSN 72142090   500 KGS   64.00",
  "Taxable Value: 32,000.00", "IGST 18%: 5,760.00", "Grand Total: 37,760.00",
]);

const contextFor = (companyId: string, permissions: readonly Permission[] = ["purchase.inbox.manage"]): RequestContext =>
  ({ companyId, branchId: `${companyId}-main`, actorId: `owner-${companyId}`, permissions: new Set(permissions), sessionId: `session-${companyId}` });

const recordFor = (n: number, extra: Partial<InboundDocument> = {}, messageKey: string | null = `email:delivery:email:desk@shop.example:<m-${randomUUID()}>:${sha(String(n))}`): HeldRecord => ({
  document: {
    id: randomUUID(), companyId: UNROUTED, channel: "email",
    sender: { channel: "email", address: "accounts@supplier.example", displayName: "Synthetic Steels", providerMessageId: `<m-${n}@supplier.example>` },
    attachment: { id: `att-${n}`, fileName: `bill-${n}.pdf`, declaredMimeType: "application/pdf", sizeBytes: 240_000 + n, sha256: sha(`file-${n}-${randomUUID()}`), storageKey: `held/${randomUUID()}`, pageCount: 2 },
    receivedAt: new Date(Date.UTC(2026, 6, 21, 10, 0, n, 123)).toISOString(), status: "screening", attempts: 1, ...extra,
  },
  keys: { messageKey, intakeKey: `intake-${n}-${randomUUID()}` },
  delivery: { deliveredTo: "desk@shop.example", scanVerdict: "unscanned" },
});

const held = (record: HeldRecord, changes: Partial<InboundDocument>): HeldRecord => ({ ...record, document: { ...record.document, ...changes } as InboundDocument });
const sharedHold = { status: "quarantined", quarantineReason: "COMPANY_NOT_IDENTIFIED", statusMessage: "This address is shared by more than one of your businesses." } as const;

export function inboxHoldingContract(name: string, harness: () => HoldingHarness, skip: string | false = false): void {
  // ------------------------------------------------------------------ the holding by itself

  test(`${name}: a held document comes back as written, with the file as a key and nothing read from it`, { skip }, async () => {
    const h = harness();
    const record = recordFor(1);
    const put = await h.holding().put(record, []);
    assert.equal(put.created, true);
    const back = await h.holding().get(record.document.id);
    assert.deepEqual(back, record);
    assert.equal(back?.document.attachment.storageKey, record.document.attachment.storageKey);
    assert.deepEqual(await h.holding().byMessage(record.keys.messageKey as string), record);
    assert.equal(await h.holding().get(randomUUID()), null);
    assert.equal(await h.holding().get("not-an-id"), null);
  });

  test(`${name}: one message is one held document, however many copies arrive at once`, { skip }, async () => {
    const h = harness();
    const first = recordFor(2);
    const copies = await Promise.all(Array.from({ length: 8 }, () => h.holding().put(held(first, { id: randomUUID() }), [])));
    assert.equal(copies.filter((copy) => copy.created).length, 1);
    const winner = copies.find((copy) => copy.created) as { record: HeldRecord };
    for (const copy of copies) assert.equal(copy.record.document.id, winner.record.document.id);
    // A message with no message id is never merged with another.
    const [a, b] = [recordFor(3, {}, null), recordFor(4, {}, null)];
    assert.equal((await h.holding().put(a, [])).created, true);
    assert.equal((await h.holding().put(b, [])).created, true);
  });

  test(`${name}: a business sees only what is waiting on its own address, and only a name and a size`, { skip }, async () => {
    const h = harness();
    const [a, b, stranger] = [await h.company(), await h.company(), await h.company()];
    const shared = recordFor(5);
    await h.holding().put(shared, []);
    assert.equal(await h.holding().save(held(shared, sharedHold), [a, b]), true);
    const unowned = recordFor(6);
    await h.holding().put(unowned, []);
    await h.holding().save(held(unowned, sharedHold), []);

    for (const owner of [a, b]) {
      const waiting = await h.holding().waitingFor(owner);
      assert.deepEqual(waiting.map((item) => item.id), [shared.document.id]);
      assert.deepEqual(Object.keys(waiting[0] ?? {}).sort(), ["channel", "fileName", "id", "receivedAt", "sizeBytes"]);
      assert.equal(waiting[0]?.fileName, shared.document.attachment.fileName);
    }
    assert.deepEqual(await h.holding().waitingFor(stranger), []);
    // A document on nobody's address is waiting for nobody.
    assert.equal((await h.holding().waitingFor(a)).some((item) => item.id === unowned.document.id), false);
    // Nor can a stranger look at it or take it.
    assert.equal(await h.holding().peek(stranger, shared.document.id), null);
    assert.equal((await h.holding().peek(a, shared.document.id))?.document.id, shared.document.id);
    assert.equal(await h.write(stranger, () => h.holding().claim(stranger, shared.document.id)), null);
    assert.equal(await h.write(a, () => h.holding().claim(a, unowned.document.id)), null);
    assert.equal((await h.holding().get(shared.document.id))?.document.id, shared.document.id);
  });

  test(`${name}: the owner lookup answers company ids and nothing else, and is on the trail`, { skip }, async () => {
    const h = harness();
    const [a, b] = [await h.company(), await h.company()];
    const record = recordFor(7);
    await h.holding().put(record, []);
    await h.holding().save(held(record, sharedHold), [a, b]);
    assert.deepEqual([...await h.holding().channelOwners(record.document.id)].sort(), [a, b].sort());
    assert.deepEqual(await h.holding().channelOwners(randomUUID()), []);
    assert.deepEqual(await h.holding().channelOwners("not-an-id"), []);
  });

  test(`${name}: claiming takes the document out of the holding for that company only, once`, { skip }, async () => {
    const h = harness();
    const [a, b] = [await h.company(), await h.company()];
    const record = recordFor(8);
    await h.holding().put(record, []);
    await h.holding().save(held(record, sharedHold), [a, b]);
    const [first, second] = await Promise.all([
      h.write(a, () => h.holding().claim(a, record.document.id)),
      h.write(b, () => h.holding().claim(b, record.document.id)),
    ]);
    assert.equal([first, second].filter((taken) => taken !== null).length, 1);
    assert.equal(await h.holding().get(record.document.id), null);
    assert.deepEqual(await h.holding().waitingFor(a), []);
  });

  test(`${name}: a save that expects a state refuses once the document has moved on`, { skip }, async () => {
    const h = harness();
    const record = recordFor(9);
    await h.holding().put(record, []);
    const waiting = held(record, { status: "quarantined", quarantineReason: "AWAITING_SCAN", statusMessage: "Waiting for the virus check." });
    assert.equal(await h.holding().save(waiting, []), true);
    const from = { status: "quarantined", quarantineReason: "AWAITING_SCAN" } as const;
    assert.equal(await h.holding().save(held(record, { status: "screening" }), [], from), true);
    // The second answer to the same question finds it already moved.
    assert.equal(await h.holding().save(held(record, { status: "screening" }), [], from), false);
    assert.equal(await h.holding().save(held(recordFor(10), {}), []), false);
  });

  test(`${name}: expiry removes what was received before the cut-off and says which files it pointed at`, { skip }, async () => {
    const h = harness();
    const [old, recent] = [recordFor(11, { receivedAt: "2020-01-01T00:00:00.000Z" }), recordFor(12, { receivedAt: new Date().toISOString() })];
    await h.holding().put(old, []);
    await h.holding().put(recent, []);
    const gone = await h.holding().expire(new Date(Date.now() - 86_400_000));
    assert.ok(gone.some((item) => item.id === old.document.id && item.storageKey === old.document.attachment.storageKey));
    assert.equal(gone.some((item) => item.id === recent.document.id), false);
    assert.equal(await h.holding().get(old.document.id), null);
    assert.ok(await h.holding().get(recent.document.id));
  });

  test(`${name}: the sweep uses the retention period and discards the files it can`, { skip }, async () => {
    const h = harness();
    const old = recordFor(13, { receivedAt: new Date(Date.now() - 31 * 86_400_000).toISOString() });
    const fresh = recordFor(14, { receivedAt: new Date(Date.now() - 29 * 86_400_000).toISOString() });
    await h.holding().put(old, []);
    await h.holding().put(fresh, []);
    const discarded: string[] = [];
    const result = await sweepInboxHolding(h.holding(), { discardBytes: async (key) => { discarded.push(key); } });
    assert.ok(result.expired >= 1);
    assert.ok(discarded.includes(old.document.attachment.storageKey));
    assert.equal(discarded.includes(fresh.document.attachment.storageKey), false);
    assert.equal(await h.holding().get(old.document.id), null);
    assert.ok(await h.holding().get(fresh.document.id));
    await assert.rejects(sweepInboxHolding(h.holding(), { retentionDays: 0 }), /whole number of days/);
  });

  test(`${name}: documents still being screened since before a time are listed for a resume`, { skip }, async () => {
    const h = harness();
    const stuck = recordFor(15, { receivedAt: "2021-01-01T00:00:00.000Z" });
    const done = recordFor(16, { receivedAt: "2021-01-01T00:00:00.000Z" });
    await h.holding().put(stuck, []);
    await h.holding().put(done, []);
    await h.holding().save(held(done, sharedHold), []);
    const ids = (await h.holding().stalled(new Date("2022-01-01T00:00:00Z"))).map((record) => record.document.id);
    assert.ok(ids.includes(stuck.document.id));
    assert.equal(ids.includes(done.document.id), false);
    assert.deepEqual(await h.holding().stalled(new Date("2020-01-01T00:00:00Z")), []);
  });

  // --------------------------------------------------- the service over it, across a "restart"

  /** A service as one process would build it; building another is the restart. */
  const boot = async (h: HoldingHarness, options: { readonly files?: Map<string, Uint8Array>; readonly sharedAddress?: boolean } = {}) => {
    const [a, b, only] = [await h.company(), await h.company(), await h.company()];
    const alias = (label: string) => `${label}-${randomUUID().slice(0, 8)}@invoices.example`;
    const [sharedAlias, ownAlias] = [alias("shared"), alias("own")];
    const companies: CompanyRoutingProfile[] = [
      { companyId: a, legalName: "Synthetic Traders A", gstins: [BUYER_GSTIN], emailAliases: [sharedAlias], whatsappNumbers: [], ownerId: "owner-1" },
      { companyId: b, legalName: "Synthetic Traders B", gstins: [syntheticGstin("27", "AAACZ9999Q")], emailAliases: [sharedAlias], whatsappNumbers: [], ownerId: "owner-1" },
      { companyId: only, legalName: "Synthetic Traders C", gstins: [BUYER_GSTIN], emailAliases: [ownAlias], whatsappNumbers: [] },
    ];
    const files = options.files ?? new Map<string, Uint8Array>();
    const start = () => {
      const audit = new AuditLog();
      return {
        audit,
        inbox: new PurchaseInboxService(new PlatformCommandService(audit, []), audit, new MockOcrAdapter({}, "healthy"), companies, {
          store: h.store(), holding: h.holding(), unitOfWork: (companyId, work) => h.write(companyId, work),
          readBytes: async (key) => files.get(key) ?? null,
        }),
      };
    };
    return { a, b, only, sharedAlias, ownAlias, companies, files, start };
  };

  const mail = (files: Map<string, Uint8Array>, deliveredTo: string, file: Uint8Array, id: string, scanVerdict: "clean" | "unscanned" = "clean") => {
    const storageKey = `held/${randomUUID()}`;
    files.set(storageKey, file);
    return {
      channel: "email" as const, sender: { channel: "email" as const, address: "accounts@supplier.example", providerMessageId: id },
      attachment: { id: `att-${id}`, fileName: "bill.pdf", declaredMimeType: "application/pdf", sizeBytes: 0, sha256: "", storageKey },
      bytes: file, scanVerdict, deliveredTo, idempotencyKey: `intake-${id}`,
    };
  };

  test(`${name}: a message held for a shared address survives a restart and is routed with assignCompany`, { skip }, async () => {
    const h = harness();
    const world = await boot(h);
    const before = world.start();
    const received = await before.inbox.receive(mail(world.files, world.sharedAlias, makePdf("shared-1"), "<shared-1>"));
    assert.equal(received.document.companyId, UNROUTED);
    assert.equal(received.document.quarantineReason, "COMPANY_NOT_IDENTIFIED");

    // The process stops. A new one starts and finds it where it was left.
    const after = world.start();
    for (const owner of [world.a, world.b]) {
      assert.deepEqual((await after.inbox.awaitingAssignment(contextFor(owner))).map((item) => item.id), [received.document.id]);
    }
    assert.deepEqual(await after.inbox.awaitingAssignment(contextFor(world.only)), []);

    // The same message delivered again after the restart is the same document.
    const again = await after.inbox.receive(mail(world.files, world.sharedAlias, makePdf("shared-1"), "<shared-1>"));
    assert.equal(again.duplicate, true);
    assert.equal(again.document.id, received.document.id);

    // Another business cannot take it, or learn that it exists.
    await assert.rejects(after.inbox.assignCompany(contextFor(world.only), received.document.id, "mine"), /not found/);
    await assert.rejects(after.inbox.document(contextFor(world.only), received.document.id), /not found/);

    const claimed = await after.inbox.assignCompany(contextFor(world.a), received.document.id, "our supplier");
    assert.equal(claimed.companyId, world.a);
    assert.equal((await after.inbox.document(contextFor(world.a), received.document.id)).status, "received");
    // Out of the holding in the same unit of work: nothing waits any more, for either owner.
    assert.equal(await h.holding().get(received.document.id), null);
    assert.deepEqual(await after.inbox.awaitingAssignment(contextFor(world.b)), []);
    await assert.rejects(after.inbox.assignCompany(contextFor(world.b), received.document.id, "ours too"), /not found/);
    // And the other business cannot see it in its books.
    await assert.rejects(after.inbox.document(contextFor(world.b), received.document.id), /not found/);
  });

  test(`${name}: two owners claiming the same held document at once make one claim`, { skip }, async () => {
    const h = harness();
    const world = await boot(h);
    const inbox = world.start().inbox;
    const received = await inbox.receive(mail(world.files, world.sharedAlias, makePdf("shared-2"), "<shared-2>"));
    const outcomes = await Promise.allSettled([
      inbox.assignCompany(contextFor(world.a), received.document.id, "ours"),
      inbox.assignCompany(contextFor(world.b), received.document.id, "ours"),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    const winner = (outcomes.find((outcome) => outcome.status === "fulfilled") as PromiseFulfilledResult<InboundDocument>).value.companyId;
    assert.ok([world.a, world.b].includes(winner));
    assert.equal(await h.holding().get(received.document.id), null);
  });

  test(`${name}: a file waiting for the virus scanner is still waiting after a restart, and the answer routes it`, { skip }, async () => {
    const h = harness();
    const world = await boot(h);
    const pdf = makePdf("scan-1");
    const received = await world.start().inbox.receive(mail(world.files, world.ownAlias, pdf, "<scan-1>", "unscanned"));
    assert.equal(received.document.quarantineReason, "AWAITING_SCAN");
    assert.equal(received.document.companyId, UNROUTED);

    const after = world.start();
    const answered = await after.inbox.scanAnswered(received.document.id, "clean");
    // Released into the normal pipeline: routed by its address to the one business that owns it, and filed there.
    assert.equal(answered.document.companyId, world.only);
    assert.equal(answered.document.routing?.basis, "channel_binding");
    assert.equal((await after.inbox.document(contextFor(world.only), received.document.id)).id, received.document.id);
    assert.equal(await h.holding().get(received.document.id), null);
    // A second answer finds nothing waiting.
    await assert.rejects(after.inbox.scanAnswered(received.document.id, "clean"), /not waiting/);
  });

  test(`${name}: an infected answer after a restart holds the file for good, and no business can claim it`, { skip }, async () => {
    const h = harness();
    const world = await boot(h);
    const received = await world.start().inbox.receive(mail(world.files, world.sharedAlias, makePdf("scan-2"), "<scan-2>", "unscanned"));
    const after = world.start();
    const infected = await after.inbox.scanAnswered(received.document.id, "infected");
    assert.equal(infected.document.quarantineReason, "MALWARE_SUSPECTED");
    await assert.rejects(after.inbox.scanAnswered(received.document.id, "clean"), /not waiting/);
    await assert.rejects(after.inbox.assignCompany(contextFor(world.a), received.document.id, "looks fine"), /not found/);
    assert.deepEqual(await after.inbox.awaitingAssignment(contextFor(world.a)), []);
  });

  test(`${name}: two scanner answers at once go through once`, { skip }, async () => {
    const h = harness();
    const world = await boot(h);
    const inbox = world.start().inbox;
    const received = await inbox.receive(mail(world.files, world.ownAlias, makePdf("scan-3"), "<scan-3>", "unscanned"));
    const outcomes = await Promise.allSettled([inbox.scanAnswered(received.document.id, "clean"), inbox.scanAnswered(received.document.id, "clean")]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  });

  test(`${name}: a document that arrived on nobody's address stays held, claimable by nobody, until it expires`, { skip }, async () => {
    const h = harness();
    const world = await boot(h);
    const received = await world.start().inbox.receive(mail(world.files, "nobody@invoices.example", makePdf("nobody-1"), "<nobody-1>"));
    assert.equal(received.document.quarantineReason, "COMPANY_NOT_IDENTIFIED");
    const after = world.start();
    for (const owner of [world.a, world.b, world.only]) {
      assert.deepEqual(await after.inbox.awaitingAssignment(contextFor(owner)), []);
      await assert.rejects(after.inbox.assignCompany(contextFor(owner), received.document.id, "mine"), /not found/);
    }
    assert.ok(await h.holding().get(received.document.id));
    const swept = await sweepInboxHolding(h.holding(), { now: new Date(Date.now() + 31 * 86_400_000) });
    assert.ok(swept.expired >= 1);
    assert.equal(await h.holding().get(received.document.id), null);
  });

  test(`${name}: a document a process stopped on while screening is picked up and carried through`, { skip }, async () => {
    const h = harness();
    const world = await boot(h);
    const pdf = makePdf("stalled-1");
    const request = mail(world.files, world.ownAlias, pdf, "<stalled-1>");
    // What the dead process left behind: a screening row, written before anything else happened.
    const record = recordFor(20, { receivedAt: "2021-01-01T00:00:00.000Z", attachment: { id: "att-20", fileName: "bill.pdf", declaredMimeType: "application/pdf", sizeBytes: pdf.length, sha256: createHash("sha256").update(pdf).digest("hex"), storageKey: request.attachment.storageKey } });
    const stalled = { ...record, keys: { messageKey: null, intakeKey: request.idempotencyKey }, delivery: { deliveredTo: world.ownAlias, scanVerdict: "clean" as const } };
    await h.holding().put(stalled, []);

    const resumed = await world.start().inbox.resumeInterrupted(new Date("2022-01-01T00:00:00Z"));
    assert.equal(resumed, 1);
    assert.equal(await h.holding().get(record.document.id), null);
    const filed = await world.start().inbox.document(contextFor(world.only), record.document.id);
    assert.equal(filed.companyId, world.only);
    assert.equal(await world.start().inbox.resumeInterrupted(new Date("2022-01-01T00:00:00Z")), 0);
  });

  test(`${name}: a held document whose file has gone is held with a plain message, not lost or guessed at`, { skip }, async () => {
    const h = harness();
    const world = await boot(h);
    const record = recordFor(21, { receivedAt: "2021-01-01T00:00:00.000Z" });
    await h.holding().put({ ...record, keys: { messageKey: null, intakeKey: "intake-gone" } }, []);
    await world.start().inbox.resumeInterrupted(new Date("2022-01-01T00:00:00Z"));
    const after = await h.holding().get(record.document.id);
    assert.equal(after?.document.quarantineReason, "UNREADABLE");
    assert.match(after?.document.statusMessage ?? "", /send it again/);
  });
}

/**
 * Issue #366 — one contract suite for the e-invoice stores, run against the in-memory ones
 * (einvoice-contract.test.ts) and against PostgreSQL (einvoice-contract.integration.test.ts).
 *
 * Only synthetic data. Every test makes its own company, so files can share one database.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import type { CompanyId } from "@invoice/kernel";
import { InMemoryAuditPort } from "@invoice/ledger";
import { ConnectorGateway, StaticWebhookVerifier } from "../../platform/src/connectors.ts";
import { decideApplicability } from "../src/applicability.ts";
import { SyntheticIrp, SyntheticIrpVault, irpAdapter } from "../src/einvoice-adapters.ts";
import {
  ALL_EINVOICE_PERMISSIONS, BUYER_GSTIN, OWNER, SUPPLIER_GSTIN, aboveThreshold, actorWith, belowThreshold, invoiceDocument,
} from "../src/einvoice-fixtures.ts";
import type { EInvoicePolicyPort, EInvoiceRepository } from "../src/einvoice-ports.ts";
import { EInvoiceService } from "../src/einvoice-service.ts";
import { DEFAULT_EINVOICE_POLICY, type EInvoicePolicy, type EInvoiceRecord } from "../src/einvoice-types.ts";
import { computeIrn } from "../src/irn.ts";

export interface EInvoiceHarness {
  records: EInvoiceRepository;
  policies: EInvoicePolicyPort;
  /** Must be called inside `run`. */
  setPolicy(companyId: CompanyId, policy: EInvoicePolicy, userId: string): Promise<void>;
  /** One business action: saved whole, or (when `work` rejects) not at all. */
  run<T>(companyId: CompanyId, work: () => Promise<T>): Promise<T>;
  /** A company and a user: rows that exist wherever the implementation keeps them. */
  company(): Promise<{ companyId: CompanyId; userId: string }>;
}

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
const AT = "2026-08-21T10:00:00.000Z";
let numbered = 0;

/** A record as `register()` first writes it: nothing optional is set. */
export const pendingRecord = (companyId: CompanyId, userId: string, over: Partial<EInvoiceRecord> = {}): EInvoiceRecord => {
  const documentId = randomUUID();
  return {
    id: randomUUID(), companyId, documentId, documentNumber: `SAM/2026/${String(numbered += 1).padStart(4, "0")}`,
    documentDate: "2026-08-21", documentType: "INVOICE", supplierGstin: SUPPLIER_GSTIN, financialYear: "2026-27",
    status: "PENDING", applicability: decideApplicability(aboveThreshold()),
    message: "This bill is about to be sent to the government.",
    createdBy: userId, createdAt: AT, updatedAt: AT, idempotencyKey: `einvoice:generate:${companyId}:${documentId}`,
    ...over,
  };
};

/** Everything a record can carry, registered. */
export const registeredRecord = (companyId: CompanyId, userId: string, over: Partial<EInvoiceRecord> = {}): EInvoiceRecord => pendingRecord(companyId, userId, {
  status: "REGISTERED", recipientGstin: BUYER_GSTIN, reportableUntil: "2026-09-19",
  acknowledgement: {
    irn: randomBytes(32).toString("hex"), ackNumber: "112000000042", ackDate: "2026-08-21 15:30:00",
    signedQrCode: "eyJhbGciOiJSUzI1NiJ9.c3ludGhldGlj.c2lnbmF0dXJl", signedInvoice: "eyJhbGciOiJSUzI1NiJ9.aW52b2ljZQ.c2lnbmF0dXJl",
    ewayBillNumber: "181000000042", providerRequestId: "synthetic-irp-42", receivedAt: "2026-08-21T10:00:01.250Z",
  },
  failure: { code: "TIMEOUT", message: "The government's e-invoice service did not answer in time.", retryable: true },
  cancellableUntil: "2026-08-22T10:00:00.000Z",
  message: "The government has registered this bill. Give the customer the copy with the QR code on it.",
  updatedAt: "2026-08-21T10:00:02.000Z",
  ...over,
});

export function eInvoiceContract(label: string, harness: () => EInvoiceHarness, skip: false | string = false): void {
  const shop = async () => ({ h: harness(), ...(await harness().company()) });
  const save = (h: EInvoiceHarness, ...records: EInvoiceRecord[]) => h.run(records[0]!.companyId as CompanyId, async () => { for (const record of records) await h.records.insert(record); });

  test(`${label}: a record comes back exactly as it was saved, by id, by bill and by IRN`, { skip }, async () => {
    const { h, companyId, userId } = await shop();
    const bare = pendingRecord(companyId, userId);
    const full = registeredRecord(companyId, userId);
    const cancelled = registeredRecord(companyId, userId, {
      status: "CANCELLED", cancelledAt: "2026-08-21T11:15:00.000Z", cancelReasonCode: "ORDER_CANCELLED", cancelReason: "The customer cancelled the order.",
    });
    await save(h, bare, full, cancelled);

    for (const saved of [bare, full, cancelled]) {
      assert.deepEqual(await h.records.findById(companyId, saved.id), saved);
      assert.deepEqual(await h.records.findByDocumentId(companyId, saved.documentId), saved);
    }
    assert.deepEqual(await h.records.findByIrn(companyId, full.acknowledgement!.irn), full);
    // Paise inside the stored decision are still bigint paise, to the last one.
    const threshold = (await h.records.findById(companyId, bare.id))?.applicability.thresholdApplied?.thresholdPaise;
    assert.equal(typeof threshold, "bigint");
    assert.equal(threshold, 5_00_00_000_00n);
    // What was never set is absent, not null.
    const read = await h.records.findById(companyId, bare.id) as EInvoiceRecord;
    for (const key of ["acknowledgement", "failure", "recipientGstin", "cancelledAt", "cancelReasonCode", "cancelReason", "cancellableUntil", "reportableUntil"]) {
      assert.equal(key in read, false, key);
    }
  });

  test(`${label}: what is not there is not found, and updating it changes nothing`, { skip }, async () => {
    const { h, companyId, userId } = await shop();
    assert.equal(await h.records.findById(companyId, randomUUID()), null);
    assert.equal(await h.records.findByDocumentId(companyId, randomUUID()), null);
    assert.equal(await h.records.findByIrn(companyId, "f".repeat(64)), null);
    const ghost = pendingRecord(companyId, userId);
    await h.run(companyId, () => h.records.update(ghost));
    assert.equal(await h.records.findById(companyId, ghost.id), null);
    assert.deepEqual(await h.records.list(companyId), []);
  });

  test(`${label}: update replaces the whole record`, { skip }, async () => {
    const { h, companyId, userId } = await shop();
    const first = pendingRecord(companyId, userId);
    await save(h, first);
    const failed: EInvoiceRecord = {
      ...first, status: "FAILED", updatedAt: "2026-08-21T10:05:00.000Z",
      failure: { code: "OUTAGE", message: "The government's e-invoice service is not responding at the moment.", retryable: true },
      message: "The government's e-invoice service is not responding at the moment. We will try again.",
    };
    await h.run(companyId, () => h.records.update(failed));
    assert.deepEqual(await h.records.findById(companyId, first.id), failed);
    const registered = registeredRecord(companyId, userId, { id: first.id, documentId: first.documentId, documentNumber: first.documentNumber, idempotencyKey: first.idempotencyKey });
    await h.run(companyId, () => h.records.update(registered));
    assert.deepEqual(await h.records.findById(companyId, first.id), registered);
  });

  test(`${label}: one record per bill and one holder per IRN — a second is refused`, { skip }, async () => {
    const { h, companyId, userId } = await shop();
    const first = registeredRecord(companyId, userId);
    await save(h, first);
    // The same bill again, under a new id.
    await assert.rejects(save(h, pendingRecord(companyId, userId, { documentId: first.documentId })), code("EINVOICE_DUPLICATE"));
    // The same id again.
    await assert.rejects(save(h, pendingRecord(companyId, userId, { id: first.id })), code("EINVOICE_DUPLICATE"));
    // Another bill claiming the IRN the first one holds.
    const other = pendingRecord(companyId, userId);
    await save(h, other);
    await assert.rejects(
      h.run(companyId, () => h.records.update({ ...other, status: "REGISTERED", acknowledgement: first.acknowledgement! })),
      code("EINVOICE_DUPLICATE"),
    );
    assert.deepEqual(await h.records.findById(companyId, other.id), other);
    assert.equal((await h.records.list(companyId)).length, 2);
  });

  test(`${label}: one company cannot read or change another company's e-invoices`, { skip }, async () => {
    const a = await shop();
    const b = await shop();
    const mine = registeredRecord(a.companyId, a.userId);
    await save(a.h, mine);

    assert.equal(await a.h.records.findById(b.companyId, mine.id), null);
    assert.equal(await a.h.records.findByDocumentId(b.companyId, mine.documentId), null);
    assert.equal(await a.h.records.findByIrn(b.companyId, mine.acknowledgement!.irn), null);
    assert.deepEqual(await a.h.records.list(b.companyId), []);
    assert.deepEqual(await a.h.records.listCancellable(b.companyId, AT), []);
    assert.deepEqual(await a.h.records.listPendingReport(b.companyId, "2026-08-21"), []);
    // B "updating" A's record by its id reaches nothing.
    await b.h.run(b.companyId, () => b.h.records.update({ ...mine, companyId: b.companyId, createdBy: b.userId, message: "Taken over." }));
    assert.deepEqual(await a.h.records.findById(a.companyId, mine.id), mine);
    assert.equal(await a.h.records.findById(b.companyId, mine.id), null);
    // The same bill id in two companies is two different bills.
    await save(b.h, pendingRecord(b.companyId, b.userId, { documentId: mine.documentId }));
    assert.equal((await b.h.records.list(b.companyId)).length, 1);
  });

  test(`${label}: an action that fails leaves no e-invoice behind`, { skip }, async () => {
    const { h, companyId, userId } = await shop();
    const kept = pendingRecord(companyId, userId);
    await save(h, kept);
    const lost = pendingRecord(companyId, userId);
    await assert.rejects(h.run(companyId, async () => {
      await h.records.insert(lost);
      await h.records.update({ ...kept, status: "FAILED", message: "Never happened." });
      throw new Error("the action failed after writing");
    }), /the action failed/);
    assert.equal(await h.records.findById(companyId, lost.id), null);
    assert.deepEqual(await h.records.findById(companyId, kept.id), kept);
  });

  test(`${label}: the lists, and paging through them, return every row exactly once`, { skip }, async () => {
    const { h, companyId, userId } = await shop();
    const minute = (n: number) => `2026-08-21T10:0${n}:00.000Z`;
    const notNeeded = { ...decideApplicability(belowThreshold()) };
    const rows = [
      // Three share a moment, so the id has to break the tie.
      pendingRecord(companyId, userId, { createdAt: minute(1) }),
      pendingRecord(companyId, userId, { createdAt: minute(1), reportableUntil: "2026-08-20" }), // past its last day
      pendingRecord(companyId, userId, { createdAt: minute(1), status: "FAILED", reportableUntil: "2026-08-21" }),
      pendingRecord(companyId, userId, { createdAt: minute(2), status: "NOT_APPLICABLE", applicability: notNeeded }),
      pendingRecord(companyId, userId, { createdAt: minute(3), applicability: notNeeded }),
      registeredRecord(companyId, userId, { createdAt: minute(4) }),
      registeredRecord(companyId, userId, { createdAt: minute(5), cancellableUntil: AT }), // closes exactly now
      registeredRecord(companyId, userId, { createdAt: minute(6), status: "CANCELLED", cancelReasonCode: "OTHER", cancelReason: "Raised twice." }),
    ];
    await save(h, ...rows);
    const ids = (records: readonly EInvoiceRecord[]) => records.map((record) => record.id);
    const oldestFirst = (records: readonly EInvoiceRecord[]) => ids([...records].sort((l, r) => (`${l.createdAt}|${l.id}` < `${r.createdAt}|${r.id}` ? -1 : 1)));

    assert.deepEqual(ids(await h.records.list(companyId)).sort(), ids(rows).sort());
    assert.deepEqual(ids(await h.records.listCancellable(companyId, AT)), [rows[5]!.id]);
    assert.deepEqual(ids(await h.records.listPendingReport(companyId, "2026-08-21")).sort(), [rows[0]!.id, rows[2]!.id].sort());

    const walk = async (list: (page: { limit: number; after?: string }) => Promise<EInvoiceRecord[]>, limit: number) => {
      const seen: string[] = [];
      let after: string | undefined;
      for (let guard = 0; guard < 20; guard += 1) {
        const page = await list(after === undefined ? { limit } : { limit, after });
        assert.ok(page.length <= limit);
        seen.push(...ids(page));
        if (page.length < limit) return seen;
        after = page.at(-1)!.id;
      }
      throw new Error("paging never ended");
    };
    for (const limit of [1, 3, 8, 50]) {
      assert.deepEqual(await walk((page) => h.records.list(companyId, page), limit), oldestFirst(rows), `list, ${limit} at a time`);
    }
    assert.deepEqual(await walk((page) => h.records.listPendingReport(companyId, "2026-08-21", page), 1), oldestFirst([rows[0]!, rows[2]!]));
    assert.deepEqual(await walk((page) => h.records.listCancellable(companyId, AT, page), 1), [rows[5]!.id]);
    // A cursor may be a row the filter no longer returns; an unknown one ends the list.
    assert.deepEqual(ids(await h.records.listCancellable(companyId, AT, { limit: 5, after: rows[4]!.id })), [rows[5]!.id]);
    assert.deepEqual(await h.records.list(companyId, { limit: 5, after: randomUUID() }), []);
  });

  test(`${label}: the policy in force on the day answers, per company`, { skip }, async () => {
    const a = await shop();
    const b = await shop();
    assert.deepEqual(await a.h.policies.policyFor(a.companyId, "2026-08-21"), DEFAULT_EINVOICE_POLICY);
    await a.h.run(a.companyId, async () => {
      await a.h.setPolicy(a.companyId, { cancellationWindowHours: 12, verifyIrnHash: true, effectiveFrom: "2026-04-01" }, a.userId);
      await a.h.setPolicy(a.companyId, { cancellationWindowHours: 48, verifyIrnHash: true, effectiveFrom: "2026-09-01" }, a.userId);
      // The same day again replaces what was set for it.
      await a.h.setPolicy(a.companyId, { cancellationWindowHours: 6, verifyIrnHash: false, effectiveFrom: "2026-09-01" }, a.userId);
    });
    assert.deepEqual(await a.h.policies.policyFor(a.companyId, "2026-03-31"), DEFAULT_EINVOICE_POLICY);
    assert.deepEqual(await a.h.policies.policyFor(a.companyId, "2026-04-01"), { cancellationWindowHours: 12, verifyIrnHash: true, effectiveFrom: "2026-04-01" });
    assert.deepEqual(await a.h.policies.policyFor(a.companyId, "2026-08-31"), { cancellationWindowHours: 12, verifyIrnHash: true, effectiveFrom: "2026-04-01" });
    assert.deepEqual(await a.h.policies.policyFor(a.companyId, "2026-09-01"), { cancellationWindowHours: 6, verifyIrnHash: false, effectiveFrom: "2026-09-01" });
    assert.deepEqual(await b.h.policies.policyFor(b.companyId, "2026-09-01"), DEFAULT_EINVOICE_POLICY);
  });

  // ---------------------------------------------------------------- the service's own lifecycle

  /** The real service on this store, behind the synthetic portal. Each command is one action. */
  const desk = async () => {
    const { h, companyId, userId } = await shop();
    let now = AT;
    const clock = { now: () => new Date(now) };
    const portal = new SyntheticIrp(clock.now);
    const service = new EInvoiceService({
      irp: irpAdapter({ gateway: new ConnectorGateway([portal], new SyntheticIrpVault(), new StaticWebhookVerifier()), clock: clock.now }),
      records: h.records, audit: new InMemoryAuditPort(), clock, policy: h.policies,
    });
    const actor = { ...actorWith(ALL_EINVOICE_PERMISSIONS, companyId), userId: userId as typeof OWNER };
    const bill = (number: string) => ({ document: invoiceDocument({ documentId: randomUUID(), documentNumber: number }), applicability: aboveThreshold() });
    return {
      h, companyId, userId, portal, bill, setNow: (at: string) => { now = at; },
      register: (input: ReturnType<typeof bill>) => h.run(companyId, () => service.register(actor, input)),
      reconcile: (documentId: string) => h.run(companyId, () => service.reconcile(actor, documentId)),
      cancel: (documentId: string, reason = "The customer cancelled the order.") => h.run(companyId, () => service.cancel(actor, documentId, { reasonCode: "ORDER_CANCELLED", reason })),
      stored: (documentId: string) => h.records.findByDocumentId(companyId, documentId),
    };
  };

  test(`${label}: register once, register again, cancel, reconcile — every move is saved`, { skip }, async () => {
    const d = await desk();
    const input = d.bill("SAM/2026/0117");
    const documentId = input.document.documentId;

    const registered = await d.register(input);
    assert.equal(registered.status, "REGISTERED");
    assert.equal(registered.acknowledgement?.irn, computeIrn({ supplierGstin: SUPPLIER_GSTIN, documentNumber: "SAM/2026/0117", documentDate: "2026-08-21", documentType: "INVOICE" }));
    assert.deepEqual(await d.stored(documentId), registered);
    assert.deepEqual(await d.h.records.findByIrn(d.companyId, registered.acknowledgement!.irn), registered);

    assert.deepEqual(await d.register(input), registered, "a second press returns the record there already is");
    assert.equal(d.portal.registeredIrns().length, 1);

    d.setNow("2026-08-21T10:30:00.000Z");
    const cancelled = await d.cancel(documentId);
    assert.equal(cancelled.status, "CANCELLED");
    assert.equal(cancelled.cancelReason, "The customer cancelled the order.");
    assert.deepEqual(await d.stored(documentId), cancelled);
    assert.deepEqual(await d.cancel(documentId), cancelled);
    assert.deepEqual(await d.register(input), cancelled, "a cancelled e-invoice is never sent again");

    const after = await d.reconcile(documentId);
    assert.equal(after.status, "CANCELLED");
    assert.equal(after.cancelReasonCode, "ORDER_CANCELLED");
    assert.deepEqual(await d.stored(documentId), after);
  });

  test(`${label}: an outage is saved as a failure, the retry registers, and the cancellation window closes`, { skip }, async () => {
    const d = await desk();
    const input = d.bill("SAM/2026/0118");
    const documentId = input.document.documentId;

    d.portal.setMode("outage");
    const failed = await d.register(input);
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.failure?.retryable, true);
    assert.deepEqual(await d.stored(documentId), failed);
    assert.deepEqual(await d.h.records.listPendingReport(d.companyId, "2026-08-21"), [failed]);

    d.portal.setMode("healthy");
    const registered = await d.register(input);
    assert.equal(registered.status, "REGISTERED");
    assert.equal(registered.id, failed.id, "the same record, not a second one");
    assert.deepEqual(await d.h.records.listPendingReport(d.companyId, "2026-08-21"), []);
    assert.deepEqual(await d.h.records.listCancellable(d.companyId, AT), [registered]);

    // A registered record is rewritten whole by a reconcile, and the database lets it: nothing fixed changed.
    d.setNow("2026-08-21T10:30:00.000Z");
    const confirmed = await d.reconcile(documentId);
    assert.equal(confirmed.status, "REGISTERED");
    assert.equal(confirmed.acknowledgement?.receivedAt, "2026-08-21T10:30:00.000Z");
    assert.deepEqual(await d.stored(documentId), confirmed);

    d.setNow("2026-08-22T11:00:00.000Z");
    assert.deepEqual(await d.h.records.listCancellable(d.companyId, "2026-08-22T11:00:00.000Z"), []);
    await assert.rejects(d.cancel(documentId), code("EINVOICE_WINDOW_CLOSED"));
    assert.deepEqual(await d.stored(documentId), confirmed);
  });

  test(`${label}: reconcile — the portal never received it, so the pending record becomes a failure`, { skip }, async () => {
    const d = await desk();
    const pending = pendingRecord(d.companyId, d.userId);
    await save(d.h, pending);
    const failed = await d.reconcile(pending.documentId);
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.failure?.code, "NOT_REGISTERED");
    assert.deepEqual(await d.stored(pending.documentId), failed);
  });

  test(`${label}: reconcile — cancelled on the portal without us: saved as cancelled, with no reason invented`, { skip }, async () => {
    const d = await desk();
    const input = d.bill("SAM/2026/0119");
    const registered = await d.register(input);
    await d.portal.execute({
      tenantId: d.companyId, operation: "einvoice.cancel", payload: { Irn: registered.acknowledgement!.irn, CnlRsn: "3", CnlRem: "Cancelled on the portal." },
      idempotencyKey: `portal-side:${randomUUID()}`, correlationId: "portal-side",
    });
    const reconciled = await d.reconcile(input.document.documentId);
    assert.equal(reconciled.status, "CANCELLED");
    assert.equal(reconciled.cancelReasonCode, undefined);
    assert.equal(reconciled.cancelReason, undefined);
    assert.deepEqual(await d.stored(input.document.documentId), reconciled);
  });

  test(`${label}: reconcile — our record says cancelled but the portal still holds it: back to registered`, { skip }, async () => {
    const d = await desk();
    const input = d.bill("SAM/2026/0120");
    const registered = await d.register(input);
    await d.h.run(d.companyId, () => d.h.records.update({
      ...registered, status: "CANCELLED", cancelledAt: "2026-08-21T10:10:00.000Z", cancelReasonCode: "DUPLICATE", cancelReason: "Raised twice.",
    }));
    const reconciled = await d.reconcile(input.document.documentId);
    assert.equal(reconciled.status, "REGISTERED");
    assert.deepEqual(await d.stored(input.document.documentId), reconciled);
  });
}

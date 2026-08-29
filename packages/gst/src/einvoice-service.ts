// Issue #26 [E26] — the IRN lifecycle.
//
// Three rules run through everything below, one per acceptance criterion:
//
//   1. **An invoice and a registered e-invoice are never confused.** A document that has not come
//      back from the government is `PENDING`, never `REGISTERED`. A timeout leaves the record
//      saying plainly that we do not know, because we do not.
//   2. **Submission is idempotent.** One live e-invoice per sales document, a stable idempotency
//      key derived from the document rather than from the attempt, and the government's own
//      duplicate reply treated as success. Pressing the button twice cannot produce two IRNs.
//   3. **The reply is verified before anything is marked registered.** See `irn.ts`: the IRN is a
//      hash of four fields we already know, so a reply belonging to another document is caught
//      instead of being written into the books.

import { conflict, forbidden, invalid, notFound, type CompanyId } from "@invoice/kernel";
import type { ActorContext, AuditPort } from "@invoice/ledger";
import type { Clock } from "@invoice/kernel";
import { decideApplicability } from "./applicability.ts";
import {
  cancellableUntil, checkAcknowledgement, computeIrn, financialYearOf, readAckDate, reportableUntil,
} from "./irn.ts";
import { buildEInvoicePayload, toOfflineJson } from "./payload.ts";
import { DEFAULT_EINVOICE_POLICY } from "./einvoice-types.ts";
import type {
  ApplicabilityDecision, CancelReasonCode, EInvoiceApplicabilityInput, EInvoicePolicy,
  EInvoiceRecord, EInvoiceStatus,
} from "./einvoice-types.ts";
import type { EInvoicePolicyPort, EInvoiceRepository, IrpPort } from "./einvoice-ports.ts";
import type { EInvoiceDocument, PayloadProblem } from "./payload.ts";
import type { Id, IsoDate } from "../../masters/src/types.ts";

/** Reporting a document to the government is its own permission, distinct from issuing a bill. */
export const EINVOICE_GENERATE_PERMISSION = "einvoice.generate";
/** Cancelling one withdraws a government record, so it is gated separately and needs a reason. */
export const EINVOICE_CANCEL_PERMISSION = "einvoice.cancel";
export const EINVOICE_VIEW_PERMISSION = "einvoice.view";

export interface EInvoiceServiceDeps {
  readonly irp: IrpPort;
  readonly records: EInvoiceRepository;
  readonly audit: AuditPort;
  readonly clock: Clock;
  readonly policy?: EInvoicePolicyPort;
  readonly idFactory?: () => string;
}

export interface RegisterInput {
  readonly document: EInvoiceDocument;
  readonly applicability: EInvoiceApplicabilityInput;
}

/** What a preview returns: the decision, the payload's problems, and nothing written anywhere. */
export interface EInvoicePreview {
  readonly applicability: ApplicabilityDecision;
  readonly ready: boolean;
  readonly problems: readonly PayloadProblem[];
  /** The IRN this document will receive, computed before it is sent. */
  readonly expectedIrn?: string;
  readonly reportableUntil?: IsoDate;
  readonly summary: string;
}

export class EInvoiceService {
  readonly #irp: IrpPort;
  readonly #records: EInvoiceRepository;
  readonly #audit: AuditPort;
  readonly #clock: Clock;
  readonly #policy: EInvoicePolicyPort | undefined;
  readonly #newId: () => string;

  constructor(deps: EInvoiceServiceDeps) {
    this.#irp = deps.irp;
    this.#records = deps.records;
    this.#audit = deps.audit;
    this.#clock = deps.clock;
    this.#policy = deps.policy;
    this.#newId = deps.idFactory ?? (() => crypto.randomUUID());
  }

  // ------------------------------------------------------------------------ reading

  async forDocument(actor: ActorContext, documentId: Id): Promise<EInvoiceRecord | null> {
    this.#require(actor, EINVOICE_VIEW_PERMISSION);
    return this.#records.findByDocumentId(actor.companyId, documentId);
  }

  async byIrn(actor: ActorContext, irn: string): Promise<EInvoiceRecord | null> {
    this.#require(actor, EINVOICE_VIEW_PERMISSION);
    return this.#records.findByIrn(actor.companyId, irn.toLowerCase());
  }

  async list(actor: ActorContext): Promise<readonly EInvoiceRecord[]> {
    this.#require(actor, EINVOICE_VIEW_PERMISSION);
    return this.#records.list(actor.companyId);
  }

  /** Applicable documents still unreported, so a deadline is never missed silently. */
  async awaitingReport(actor: ActorContext, on?: IsoDate): Promise<readonly EInvoiceRecord[]> {
    this.#require(actor, EINVOICE_VIEW_PERMISSION);
    return this.#records.listPendingReport(actor.companyId, on ?? this.#today());
  }

  /**
   * Everything registering would do, written nowhere.
   *
   * Deliberately available before anything is sent, because the government keeps what it is given
   * and a person deserves to see the decision, the gaps and even the IRN beforehand.
   */
  async preview(actor: ActorContext, input: RegisterInput): Promise<EInvoicePreview> {
    this.#require(actor, EINVOICE_VIEW_PERMISSION);
    const policy = await this.#policyFor(actor.companyId, input.document.documentDate);
    const applicability = decideApplicability(input.applicability);

    if (applicability.outcome !== "APPLICABLE") {
      return {
        applicability, ready: false, problems: [],
        // The reason already says what was decided, so prefixing it would say it twice.
        summary: applicability.reason,
      };
    }

    const built = buildEInvoicePayload(input.document);
    const due = reportableUntil(input.document.documentDate, policy.reportingWindowDays);
    if (!built.ok) {
      return {
        applicability, ready: false, problems: built.problems,
        ...(due === undefined ? {} : { reportableUntil: due }),
        summary: `This bill needs an e-invoice number, but ${built.problems.length === 1 ? "one thing is" : `${built.problems.length} things are`} missing first: ${built.problems[0]?.message ?? ""}`,
      };
    }

    return {
      applicability, ready: true, problems: [],
      expectedIrn: this.#expectedIrn(input.document),
      ...(due === undefined ? {} : { reportableUntil: due }),
      summary: `This bill needs an e-invoice number and is ready to send${due === undefined ? "" : `. It should be sent by ${due}`}.`,
    };
  }

  // ------------------------------------------------------------------------ writing

  /**
   * Registers a document with the government, once.
   *
   * Calling it again for the same document returns the record that already exists rather than
   * submitting a second time — and if the government says the document is already on its record,
   * that reply is treated as success and its IRN is kept. Between those two, pressing the button
   * twice cannot produce two IRNs, whatever the network did in between.
   */
  async register(actor: ActorContext, input: RegisterInput): Promise<EInvoiceRecord> {
    this.#require(actor, EINVOICE_GENERATE_PERMISSION);
    const document = input.document;
    const policy = await this.#policyFor(actor.companyId, document.documentDate);
    const at = this.#clock.now().toISOString();

    const existing = await this.#records.findByDocumentId(actor.companyId, document.documentId);
    if (existing !== null && (existing.status === "REGISTERED" || existing.status === "CANCELLED")) {
      return existing;
    }

    const applicability = decideApplicability(input.applicability);
    if (applicability.outcome === "CANNOT_DECIDE") {
      // Rule 8 of the brief: a fact we do not have goes to a person, never into a guess.
      throw invalid(
        "EINVOICE_CANNOT_DECIDE",
        `We cannot tell whether this bill needs an e-invoice number, so nothing has been sent. ${applicability.reason}`,
        { details: { missing: (applicability.missingFacts ?? []).join(", ") } },
      );
    }
    if (applicability.outcome === "NOT_APPLICABLE") {
      // Registering a document that did not need it puts it on a record that cannot be quietly
      // withdrawn after twenty-four hours, so this refuses rather than obliges.
      throw conflict(
        "EINVOICE_NOT_APPLICABLE",
        `This bill does not need an e-invoice number, so it has not been sent to the government. ${applicability.reason}`,
      );
    }

    const built = buildEInvoicePayload(document);
    if (!built.ok) {
      throw invalid(
        "EINVOICE_INCOMPLETE",
        `This bill cannot be sent to the government yet: ${built.problems[0]?.message ?? "something is missing."}`,
        { details: { problems: built.problems.map((problem) => `${problem.field}: ${problem.message}`).join(" | ") } },
      );
    }

    // Derived from the document, never from the attempt: that is what makes a retry the same call.
    const idempotencyKey = `einvoice:generate:${actor.companyId}:${document.documentId}`;
    const record = existing ?? this.#blank(actor, document, applicability, policy, at, idempotencyKey);
    if (existing === null) await this.#records.insert(record);

    // Marked pending before the call, so a process that dies mid-flight leaves a record saying
    // "we do not know" rather than no record at all.
    const pending: EInvoiceRecord = {
      ...record, status: "PENDING", applicability, updatedAt: at,
      message: "This bill has been sent to the government and we are waiting for the e-invoice number.",
    };
    await this.#records.update(pending);

    const outcome = await this.#irp.generate(actor.companyId, document, built.payload, idempotencyKey);

    if (outcome.kind === "UNAVAILABLE") {
      const failed: EInvoiceRecord = {
        ...pending, status: "FAILED", updatedAt: this.#clock.now().toISOString(),
        failure: { code: outcome.code, message: outcome.message, retryable: outcome.retryable },
        message: `${outcome.message} This bill is a valid GST bill and is safe in your books; it is only the government's e-invoice number that is still to come.${outcome.retryable ? " We will try again." : ""}`,
      };
      await this.#records.update(failed);
      await this.#record(actor, failed, "einvoice.generate_failed", { code: outcome.code, retryable: String(outcome.retryable) });
      return failed;
    }

    if (outcome.kind === "REJECTED") {
      const failed: EInvoiceRecord = {
        ...pending, status: "FAILED", updatedAt: this.#clock.now().toISOString(),
        failure: { code: outcome.code, message: outcome.message, retryable: false },
        message: `The government did not accept this bill: ${outcome.message} Sending it again unchanged will get the same answer, so something on the bill needs correcting first.`,
      };
      await this.#records.update(failed);
      await this.#record(actor, failed, "einvoice.rejected", { code: outcome.code, hints: (outcome.fieldHints ?? []).join(", ") });
      return failed;
    }

    // Verified before it is believed. A reply that belongs to another document, or is missing the
    // signed QR the customer's copy needs, is not a registration we are willing to record.
    const check = checkAcknowledgement(outcome.acknowledgement, {
      supplierGstin: document.supplier.gstin,
      documentNumber: document.documentNumber,
      documentDate: document.documentDate,
      documentType: document.documentType,
    }, { verifyIrnHash: policy.verifyIrnHash });

    if (!check.ok) {
      const failed: EInvoiceRecord = {
        ...pending, status: "FAILED", updatedAt: this.#clock.now().toISOString(),
        failure: { code: `ACKNOWLEDGEMENT_${check.problems[0]}`, message: check.explanation, retryable: false },
        message: check.explanation,
      };
      await this.#records.update(failed);
      await this.#record(actor, failed, "einvoice.acknowledgement_rejected", { problems: check.problems.join(", ") });
      return failed;
    }

    const acknowledgement = outcome.acknowledgement;
    const registered: EInvoiceRecord = {
      ...pending,
      status: "REGISTERED",
      acknowledgement,
      updatedAt: this.#clock.now().toISOString(),
      cancellableUntil: cancellableUntil(acknowledgement.ackDate, policy.cancellationWindowHours),
      message: outcome.kind === "DUPLICATE"
        ? `This bill was already registered with the government, so its existing e-invoice number has been kept. Nothing has been registered twice.`
        : `The government has registered this bill. Give the customer the copy with the QR code on it.`,
    };
    await this.#records.update(registered);
    await this.#record(actor, registered, outcome.kind === "DUPLICATE" ? "einvoice.duplicate_reconciled" : "einvoice.registered", {
      irn: acknowledgement.irn,
      ackNumber: acknowledgement.ackNumber,
      // The signed QR is the government's signature over the invoice, not a secret, but it is
      // long and useless in an audit line, so only its presence is recorded.
      signedQr: "present",
    });
    return registered;
  }

  /**
   * Fetches what the government holds and reconciles our record with it.
   *
   * The honest answer to "the call timed out — did it go through?" is to ask, and this is how.
   */
  async reconcile(actor: ActorContext, documentId: Id): Promise<EInvoiceRecord> {
    this.#require(actor, EINVOICE_VIEW_PERMISSION);
    const record = await this.#mustFind(actor, documentId);
    const expected = record.acknowledgement?.irn ?? this.#expectedIrnFor(record);
    const outcome = await this.#irp.fetch(actor.companyId, expected);
    const at = this.#clock.now().toISOString();

    if (outcome.kind === "UNAVAILABLE") return record;
    if (outcome.kind === "NOT_FOUND") {
      if (record.status !== "PENDING") return record;
      const failed: EInvoiceRecord = {
        ...record, status: "FAILED", updatedAt: at,
        failure: { code: "NOT_REGISTERED", message: "The government has no record of this bill.", retryable: true },
        message: "The government has no record of this bill, so the earlier attempt did not go through. You can send it again.",
      };
      await this.#records.update(failed);
      return failed;
    }

    const policy = await this.#policyFor(actor.companyId, record.documentDate);
    const status: EInvoiceStatus = outcome.cancelled ? "CANCELLED" : "REGISTERED";
    const reconciled: EInvoiceRecord = {
      ...record, status, acknowledgement: outcome.acknowledgement, updatedAt: at,
      cancellableUntil: cancellableUntil(outcome.acknowledgement.ackDate, policy.cancellationWindowHours),
      message: outcome.cancelled
        ? "The government's record shows this e-invoice was cancelled."
        : "The government's record shows this bill is registered.",
    };
    await this.#records.update(reconciled);
    await this.#record(actor, reconciled, "einvoice.reconciled", { irn: outcome.acknowledgement.irn, status });
    return reconciled;
  }

  /**
   * Cancels a registered e-invoice with the government.
   *
   * The window is the government's, not ours, and it is short. We check it before calling so a
   * person gets a useful sentence rather than error 4002, but the portal is the authority and its
   * refusal is honoured if the two ever disagree.
   */
  async cancel(
    actor: ActorContext,
    documentId: Id,
    input: { readonly reasonCode: CancelReasonCode; readonly reason: string },
  ): Promise<EInvoiceRecord> {
    this.#require(actor, EINVOICE_CANCEL_PERMISSION);
    const record = await this.#mustFind(actor, documentId);
    if (record.status === "CANCELLED") return record;
    if (record.status !== "REGISTERED" || record.acknowledgement === undefined) {
      throw conflict("EINVOICE_NOT_REGISTERED", "This bill has no e-invoice number with the government, so there is nothing to cancel.");
    }
    if (input.reason.trim() === "") {
      throw invalid("EINVOICE_CANCEL_REASON_REQUIRED", "Please say why this e-invoice is being cancelled; the government asks for a reason and it is kept with the bill.");
    }

    const now = this.#clock.now();
    if (record.cancellableUntil !== undefined && record.cancellableUntil <= now.toISOString()) {
      throw conflict(
        "EINVOICE_WINDOW_CLOSED",
        `The government only allows an e-invoice to be cancelled within ${Math.round((new Date(record.cancellableUntil).getTime() - readAckDate(record.acknowledgement.ackDate).getTime()) / 3_600_000)} hours of registering it, and that time has passed. To undo this bill now, raise a credit note against it instead.`,
      );
    }

    const outcome = await this.#irp.cancel(actor.companyId, {
      irn: record.acknowledgement.irn,
      reasonCode: input.reasonCode,
      reason: input.reason,
      idempotencyKey: `einvoice:cancel:${actor.companyId}:${record.documentId}`,
    });

    if (outcome.kind === "UNAVAILABLE") {
      throw conflict("EINVOICE_CANCEL_UNAVAILABLE", `${outcome.message} The e-invoice has not been cancelled; nothing has changed. Please try again.`);
    }
    if (outcome.kind === "REFUSED") {
      throw conflict("EINVOICE_CANCEL_REFUSED", `The government would not cancel this e-invoice: ${outcome.message}`);
    }

    const cancelled: EInvoiceRecord = {
      ...record, status: "CANCELLED", cancelledAt: outcome.cancelledAt,
      cancelReasonCode: input.reasonCode, cancelReason: input.reason,
      updatedAt: now.toISOString(),
      message: `This e-invoice has been cancelled with the government. The bill in your books is unchanged — cancel or credit that separately if it is also wrong. Reason kept on record: ${input.reason}`,
    };
    await this.#records.update(cancelled);
    await this.#record(actor, cancelled, "einvoice.cancelled", {
      irn: record.acknowledgement.irn, reasonCode: input.reasonCode,
    }, input.reason);
    return cancelled;
  }

  /**
   * The payload as a file, for the day the portal is down and the business still has to invoice.
   *
   * Explicitly not an e-invoice: the file says so inside itself, because a JSON file on a desktop
   * that looks like a registered invoice is precisely the confusion criterion one forbids.
   */
  async offlineJson(actor: ActorContext, input: RegisterInput): Promise<string> {
    this.#require(actor, EINVOICE_VIEW_PERMISSION);
    const applicability = decideApplicability(input.applicability);
    if (applicability.outcome === "NOT_APPLICABLE") {
      throw conflict("EINVOICE_NOT_APPLICABLE", `This bill does not need an e-invoice number, so there is nothing to export. ${applicability.reason}`);
    }
    return toOfflineJson(input.document);
  }

  // --------------------------------------------------------------------- internals

  #blank(
    actor: ActorContext,
    document: EInvoiceDocument,
    applicability: ApplicabilityDecision,
    policy: EInvoicePolicy,
    at: string,
    idempotencyKey: string,
  ): EInvoiceRecord {
    const due = reportableUntil(document.documentDate, policy.reportingWindowDays);
    return {
      id: this.#newId(),
      companyId: actor.companyId,
      documentId: document.documentId,
      documentNumber: document.documentNumber,
      documentDate: document.documentDate,
      documentType: document.documentType,
      supplierGstin: document.supplier.gstin,
      ...(document.recipient.gstin === "" ? {} : { recipientGstin: document.recipient.gstin }),
      financialYear: financialYearOf(document.documentDate),
      status: "PENDING",
      applicability,
      message: "This bill is about to be sent to the government.",
      ...(due === undefined ? {} : { reportableUntil: due }),
      createdBy: actor.userId,
      createdAt: at,
      updatedAt: at,
      idempotencyKey,
    };
  }

  #expectedIrn(document: EInvoiceDocument): string {
    return this.#expectedIrnFor({
      supplierGstin: document.supplier.gstin,
      documentNumber: document.documentNumber,
      documentDate: document.documentDate,
      documentType: document.documentType,
    });
  }

  /** The same helper the verification uses, so the two can never drift apart. */
  #expectedIrnFor(parts: { supplierGstin: string; documentNumber: string; documentDate: string; documentType: EInvoiceRecord["documentType"] }): string {
    return computeIrn(parts);
  }

  async #policyFor(companyId: CompanyId, on: IsoDate): Promise<EInvoicePolicy> {
    return this.#policy === undefined ? DEFAULT_EINVOICE_POLICY : this.#policy.policyFor(companyId, on);
  }

  async #mustFind(actor: ActorContext, documentId: Id): Promise<EInvoiceRecord> {
    const record = await this.#records.findByDocumentId(actor.companyId, documentId);
    // Tenancy from the query, never from an id the caller supplied.
    if (record === null) throw notFound("EINVOICE_UNKNOWN", "We have no e-invoice record for that bill.");
    return record;
  }

  #today(): IsoDate {
    return this.#clock.now().toISOString().slice(0, 10);
  }

  #require(actor: ActorContext, permission: string): void {
    if (!actor.permissions.includes(permission)) {
      throw forbidden("PERMISSION_DENIED", "You do not have permission to do that. Ask the owner to give you access.", { details: { permission } });
    }
  }

  async #record(
    actor: ActorContext,
    record: EInvoiceRecord,
    action: string,
    details: Record<string, string>,
    overrideReason?: string,
  ): Promise<void> {
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at: this.#clock.now().toISOString(),
      action,
      subjectType: "e_invoice",
      subjectId: record.documentId,
      summary: record.message,
      details: { number: record.documentNumber, status: record.status, ...details },
      ...(overrideReason === undefined ? {} : { overrideReason }),
    });
  }
}

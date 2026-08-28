// The omnichannel purchase-invoice inbox (issue #15).
//
// A document arrives from WhatsApp, email, a camera, an upload or an e-invoice JSON
// file. This service screens it, decides which company it belongs to, reads it, and
// produces a reviewable draft. It posts nothing: no ledger entry, no stock movement, no
// payable. Validation is issue #16 and posting is issue #17.
//
// One deliberate ordering choice: a document is routed to a company *before* its pages
// are sent to the OCR provider, so no company's paperwork is ever processed under
// another company's tenant. When routing can only be guessed from the channel, the read
// is done under that company and then re-checked against the GST number printed on the
// page; a contradiction quarantines the document rather than filing it.

import { randomUUID } from "node:crypto";
import { ConnectorError } from "../../platform/src/connectors.ts";
import { PlatformError } from "../../platform/src/types.ts";
import type { RequestContext } from "../../platform/src/types.ts";
import type { AuditLog, PlatformCommandService } from "../../platform/src/platform.ts";
import type { Id } from "../../masters/src/types.ts";
import { screenAttachment } from "./safety.ts";
import type { ScanVerdict } from "./safety.ts";
import { routeDocument } from "./routing.ts";
import type { CompanyRoutingProfile } from "./routing.ts";
import { readEInvoiceJson } from "./einvoice.ts";
import { crossCheck, readInvoiceFromOcr } from "./extraction.ts";
import type { OcrAdapter } from "./ocr.ts";
import type { Attachment, ExtractedField, ExtractionDraft, InboundDocument, InboundSender, InboundStatus, IntakeChannel, LogicalInvoiceKey, QuarantineReason } from "./inbox-types.ts";

export class InboxError extends Error {
  public readonly code: "NOT_FOUND" | "TENANT_ISOLATION" | "INVALID_STATE";
  constructor(code: InboxError["code"], message: string) { super(message); this.code = code; }
}

export interface ReceiveInput {
  readonly channel: IntakeChannel;
  readonly sender: InboundSender;
  readonly attachment: Attachment;
  /** The first few kilobytes, for type and safety checks. */
  readonly head: Uint8Array;
  /** Full text, for e-invoice JSON only. Binary documents go to OCR instead. */
  readonly jsonBody?: string;
  readonly scanVerdict?: ScanVerdict;
  /** The alias or number the document was delivered to, for channel routing. */
  readonly deliveredTo?: string;
  /** Set when an authenticated user uploaded this into a company. */
  readonly explicitCompanyId?: Id;
  /** Required. A resend of the same provider message returns the original document. */
  readonly idempotencyKey: string;
}

export interface ReceiveResult {
  readonly document: InboundDocument;
  readonly draft?: ExtractionDraft;
  /** True when this exact file had already been received for this company. */
  readonly duplicate: boolean;
}

/** Below this confidence a field must be looked at before the draft moves on. */
export const REVIEW_CONFIDENCE = 0.8;
/** Below this, the document is not worth reviewing at all and is quarantined. */
export const QUARANTINE_CONFIDENCE = 0.4;

const UNROUTED = "__unrouted__";

export class PurchaseInboxService {
  readonly #commands: PlatformCommandService;
  readonly #audit: AuditLog;
  readonly #ocr: OcrAdapter;
  readonly #companies: readonly CompanyRoutingProfile[];
  readonly #documents = new Map<Id, InboundDocument>();
  readonly #drafts = new Map<Id, ExtractionDraft>();
  /** company + sha256 to document id, the attachment-level duplicate index. */
  readonly #byContent = new Map<string, Id>();
  /** Provider message id to document id, so a channel redelivery is not a new document. */
  readonly #byProviderMessage = new Map<string, Id>();

  constructor(commands: PlatformCommandService, audit: AuditLog, ocr: OcrAdapter, companies: readonly CompanyRoutingProfile[]) {
    this.#commands = commands;
    this.#audit = audit;
    this.#ocr = ocr;
    this.#companies = companies;
  }

  // ------------------------------------------------------------------ reading

  document(context: RequestContext, id: Id): InboundDocument {
    const found = this.#documents.get(id);
    if (!found) throw new InboxError("NOT_FOUND", "That document was not found.");
    if (found.companyId !== context.companyId) throw new PlatformError("TENANT_ISOLATION", "This document belongs to another company.");
    return found;
  }

  draft(context: RequestContext, documentId: Id): ExtractionDraft {
    const document = this.document(context, documentId);
    const draft = [...this.#drafts.values()].find((candidate) => candidate.documentId === document.id);
    if (!draft) throw new InboxError("NOT_FOUND", "This document has no draft yet.");
    return draft;
  }

  inbox(context: RequestContext, status?: InboundStatus): readonly InboundDocument[] {
    return [...this.#documents.values()].filter((document) => document.companyId === context.companyId && (status === undefined || document.status === status));
  }

  /** The key #16 will use to spot the same invoice arriving twice through two channels. */
  logicalKey(draft: ExtractionDraft): LogicalInvoiceKey | null {
    const supplier = draft.supplierGstin?.value;
    const number = draft.invoiceNumber?.value;
    const date = draft.invoiceDate?.value;
    const total = draft.invoiceTotalPaise?.value;
    if (!supplier || !number || !date || total === undefined) return null;
    return { supplierGstin: supplier, invoiceNumber: number.toUpperCase(), invoiceDate: date, invoiceTotalPaise: total.toString() };
  }

  // ------------------------------------------------------------------ writing

  async receive(input: ReceiveInput): Promise<ReceiveResult> {
    const existingByMessage = input.sender.providerMessageId ? this.#byProviderMessage.get(input.sender.providerMessageId) : undefined;
    if (existingByMessage) {
      const document = this.#documents.get(existingByMessage) as InboundDocument;
      return { document, duplicate: true, ...(this.#draftFor(document.id) ? { draft: this.#draftFor(document.id) as ExtractionDraft } : {}) };
    }

    const id = randomUUID();
    let document: InboundDocument = {
      id,
      companyId: UNROUTED,
      channel: input.channel,
      sender: input.sender,
      attachment: input.attachment,
      receivedAt: new Date().toISOString(),
      status: "received",
      attempts: 1,
    };
    this.#documents.set(id, document);
    if (input.sender.providerMessageId) this.#byProviderMessage.set(input.sender.providerMessageId, id);

    // 1. Screening, before anything reads the file.
    document = this.#set(document, { status: "screening" });
    const screening = screenAttachment(input.attachment, input.head, input.scanVerdict ?? "unscanned");
    if (!screening.ok) return { document: this.#quarantine(document, screening.reason, screening.message), duplicate: false };

    // 2. Structured documents can be read before routing, because reading JSON needs no
    //    external provider and therefore cannot leak one company's file to another.
    const eInvoice = screening.detectedType === "json" && input.jsonBody ? readEInvoiceJson(input.jsonBody) : null;
    if (screening.detectedType === "json" && !eInvoice?.invoiceNumber) {
      return { document: this.#quarantine(document, "NOT_AN_INVOICE", eInvoice?.problems[0] ?? "This JSON file is not a GST e-invoice."), duplicate: false };
    }

    // 3. Routing.
    const routing = routeDocument({
      companies: this.#companies,
      sender: input.sender,
      ...(input.deliveredTo === undefined ? {} : { deliveredTo: input.deliveredTo }),
      ...(eInvoice?.buyerGstin ? { buyerGstin: eInvoice.buyerGstin.value } : {}),
      ...(input.explicitCompanyId === undefined ? {} : { explicitCompanyId: input.explicitCompanyId }),
    });
    if (!routing.ok) return { document: this.#quarantine(document, routing.reason, routing.message), duplicate: false };
    document = this.#set(document, { companyId: routing.companyId, routing: routing.decision });

    // 4. Attachment-level duplicate check, scoped to the company that owns the file.
    const contentKey = `${routing.companyId}:${input.attachment.sha256}`;
    const earlier = this.#byContent.get(contentKey);
    if (earlier && earlier !== id) {
      const original = this.#documents.get(earlier) as InboundDocument;
      const marked = this.#set(document, {
        status: "discarded",
        duplicateOfId: earlier,
        statusMessage: `This is the same file you already received on ${new Date(original.receivedAt).toDateString()} through ${original.channel.replace("_", " ")}, so it has not been added twice.`,
      });
      this.#record(marked, "purchase.inbox.duplicate_discarded", { duplicateOfId: earlier });
      return { document: marked, duplicate: true };
    }
    this.#byContent.set(contentKey, id);

    // 5. Reading.
    document = this.#set(document, { status: "extracting" });
    const company = this.#companies.find((candidate) => candidate.companyId === routing.companyId) as CompanyRoutingProfile;
    let read: ReturnType<typeof readInvoiceFromOcr> | null = null;
    if (!eInvoice) {
      try {
        const ocr = await this.#ocr.read({ companyId: routing.companyId, storageKey: input.attachment.storageKey, idempotencyKey: `ocr:${id}`, correlationId: id });
        read = readInvoiceFromOcr(ocr.pages, { companyGstins: company.gstins });
      } catch (error) {
        const connectorError = error instanceof ConnectorError ? error : null;
        const failed = this.#set(document, {
          status: "failed",
          statusMessage: connectorError?.retryable ? "The document reader is temporarily unavailable. This will be tried again automatically." : "This document could not be read.",
        });
        this.#record(failed, "purchase.inbox.extraction_failed", { code: connectorError?.code ?? "UNKNOWN", retryable: connectorError?.retryable ?? false });
        return { document: failed, duplicate: false };
      }
      if (read.unreadable) return { document: this.#quarantine(document, "UNREADABLE", read.problems[0] ?? "This document could not be read."), duplicate: false };
    }

    // 6. What is printed on the page overrules a guess made from the channel. Every GST
    //    number on the document is checked, not only the one identified as the buyer:
    //    when a document names another of your companies and never names this one, it
    //    arrived at the wrong address and must not be filed here.
    const printedSupplier = eInvoice?.supplierGstin?.value ?? read?.supplierGstin?.value;
    const printed = (eInvoice?.allGstins ?? read?.allGstins ?? []).map((gstin) => gstin.toUpperCase());
    const namesThisCompany = company.gstins.some((gstin) => printed.includes(gstin.toUpperCase()));
    const otherOwner = this.#companies.find((candidate) => candidate.companyId !== company.companyId && candidate.gstins.some((gstin) => printed.includes(gstin.toUpperCase())));
    if (routing.decision.basis === "channel_binding" && printed.length > 0 && !namesThisCompany) {
      return {
        document: this.#quarantine(document, "COMPANY_MISMATCH", otherOwner
          ? `This invoice is addressed to ${otherOwner.legalName}, but it arrived on ${company.legalName}'s address. It has been held rather than filed in the wrong books.`
          : `This invoice does not name ${company.legalName}'s GST number, so it has been held for you to confirm which business it belongs to.`),
        duplicate: false,
      };
    }

    // 7. Draft.
    const source = eInvoice ? "einvoice_json" : "ocr";
    const readFields = eInvoice ?? read;
    if (!readFields) return { document: this.#quarantine(document, "UNREADABLE", "This document could not be read."), duplicate: false };
    const fields = {
      ...(readFields.supplierGstin ? { supplierGstin: readFields.supplierGstin } : {}),
      ...(readFields.supplierName ? { supplierName: readFields.supplierName } : {}),
      ...(readFields.buyerGstin ? { buyerGstin: readFields.buyerGstin } : {}),
      ...(readFields.invoiceNumber ? { invoiceNumber: readFields.invoiceNumber } : {}),
      ...(readFields.invoiceDate ? { invoiceDate: readFields.invoiceDate } : {}),
      ...(readFields.taxableValuePaise ? { taxableValuePaise: readFields.taxableValuePaise } : {}),
      ...(readFields.totalTaxPaise ? { totalTaxPaise: readFields.totalTaxPaise } : {}),
      ...(readFields.invoiceTotalPaise ? { invoiceTotalPaise: readFields.invoiceTotalPaise } : {}),
      ...(readFields.irn ? { irn: readFields.irn } : {}),
    };
    const named: readonly [string, ExtractedField<unknown> | undefined][] = Object.entries(fields);
    const fieldsNeedingReview = named.filter(([, value]) => value !== undefined && value.confidence < REVIEW_CONFIDENCE).map(([name]) => name);
    const essential = ["supplierGstin", "invoiceNumber", "invoiceDate", "invoiceTotalPaise"] as const;
    const missing = essential.filter((name) => fields[name] === undefined);
    const worst = named.reduce((lowest, [, value]) => (value && value.confidence < lowest ? value.confidence : lowest), 1);

    if (source === "ocr" && (missing.length >= 3 || worst < QUARANTINE_CONFIDENCE)) {
      return {
        document: this.#quarantine(document, "EXTRACTION_TOO_UNCERTAIN", `Too little could be read from this document to prepare a draft${missing.length ? ` (missing: ${missing.join(", ")})` : ""}. Please send a clearer copy or enter it by hand.`),
        duplicate: false,
      };
    }

    const draft: ExtractionDraft = {
      id: randomUUID(),
      companyId: routing.companyId,
      documentId: id,
      source,
      ...fields,
      lines: readFields.lines,
      fieldsNeedingReview: [...fieldsNeedingReview, ...missing.map((name) => `${name} (not found)`)],
      arithmeticProblems: [...crossCheck({ ...fields, lines: readFields.lines }), ...readFields.problems],
      createdAt: new Date().toISOString(),
    };
    this.#drafts.set(draft.id, Object.freeze(draft));

    const ready = this.#set(document, {
      status: "draft_ready",
      statusMessage: draft.fieldsNeedingReview.length === 0
        ? "Read successfully. Nothing has been posted yet — please review and approve."
        : `Read, but ${draft.fieldsNeedingReview.length} value(s) need your eye. Nothing has been posted yet.`,
    });
    // A command records the intake for audit and idempotency. It finalises at "draft
    // prepared"; approving and posting the purchase are separate commands in #16/#17.
    const command = this.#commands.create(
      { companyId: routing.companyId, branchId: routing.companyId, actorId: input.sender.address, permissions: new Set(), sessionId: id },
      { action: "purchase.inbox.draft_prepared", risk: "low", idempotencyKey: input.idempotencyKey, payload: { documentId: id, sha256: input.attachment.sha256, supplierGstin: printedSupplier ?? null } },
    );
    this.#record(ready, "purchase.inbox.draft_ready", { draftId: draft.id, command: command.id, needsReview: draft.fieldsNeedingReview });
    return { document: ready, draft, duplicate: false };
  }

  /**
   * Retries a failed document. The OCR idempotency key is derived from the document id,
   * so a provider that already produced a result returns the same one instead of
   * charging for and generating a second read.
   */
  async retry(documentId: Id): Promise<ReceiveResult> {
    const document = this.#documents.get(documentId);
    if (!document) throw new InboxError("NOT_FOUND", "That document was not found.");
    if (document.status !== "failed") throw new InboxError("INVALID_STATE", "Only a document that failed can be tried again.");
    const company = this.#companies.find((candidate) => candidate.companyId === document.companyId);
    if (!company) throw new InboxError("INVALID_STATE", "This document has not been routed to a company yet.");
    const attempted = this.#set(document, { status: "extracting", attempts: document.attempts + 1 });
    try {
      const ocr = await this.#ocr.read({ companyId: company.companyId, storageKey: document.attachment.storageKey, idempotencyKey: `ocr:${document.id}`, correlationId: document.id });
      const read = readInvoiceFromOcr(ocr.pages, { companyGstins: company.gstins });
      if (read.unreadable) return { document: this.#quarantine(attempted, "UNREADABLE", read.problems[0] ?? "This document could not be read."), duplicate: false };
      const draft: ExtractionDraft = {
        id: randomUUID(), companyId: company.companyId, documentId: document.id, source: "ocr",
        ...(read.supplierGstin ? { supplierGstin: read.supplierGstin } : {}),
        ...(read.invoiceNumber ? { invoiceNumber: read.invoiceNumber } : {}),
        ...(read.invoiceDate ? { invoiceDate: read.invoiceDate } : {}),
        ...(read.taxableValuePaise ? { taxableValuePaise: read.taxableValuePaise } : {}),
        ...(read.totalTaxPaise ? { totalTaxPaise: read.totalTaxPaise } : {}),
        ...(read.invoiceTotalPaise ? { invoiceTotalPaise: read.invoiceTotalPaise } : {}),
        lines: read.lines, fieldsNeedingReview: [], arithmeticProblems: read.problems, createdAt: new Date().toISOString(),
      };
      this.#drafts.set(draft.id, Object.freeze(draft));
      const ready = this.#set(attempted, { status: "draft_ready", statusMessage: "Read successfully on retry. Nothing has been posted yet." });
      this.#record(ready, "purchase.inbox.draft_ready", { draftId: draft.id, attempt: ready.attempts });
      return { document: ready, draft, duplicate: false };
    } catch (error) {
      const connectorError = error instanceof ConnectorError ? error : null;
      const failed = this.#set(attempted, { status: "failed", statusMessage: connectorError?.retryable ? "Still unavailable. This will be tried again." : "This document could not be read." });
      this.#record(failed, "purchase.inbox.extraction_failed", { code: connectorError?.code ?? "UNKNOWN", attempt: failed.attempts });
      return { document: failed, duplicate: false };
    }
  }

  /** A human deciding a quarantined document belongs to a company after all. */
  assignCompany(context: RequestContext, documentId: Id, reason: string): InboundDocument {
    const document = this.#documents.get(documentId);
    if (!document) throw new InboxError("NOT_FOUND", "That document was not found.");
    if (document.companyId !== UNROUTED && document.companyId !== context.companyId) throw new PlatformError("TENANT_ISOLATION", "This document belongs to another company.");
    const assigned = this.#set(document, { companyId: context.companyId, status: "received", routing: { basis: "explicit_company", evidence: reason, confidence: 1 } });
    this.#record(assigned, "purchase.inbox.company_assigned", { reason });
    return assigned;
  }

  // ---------------------------------------------------------------- internals

  #draftFor(documentId: Id): ExtractionDraft | undefined {
    return [...this.#drafts.values()].find((draft) => draft.documentId === documentId);
  }

  #set(document: InboundDocument, changes: Partial<InboundDocument>): InboundDocument {
    const updated = Object.freeze({ ...document, ...changes }) as InboundDocument;
    this.#documents.set(document.id, updated);
    return updated;
  }

  #quarantine(document: InboundDocument, reason: QuarantineReason, message: string): InboundDocument {
    const held = this.#set(document, { status: "quarantined", quarantineReason: reason, statusMessage: message });
    this.#record(held, "purchase.inbox.quarantined", { reason, message });
    return held;
  }

  /** Audit entries are written against the owning company; unrouted ones are not leaked. */
  #record(document: InboundDocument, action: string, after: Record<string, unknown>): void {
    if (document.companyId === UNROUTED) return;
    this.#audit.append({
      companyId: document.companyId,
      actorId: document.sender.address,
      action,
      correlationId: document.id,
      before: { status: document.status },
      after: { ...after, fileName: document.attachment.fileName, channel: document.channel },
    });
  }
}

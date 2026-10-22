// The omnichannel purchase-invoice inbox (issue #15).
//
// A document arrives from WhatsApp, email, a camera, an upload or an e-invoice JSON
// file. This service screens it, decides which company it belongs to, reads it, and
// produces a reviewable draft. It posts nothing: no ledger entry, no stock movement, no
// payable. Validation is issue #16 and posting is issue #17.
//
// One deliberate ordering choice: a document is routed to a company *before* its pages
// are sent to the OCR provider, so no company's paperwork is ever processed under
// another company's tenant.
//
// Issue #400: only facts the sender cannot write route a document — the uploader's
// session, or the address the provider delivered it to (routing.ts). The GST numbers
// printed in it are then a cross-check that can *hold* the document in that company, never
// move it to another. Every later command (`retry`, `assignCompany`) takes the caller's
// `RequestContext` and works only on that company's documents.
//
// Issue #401: screening trusts nothing the sender declared. Size and hash are measured
// from the bytes that arrived, the whole file is read by the PDF checks, and a document
// waits for the virus scanner's own answer before anything reads it.

import { randomUUID } from "node:crypto";
import { ConnectorError } from "../../platform/src/connectors.ts";
import { PlatformError } from "../../platform/src/types.ts";
import type { Permission, RequestContext } from "../../platform/src/types.ts";
import type { AuditLog, PlatformCommandService } from "../../platform/src/platform.ts";
import type { Id } from "../../masters/src/types.ts";
import { NO_IRP_SIGNING_KEY } from "../../gst/src/irp-signature.ts";
import type { IrpSignatureVerifier } from "../../gst/src/irp-signature.ts";
import { applyScanVerdict, inspectAttachment } from "./safety.ts";
import type { DeclaredAttachment, ScreeningResult, SupportedType } from "./safety.ts";
import type { VirusScanPort } from "./virus-scan.ts";
import { assertDistinctChannels, routeDocument } from "./routing.ts";
import type { CompanyRoutingProfile } from "./routing.ts";
import { readEInvoiceJson } from "./einvoice.ts";
import type { EInvoiceReadResult } from "./einvoice.ts";
import { crossCheck, readInvoiceFromOcr } from "./extraction.ts";
import type { OcrReadResult } from "./extraction.ts";
import type { OcrAdapter } from "./ocr.ts";
import type { ExtractedField, ExtractionDraft, InboundDocument, InboundSender, InboundStatus, IntakeChannel, LogicalInvoiceKey, QuarantineReason } from "./inbox-types.ts";

export class InboxError extends Error {
  public readonly code: "NOT_FOUND" | "TENANT_ISOLATION" | "INVALID_STATE";
  constructor(code: InboxError["code"], message: string) { super(message); this.code = code; }
}

export interface ReceiveInput {
  readonly channel: IntakeChannel;
  readonly sender: InboundSender;
  /**
   * What the channel says about the file. `sizeBytes` and `sha256` are optional claims:
   * when given they are compared with the bytes, and the stored document always carries
   * the measured values (#401).
   */
  readonly attachment: DeclaredAttachment;
  /**
   * The whole file exactly as it arrived. Screening reads all of it — never a prefix —
   * and e-invoice JSON is parsed from these same bytes, so what was screened is what is
   * read (#401). There is deliberately no way to pass in a scan verdict: the inbox asks
   * its own scanner.
   */
  readonly bytes: Uint8Array;
  /**
   * The alias or number the document was delivered to, for channel routing. The channel
   * adapter must take it from the provider's delivery record (SMTP envelope recipient,
   * WhatsApp Business phone-number id), never from a header the sender wrote.
   */
  readonly deliveredTo?: string;
  /**
   * The signed-in user who uploaded this. The company is taken from this context and
   * nowhere else (#400: a caller-supplied company id is never authority).
   */
  readonly uploader?: RequestContext;
  /** Required. A resend of the same provider message returns the original document. */
  readonly idempotencyKey: string;
}

export interface ReceiveResult {
  readonly document: InboundDocument;
  readonly draft?: ExtractionDraft;
  /** True when this exact file had already been received for this company. */
  readonly duplicate: boolean;
}

export interface PurchaseInboxOptions {
  /**
   * Checks the Invoice Registration Portal's signature on e-invoice JSON. Without one, no
   * file is ever treated as signed (packages/gst/src/irp-signature.ts).
   */
  readonly irpSignatures?: IrpSignatureVerifier;
}

/** Below this confidence a field must be looked at before the draft moves on. */
export const REVIEW_CONFIDENCE = 0.8;
/** Below this, the document is not worth reviewing at all and is quarantined. */
export const QUARANTINE_CONFIDENCE = 0.4;

const UNROUTED = "__unrouted__";

/** Claiming a held document, or asking for it to be read again (#400). */
export const INBOX_MANAGE_PERMISSION: Permission = "purchase.inbox.manage";

/**
 * One answer for "does not exist" and "belongs to another company", so a document id from
 * another company cannot be probed for (#400).
 */
const notFound = (): InboxError => new InboxError("NOT_FOUND", "That document was not found.");

/** The quarantine reasons a person may resolve by saying which company a document is for. */
const ASSIGNABLE: ReadonlySet<QuarantineReason> = new Set(["COMPANY_NOT_IDENTIFIED", "COMPANY_MISMATCH"]);

const same = (a: string, b: string): boolean => a.trim().toUpperCase() === b.trim().toUpperCase();

export class PurchaseInboxService {
  readonly #commands: PlatformCommandService;
  readonly #audit: AuditLog;
  readonly #ocr: OcrAdapter;
  readonly #companies: readonly CompanyRoutingProfile[];
  readonly #signatures: IrpSignatureVerifier;
  readonly #documents = new Map<Id, InboundDocument>();
  readonly #drafts = new Map<Id, ExtractionDraft>();
  /** company + sha256 to document id, the attachment-level duplicate index. */
  readonly #byContent = new Map<string, Id>();
  /** Provider message id to document id, so a channel redelivery is not a new document. */
  readonly #byProviderMessage = new Map<string, Id>();
  /** For an unrouted document, the companies whose channel it arrived on: the only ones who may claim it. */
  readonly #channelOwners = new Map<Id, readonly Id[]>();
  /** The intake idempotency key, so a retry records its draft under the same command. */
  readonly #intakeKeys = new Map<Id, string>();
  /** Documents waiting for the virus scanner, with what is needed to carry on later. */
  readonly #awaitingScan = new Map<Id, Omit<ReceiveInput, "bytes">>();
  readonly #scanner: VirusScanPort;

  constructor(commands: PlatformCommandService, audit: AuditLog, ocr: OcrAdapter, companies: readonly CompanyRoutingProfile[], scanner: VirusScanPort, options: PurchaseInboxOptions = {}) {
    this.#commands = commands;
    this.#audit = audit;
    this.#ocr = ocr;
    // An address under two businesses that do not share an owner would let one claim the
    // other's documents (#400 review), so that configuration is refused outright.
    assertDistinctChannels(companies);
    this.#companies = companies;
    this.#scanner = scanner;
    this.#signatures = options.irpSignatures ?? NO_IRP_SIGNING_KEY;
  }

  // ------------------------------------------------------------------ reading

  document(context: RequestContext, id: Id): InboundDocument {
    const found = this.#documents.get(id);
    if (!found || found.companyId !== context.companyId) throw notFound();
    return found;
  }

  draft(context: RequestContext, documentId: Id): ExtractionDraft {
    const document = this.document(context, documentId);
    const draft = this.#draftFor(document.id);
    if (!draft) throw new InboxError("NOT_FOUND", "This document has no draft yet.");
    return draft;
  }

  inbox(context: RequestContext, status?: InboundStatus): readonly InboundDocument[] {
    return [...this.#documents.values()].filter((document) => document.companyId === context.companyId && (status === undefined || document.status === status));
  }

  /**
   * Documents that arrived on an address this company shares with another (so routing could
   * not choose) and are waiting for someone to claim them. Only the file name, size, channel
   * and time are shown: nothing has been read from them, and no storage key or hash leaves.
   */
  awaitingAssignment(context: RequestContext): readonly { readonly id: Id; readonly channel: IntakeChannel; readonly receivedAt: string; readonly fileName: string; readonly sizeBytes: number }[] {
    return [...this.#documents.values()]
      .filter((document) => document.companyId === UNROUTED && document.status === "quarantined" && (this.#channelOwners.get(document.id) ?? []).includes(context.companyId))
      .map((document) => ({ id: document.id, channel: document.channel, receivedAt: document.receivedAt, fileName: document.attachment.fileName, sizeBytes: document.attachment.sizeBytes }));
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
      // Size and hash are filled in from the measured bytes during screening.
      attachment: { ...input.attachment, sizeBytes: input.bytes.byteLength, sha256: "" },
      receivedAt: new Date().toISOString(),
      status: "received",
      attempts: 1,
    };
    this.#documents.set(id, document);
    this.#intakeKeys.set(id, input.idempotencyKey);
    if (input.sender.providerMessageId) this.#byProviderMessage.set(input.sender.providerMessageId, id);

    // 1. Screening, before anything reads the file: the whole file, measured size and
    //    hash, and an answer from the virus scanner (#401).
    document = this.#set(document, { status: "screening" });
    const screened = await this.#screen(document, input.attachment, input.bytes);
    document = screened.document;
    const screening = screened.screening;
    if (!screening.ok && screening.outcome === "quarantine") return { document: this.#quarantine(document, screening.reason, screening.message, screening.detail), duplicate: false };
    if (!screening.ok) {
      const { bytes: _bytes, ...rest } = input;
      this.#awaitingScan.set(id, rest);
      return { document: this.#set(document, { status: "awaiting_scan", statusMessage: screening.message }), duplicate: false };
    }
    return this.#afterScreening(document, input, screening.detectedType, input.bytes);
  }

  /**
   * Asks the scanner again about a document it has not answered for yet. The caller (a
   * worker reading from object storage) supplies the bytes; they must be the same file,
   * byte for byte, or the document is quarantined.
   */
  async rescan(documentId: Id, bytes: Uint8Array): Promise<ReceiveResult> {
    const document = this.#documents.get(documentId);
    const pending = this.#awaitingScan.get(documentId);
    if (!document) throw new InboxError("NOT_FOUND", "That document was not found.");
    if (document.status !== "awaiting_scan" || !pending) throw new InboxError("INVALID_STATE", "Only a document waiting for its virus check can be checked again.");
    const attempted = this.#set(document, { status: "screening", attempts: document.attempts + 1 });
    // The stored, measured size and hash are now the declaration the bytes must match.
    const screened = await this.#screen(attempted, attempted.attachment, bytes);
    const screening = screened.screening;
    if (!screening.ok && screening.outcome === "quarantine") {
      this.#awaitingScan.delete(documentId);
      return { document: this.#quarantine(screened.document, screening.reason, screening.message, screening.detail), duplicate: false };
    }
    if (!screening.ok) return { document: this.#set(screened.document, { status: "awaiting_scan", statusMessage: screening.message }), duplicate: false };
    this.#awaitingScan.delete(documentId);
    return this.#afterScreening(screened.document, { ...pending, bytes }, screening.detectedType, bytes);
  }

  async #screen(document: InboundDocument, declared: DeclaredAttachment, bytes: Uint8Array): Promise<{ document: InboundDocument; screening: ScreeningResult }> {
    const inspection = inspectAttachment(declared, bytes);
    const withMeasured = this.#set(document, { attachment: { ...document.attachment, sizeBytes: inspection.measured.sizeBytes, sha256: inspection.measured.sha256 ?? "" } });
    if (!inspection.ok) return { document: withMeasured, screening: inspection };
    const sha256 = inspection.measured.sha256;
    try {
      const answer = await this.#scanner.scan({
        bytes,
        sha256,
        sizeBytes: inspection.measured.sizeBytes,
        storageKey: document.attachment.storageKey,
        correlationId: document.id,
        idempotencyKey: `scan:${sha256}`,
      });
      // An answer about different bytes, or one we do not recognise, is no answer.
      const sameFile = typeof answer?.scannedSha256 === "string" && answer.scannedSha256.toLowerCase() === sha256;
      const verdict = sameFile && (answer.verdict === "clean" || answer.verdict === "infected") ? answer.verdict : "unscanned";
      this.#record(withMeasured, "purchase.inbox.virus_scanned", { verdict, sameFile, engine: String(answer?.engine ?? ""), providerRequestId: String(answer?.providerRequestId ?? "") });
      return { document: withMeasured, screening: applyScanVerdict(inspection, verdict) };
    } catch (error) {
      // Outage, timeout, a non-retryable failure or a bug in the adapter: all hold.
      const connectorError = error instanceof ConnectorError ? error : null;
      this.#record(withMeasured, "purchase.inbox.virus_scan_unavailable", { code: connectorError?.code ?? "UNKNOWN", retryable: connectorError?.retryable ?? false });
      return { document: withMeasured, screening: applyScanVerdict(inspection, undefined, true) };
    }
  }

  async #afterScreening(screened: InboundDocument, input: ReceiveInput, detectedType: SupportedType, bytes: Uint8Array): Promise<ReceiveResult> {
    let document = screened;
    const id = document.id;
    const measuredSha256 = document.attachment.sha256;

    // 2. Routing, from the uploader's session or the delivery address only. Nothing inside
    //    the file is consulted (#400).
    const routing = routeDocument({
      companies: this.#companies,
      channel: input.channel,
      sender: input.sender,
      ...(input.deliveredTo === undefined ? {} : { deliveredTo: input.deliveredTo }),
      ...(input.uploader === undefined ? {} : { uploader: input.uploader }),
    });
    if (!routing.ok) {
      this.#channelOwners.set(id, routing.channelOwners);
      return { document: this.#quarantine(document, routing.reason, routing.message), duplicate: false };
    }
    document = this.#set(document, { companyId: routing.companyId, routing: routing.decision });

    // 3. Attachment-level duplicate check, scoped to the company that owns the file. The
    //    hash is the one measured during screening, never a declared one (#401).
    const contentKey = `${routing.companyId}:${measuredSha256}`;
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

    // 4-6. Reading, cross-checking and drafting. e-invoice JSON is decoded from the
    //    screened bytes — the same bytes the hash and the virus check covered (#401).
    const company = this.#companies.find((candidate) => candidate.companyId === routing.companyId) as CompanyRoutingProfile;
    const jsonBody = detectedType === "json" ? new TextDecoder("utf-8").decode(bytes) : null;
    return this.#readAndDraft(document, company, {
      json: jsonBody === null ? null : { body: jsonBody },
      ...(input.uploader === undefined ? {} : { actor: input.uploader }),
    });
  }

  /**
   * Retries a failed document of the caller's own company. The OCR idempotency key is
   * derived from the document id, so a provider that already produced a result returns the
   * same one instead of charging for a second read. The retry goes through exactly the same
   * reading, cross-check and review rules as the first attempt (#400): a retry is never a way
   * round the company check or the review list.
   */
  async retry(context: RequestContext, documentId: Id): Promise<ReceiveResult> {
    const document = this.document(context, documentId);
    this.#require(context);
    if (document.status !== "failed") throw new InboxError("INVALID_STATE", "Only a document that failed can be tried again.");
    const company = this.#companies.find((candidate) => candidate.companyId === document.companyId);
    if (!company) throw new InboxError("INVALID_STATE", "This document has not been routed to a company yet.");
    const attempted = this.#set(document, { attempts: document.attempts + 1 });
    return this.#readAndDraft(attempted, company, { json: null, actor: context });
  }

  /**
   * A person in the caller's company deciding that a document held for its company is
   * theirs after all. Allowed only for a document that is already in this company, or one
   * that arrived on an address this company owns (#400). A document that arrived on nobody's
   * address cannot be claimed by anybody, however its id was learned.
   */
  assignCompany(context: RequestContext, documentId: Id, reason: string): InboundDocument {
    const document = this.#documents.get(documentId);
    if (!document) throw notFound();
    const mayClaim = document.companyId === UNROUTED
      ? (this.#channelOwners.get(document.id) ?? []).includes(context.companyId)
      : document.companyId === context.companyId;
    if (!mayClaim) throw notFound();
    this.#require(context);
    if (document.status !== "quarantined" || !document.quarantineReason || !ASSIGNABLE.has(document.quarantineReason)) {
      throw new InboxError("INVALID_STATE", "Only a document held because its business was unclear can be assigned. Other holds, such as an unsafe file, cannot be cleared this way.");
    }
    if (!reason.trim()) throw new InboxError("INVALID_STATE", "Please say why this document belongs to this business.");
    // The hold is lifted, so its reason goes; the decision and who made it are kept.
    const { quarantineReason, ...rest } = document;
    const assigned = Object.freeze({
      ...rest,
      companyId: context.companyId,
      status: "received",
      statusMessage: "Assigned to this business by hand. Nothing has been read or posted yet.",
      routing: { basis: "explicit_company", evidence: `Assigned by ${context.actorId}: ${reason.trim()}`, confidence: 1 },
    }) as InboundDocument;
    this.#documents.set(document.id, assigned);
    this.#channelOwners.delete(document.id);
    // The file now belongs to this company, so the same file arriving again is a duplicate here.
    const contentKey = `${context.companyId}:${document.attachment.sha256}`;
    if (!this.#byContent.has(contentKey)) this.#byContent.set(contentKey, document.id);
    this.#record(assigned, "purchase.inbox.company_assigned", { reason: reason.trim(), quarantineReason }, context.actorId);
    return assigned;
  }

  // ---------------------------------------------------------------- internals

  async #readAndDraft(
    routed: InboundDocument,
    company: CompanyRoutingProfile,
    options: { readonly json: { readonly body: string } | null; readonly actor?: RequestContext },
  ): Promise<ReceiveResult> {
    let document = this.#set(routed, { status: "extracting" });

    // Reading. e-invoice JSON is parsed locally, its IRP signature checked first.
    let eInvoice: EInvoiceReadResult | null = null;
    let read: OcrReadResult | null = null;
    if (options.json) {
      eInvoice = options.json.body ? readEInvoiceJson(options.json.body, { signatures: this.#signatures }) : null;
      if (eInvoice?.signature === "invalid") {
        return { document: this.#quarantine(document, "SIGNATURE_INVALID", `This e-invoice file carries a government signature that does not match what is written in it, so it may have been altered. It has been held. Ask the supplier for the original. (${eInvoice.signatureMessage ?? ""})`.replace(" ()", "")), duplicate: false };
      }
      if (!eInvoice?.invoiceNumber) {
        return { document: this.#quarantine(document, "NOT_AN_INVOICE", eInvoice?.problems[0] ?? "This JSON file is not a GST e-invoice."), duplicate: false };
      }
    } else {
      try {
        const ocr = await this.#ocr.read({ companyId: company.companyId, storageKey: document.attachment.storageKey, idempotencyKey: `ocr:${document.id}`, correlationId: document.id });
        read = readInvoiceFromOcr(ocr.pages, { companyGstins: company.gstins });
      } catch (error) {
        const connectorError = error instanceof ConnectorError ? error : null;
        const firstAttempt = document.attempts <= 1;
        const failed = this.#set(document, {
          status: "failed",
          statusMessage: connectorError?.retryable
            ? (firstAttempt ? "The document reader is temporarily unavailable. This will be tried again automatically." : "Still unavailable. This will be tried again.")
            : "This document could not be read.",
        });
        this.#record(failed, "purchase.inbox.extraction_failed", { code: connectorError?.code ?? "UNKNOWN", retryable: connectorError?.retryable ?? false, attempt: failed.attempts });
        return { document: failed, duplicate: false };
      }
      if (read.unreadable) return { document: this.#quarantine(document, "UNREADABLE", read.problems[0] ?? "This document could not be read."), duplicate: false };
    }

    // Cross-check against what is printed. It can hold the document here; it never moves it.
    // The other business is never named: the list of companies is every tenant, and naming
    // one would tell this company who else uses the product (#400).
    const readFields = eInvoice ?? read;
    if (!readFields) return { document: this.#quarantine(document, "UNREADABLE", "This document could not be read."), duplicate: false };
    const buyer = readFields.buyerGstin?.value;
    const printed = readFields.allGstins;
    const namesThisCompany = company.gstins.some((gstin) => printed.some((seen) => same(seen, gstin)));
    if (buyer && !company.gstins.some((gstin) => same(gstin, buyer))) {
      return {
        document: this.#quarantine(document, "COMPANY_MISMATCH", `This invoice is addressed to GST number ${buyer.trim().toUpperCase()}, which is not one of ${company.legalName}'s GST numbers. It has been held rather than filed in the wrong books.`),
        duplicate: false,
      };
    }
    if (routed.routing?.basis === "channel_binding" && printed.length > 0 && !namesThisCompany) {
      return {
        document: this.#quarantine(document, "COMPANY_MISMATCH", `This invoice does not name ${company.legalName}'s GST number, so it has been held for you to confirm which business it belongs to.`),
        duplicate: false,
      };
    }

    // Draft.
    const source = eInvoice ? "einvoice_json" : "ocr";
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

    const signatureNote = eInvoice && eInvoice.signature !== "verified"
      ? [eInvoice.signatureMessage ?? "This e-invoice file carries no government signature, so every value in it needs checking."]
      : [];
    const draft: ExtractionDraft = {
      id: randomUUID(),
      companyId: company.companyId,
      documentId: document.id,
      source,
      ...(eInvoice ? { signature: eInvoice.signature } : {}),
      ...fields,
      lines: readFields.lines,
      fieldsNeedingReview: [...fieldsNeedingReview, ...missing.map((name) => `${name} (not found)`)],
      arithmeticProblems: [...crossCheck({ ...fields, lines: readFields.lines }), ...readFields.problems, ...signatureNote],
      createdAt: new Date().toISOString(),
    };
    this.#drafts.set(draft.id, Object.freeze(draft));

    const retried = document.attempts > 1;
    document = this.#set(document, {
      status: "draft_ready",
      statusMessage: draft.fieldsNeedingReview.length === 0 && draft.arithmeticProblems.length === 0
        ? `Read successfully${retried ? " on retry" : ""}. Nothing has been posted yet — please review and approve.`
        : `Read${retried ? " on retry" : ""}, but ${draft.fieldsNeedingReview.length + draft.arithmeticProblems.length} thing(s) need your eye. Nothing has been posted yet.`,
    });
    // A command records the intake for audit and idempotency. It finalises at "draft
    // prepared"; approving and posting the purchase are separate commands in #16/#17.
    const context: RequestContext = options.actor && options.actor.companyId === company.companyId
      ? options.actor
      : { companyId: company.companyId, branchId: company.companyId, actorId: document.sender.address, permissions: new Set(), sessionId: document.id };
    const command = this.#commands.create(context, {
      action: "purchase.inbox.draft_prepared",
      risk: "low",
      idempotencyKey: this.#intakeKeys.get(document.id) ?? document.id,
      payload: { documentId: document.id, sha256: document.attachment.sha256, supplierGstin: readFields.supplierGstin?.value ?? null },
    });
    this.#record(document, "purchase.inbox.draft_ready", { draftId: draft.id, command: command.id, needsReview: draft.fieldsNeedingReview, attempt: document.attempts }, options.actor?.actorId);
    return { document, draft, duplicate: false };
  }

  #require(context: RequestContext): void {
    if (!context.permissions.has(INBOX_MANAGE_PERMISSION)) {
      throw new PlatformError("FORBIDDEN", "You do not have permission to manage held purchase documents. Ask the owner to give you access.");
    }
  }

  #draftFor(documentId: Id): ExtractionDraft | undefined {
    return [...this.#drafts.values()].find((draft) => draft.documentId === documentId);
  }

  #set(document: InboundDocument, changes: Partial<InboundDocument>): InboundDocument {
    const updated = Object.freeze({ ...document, ...changes }) as InboundDocument;
    this.#documents.set(document.id, updated);
    return updated;
  }

  #quarantine(document: InboundDocument, reason: QuarantineReason, message: string, detail?: string): InboundDocument {
    const held = this.#set(document, { status: "quarantined", quarantineReason: reason, statusMessage: message });
    this.#record(held, "purchase.inbox.quarantined", { reason, message, ...(detail === undefined ? {} : { detail }) });
    return held;
  }

  /** Audit entries are written against the owning company; unrouted ones are not leaked. */
  #record(document: InboundDocument, action: string, after: Record<string, unknown>, actorId?: Id): void {
    if (document.companyId === UNROUTED) return;
    this.#audit.append({
      companyId: document.companyId,
      actorId: actorId ?? document.sender.address,
      action,
      correlationId: document.id,
      before: { status: document.status },
      after: { ...after, fileName: document.attachment.fileName, channel: document.channel },
    });
  }
}

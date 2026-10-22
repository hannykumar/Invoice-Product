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

import { randomUUID } from "node:crypto";
import { ConnectorError } from "../../platform/src/connectors.ts";
import { PlatformError } from "../../platform/src/types.ts";
import type { Permission, RequestContext } from "../../platform/src/types.ts";
import type { AuditLog, PlatformCommandService } from "../../platform/src/platform.ts";
import type { Id } from "../../masters/src/types.ts";
import { NO_IRP_SIGNING_KEY } from "../../gst/src/irp-signature.ts";
import type { IrpSignatureVerifier } from "../../gst/src/irp-signature.ts";
import { screenAttachment } from "./safety.ts";
import type { ScanVerdict } from "./safety.ts";
import { assertDistinctChannels, routeDocument } from "./routing.ts";
import type { CompanyRoutingProfile } from "./routing.ts";
import { readEInvoiceJson } from "./einvoice.ts";
import type { EInvoiceReadResult } from "./einvoice.ts";
import { crossCheck, readInvoiceFromOcr } from "./extraction.ts";
import type { OcrReadResult } from "./extraction.ts";
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
  /**
   * Required. Usually the provider message id. The intake command is keyed on this plus the
   * file hash, so several attachments of one message are each their own document (#406).
   */
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
  /**
   * Channel-level duplicate index (#406): (company or delivery address, channel, provider
   * message id, file hash) to document id, so a channel redelivery is not a new document. Never
   * keyed by the bare message id, which is shared by every company and channel and, for email
   * (`Message-ID`) and camera/upload, written by the sender or the client.
   */
  readonly #byProviderMessage = new Map<string, { readonly id: Id; readonly scope: Id }>();
  /** For an unrouted document, the companies whose channel it arrived on: the only ones who may claim it. */
  readonly #channelOwners = new Map<Id, readonly Id[]>();
  /** The intake idempotency key, so a retry records its draft under the same command. */
  readonly #intakeKeys = new Map<Id, string>();

  constructor(commands: PlatformCommandService, audit: AuditLog, ocr: OcrAdapter, companies: readonly CompanyRoutingProfile[], options: PurchaseInboxOptions = {}) {
    this.#commands = commands;
    this.#audit = audit;
    this.#ocr = ocr;
    // An address under two businesses that do not share an owner would let one claim the
    // other's documents (#400 review), so that configuration is refused outright.
    assertDistinctChannels(companies);
    this.#companies = companies;
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
    // Routing reads nothing from the file (#400), so it can be decided first and scope the
    // channel-level duplicate check to one company (#406).
    const routing = routeDocument({
      companies: this.#companies,
      channel: input.channel,
      sender: input.sender,
      ...(input.deliveredTo === undefined ? {} : { deliveredTo: input.deliveredTo }),
      ...(input.uploader === undefined ? {} : { uploader: input.uploader }),
    });
    const routedTo = routing.ok ? routing.companyId : UNROUTED;
    const messageKey = this.#messageKey(input, routing.ok ? routing.companyId : null);
    const indexed = messageKey ? this.#byProviderMessage.get(messageKey) : undefined;
    const original = indexed ? this.#documents.get(indexed.id) : undefined;
    // Belt and braces: a "duplicate" is only ever a document indexed for the same company (or
    // the same unrouted address) through the same channel, and still in that company or still
    // unrouted (one held at screening, before routing was applied). Anything else is new.
    if (indexed && original && indexed.scope === routedTo && original.channel === input.channel
      && (original.companyId === routedTo || original.companyId === UNROUTED)) {
      const draft = this.#draftFor(original.id);
      return { document: original, duplicate: true, ...(draft ? { draft } : {}) };
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
    this.#intakeKeys.set(id, input.idempotencyKey);
    if (messageKey) this.#byProviderMessage.set(messageKey, { id, scope: routedTo });

    // 1. Screening, before anything reads the file.
    document = this.#set(document, { status: "screening" });
    const screening = screenAttachment(input.attachment, input.head, input.scanVerdict ?? "unscanned");
    if (!screening.ok) return { document: this.#quarantine(document, screening.reason, screening.message), duplicate: false };

    // 2. Routing, from the uploader's session or the delivery address only (decided above).
    //    Nothing inside the file is consulted (#400).
    if (!routing.ok) {
      this.#channelOwners.set(id, routing.channelOwners);
      return { document: this.#quarantine(document, routing.reason, routing.message), duplicate: false };
    }
    document = this.#set(document, { companyId: routing.companyId, routing: routing.decision });

    // 3. Attachment-level duplicate check, scoped to the company that owns the file.
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

    // 4-6. Reading, cross-checking and drafting.
    const company = this.#companies.find((candidate) => candidate.companyId === routing.companyId) as CompanyRoutingProfile;
    return this.#readAndDraft(document, company, {
      json: screening.detectedType === "json" ? { body: input.jsonBody ?? "" } : null,
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
    // A command records the intake for audit and idempotency. It is created before the draft
    // is stored, so a refused command leaves no half-finished document. Its key is per file:
    // one provider message can carry several attachments, each its own document (#406).
    const context: RequestContext = options.actor && options.actor.companyId === company.companyId
      ? options.actor
      : { companyId: company.companyId, branchId: company.companyId, actorId: document.sender.address, permissions: new Set(), sessionId: document.id };
    const command = this.#commands.create(context, {
      action: "purchase.inbox.draft_prepared",
      risk: "low",
      idempotencyKey: JSON.stringify([this.#intakeKeys.get(document.id) ?? document.id, document.attachment.sha256]),
      payload: { documentId: document.id, sha256: document.attachment.sha256, supplierGstin: readFields.supplierGstin?.value ?? null },
    });
    this.#drafts.set(draft.id, Object.freeze(draft));

    const retried = document.attempts > 1;
    document = this.#set(document, {
      status: "draft_ready",
      statusMessage: draft.fieldsNeedingReview.length === 0 && draft.arithmeticProblems.length === 0
        ? `Read successfully${retried ? " on retry" : ""}. Nothing has been posted yet — please review and approve.`
        : `Read${retried ? " on retry" : ""}, but ${draft.fieldsNeedingReview.length + draft.arithmeticProblems.length} thing(s) need your eye. Nothing has been posted yet.`,
    });
    // The command finalises at "draft prepared"; approving and posting are #16/#17.
    this.#record(document, "purchase.inbox.draft_ready", { draftId: draft.id, command: command.id, needsReview: draft.fieldsNeedingReview, attempt: document.attempts }, options.actor?.actorId);
    return { document, draft, duplicate: false };
  }

  /**
   * The channel-level duplicate key (#406). Scoped to the routed company, or for a document no
   * company could be chosen for, to the channel and delivery address it arrived on. The file
   * hash is always part of it: one email or upload can carry several files under one id, and a
   * reused `Message-ID` with a different file is a different document. A genuine redelivery
   * carries the same bytes, so it still matches. JSON-encoded so no part can forge another.
   */
  #messageKey(input: ReceiveInput, companyId: Id | null): string | null {
    const messageId = input.sender.providerMessageId?.trim();
    if (!messageId) return null;
    // Unrouted with no delivery address (an upload into a company with no inbox set up): there
    // is nothing to scope by, so no channel-level dedup rather than a shared bucket (#406 review).
    if (companyId === null && !(input.deliveredTo ?? "").trim()) return null;
    const scope = companyId === null
      ? ["unrouted", input.channel, (input.deliveredTo ?? "").trim().toLowerCase()]
      : ["company", companyId];
    return JSON.stringify([...scope, input.channel, messageId, input.attachment.sha256]);
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

  #quarantine(document: InboundDocument, reason: QuarantineReason, message: string): InboundDocument {
    const held = this.#set(document, { status: "quarantined", quarantineReason: reason, statusMessage: message });
    this.#record(held, "purchase.inbox.quarantined", { reason, message });
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

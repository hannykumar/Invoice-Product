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

import { createHash, randomUUID } from "node:crypto";
import { ConnectorError } from "../../platform/src/connectors.ts";
import { PlatformError } from "../../platform/src/types.ts";
import type { Permission, RequestContext } from "../../platform/src/types.ts";
import type { AuditLog, PlatformCommandService } from "../../platform/src/platform.ts";
import type { Id } from "../../masters/src/types.ts";
import { NO_IRP_SIGNING_KEY } from "../../gst/src/irp-signature.ts";
import type { IrpSignatureVerifier } from "../../gst/src/irp-signature.ts";
import { screenAttachment } from "./safety.ts";
import type { ScanVerdict, SupportedType } from "./safety.ts";
import { assertDistinctChannels, deliveryKey, routeDocument } from "./routing.ts";
import type { CompanyRoutingProfile } from "./routing.ts";
import { readEInvoiceJson } from "./einvoice.ts";
import type { EInvoiceReadResult } from "./einvoice.ts";
import { crossCheck, readInvoiceFromOcr } from "./extraction.ts";
import type { OcrReadResult } from "./extraction.ts";
import type { OcrAdapter } from "./ocr.ts";
import { InMemoryInboxStore } from "./inbox-store.ts";
import type { InboxStore } from "./inbox-store.ts";
import type { Page } from "./paging.ts";
import type { Attachment, ExtractedField, ExtractionDraft, InboundDocument, InboundSender, InboundStatus, IntakeChannel, LogicalInvoiceKey, QuarantineReason } from "./inbox-types.ts";

export class InboxError extends Error {
  public readonly code: "NOT_FOUND" | "TENANT_ISOLATION" | "INVALID_STATE";
  constructor(code: InboxError["code"], message: string) { super(message); this.code = code; }
}

export interface ReceiveInput {
  readonly channel: IntakeChannel;
  readonly sender: InboundSender;
  readonly attachment: Attachment;
  /**
   * The whole file. Its size and SHA-256 are measured here from the bytes — the
   * `sizeBytes`/`sha256` the caller declared on `attachment` are never trusted (#401).
   * For an e-invoice JSON this is also the parsed body.
   */
  readonly bytes: Uint8Array;
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
  /**
   * Where a document is kept once it belongs to a company (#366). In memory unless given; the app
   * passes `PostgresInboxStore` when it runs on PostgreSQL.
   */
  readonly store?: InboxStore;
  /**
   * Runs one step's writes for a company in one transaction: on PostgreSQL,
   * `(companyId, work) => db.unitOfWork(companyId, () => work())`. The inbox calls it itself, one
   * short step at a time, because the company is only known after routing and the OCR read must
   * never run inside a transaction. Without it the steps simply run.
   */
  readonly unitOfWork?: <T>(companyId: Id, work: () => Promise<T>) => Promise<T>;
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

/**
 * The redelivery dedup key, built only from facts the sender cannot write (#406): the company
 * an upload was made into, or the channel and destination the provider delivered to — plus the
 * file itself. A provider message id is never trusted on its own: an email `Message-ID` is the
 * sender's own text and a camera or upload id is the client's, so two different bills can carry
 * the same id. Scoped this way, a resend of one delivery is still one document, while the same
 * id on another channel, another destination or another file is a new document — never a
 * "duplicate" answer that returns a different company's paperwork or drops a real bill.
 */
const providerMessageKey = (input: ReceiveInput): string | null => {
  const id = input.sender.providerMessageId?.trim();
  if (!id) return null;
  const scope = input.uploader ? `uploader:${input.uploader.companyId}` : `delivery:${deliveryKey(input.channel, input.deliveredTo) ?? "unbound"}`;
  return `${input.channel}:${scope}:${id}:${input.attachment.sha256}`;
};

export class PurchaseInboxService {
  readonly #commands: PlatformCommandService;
  readonly #audit: AuditLog;
  readonly #ocr: OcrAdapter;
  readonly #companies: readonly CompanyRoutingProfile[];
  readonly #signatures: IrpSignatureVerifier;
  /** Routed documents, their drafts, and the company-scoped duplicate keys (#366). */
  readonly #store: InboxStore;
  readonly #unitOfWork: <T>(companyId: Id, work: () => Promise<T>) => Promise<T>;
  /**
   * The unrouted holding: documents whose company is not known yet (still screening, waiting for
   * the virus scanner, or on an address no single company owns). They have no company to be
   * stored under, so they stay in this process until routed or claimed (#366).
   */
  readonly #held = new Map<Id, InboundDocument>();
  /** Scoped provider message id to a held document's id, so a channel redelivery is not a new document (#406). */
  readonly #heldByMessage = new Map<string, Id>();
  /** For an unrouted document, the companies whose channel it arrived on: the only ones who may claim it. */
  readonly #channelOwners = new Map<Id, readonly Id[]>();
  /** A held document's intake idempotency key; stored with the document once it is routed. */
  readonly #intakeKeys = new Map<Id, string>();
  /** Files held until the virus scanner answers (#401), keyed by document id. */
  readonly #awaitingScan = new Map<Id, ReceiveInput>();

  constructor(commands: PlatformCommandService, audit: AuditLog, ocr: OcrAdapter, companies: readonly CompanyRoutingProfile[], options: PurchaseInboxOptions = {}) {
    this.#commands = commands;
    this.#audit = audit;
    this.#ocr = ocr;
    // An address under two businesses that do not share an owner would let one claim the
    // other's documents (#400 review), so that configuration is refused outright.
    assertDistinctChannels(companies);
    this.#companies = companies;
    this.#signatures = options.irpSignatures ?? NO_IRP_SIGNING_KEY;
    this.#store = options.store ?? new InMemoryInboxStore();
    this.#unitOfWork = options.unitOfWork ?? ((_companyId, work) => work());
  }

  // ------------------------------------------------------------------ reading

  async document(context: RequestContext, id: Id): Promise<InboundDocument> {
    const found = await this.#store.document(context.companyId, id);
    if (!found) throw notFound();
    return found;
  }

  async draft(context: RequestContext, documentId: Id): Promise<ExtractionDraft> {
    const document = await this.document(context, documentId);
    const draft = await this.#store.draftFor(document.companyId, document.id);
    if (!draft) throw new InboxError("NOT_FOUND", "This document has no draft yet.");
    return draft;
  }

  /** Oldest first. Leave `page` out for the whole inbox, as before (#366). */
  inbox(context: RequestContext, status?: InboundStatus, page?: Page): Promise<readonly InboundDocument[]> {
    return this.#store.documents(context.companyId, status, page);
  }

  /**
   * Documents that arrived on an address this company shares with another (so routing could
   * not choose) and are waiting for someone to claim them. Only the file name, size, channel
   * and time are shown: nothing has been read from them, and no storage key or hash leaves.
   */
  awaitingAssignment(context: RequestContext): readonly { readonly id: Id; readonly channel: IntakeChannel; readonly receivedAt: string; readonly fileName: string; readonly sizeBytes: number }[] {
    return [...this.#held.values()]
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
    // The file is measured before anything trusts it: the size and hash the caller
    // declared are replaced by what the bytes actually contain (#401). Dedup keys,
    // the size cap and the stored record all use the measured values, so a lying
    // upload cannot smuggle a bigger file past the cap or claim another file's hash.
    const measured: Attachment = {
      ...input.attachment,
      sizeBytes: input.bytes.length,
      sha256: createHash("sha256").update(input.bytes).digest("hex"),
    };
    const checked: ReceiveInput = { ...input, attachment: measured };

    const messageKey = providerMessageKey(checked);
    if (messageKey) {
      // The key is scoped to this delivery's destination and file, so the document found is
      // always one that arrived on this same binding — never another company's document (#406).
      const stored = await this.#storedByMessage(checked, messageKey);
      if (stored) return stored;
      // Looked up after the await and set below with nothing awaited in between, so two copies
      // arriving at once in this process still make one document.
      const held = this.#heldByMessage.get(messageKey);
      if (held) return { document: this.#held.get(held) as InboundDocument, duplicate: true };
    }

    const id = randomUUID();
    let document: InboundDocument = {
      id,
      companyId: UNROUTED,
      channel: input.channel,
      sender: input.sender,
      attachment: measured,
      receivedAt: new Date().toISOString(),
      status: "received",
      attempts: 1,
    };
    this.#held.set(id, document);
    this.#intakeKeys.set(id, input.idempotencyKey);
    if (messageKey) this.#heldByMessage.set(messageKey, id);

    // 1. Screening, before anything reads the file.
    document = this.#set(document, { status: "screening" });
    const screening = await screenAttachment(measured, input.bytes, input.scanVerdict ?? "unscanned");
    if (!screening.ok) {
      // A file waiting on the scanner keeps its delivery so "clean" can release it
      // back into this same pipeline (#401); every other hold ends here.
      if (screening.reason === "AWAITING_SCAN") this.#awaitingScan.set(id, checked);
      return { document: this.#quarantine(document, screening.reason, screening.message), duplicate: false };
    }
    if (screening.pageCount !== undefined) {
      document = this.#set(document, { attachment: { ...document.attachment, pageCount: screening.pageCount } });
    }
    return this.#routeAndDraft(document, checked, screening.detectedType);
  }

  /**
   * The virus scanner has answered for a document that was held as `AWAITING_SCAN`
   * (#401). A clean verdict runs it through the identical pipeline any other file
   * takes — routing, duplicate check, reading — so a held document can never skip a
   * step. An infected verdict holds it for good. Called by the scanner integration,
   * not by a tenant: the document is still unrouted, so no RequestContext exists yet.
   */
  async scanAnswered(documentId: Id, verdict: ScanVerdict): Promise<ReceiveResult> {
    const input = this.#awaitingScan.get(documentId);
    const document = this.#held.get(documentId);
    if (!input || !document || document.status !== "quarantined" || document.quarantineReason !== "AWAITING_SCAN") {
      throw new InboxError("INVALID_STATE", "This document is not waiting for a virus check.");
    }
    if (verdict === "unscanned") throw new InboxError("INVALID_STATE", "A scan answer must be clean or infected.");
    this.#awaitingScan.delete(documentId);
    if (verdict === "infected") {
      return { document: this.#quarantine(document, "MALWARE_SUSPECTED", "This file was flagged as unsafe by the virus scanner, so it has not been opened."), duplicate: false };
    }
    // The hold is lifted: its reason and message go, everything else is kept.
    const { quarantineReason: _hold, statusMessage: _holdMessage, ...fields } = document;
    let released = this.#set(fields as InboundDocument, { status: "screening" });
    const screening = await screenAttachment(input.attachment, input.bytes, "clean");
    if (!screening.ok) return { document: this.#quarantine(released, screening.reason, screening.message), duplicate: false };
    if (screening.pageCount !== undefined) {
      released = this.#set(released, { attachment: { ...released.attachment, pageCount: screening.pageCount } });
    }
    return this.#routeAndDraft(released, input, screening.detectedType);
  }

  /**
   * Everything after a file has passed screening: route to a company, drop a file
   * the company already has, then read and draft. `scanAnswered` releases a held
   * document into exactly this path, so a released file is never read differently.
   */
  async #routeAndDraft(document: InboundDocument, input: ReceiveInput, detectedType: SupportedType): Promise<ReceiveResult> {
    // 2. Routing, from the uploader's session or the delivery address only. Nothing inside
    //    the file is consulted (#400).
    const routing = this.#route(input);
    if (!routing.ok) {
      this.#channelOwners.set(document.id, routing.channelOwners);
      return { document: this.#quarantine(document, routing.reason, routing.message), duplicate: false };
    }
    const companyId = routing.companyId;
    const routed = Object.freeze({ ...document, companyId, routing: routing.decision }) as InboundDocument;
    const messageKey = providerMessageKey(input);
    const intakeKey = this.#intakeKeys.get(document.id) ?? document.id;

    // From here the document belongs to a company and is stored in that company's books (#366).
    // 3. Attachment-level duplicate check, scoped to the company that owns the file.
    //    The hash was measured from the bytes at intake (#401), not taken from the sender.
    const outcome = await this.#unitOfWork(companyId, async (): Promise<ReceiveResult | null> => {
      // The same delivery, stored by another server while this one was screening it (#406).
      const redelivered = messageKey ? await this.#store.documentByMessageKey(companyId, messageKey) : null;
      if (redelivered) return this.#withDraft(redelivered);
      await this.#store.insertDocument(routed, { messageKey, intakeKey });
      const earlier = await this.#store.claimContent(companyId, routed.attachment.sha256, routed.id);
      if (earlier === routed.id) return null;
      const original = await this.#store.document(companyId, earlier) as InboundDocument;
      const marked = await this.#update(routed, {
        status: "discarded",
        duplicateOfId: earlier,
        statusMessage: `This is the same file you already received on ${new Date(original.receivedAt).toDateString()} through ${original.channel.replace("_", " ")}, so it has not been added twice.`,
      });
      this.#record(marked, "purchase.inbox.duplicate_discarded", { duplicateOfId: earlier });
      return { document: marked, duplicate: true };
    });
    this.#release(document.id);
    if (outcome) return outcome;

    // 4-6. Reading, cross-checking and drafting.
    const company = this.#companies.find((candidate) => candidate.companyId === companyId) as CompanyRoutingProfile;
    return this.#readAndDraft(routed, company, {
      // An e-invoice JSON file is its own body; the text comes from the received bytes.
      json: detectedType === "json" ? { body: new TextDecoder("utf-8").decode(input.bytes) } : null,
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
    const document = await this.document(context, documentId);
    this.#require(context);
    if (document.status !== "failed") throw new InboxError("INVALID_STATE", "Only a document that failed can be tried again.");
    const company = this.#companies.find((candidate) => candidate.companyId === document.companyId);
    if (!company) throw new InboxError("INVALID_STATE", "This document has not been routed to a company yet.");
    const attempted = await this.#update(document, { attempts: document.attempts + 1 });
    return this.#readAndDraft(attempted, company, { json: null, actor: context });
  }

  /**
   * A person in the caller's company deciding that a document held for its company is
   * theirs after all. Allowed only for a document that is already in this company, or one
   * that arrived on an address this company owns (#400). A document that arrived on nobody's
   * address cannot be claimed by anybody, however its id was learned.
   */
  async assignCompany(context: RequestContext, documentId: Id, reason: string): Promise<InboundDocument> {
    const held = this.#held.get(documentId);
    const document = held ?? await this.#store.document(context.companyId, documentId);
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
    await this.#unitOfWork(context.companyId, async () => {
      if (held) {
        // Out of the unrouted holding and into this company's books, with the keys it arrived with.
        const messageKey = [...this.#heldByMessage].find(([, id]) => id === document.id)?.[0] ?? null;
        await this.#store.insertDocument(assigned, { messageKey, intakeKey: this.#intakeKeys.get(document.id) ?? document.id });
      } else {
        await this.#store.updateDocument(assigned);
      }
      // The file now belongs to this company, so the same file arriving again is a duplicate here.
      await this.#store.claimContent(context.companyId, document.attachment.sha256, document.id);
      this.#record(assigned, "purchase.inbox.company_assigned", { reason: reason.trim(), quarantineReason }, context.actorId);
    });
    if (held) this.#release(document.id);
    return assigned;
  }

  // ---------------------------------------------------------------- internals

  async #readAndDraft(
    routed: InboundDocument,
    company: CompanyRoutingProfile,
    options: { readonly json: { readonly body: string } | null; readonly actor?: RequestContext },
  ): Promise<ReceiveResult> {
    let document = await this.#update(routed, { status: "extracting" });

    // Reading. e-invoice JSON is parsed locally, its IRP signature checked first.
    let eInvoice: EInvoiceReadResult | null = null;
    let read: OcrReadResult | null = null;
    if (options.json) {
      eInvoice = options.json.body ? readEInvoiceJson(options.json.body, { signatures: this.#signatures }) : null;
      if (eInvoice?.signature === "invalid") {
        return { document: await this.#hold(document, "SIGNATURE_INVALID", `This e-invoice file carries a government signature that does not match what is written in it, so it may have been altered. It has been held. Ask the supplier for the original. (${eInvoice.signatureMessage ?? ""})`.replace(" ()", "")), duplicate: false };
      }
      if (!eInvoice?.invoiceNumber) {
        return { document: await this.#hold(document, "NOT_AN_INVOICE", eInvoice?.problems[0] ?? "This JSON file is not a GST e-invoice."), duplicate: false };
      }
    } else {
      try {
        const ocr = await this.#ocr.read({ companyId: company.companyId, storageKey: document.attachment.storageKey, idempotencyKey: `ocr:${document.id}`, correlationId: document.id });
        read = readInvoiceFromOcr(ocr.pages, { companyGstins: company.gstins });
      } catch (error) {
        const connectorError = error instanceof ConnectorError ? error : null;
        const firstAttempt = document.attempts <= 1;
        const failed = await this.#update(document, {
          status: "failed",
          statusMessage: connectorError?.retryable
            ? (firstAttempt ? "The document reader is temporarily unavailable. This will be tried again automatically." : "Still unavailable. This will be tried again.")
            : "This document could not be read.",
        });
        this.#record(failed, "purchase.inbox.extraction_failed", { code: connectorError?.code ?? "UNKNOWN", retryable: connectorError?.retryable ?? false, attempt: failed.attempts });
        return { document: failed, duplicate: false };
      }
      if (read.unreadable) return { document: await this.#hold(document, "UNREADABLE", read.problems[0] ?? "This document could not be read."), duplicate: false };
    }

    // Cross-check against what is printed. It can hold the document here; it never moves it.
    // The other business is never named: the list of companies is every tenant, and naming
    // one would tell this company who else uses the product (#400).
    const readFields = eInvoice ?? read;
    if (!readFields) return { document: await this.#hold(document, "UNREADABLE", "This document could not be read."), duplicate: false };
    const buyer = readFields.buyerGstin?.value;
    const printed = readFields.allGstins;
    const namesThisCompany = company.gstins.some((gstin) => printed.some((seen) => same(seen, gstin)));
    if (buyer && !company.gstins.some((gstin) => same(gstin, buyer))) {
      return {
        document: await this.#hold(document, "COMPANY_MISMATCH", `This invoice is addressed to GST number ${buyer.trim().toUpperCase()}, which is not one of ${company.legalName}'s GST numbers. It has been held rather than filed in the wrong books.`),
        duplicate: false,
      };
    }
    if (routed.routing?.basis === "channel_binding" && printed.length > 0 && !namesThisCompany) {
      return {
        document: await this.#hold(document, "COMPANY_MISMATCH", `This invoice does not name ${company.legalName}'s GST number, so it has been held for you to confirm which business it belongs to.`),
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
        document: await this.#hold(document, "EXTRACTION_TOO_UNCERTAIN", `Too little could be read from this document to prepare a draft${missing.length ? ` (missing: ${missing.join(", ")})` : ""}. Please send a clearer copy or enter it by hand.`),
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
    const extracted = document;
    // The draft, the document's move to "draft ready" and the command are saved together (#366).
    return this.#unitOfWork(company.companyId, async () => {
      await this.#store.insertDraft(Object.freeze(draft));
      const retried = extracted.attempts > 1;
      const ready = await this.#update(extracted, {
        status: "draft_ready",
        statusMessage: draft.fieldsNeedingReview.length === 0 && draft.arithmeticProblems.length === 0
          ? `Read successfully${retried ? " on retry" : ""}. Nothing has been posted yet — please review and approve.`
          : `Read${retried ? " on retry" : ""}, but ${draft.fieldsNeedingReview.length + draft.arithmeticProblems.length} thing(s) need your eye. Nothing has been posted yet.`,
      });
      // A command records the intake for audit and idempotency. It finalises at "draft
      // prepared"; approving and posting the purchase are separate commands in #16/#17.
      const context: RequestContext = options.actor && options.actor.companyId === company.companyId
        ? options.actor
        : { companyId: company.companyId, branchId: company.companyId, actorId: ready.sender.address, permissions: new Set(), sessionId: ready.id };
      const command = this.#commands.create(context, {
        action: "purchase.inbox.draft_prepared",
        risk: "low",
        idempotencyKey: (await this.#store.intakeKey(ready.companyId, ready.id)) ?? ready.id,
        payload: { documentId: ready.id, sha256: ready.attachment.sha256, supplierGstin: readFields.supplierGstin?.value ?? null },
      });
      this.#record(ready, "purchase.inbox.draft_ready", { draftId: draft.id, command: command.id, needsReview: draft.fieldsNeedingReview, attempt: ready.attempts }, options.actor?.actorId);
      return { document: ready, draft, duplicate: false };
    });
  }

  #require(context: RequestContext): void {
    if (!context.permissions.has(INBOX_MANAGE_PERMISSION)) {
      throw new PlatformError("FORBIDDEN", "You do not have permission to manage held purchase documents. Ask the owner to give you access.");
    }
  }

  #route(input: ReceiveInput) {
    return routeDocument({
      companies: this.#companies,
      channel: input.channel,
      sender: input.sender,
      ...(input.deliveredTo === undefined ? {} : { deliveredTo: input.deliveredTo }),
      ...(input.uploader === undefined ? {} : { uploader: input.uploader }),
    });
  }

  /**
   * A redelivery already filed in a company (#406). Only the companies it could have reached are
   * asked: the one its delivery routes to, or — when the address is shared — the ones that own the
   * address and so may have claimed it. Routing is a pure function of the delivery, so this is the
   * same answer the in-memory index gave.
   */
  async #storedByMessage(input: ReceiveInput, messageKey: string): Promise<ReceiveResult | null> {
    const routing = this.#route(input);
    for (const companyId of routing.ok ? [routing.companyId] : routing.channelOwners) {
      const found = await this.#store.documentByMessageKey(companyId, messageKey);
      if (found) return this.#withDraft(found);
    }
    return null;
  }

  async #withDraft(document: InboundDocument): Promise<ReceiveResult> {
    const draft = await this.#store.draftFor(document.companyId, document.id);
    return { document, duplicate: true, ...(draft ? { draft } : {}) };
  }

  /** A held document has been stored in its company: it leaves the unrouted holding. */
  #release(id: Id): void {
    this.#held.delete(id);
    this.#intakeKeys.delete(id);
    this.#channelOwners.delete(id);
    for (const [key, heldId] of this.#heldByMessage) if (heldId === id) this.#heldByMessage.delete(key);
  }

  /** A document in the unrouted holding. Once routed, `#update` saves it instead. */
  #set(document: InboundDocument, changes: Partial<InboundDocument>): InboundDocument {
    const updated = Object.freeze({ ...document, ...changes }) as InboundDocument;
    this.#held.set(document.id, updated);
    return updated;
  }

  /** A routed document's next step, saved in its company's unit of work. */
  #update(document: InboundDocument, changes: Partial<InboundDocument>): Promise<InboundDocument> {
    const updated = Object.freeze({ ...document, ...changes }) as InboundDocument;
    return this.#unitOfWork(updated.companyId, async () => {
      await this.#store.updateDocument(updated);
      return updated;
    });
  }

  /** `#quarantine` for a routed document. */
  #hold(document: InboundDocument, reason: QuarantineReason, message: string): Promise<InboundDocument> {
    return this.#unitOfWork(document.companyId, async () => {
      const held = await this.#update(document, { status: "quarantined", quarantineReason: reason, statusMessage: message });
      this.#record(held, "purchase.inbox.quarantined", { reason, message });
      return held;
    });
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

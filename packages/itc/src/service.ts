/**
 * Issue #31 [E31] — the reconciliation as a thing a business uses.
 *
 * Everything before this file is pure: hand it two lists, get back lines. This is where the month
 * acquires a life — a file somebody imported at a particular moment, an accountant's answer on one
 * line, an audit trail, and a figure that ends up on a filed return.
 *
 * Three promises are kept here rather than anywhere else.
 *
 *   1. **Recomputation preserves user actions.** The workspace is recomputed from scratch on every
 *      read — new bills, a fresh import, a corrected posting — and the decisions are re-attached by
 *      a key built only from facts that do not move. A decision whose figures have changed is kept
 *      and shown as out of date; it is never applied to numbers it did not cover, and it is never
 *      thrown away.
 *   2. **Nothing here files or claims by itself.** Preparing the comparison is free and writes
 *      nothing. Importing writes portal rows and an audit entry. Deciding writes one row and an
 *      audit entry. The credit reaches a return only through the linkage the return module reads,
 *      and only for lines that either match cleanly or carry somebody's name.
 *   3. **Tenancy comes from the actor.** Every method takes the company from the authenticated
 *      context and never from the caller's input, so one company can never read or decide another
 *      company's purchases.
 */
import { createHash } from 'node:crypto';
import { conflict, forbidden, invalid, notFound, type Clock, type CompanyId, type IsoDate } from '@invoice/kernel';
import type { ActorContext, AuditPort } from '@invoice/ledger';
import { checksumOf, parsePortalFile, parseTypedRecord, type ParsedPortalRecord, type TypedPortalRecord } from './import.ts';
import { assessLine, linkageFor } from './itc.ts';
import { matchDocuments } from './match.ts';
import type {
  ImportBatchRepository,
  ItcDecisionRepository,
  ItcPolicyPort,
  PortalRecordRepository,
  PortalRecordSource,
  PurchaseBookPort,
} from './ports.ts';
import {
  DEFAULT_MATCH_POLICY,
  ITC_PERMISSIONS,
  RECORD_SOURCE_PLAIN,
  emptyAmounts,
  formatTaxPeriod,
  subtractAmounts,
  sumAmounts,
  totalTaxOf,
  taxPeriodRange,
  type Bilingual,
  type BookPurchaseDocument,
  type DecisionKind,
  type Gstr3bLinkage,
  type ImportBatch,
  type ItcDecision,
  type ItcFinding,
  type ItcMatchPolicy,
  type ItcOutcome,
  type ItcWorkspace,
  type MatchStatus,
  type PortalDocument,
  type RecordSource,
  type ReconciliationLine,
  type TaxAmounts,
  type TaxPeriod,
} from './types.ts';
import { formatINR } from '@invoice/kernel';

export interface ItcServiceDeps {
  readonly books: PurchaseBookPort;
  readonly records: PortalRecordRepository;
  readonly batches: ImportBatchRepository;
  readonly decisions: ItcDecisionRepository;
  readonly audit: AuditPort;
  readonly clock: Clock;
  /** Absent for a business with no licensed intermediary. Everything except one button still works. */
  readonly portal?: PortalRecordSource;
  readonly policy?: ItcPolicyPort;
  readonly idFactory?: () => string;
}

export interface ImportInput {
  readonly period: TaxPeriod;
  readonly content: string;
  readonly fileName?: string;
  readonly source?: RecordSource;
  /** The registration the month is being reconciled for, checked against what the file says. */
  readonly expectedGstin?: string;
}

export interface DecisionInput {
  readonly period: TaxPeriod;
  readonly lineKey: string;
  readonly kind: DecisionKind;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export class ItcReconciliationService {
  readonly #books: PurchaseBookPort;
  readonly #records: PortalRecordRepository;
  readonly #batches: ImportBatchRepository;
  readonly #decisions: ItcDecisionRepository;
  readonly #audit: AuditPort;
  readonly #clock: Clock;
  readonly #portal: PortalRecordSource | undefined;
  readonly #policy: ItcPolicyPort | undefined;
  readonly #newId: () => string;

  constructor(deps: ItcServiceDeps) {
    this.#books = deps.books;
    this.#records = deps.records;
    this.#batches = deps.batches;
    this.#decisions = deps.decisions;
    this.#audit = deps.audit;
    this.#clock = deps.clock;
    this.#portal = deps.portal;
    this.#policy = deps.policy;
    this.#newId = deps.idFactory ?? (() => crypto.randomUUID());
  }

  // ------------------------------------------------------------------ reading

  /**
   * The whole month, computed and stored nowhere.
   *
   * Free to call, and called on every visit: a screen built from a cached comparison would show a
   * bill that has since been posted as still missing, and somebody would ring a supplier about a
   * problem that no longer exists.
   */
  async workspace(actor: ActorContext, period: TaxPeriod): Promise<ItcWorkspace> {
    this.#require(actor, ITC_PERMISSIONS.view);
    const companyId = actor.companyId;
    const [books, portal, decisions, lastImport] = await Promise.all([
      this.#books.documentsFor(companyId, period),
      this.#records.listForPeriod(companyId, period),
      this.#decisions.latestForPeriod(companyId, period),
      this.#batches.latestFor(companyId, period),
    ]);
    const policy = await this.#policyFor(companyId, period);

    const latest = new Map<string, ItcDecision>();
    for (const decision of decisions) {
      const held = latest.get(decision.lineKey);
      if (held === undefined || held.decidedAt <= decision.decidedAt) latest.set(decision.lineKey, decision);
    }

    const pairs = matchDocuments({ books, portal, policy });
    const lines = pairs.map((pair) => {
      const provisional = assessLine({ pair, decision: null, policy });
      return assessLine({ pair, decision: latest.get(provisional.key) ?? null, policy });
    });

    return this.#assemble(period, lines, books, portal, lastImport);
  }

  /** Every answer ever given on one line, for the "who decided this" panel. */
  async decisionHistory(actor: ActorContext, lineKey: string): Promise<readonly ItcDecision[]> {
    this.#require(actor, ITC_PERMISSIONS.view);
    return this.#decisions.history(actor.companyId, lineKey);
  }

  async imports(actor: ActorContext, period: TaxPeriod): Promise<readonly ImportBatch[]> {
    this.#require(actor, ITC_PERMISSIONS.view);
    return this.#batches.list(actor.companyId, period);
  }

  // ------------------------------------------------------------------ getting the portal's list in

  /**
   * Imports a downloaded GSTR-2B or IMS file, or a spreadsheet of one.
   *
   * Importing the same file twice is not an error and does not double anything: the checksum is
   * recognised and the first batch is returned. That matters because the commonest thing a person
   * does when a screen seems not to have responded is to press the button again.
   */
  async importFile(actor: ActorContext, input: ImportInput): Promise<ImportBatch> {
    this.#require(actor, ITC_PERMISSIONS.import);
    const source: RecordSource = input.source ?? 'GSTR2B_FILE';
    const checksum = checksumOf(input.content);
    const already = await this.#batches.findByChecksum(actor.companyId, input.period, checksum);
    if (already !== null) return already;

    const parsed = parsePortalFile(input.content, source);
    if (parsed.records.length === 0 && parsed.rejected.length > 0) {
      throw invalid('ITC_FILE_UNREADABLE', `Nothing could be read from this file. ${(parsed.rejected[0] as { reason: string }).reason}`);
    }
    if (parsed.period !== null && parsed.period !== input.period) {
      throw invalid(
        'ITC_FILE_WRONG_PERIOD',
        `This file is the statement for ${formatTaxPeriod(parsed.period)}, and you are working on ${formatTaxPeriod(input.period)}. Open ${formatTaxPeriod(parsed.period)} and import it there, or download the right month.`,
      );
    }
    if (input.expectedGstin !== undefined && parsed.gstin !== null && parsed.gstin.toUpperCase() !== input.expectedGstin.toUpperCase()) {
      throw invalid(
        'ITC_FILE_WRONG_GSTIN',
        `This file was downloaded for GST number ${parsed.gstin}, and this business files under ${input.expectedGstin}. Nothing has been imported.`,
      );
    }

    return this.#storeBatch(actor, {
      period: input.period,
      source,
      fileName: input.fileName ?? null,
      checksum,
      records: parsed.records,
      rejected: parsed.rejected,
    });
  }

  /**
   * One row read off the portal by a person and typed in.
   *
   * The path exists because the file often cannot be had: no download on a phone, a portal that
   * will not produce the statement, an accountant reading four figures down the line. The typed
   * row runs the same validation and produces the same kind of record; what differs is that the
   * evidence says a person supplied it, and every screen showing the figure says so too.
   */
  async addTypedRecord(
    actor: ActorContext,
    input: { readonly period: TaxPeriod; readonly record: TypedPortalRecord },
  ): Promise<ImportBatch> {
    this.#require(actor, ITC_PERMISSIONS.import);
    let record: ParsedPortalRecord;
    try {
      record = parseTypedRecord(input.record);
    } catch (error) {
      throw invalid('ITC_TYPED_ROW_INVALID', (error as Error).message);
    }
    // Typed rows are keyed by what was typed, so typing the same row twice is recognised the same
    // way a re-imported file is.
    const checksum = checksumOf(`typed|${record.supplierGstin}|${record.number}|${record.kind}|${record.documentDate}|${record.amounts.taxableValue.minor}`);
    const already = await this.#batches.findByChecksum(actor.companyId, input.period, checksum);
    if (already !== null) return already;

    return this.#storeBatch(actor, {
      period: input.period,
      source: 'TYPED',
      fileName: null,
      checksum,
      records: [record],
      rejected: [],
    });
  }

  /**
   * Fetches the statement through a licensed intermediary, when the business has one.
   *
   * The content goes through the same reader as an imported file, so this path cannot produce a
   * different reconciliation from the file path. A business without a channel is told what to do
   * instead, in one sentence, rather than shown a disabled button and no explanation.
   */
  async fetchFromPortal(
    actor: ActorContext,
    input: { readonly period: TaxPeriod; readonly gstin: string },
  ): Promise<ImportBatch> {
    this.#require(actor, ITC_PERMISSIONS.import);
    if (this.#portal === undefined) {
      throw invalid(
        'ITC_NO_PORTAL_CHANNEL',
        'This business has no connection to the GST portal, so nothing can be fetched from here. Download the GSTR-2B file from the portal and import it — it produces exactly the same comparison.',
      );
    }
    const outcome = await this.#portal.fetchGstr2b(actor.companyId, input.gstin, input.period);
    if (outcome.kind === 'NOT_READY') {
      throw conflict(
        'ITC_STATEMENT_NOT_READY',
        `The government has not published ${formatTaxPeriod(input.period)} yet. ${outcome.detail} It usually appears after the 14th of the following month.`,
      );
    }
    if (outcome.kind === 'UNAVAILABLE') {
      throw conflict(
        'ITC_PORTAL_UNAVAILABLE',
        `The portal did not answer, so we do not know what it holds for ${formatTaxPeriod(input.period)}. ${outcome.detail} Nothing has been changed. ${outcome.retryable ? 'Try again in a few minutes, or download the file and import it.' : 'Download the file from the portal and import it instead.'}`,
      );
    }
    return this.importFile(actor, {
      period: input.period,
      content: outcome.content,
      fileName: `${this.#portal.provider}-gstr2b-${input.period}.json`,
      source: 'PORTAL_API',
      expectedGstin: input.gstin,
    });
  }

  // ------------------------------------------------------------------ deciding

  /**
   * Accept, reject or keep pending — one line, one person, one reason.
   *
   * Accepting a line that does not agree with the portal is a different act from accepting one
   * that does, and it is gated differently: it needs its own permission and a reason in words,
   * because it is the act that can cost the business money if the supplier never files.
   */
  async decide(actor: ActorContext, input: DecisionInput): Promise<ItcWorkspace> {
    this.#require(actor, ITC_PERMISSIONS.decide);
    const existing = await this.#decisions.findByIdempotencyKey(actor.companyId, input.idempotencyKey);
    if (existing !== null) return this.workspace(actor, input.period);

    const before = await this.workspace(actor, input.period);
    const line = before.lines.find((candidate) => candidate.key === input.lineKey);
    if (line === undefined) {
      throw notFound('ITC_LINE_NOT_FOUND', 'That bill is not in this month\'s comparison any more. Open the month again and look for it.');
    }
    if (line.status === 'DUPLICATE_IN_BOOKS' || line.status === 'DUPLICATE_ON_PORTAL') {
      throw invalid(
        'ITC_DUPLICATE_CANNOT_BE_ACCEPTED',
        'This bill is recorded twice, so credit cannot be taken on this copy whatever is decided. Reverse the copy that was entered by mistake first.',
      );
    }

    // Would accepting this produce a claim the portal does not fully support? Then it is the
    // at-risk act, and it needs the at-risk permission and a reason. Working it out from the line
    // rather than from a flag the caller sends means the screen cannot talk its way past it.
    const wouldBeAtRisk = input.kind === 'ACCEPT' && line.status !== 'EXACT';
    const portalObjects = line.portal !== null && (line.portal.itcAvailableOnPortal === false || line.portal.reversed || line.portal.amends !== null);
    if (input.kind === 'ACCEPT' && (wouldBeAtRisk || portalObjects)) {
      this.#require(actor, ITC_PERMISSIONS.claimAtRisk);
      if (input.reason.trim() === '') {
        throw invalid(
          'ITC_REASON_REQUIRED',
          'Say why this credit is being claimed even though the government record does not agree. It goes on the record with your name.',
        );
      }
    }
    if (input.kind === 'REJECT' && input.reason.trim() === '') {
      throw invalid('ITC_REASON_REQUIRED', 'Say why this bill is being rejected, so the supplier can be told something specific.');
    }

    const decision: ItcDecision = {
      id: this.#newId(),
      companyId: actor.companyId,
      period: input.period,
      lineKey: input.lineKey,
      kind: input.kind,
      reason: input.reason.trim(),
      decidedBy: actor.userId,
      decidedAt: this.#clock.now().toISOString(),
      fingerprint: line.fingerprint,
      idempotencyKey: input.idempotencyKey,
    };
    await this.#decisions.insert(decision);

    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at: decision.decidedAt,
      action: 'itc.decision',
      subjectType: 'itc_line',
      subjectId: `${input.period}:${input.lineKey}`,
      summary: `${input.kind === 'ACCEPT' ? 'Accepted' : input.kind === 'REJECT' ? 'Rejected' : 'Kept pending'} ${line.book?.number ?? line.portal?.number ?? input.lineKey} for ${formatTaxPeriod(input.period)}.`,
      details: {
        kind: input.kind,
        status: line.status,
        fingerprint: line.fingerprint,
        claimedTax: totalTaxOf(line.claimable).minor.toString(),
        ...(decision.reason === '' ? {} : { reason: decision.reason }),
      },
    });

    return this.workspace(actor, input.period);
  }

  // ------------------------------------------------------------------ what the return reads

  /**
   * The credit side of GSTR-3B for a period.
   *
   * This is the only door between the reconciliation and a filed return, which is the point: there
   * is no second path by which an unreconciled purchase can reach the credit boxes.
   */
  async linkage(actor: ActorContext, period: TaxPeriod): Promise<Gstr3bLinkage> {
    return (await this.workspace(actor, period)).returnLinkage;
  }

  /**
   * #19's optional signal about one bill.
   *
   * Answers `null` when we hold nothing for that supplier and bill, and the supplier-risk module
   * then says plainly that GSTR-2B was not checked. Answering "not present" when the truth is "we
   * never looked" would turn silence into an accusation, which is exactly what that module's
   * wording rules exist to prevent.
   */
  async signalFor(
    companyId: CompanyId,
    input: { readonly supplierGstin: string; readonly invoiceNumber: string; readonly invoiceDate: IsoDate },
  ): Promise<{
    readonly period: string;
    readonly present: boolean;
    readonly theirTaxableValue?: string;
    readonly ourTaxableValue?: string;
    readonly observedAt: string;
  } | null> {
    const document = await this.#records.findByDocument(companyId, {
      supplierGstin: input.supplierGstin,
      invoiceNumber: input.invoiceNumber,
    });
    const period = input.invoiceDate.slice(0, 7) as TaxPeriod;
    const batch = await this.#batches.latestFor(companyId, period);
    if (document === null) {
      // Nothing for this bill. Only say "not present" when we actually hold the month's statement.
      if (batch === null) return null;
      return { period, present: false, observedAt: batch.importedAt };
    }
    const books = await this.#books.documentsFor(companyId, document.period);
    const ours = books.find(
      (book) => book.number.trim().toUpperCase() === input.invoiceNumber.trim().toUpperCase()
        && (book.supplierGstin ?? '').toUpperCase() === input.supplierGstin.toUpperCase(),
    );
    return {
      period: document.period,
      present: true,
      theirTaxableValue: document.amounts.taxableValue.minor.toString(),
      ...(ours === undefined ? {} : { ourTaxableValue: ours.amounts.taxableValue.minor.toString() }),
      observedAt: document.observedAt,
    };
  }

  // ------------------------------------------------------------------ internals

  async #storeBatch(
    actor: ActorContext,
    input: {
      readonly period: TaxPeriod;
      readonly source: RecordSource;
      readonly fileName: string | null;
      readonly checksum: string;
      readonly records: readonly ParsedPortalRecord[];
      readonly rejected: readonly { readonly row: string; readonly reason: string }[];
    },
  ): Promise<ImportBatch> {
    const at = this.#clock.now().toISOString();
    const batchId = this.#newId();
    const documents: PortalDocument[] = input.records.map((record, index) => ({
      id: `${batchId}:${index}`,
      companyId: actor.companyId,
      period: input.period,
      supplierGstin: record.supplierGstin,
      supplierName: record.supplierName,
      kind: record.kind,
      number: record.number,
      documentDate: record.documentDate,
      amounts: record.amounts,
      invoiceValue: record.invoiceValue,
      itcAvailableOnPortal: record.itcAvailableOnPortal,
      itcUnavailableReason: record.itcUnavailableReason,
      amends: record.amends,
      reversed: record.reversed,
      reverseCharge: record.reverseCharge,
      source: input.source,
      batchId,
      observedAt: at,
    }));

    const counts = await this.#records.put(actor.companyId, input.period, documents);
    const batch: ImportBatch = {
      id: batchId,
      companyId: actor.companyId,
      period: input.period,
      source: input.source,
      fileName: input.fileName,
      checksum: input.checksum,
      importedBy: actor.userId,
      importedAt: at,
      documentCount: documents.length,
      addedCount: counts.added,
      replacedCount: counts.replaced,
      unchangedCount: counts.unchanged,
      rejected: input.rejected,
      sentence: {
        'en-IN': `${documents.length} ${documents.length === 1 ? 'purchase' : 'purchases'} for ${formatTaxPeriod(input.period)} ${RECORD_SOURCE_PLAIN[input.source]['en-IN']}: ${counts.added} new, ${counts.replaced} updated${input.rejected.length === 0 ? '' : `, ${input.rejected.length} could not be read`}.`,
        'hi-IN': `${formatTaxPeriod(input.period)} ki ${documents.length} kharid ${RECORD_SOURCE_PLAIN[input.source]['hi-IN']}: ${counts.added} nayi, ${counts.replaced} badli${input.rejected.length === 0 ? '' : `, ${input.rejected.length} padhi nahin ja saki`}.`,
      },
    };
    await this.#batches.insert(batch);

    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at,
      action: 'itc.portal_records_imported',
      subjectType: 'itc_period',
      subjectId: input.period,
      summary: batch.sentence['en-IN'],
      details: {
        source: input.source,
        checksum: input.checksum,
        documents: String(documents.length),
        added: String(counts.added),
        replaced: String(counts.replaced),
        rejected: String(input.rejected.length),
        ...(input.fileName === null ? {} : { fileName: input.fileName }),
      },
    });

    return batch;
  }

  #assemble(
    period: TaxPeriod,
    lines: readonly ReconciliationLine[],
    books: readonly BookPurchaseDocument[],
    portal: readonly PortalDocument[],
    lastImport: ImportBatch | null,
  ): ItcWorkspace {
    const counts: Record<MatchStatus, number> = {
      EXACT: 0, CLOSE: 0, ONLY_IN_BOOKS: 0, ONLY_ON_PORTAL: 0, DUPLICATE_IN_BOOKS: 0, DUPLICATE_ON_PORTAL: 0,
    };
    const outcomeCounts: Record<ItcOutcome, number> = { CLAIM_NOW: 0, CLAIM_AT_RISK: 0, HELD_BACK: 0, BLOCKED_IN_BOOKS: 0 };
    for (const line of lines) {
      counts[line.status] += 1;
      outcomeCounts[line.outcome] += 1;
    }

    const linkage = linkageFor(period, lines, books);
    // The headline figure is the *net* credit: a credit note the supplier reported lowers what can
    // be claimed, so adding it to the claim would overstate the month by twice its tax.
    const claimable = subtractAmounts(
      sumAmounts([linkage.allOtherItc, linkage.reverseChargeItc, linkage.importItc]),
      linkage.reversedItc,
    );
    const heldBack = sumAmounts(lines.map((line) => line.heldBack));
    const atRisk = sumAmounts(lines.filter((line) => line.outcome === 'CLAIM_AT_RISK').map((line) => line.claimable));

    const findings: ItcFinding[] = [];
    if (portal.length === 0) {
      findings.push({
        code: 'ITC_NO_PORTAL_DATA',
        severity: 'BLOCKING',
        lineKey: null,
        message: {
          'en-IN': `Nothing has been brought in from the government's record for ${formatTaxPeriod(period)}, so none of these purchases has been checked against what your suppliers filed.`,
          'hi-IN': `${formatTaxPeriod(period)} ke liye sarkari record se kuch nahin liya gaya, isliye in kharidon ko supplier ki filing se milaya nahin gaya hai.`,
        },
        whatToDo: {
          'en-IN': 'Download the GSTR-2B file for this month from the portal and import it here. If you cannot download it, type the rows in from the portal screen — either way works.',
          'hi-IN': 'Portal se is mahine ki GSTR-2B file lekar yahan import kijiye. Download na ho paye to portal dekh kar rows haath se likh dijiye — dono chalta hai.',
        },
      });
    }
    for (const line of lines) findings.push(...line.findings);

    const withoutGstin = books.filter((book) => book.supplierGstin === null);
    if (withoutGstin.length > 0) {
      findings.push({
        code: 'ITC_SUPPLIER_GSTIN_MISSING',
        severity: 'WARNING',
        lineKey: null,
        message: {
          'en-IN': `${withoutGstin.length} ${withoutGstin.length === 1 ? 'bill has' : 'bills have'} no GST number for the supplier, so ${withoutGstin.length === 1 ? 'it cannot' : 'they cannot'} be compared with the government's record at all.`,
          'hi-IN': `${withoutGstin.length} bill par supplier ka GST number nahin hai, isliye unhen sarkari record se milaya hi nahin ja sakta.`,
        },
        whatToDo: {
          'en-IN': 'Add the supplier\'s GST number to the supplier record and open this month again. Until then no credit is being taken on those bills.',
          'hi-IN': 'Supplier ke record mein unka GST number daal kar yeh mahina dobara kholiye. Tab tak un bills par credit nahin liya ja raha.',
        },
      });
    }

    const claimedTax = totalTaxOf(claimable);
    const heldTax = totalTaxOf(heldBack);

    return {
      period,
      periodLabel: formatTaxPeriod(period),
      portalDataPresent: portal.length > 0,
      lastImport,
      lines,
      counts,
      outcomeCounts,
      claimable,
      heldBack,
      atRisk,
      findings,
      sentence: {
        'en-IN': `${formatTaxPeriod(period)}: ${formatINR(claimedTax)} of GST on your purchases is safe to claim this month, and ${formatINR(heldTax)} is being held back${heldTax.minor === 0n ? '' : ` on ${outcomeCounts.HELD_BACK} ${outcomeCounts.HELD_BACK === 1 ? 'bill that still needs' : 'bills that still need'} an answer`}.`,
        'hi-IN': `${formatTaxPeriod(period)}: aapki kharid par ${formatINR(claimedTax)} GST is mahine lena theek hai, aur ${formatINR(heldTax)} roka gaya hai${heldTax.minor === 0n ? '' : `, ${outcomeCounts.HELD_BACK} bill par abhi jawab chahiye`}.`,
      },
      returnLinkage: linkage,
    };
  }

  async #policyFor(companyId: CompanyId, period: TaxPeriod): Promise<ItcMatchPolicy> {
    if (this.#policy === undefined) return DEFAULT_MATCH_POLICY;
    return this.#policy.policyFor(companyId, taxPeriodRange(period).to);
  }

  #require(actor: ActorContext, permission: string): void {
    if (!actor.permissions.includes(permission)) {
      throw forbidden(
        'ITC_FORBIDDEN',
        permission === ITC_PERMISSIONS.claimAtRisk
          ? 'You cannot claim credit the government record does not carry. Ask the owner or whoever handles your GST to do it.'
          : `You do not have permission to ${permission === ITC_PERMISSIONS.view ? 'see' : permission === ITC_PERMISSIONS.import ? 'import records for' : 'decide'} the purchase comparison.`,
      );
    }
  }
}

/** The fingerprint of a whole month, for a caller that wants to know whether anything moved. */
export const workspaceFingerprint = (workspace: ItcWorkspace): string => {
  const hash = createHash('sha256');
  for (const line of workspace.lines) hash.update(`${line.key}:${line.fingerprint}:${line.outcome}`).update('\n');
  return hash.digest('hex');
};

/** An empty month, for a caller that needs the shape before anything has been imported. */
export const emptyLinkage = (period: TaxPeriod): Gstr3bLinkage => ({
  period,
  allOtherItc: emptyAmounts(),
  reverseChargeItc: emptyAmounts(),
  importItc: emptyAmounts(),
  reversedItc: emptyAmounts(),
  reverseChargeLiability: emptyAmounts(),
  exemptInwardValue: { currency: 'INR', minor: 0n },
  contributions: [],
  caution: {
    'en-IN': 'No purchases have been reconciled for this month yet.',
    'hi-IN': 'Is mahine ki koi kharid abhi milayi nahin gayi hai.',
  },
});

export type { TaxAmounts, Bilingual };

/**
 * Issue #30 [E30] — the workspace itself.
 *
 * Everything up to this point is pure: hand it documents, get back tables. This file is where the
 * return acquires a life — a snapshot taken at a moment, an approval by a named person, an export,
 * a submission that may or may not have gone through — and where the two hard promises of the
 * issue are actually kept.
 *
 * **Every return number traces to source vouchers.** The snapshot keeps the documents themselves,
 * not just the totals, so an approved return can be rebuilt exactly as it was approved, years
 * later, from a row in one table. `sourcesOf` walks any figure back to the bills behind it.
 *
 * **Locked or approved periods cannot change silently.** At approval the snapshot's fingerprint is
 * recorded. Every later read re-reads the books, re-fingerprints them, and if they differ it says
 * so — loudly, on the return, naming what changed. It does not refresh the figures underneath the
 * approval, and it does not throw them away either. Both would be a lie of a different kind.
 *
 * The workspace never files anything on its own. Preparing is free, checking is free, and the two
 * steps that leave the building — export and submit — each need their own permission and their own
 * deliberate act by a person who has seen the numbers.
 */
import { createHash } from 'node:crypto';
import { conflict, forbidden, invalid, notFound, type Clock, type CompanyId } from '@invoice/kernel';
import type { ActorContext, AuditPort } from '@invoice/ledger';
import { buildGstr1, sourcesOfSection, type Gstr1BuildResult } from './gstr1.ts';
import { buildGstr3b } from './gstr3b.ts';
import { reconcile, type Reconciliation } from './reconcile.ts';
import { toGstr1Json, toGstr3bJson, exportFileName } from './json-export.ts';
import { blockingOf, countBySeverity, validateDocuments } from './validate.ts';
import { B2clThresholdTable } from './thresholds.ts';
import {
  DEFAULT_RETURN_POLICY,
  type BookTaxPort,
  type GovernmentReturnPort,
  type InwardTaxPort,
  type OutwardSupplyPort,
  type PeriodLockPort,
  type ReturnPolicy,
  type ReturnPolicyPort,
  type ReturnPreparationRepository,
} from './ports.ts';
import {
  GST_RETURN_PERMISSIONS,
  RETURN_STATE_PLAIN,
  formatTaxPeriod,
  taxPeriodRange,
  type Bilingual,
  type BookSnapshot,
  type Gstr1Return,
  type Gstr3bReturn,
  type OutwardDocument,
  type ReturnFinding,
  type ReturnPreparation,
  type ReturnState,
  type SourceRef,
  type TaxPeriod,
} from './types.ts';

export interface GstReturnServiceDeps {
  readonly outward: OutwardSupplyPort;
  readonly inward: InwardTaxPort;
  readonly books: BookTaxPort;
  readonly repository: ReturnPreparationRepository;
  readonly audit: AuditPort;
  readonly clock: Clock;
  /** Absent for a business with no licensed intermediary. Everything but `submit` still works. */
  readonly government?: GovernmentReturnPort;
  readonly periods?: PeriodLockPort;
  readonly policy?: ReturnPolicyPort;
  readonly thresholds?: B2clThresholdTable;
  readonly idFactory?: () => string;
}

export interface WorkspaceInput {
  readonly period: TaxPeriod;
  readonly gstin: string;
  readonly supplierStateCode: string;
}

/**
 * Everything a preparer sees on one screen: the two returns, what is wrong, and what changed.
 *
 * Deliberately one object rather than five calls. A screen assembled from five reads of a moving
 * ledger can show a GSTR-1 built from one set of bills beside a 3B built from another, and that is
 * the exact failure this design exists to prevent.
 */
export interface ReturnWorkspace {
  readonly period: TaxPeriod;
  readonly periodLabel: string;
  readonly gstin: string;
  readonly state: ReturnState;
  readonly stateLabel: Bilingual;
  readonly gstr1: Gstr1Return;
  readonly gstr3b: Gstr3bReturn;
  readonly reconciliation: Reconciliation;
  /** Documents that could not be placed on the return, with the question that would place them. */
  readonly exceptions: readonly { readonly document: OutwardDocument; readonly findings: readonly ReturnFinding[] }[];
  readonly findings: readonly ReturnFinding[];
  readonly counts: Readonly<Record<ReturnFinding['severity'], number>>;
  readonly mayApprove: boolean;
  readonly whyNotApprovable: readonly Bilingual[];
  readonly snapshot: BookSnapshot;
  /** Set once a return has been approved and the books have moved since. */
  readonly drift: DriftReport | null;
  readonly preparation: ReturnPreparation | null;
  readonly sentence: Bilingual;
  /** Why each document landed in the table it did, for the "why is this here" panel. */
  readonly reasons: Gstr1BuildResult['reasons'];
}

/** The books moved after somebody approved the return. What changed, and by how much. */
export interface DriftReport {
  readonly approvedAt: string;
  readonly approvedFingerprint: string;
  readonly currentFingerprint: string;
  readonly documentsAdded: readonly SourceRef[];
  readonly documentsRemoved: readonly SourceRef[];
  readonly documentsChanged: readonly SourceRef[];
  readonly message: Bilingual;
}

export class GstReturnService {
  readonly #outward: OutwardSupplyPort;
  readonly #inward: InwardTaxPort;
  readonly #books: BookTaxPort;
  readonly #repository: ReturnPreparationRepository;
  readonly #audit: AuditPort;
  readonly #clock: Clock;
  readonly #government: GovernmentReturnPort | undefined;
  readonly #periods: PeriodLockPort | undefined;
  readonly #policy: ReturnPolicyPort | undefined;
  readonly #thresholds: B2clThresholdTable;
  readonly #newId: () => string;

  constructor(deps: GstReturnServiceDeps) {
    this.#outward = deps.outward;
    this.#inward = deps.inward;
    this.#books = deps.books;
    this.#repository = deps.repository;
    this.#audit = deps.audit;
    this.#clock = deps.clock;
    this.#government = deps.government;
    this.#periods = deps.periods;
    this.#policy = deps.policy;
    this.#thresholds = deps.thresholds ?? new B2clThresholdTable();
    this.#newId = deps.idFactory ?? (() => crypto.randomUUID());
  }

  // ------------------------------------------------------------------ reading

  /**
   * The whole workspace for one period, computed and written nowhere.
   *
   * Available before anything is prepared, because a shopkeeper should be able to look at what
   * their return would say without committing to anything at all.
   */
  async workspace(actor: ActorContext, input: WorkspaceInput): Promise<ReturnWorkspace> {
    this.#require(actor, GST_RETURN_PERMISSIONS.view);
    const stored = await this.#repository.find(actor.companyId, input.period, 'GSTR1');
    const policy = await this.#policyFor(actor.companyId, input.period);

    // An approved return is shown as it was approved. The live books are still read, but only to
    // work out whether they have moved — never to quietly restate an approved figure.
    const live = await this.#takeSnapshot(actor, input.period);
    const basis = stored !== null && stored.approval !== null ? stored.snapshot : live;
    const drift = stored !== null && stored.approval !== null
      ? this.#driftBetween(stored.snapshot, live, stored.approval.approvedAt, stored.approval.fingerprint)
      : null;

    return this.#assemble(actor, input, basis, stored, policy, drift);
  }

  /** Every period this company has prepared, newest first, for the list screen. */
  async list(actor: ActorContext): Promise<readonly ReturnPreparation[]> {
    this.#require(actor, GST_RETURN_PERMISSIONS.view);
    const all = await this.#repository.list(actor.companyId);
    return [...all].sort((a, b) => b.period.localeCompare(a.period) || a.returnType.localeCompare(b.returnType));
  }

  /** Every document behind one figure on the return. The drill-down the first criterion demands. */
  sourcesOf(workspace: ReturnWorkspace, sectionId: string): readonly SourceRef[] {
    const section = workspace.gstr1.sections.find((entry) => entry.id === sectionId);
    if (section === undefined) return [];
    return sourcesOfSection(section);
  }

  // ------------------------------------------------------------------ preparing

  /**
   * Takes the snapshot and stores it.
   *
   * Running it twice with the same idempotency key returns the first preparation rather than
   * taking a second photograph, so a double-click cannot produce two accounts of one month.
   */
  async prepare(
    actor: ActorContext,
    input: WorkspaceInput & { readonly idempotencyKey: string },
  ): Promise<ReturnWorkspace> {
    this.#require(actor, GST_RETURN_PERMISSIONS.prepare);
    const existingByKey = await this.#repository.findByIdempotencyKey(actor.companyId, input.idempotencyKey);
    if (existingByKey !== null) return this.workspace(actor, input);

    const existing = await this.#repository.find(actor.companyId, input.period, 'GSTR1');
    if (existing !== null && existing.approval !== null) {
      throw conflict(
        'GST_RETURN_ALREADY_APPROVED',
        `${formatTaxPeriod(input.period)} has already been approved. Reopen it first if the figures have to change, and say why.`,
      );
    }

    const snapshot = await this.#takeSnapshot(actor, input.period);
    const policy = await this.#policyFor(actor.companyId, input.period);
    const assembled = await this.#assemble(actor, input, snapshot, existing, policy, null);

    const preparation: ReturnPreparation = {
      id: existing?.id ?? this.#newId(),
      companyId: actor.companyId,
      gstin: input.gstin,
      period: input.period,
      returnType: 'GSTR1',
      state: assembled.mayApprove ? 'DRAFT' : 'NEEDS_ATTENTION',
      snapshot,
      findings: assembled.findings,
      approval: null,
      exportedAt: null,
      submission: null,
      createdBy: existing?.createdBy ?? actor.userId,
      createdAt: existing?.createdAt ?? this.#clock.now().toISOString(),
      idempotencyKey: input.idempotencyKey,
      version: (existing?.version ?? 0) + 1,
    };

    if (existing === null) await this.#repository.insert(preparation);
    else await this.#repository.update(preparation, existing.version);

    await this.#record(actor, preparation, 'gst_return.prepared',
      `Prepared ${formatTaxPeriod(input.period)} from ${snapshot.documentCount} documents.`, {
        documents: String(snapshot.documentCount),
        fingerprint: snapshot.fingerprint,
        blocking: String(assembled.counts.BLOCKING),
      });

    return { ...assembled, preparation, state: preparation.state, stateLabel: RETURN_STATE_PLAIN[preparation.state] };
  }

  /**
   * Signs the return off.
   *
   * From here the figures are the ones a named person accepted, and the workspace stops updating
   * them behind that person's back. Blocking findings refuse the approval outright: the point of a
   * blocking finding is that nobody knows what the right number is yet, and approving one would be
   * approving a question.
   */
  async approve(
    actor: ActorContext,
    input: WorkspaceInput & { readonly note?: string },
  ): Promise<ReturnWorkspace> {
    this.#require(actor, GST_RETURN_PERMISSIONS.approve);
    const stored = await this.#mustFind(actor.companyId, input.period);
    if (stored.approval !== null) {
      throw conflict('GST_RETURN_ALREADY_APPROVED', `${formatTaxPeriod(input.period)} was already approved on ${stored.approval.approvedAt}.`);
    }

    const policy = await this.#policyFor(actor.companyId, input.period);
    const snapshot = await this.#takeSnapshot(actor, input.period);
    const assembled = await this.#assemble(actor, input, snapshot, stored, policy, null);

    if (!assembled.mayApprove) {
      throw invalid(
        'GST_RETURN_NOT_APPROVABLE',
        `${formatTaxPeriod(input.period)} cannot be approved yet: ${assembled.whyNotApprovable.map((reason) => reason['en-IN']).join(' ')}`,
      );
    }

    const at = this.#clock.now().toISOString();
    const approved: ReturnPreparation = {
      ...stored,
      snapshot,
      findings: assembled.findings,
      state: 'APPROVED',
      approval: {
        approvedBy: actor.userId,
        approvedAt: at,
        fingerprint: snapshot.fingerprint,
        note: input.note ?? null,
      },
      version: stored.version + 1,
    };
    await this.#repository.update(approved, stored.version);

    await this.#record(actor, approved, 'gst_return.approved',
      `Approved ${formatTaxPeriod(input.period)}: ${snapshot.documentCount} documents, fingerprint ${snapshot.fingerprint.slice(0, 12)}.`, {
        fingerprint: snapshot.fingerprint,
        documents: String(snapshot.documentCount),
        ...(input.note === undefined ? {} : { note: input.note }),
      });

    return { ...assembled, preparation: approved, state: 'APPROVED', stateLabel: RETURN_STATE_PLAIN.APPROVED };
  }

  /**
   * Takes an approval back, with a reason, so figures can be corrected.
   *
   * Reopening is a real and ordinary thing — a bill turns up late, a rate was wrong — and pretending
   * otherwise only teaches people to work around the product. What is not allowed is reopening
   * something already filed: that is an amendment on a later return, not an edit to this one.
   */
  async reopen(actor: ActorContext, period: TaxPeriod, reason: string): Promise<ReturnPreparation> {
    this.#require(actor, GST_RETURN_PERMISSIONS.reopen);
    if (reason.trim() === '') {
      throw invalid('GST_RETURN_REOPEN_NEEDS_REASON', 'Say why the approved return is being reopened. It goes in the audit trail.');
    }
    const stored = await this.#mustFind(actor.companyId, period);
    if (stored.state === 'FILED') {
      throw conflict(
        'GST_RETURN_ALREADY_FILED',
        `${formatTaxPeriod(period)} has been filed with the government. A filed return is corrected by an amendment on a later month's return, not by changing this one.`,
      );
    }
    if (stored.approval === null) {
      throw conflict('GST_RETURN_NOT_APPROVED', `${formatTaxPeriod(period)} has not been approved, so there is nothing to reopen.`);
    }

    const reopened: ReturnPreparation = {
      ...stored,
      state: 'DRAFT',
      approval: null,
      exportedAt: null,
      version: stored.version + 1,
    };
    await this.#repository.update(reopened, stored.version);
    await this.#record(actor, reopened, 'gst_return.reopened', `Reopened ${formatTaxPeriod(period)}.`, { reason });
    return reopened;
  }

  // ------------------------------------------------------------------ leaving the building

  /**
   * Writes the file a person uploads to the portal themselves.
   *
   * This is the path that must work for a business with no licensed intermediary, so it depends on
   * nothing but the approved snapshot. It is gated behind approval because a JSON file on a
   * desktop is indistinguishable from a filed one the moment it leaves here.
   */
  async exportFile(
    actor: ActorContext,
    input: WorkspaceInput & { readonly returnType: 'GSTR1' | 'GSTR3B' },
  ): Promise<{ readonly fileName: string; readonly payload: Record<string, unknown>; readonly sentence: Bilingual }> {
    this.#require(actor, GST_RETURN_PERMISSIONS.export);
    const stored = await this.#mustFind(actor.companyId, input.period);
    if (stored.approval === null) {
      throw conflict(
        'GST_RETURN_NOT_APPROVED',
        `${formatTaxPeriod(input.period)} has not been approved yet. Check the figures and approve them before downloading a file to upload.`,
      );
    }

    const built = this.#buildFrom(stored.snapshot, input);
    const payload = input.returnType === 'GSTR1' ? toGstr1Json(built.gstr1) : toGstr3bJson(built.gstr3b);
    const fileName = exportFileName(input.returnType, input.gstin, input.period);

    if (stored.exportedAt === null) {
      const exported: ReturnPreparation = {
        ...stored,
        state: stored.state === 'APPROVED' ? 'EXPORTED' : stored.state,
        exportedAt: this.#clock.now().toISOString(),
        version: stored.version + 1,
      };
      await this.#repository.update(exported, stored.version);
    }

    await this.#record(actor, stored, 'gst_return.exported',
      `Downloaded the ${input.returnType} file for ${formatTaxPeriod(input.period)}.`, {
        returnType: input.returnType, fileName, fingerprint: stored.approval.fingerprint,
      });

    return {
      fileName,
      payload,
      sentence: {
        'en-IN': `Save ${fileName} and upload it on the government portal under ${input.returnType === 'GSTR1' ? 'GSTR-1' : 'GSTR-3B'} for ${formatTaxPeriod(input.period)}. Nothing has been sent from here.`,
        'hi-IN': `${fileName} save karke government portal par ${formatTaxPeriod(input.period)} ke ${input.returnType === 'GSTR1' ? 'GSTR-1' : 'GSTR-3B'} me upload kijiye. Yahan se kuch bheja nahi gaya hai.`,
      },
    };
  }

  /**
   * Sends the return through a licensed intermediary, when there is one.
   *
   * Three states come back and all three are recorded as themselves. `UNKNOWN` is not a failure:
   * the filing may well have gone through, and telling a shopkeeper it failed would have them file
   * a second time. The idempotency key is derived from the approved fingerprint, so a retry after a
   * timeout reaches the portal as the same filing rather than a duplicate one.
   */
  async submit(actor: ActorContext, input: WorkspaceInput & { readonly returnType: 'GSTR1' | 'GSTR3B' }): Promise<ReturnPreparation> {
    this.#require(actor, GST_RETURN_PERMISSIONS.submit);
    if (this.#government === undefined) {
      throw invalid(
        'GST_RETURN_NO_CHANNEL',
        'This business has no connection to a licensed GST intermediary, so nothing can be sent from here. Download the file and upload it on the portal instead — it files exactly the same return.',
      );
    }
    const stored = await this.#mustFind(actor.companyId, input.period);
    if (stored.approval === null) {
      throw conflict('GST_RETURN_NOT_APPROVED', `${formatTaxPeriod(input.period)} has not been approved, so it cannot be sent.`);
    }
    if (stored.state === 'FILED') return stored;

    const built = this.#buildFrom(stored.snapshot, input);
    const payload = input.returnType === 'GSTR1' ? toGstr1Json(built.gstr1) : toGstr3bJson(built.gstr3b);

    const sending: ReturnPreparation = { ...stored, state: 'SUBMITTING', version: stored.version + 1 };
    await this.#repository.update(sending, stored.version);

    const outcome = await this.#government.submit({
      companyId: actor.companyId,
      gstin: input.gstin,
      period: input.period,
      returnType: input.returnType,
      payload,
      // Derived from what is being filed, not from the attempt, so two attempts at the same
      // approved figures are one filing.
      idempotencyKey: `gstr:${input.returnType}:${input.gstin}:${input.period}:${stored.approval.fingerprint}`,
    });

    const at = this.#clock.now().toISOString();
    const settled: ReturnPreparation = {
      ...sending,
      state: outcome.kind === 'ACCEPTED' ? 'FILED' : outcome.kind === 'REJECTED' ? 'SUBMISSION_FAILED' : 'SUBMITTING',
      submission:
        outcome.kind === 'ACCEPTED'
          ? { reference: outcome.reference, attemptedAt: at, outcome: 'ACCEPTED', message: `Filed. The government's reference is ${outcome.reference}.`, errors: [] }
          : outcome.kind === 'REJECTED'
            ? { reference: null, attemptedAt: at, outcome: 'REJECTED', message: 'The government refused this return. Nothing was filed.', errors: outcome.errors }
            : { reference: null, attemptedAt: at, outcome: 'UNKNOWN', message: `We do not know whether this was filed: ${outcome.detail}. Check the portal before sending it again.`, errors: [] },
      version: sending.version + 1,
    };
    await this.#repository.update(settled, sending.version);

    await this.#record(actor, settled, 'gst_return.submitted',
      settled.submission?.message ?? 'Submission attempted.', {
        returnType: input.returnType,
        outcome: outcome.kind,
        provider: this.#government.provider,
      });

    if (outcome.kind === 'ACCEPTED' && this.#periods?.softLock !== undefined) {
      await this.#periods.softLock(actor.companyId, input.period, `GST return filed on ${at}`);
    }

    return settled;
  }

  // ------------------------------------------------------------------ internals

  /**
   * Reads the books once and fingerprints what it read.
   *
   * The fingerprint covers every fact that could change a figure on the return — the number, the
   * date, the treatment, the party, the place of supply and every amount on every line. It does
   * not cover the order the documents came back in, because the order is the database's business
   * and not the return's.
   */
  async #takeSnapshot(actor: ActorContext, period: TaxPeriod): Promise<BookSnapshot> {
    const documents = await this.#outward.documentsFor(actor.companyId, period);
    const inward = await this.#inward.summaryFor(actor.companyId, period);
    const sorted = [...documents].sort((a, b) => a.sourceKind.localeCompare(b.sourceKind) || a.sourceId.localeCompare(b.sourceId));
    return {
      period,
      takenAt: this.#clock.now().toISOString(),
      takenBy: actor.userId,
      documentCount: sorted.length,
      fingerprint: fingerprintOf(sorted, inward),
      documents: sorted,
      inward,
    };
  }

  #buildFrom(snapshot: BookSnapshot, input: WorkspaceInput): { gstr1: Gstr1Return; gstr3b: Gstr3bReturn; build: Gstr1BuildResult } {
    const build = buildGstr1(
      { period: snapshot.period, gstin: input.gstin, documents: snapshot.documents },
      { thresholds: this.#thresholds, mode: 'development' },
    );
    const gstr3b = buildGstr3b({
      period: snapshot.period,
      gstin: input.gstin,
      supplierStateCode: input.supplierStateCode,
      // The 3B is built from the documents that reached GSTR-1, not from all of them, so the two
      // returns can never disagree about what happened in the month.
      documents: snapshot.documents.filter((document) => !build.unresolved.some((entry) => entry.document.sourceId === document.sourceId)),
      inward: snapshot.inward,
    });
    return { gstr1: build.return, gstr3b, build };
  }

  async #assemble(
    actor: ActorContext,
    input: WorkspaceInput,
    snapshot: BookSnapshot,
    stored: ReturnPreparation | null,
    policy: ReturnPolicy,
    drift: DriftReport | null,
  ): Promise<ReturnWorkspace> {
    const build = buildGstr1(
      { period: snapshot.period, gstin: input.gstin, documents: snapshot.documents },
      { thresholds: this.#thresholds, mode: policy.mode },
    );
    const placed = snapshot.documents.filter(
      (document) => !build.unresolved.some((entry) => entry.document.sourceId === document.sourceId),
    );
    const gstr3b = buildGstr3b({
      period: snapshot.period,
      gstin: input.gstin,
      supplierStateCode: input.supplierStateCode,
      documents: placed,
      inward: snapshot.inward,
    });

    const bookTotals = await this.#books.totalsFor(actor.companyId, snapshot.period);
    const reconciliation = reconcile({
      period: snapshot.period,
      returnTotals: build.return.totals,
      books: bookTotals,
      returnSources: placed.map(refOf),
      unresolvedSources: build.unresolved.map((entry) => refOf(entry.document)),
    });

    const validation = validateDocuments({
      period: snapshot.period,
      supplierGstin: input.gstin,
      supplierStateCode: input.supplierStateCode,
      documents: snapshot.documents,
    });

    const findings: ReturnFinding[] = [
      ...build.findings,
      ...validation,
      ...(policy.requireBooksToAgree ? reconciliation.findings : reconciliation.findings.map(downgrade)),
      ...(drift === null ? [] : [driftFinding(drift)]),
    ];

    const whyNot: Bilingual[] = [];
    const blocking = blockingOf(findings);
    if (blocking.length > 0) {
      whyNot.push({
        'en-IN': `${blocking.length === 1 ? 'One thing has' : `${blocking.length} things have`} to be decided first.`,
        'hi-IN': `${blocking.length === 1 ? 'Ek cheez' : `${blocking.length} cheezein`} pehle tay karni hain.`,
      });
    }
    if (policy.requireClosedPeriod && this.#periods !== undefined) {
      const state = await this.#periods.stateOf(actor.companyId, taxPeriodRange(snapshot.period).to);
      if (state === 'OPEN') {
        whyNot.push({
          'en-IN': `${formatTaxPeriod(snapshot.period)} is still open in your books, and this business has asked that a month be closed before its return is approved.`,
          'hi-IN': `${formatTaxPeriod(snapshot.period)} abhi books me khula hai, aur is business ne kaha hai ki return approve karne se pehle mahina band ho.`,
        });
      }
    }

    const state: ReturnState = stored?.state ?? (whyNot.length === 0 ? 'DRAFT' : 'NEEDS_ATTENTION');
    const counts = countBySeverity(findings);

    return {
      period: snapshot.period,
      periodLabel: formatTaxPeriod(snapshot.period),
      gstin: input.gstin,
      state,
      stateLabel: RETURN_STATE_PLAIN[state],
      gstr1: build.return,
      gstr3b,
      reconciliation,
      exceptions: build.unresolved,
      findings,
      counts,
      mayApprove: whyNot.length === 0,
      whyNotApprovable: whyNot,
      snapshot,
      drift,
      preparation: stored,
      reasons: build.reasons,
      sentence: {
        'en-IN': `${build.return.sentence['en-IN']}${build.unresolved.length === 0 ? '' : ` ${build.unresolved.length === 1 ? 'One document is' : `${build.unresolved.length} documents are`} waiting on a decision and ${build.unresolved.length === 1 ? 'is' : 'are'} not on the return yet.`}`,
        'hi-IN': `${build.return.sentence['hi-IN']}${build.unresolved.length === 0 ? '' : ` ${build.unresolved.length} document par faisla baaki hai, woh abhi return me nahi hain.`}`,
      },
    };
  }

  /** What moved between the approved photograph and the books as they are now. */
  #driftBetween(approved: BookSnapshot, live: BookSnapshot, approvedAt: string, approvedFingerprint: string): DriftReport | null {
    if (live.fingerprint === approvedFingerprint) return null;

    const key = (document: OutwardDocument): string => `${document.sourceKind}:${document.sourceId}`;
    const approvedById = new Map(approved.documents.map((document) => [key(document), document]));
    const liveById = new Map(live.documents.map((document) => [key(document), document]));

    const added = [...liveById.entries()].filter(([id]) => !approvedById.has(id)).map(([, document]) => refOf(document));
    const removed = [...approvedById.entries()].filter(([id]) => !liveById.has(id)).map(([, document]) => refOf(document));
    const changed = [...liveById.entries()]
      .filter(([id, document]) => {
        const before = approvedById.get(id);
        return before !== undefined && documentFingerprint(before) !== documentFingerprint(document);
      })
      .map(([, document]) => refOf(document));

    const parts: string[] = [];
    if (added.length > 0) parts.push(`${added.length} new`);
    if (removed.length > 0) parts.push(`${removed.length} removed`);
    if (changed.length > 0) parts.push(`${changed.length} changed`);

    return {
      approvedAt,
      approvedFingerprint,
      currentFingerprint: live.fingerprint,
      documentsAdded: added,
      documentsRemoved: removed,
      documentsChanged: changed,
      message: {
        'en-IN': `Your books have moved since this return was approved on ${approvedAt.slice(0, 10)}: ${parts.join(', ')}. The figures below are the ones that were approved; they have not been changed underneath you.`,
        'hi-IN': `Yeh return ${approvedAt.slice(0, 10)} ko approve hone ke baad books badli hain: ${parts.join(', ')}. Neeche wale figure wahi hain jo approve hue the; chupke se badle nahi gaye.`,
      },
    };
  }

  async #policyFor(companyId: CompanyId, period: TaxPeriod): Promise<ReturnPolicy> {
    return this.#policy === undefined ? DEFAULT_RETURN_POLICY : this.#policy.policyFor(companyId, period);
  }

  async #mustFind(companyId: CompanyId, period: TaxPeriod): Promise<ReturnPreparation> {
    const stored = await this.#repository.find(companyId, period, 'GSTR1');
    if (stored === null) {
      throw notFound('GST_RETURN_NOT_PREPARED', `${formatTaxPeriod(period)} has not been prepared yet.`);
    }
    return stored;
  }

  #require(actor: ActorContext, permission: string): void {
    if (!actor.permissions.includes(permission)) {
      throw forbidden('GST_RETURN_FORBIDDEN', `You do not have permission to ${permission.split('.')[1]} GST returns.`);
    }
  }

  async #record(
    actor: ActorContext,
    preparation: ReturnPreparation,
    action: string,
    summary: string,
    details: Readonly<Record<string, string>>,
  ): Promise<void> {
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at: this.#clock.now().toISOString(),
      action,
      subjectType: 'gst_return',
      subjectId: `${preparation.period}:${preparation.returnType}`,
      summary,
      details,
    });
  }
}

const refOf = (document: OutwardDocument): SourceRef => ({
  sourceKind: document.sourceKind,
  sourceId: document.sourceId,
  number: document.number,
  date: document.documentDate,
  voucherId: document.voucherId,
  amount: document.invoiceValue,
});

/**
 * One document reduced to the facts that could change a return figure.
 *
 * Written out field by field rather than by serialising the object, because a snapshot that
 * changes its fingerprint when an unrelated field is added to `OutwardDocument` would cry wolf on
 * every deployment, and a workspace that cries wolf is one nobody reads.
 */
const documentFingerprint = (document: OutwardDocument): string =>
  [
    document.sourceKind,
    document.sourceId,
    document.kind,
    document.number,
    document.documentDate,
    document.treatment,
    document.supplierGstin,
    document.counterpartyGstin ?? '',
    document.placeOfSupplyStateCode ?? '',
    document.reverseCharge ? 'rc' : '',
    document.invoiceValue.minor.toString(),
    document.amends === undefined ? '' : `${document.amends.period}/${document.amends.number}`,
    ...document.lines.map((line) =>
      [
        line.lineId,
        line.hsnOrSac ?? '',
        line.ratePercentTimes100?.toString() ?? '',
        line.amounts.taxableValue.minor,
        line.amounts.cgst.minor,
        line.amounts.sgst.minor,
        line.amounts.igst.minor,
        line.amounts.cess.minor,
      ].join(':'),
    ),
  ].join('|');

const fingerprintOf = (documents: readonly OutwardDocument[], inward: { readonly contributions: readonly SourceRef[] }): string => {
  const hash = createHash('sha256');
  for (const document of documents) hash.update(documentFingerprint(document)).update('\n');
  for (const contribution of inward.contributions) {
    hash.update(`${contribution.sourceKind}:${contribution.sourceId}:${contribution.amount.minor}`).update('\n');
  }
  return hash.digest('hex');
};

/** When the business has said the books need not agree, the mismatch is shown but does not block. */
const downgrade = (finding: ReturnFinding): ReturnFinding =>
  finding.severity === 'BLOCKING' ? { ...finding, severity: 'WARNING' } : finding;

const driftFinding = (drift: DriftReport): ReturnFinding => ({
  code: 'GST_RETURN_BOOKS_MOVED_AFTER_APPROVAL',
  severity: 'WARNING',
  origin: 'SNAPSHOT',
  message: drift.message,
  whatToDo: {
    'en-IN': 'If those changes belong in this month, reopen the return, prepare it again and approve it again. If they belong in a later month, leave this one alone.',
    'hi-IN': 'Agar woh badlav is mahine ke hain to return reopen karke dobara banaiye aur approve kijiye. Agar aage ke mahine ke hain to ise waise hi rehne dijiye.',
  },
});

export { fingerprintOf, documentFingerprint };

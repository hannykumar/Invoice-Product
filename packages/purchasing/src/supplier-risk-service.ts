// Issue #19 [E19] — assessing a supplier, and keeping the answer answerable for.
//
// The service gathers facts from the ports, hands them to the pure `assessSupplierRisk`, and
// records what it showed. It never decides anything itself: the reasoning lives in one pure
// function so the same facts can be replayed months later when a supplier disputes a warning.

import { conflict, forbidden, invalid, notFound, type CompanyId } from "@invoice/kernel";
import type { ActorContext, AuditPort } from "@invoice/ledger";
import type { Clock } from "@invoice/kernel";
import { assessSupplierRisk, type SupplierRiskInput } from "./supplier-risk.ts";
import { DEFAULT_RISK_POLICY } from "./supplier-risk-types.ts";
import type {
  ModelHint, RiskAcknowledgement, RiskPolicy, SupplierRiskAssessment, SupplierRiskCode,
} from "./supplier-risk-types.ts";
import type {
  Gstr2bPort, GstinStatusPort, RiskAcknowledgementRepository, RiskAssessmentRepository,
  RiskPolicyPort, SupplierHistoryPort,
} from "./supplier-risk-ports.ts";
import type { Id, IsoDate } from "../../masters/src/types.ts";

/** Seeing a supplier's government record is its own permission: it is data about someone else. */
export const SUPPLIER_RISK_VIEW_PERMISSION = "supplier.risk.view";
/** Going ahead despite a serious warning is a decision somebody owns. */
export const SUPPLIER_RISK_ACKNOWLEDGE_PERMISSION = "supplier.risk.acknowledge";

export interface AssessSupplierInput {
  readonly supplierPartyId: Id;
  readonly supplierName: string;
  readonly gstin?: string;
  readonly expectedStateCode?: string;
  readonly invoiceNumber?: string;
  readonly invoiceDate?: IsoDate;
  /** The day to assess as of. Defaults to today. */
  readonly on?: IsoDate;
  /** Skip the cache and ask the GST department again. */
  readonly refresh?: boolean;
  /** A model's guess, if the caller has one. Shown as a guess; never changes the level. */
  readonly modelHint?: ModelHint;
}

export interface SupplierRiskServiceDeps {
  readonly gstin: GstinStatusPort;
  readonly history: SupplierHistoryPort;
  readonly assessments: RiskAssessmentRepository;
  readonly acknowledgements: RiskAcknowledgementRepository;
  readonly audit: AuditPort;
  readonly clock: Clock;
  /** #31's optional signal. Absent means every assessment says GSTR-2B was not checked. */
  readonly gstr2b?: Gstr2bPort;
  readonly policy?: RiskPolicyPort;
}

export class SupplierRiskService {
  readonly #gstin: GstinStatusPort;
  readonly #history: SupplierHistoryPort;
  readonly #assessments: RiskAssessmentRepository;
  readonly #acknowledgements: RiskAcknowledgementRepository;
  readonly #audit: AuditPort;
  readonly #clock: Clock;
  readonly #gstr2b: Gstr2bPort | undefined;
  readonly #policy: RiskPolicyPort | undefined;

  constructor(deps: SupplierRiskServiceDeps) {
    this.#gstin = deps.gstin;
    this.#history = deps.history;
    this.#assessments = deps.assessments;
    this.#acknowledgements = deps.acknowledgements;
    this.#audit = deps.audit;
    this.#clock = deps.clock;
    this.#gstr2b = deps.gstr2b;
    this.#policy = deps.policy;
  }

  /**
   * Gathers what is known and assesses it.
   *
   * A government source that will not answer never fails the call: the assessment comes back with
   * that source marked unavailable and `confidence: "PARTIAL"`. Refusing to answer at all would
   * teach people to skip the check, which is the opposite of what this is for.
   */
  async assess(actor: ActorContext, input: AssessSupplierInput): Promise<SupplierRiskAssessment> {
    this.#require(actor, SUPPLIER_RISK_VIEW_PERMISSION);
    if (input.supplierName.trim() === "") {
      throw invalid("SUPPLIER_NAME_REQUIRED", "We need to know which supplier you mean.");
    }
    const on = input.on ?? this.#clock.now().toISOString().slice(0, 10);
    const policy = await this.#policyFor(actor.companyId, on);

    const lookup = input.gstin === undefined
      ? undefined
      : await this.#gstin.lookup(actor.companyId, input.gstin, { refresh: input.refresh === true });

    const history = await this.#history.historyFor(actor.companyId, input.supplierPartyId, on);

    // #31's signal when it exists. A port that throws is treated as "not checked", never as a
    // finding against the supplier — that is the whole point of the optional contract.
    let gstr2b;
    if (this.#gstr2b !== undefined && input.gstin !== undefined && input.invoiceNumber !== undefined && input.invoiceDate !== undefined) {
      try {
        gstr2b = (await this.#gstr2b.signalFor(actor.companyId, {
          supplierGstin: input.gstin, invoiceNumber: input.invoiceNumber, invoiceDate: input.invoiceDate,
        })) ?? undefined;
      } catch {
        gstr2b = undefined;
      }
    }

    const assessmentInput: SupplierRiskInput = {
      companyId: actor.companyId,
      supplierPartyId: input.supplierPartyId,
      supplierName: input.supplierName,
      ...(input.gstin === undefined ? {} : { gstin: input.gstin }),
      ...(input.expectedStateCode === undefined ? {} : { expectedStateCode: input.expectedStateCode }),
      ...(input.invoiceNumber === undefined ? {} : { invoiceNumber: input.invoiceNumber }),
      ...(input.invoiceDate === undefined ? {} : { invoiceDate: input.invoiceDate }),
      ...(lookup === undefined ? {} : { gstin_lookup: lookup }),
      history,
      ...(gstr2b === undefined ? {} : { gstr2b }),
      ...(input.modelHint === undefined ? {} : { modelHint: input.modelHint }),
      on,
    };

    const assessment = assessSupplierRisk(assessmentInput, policy, () => this.#clock.now());

    // Identical facts give an identical fingerprint, so re-checking the same supplier on the same
    // day records one assessment rather than a row per page refresh.
    const existing = await this.#assessments.findByFingerprint(actor.companyId, assessment.fingerprint);
    if (existing === null) {
      await this.#assessments.insert(assessment);
      await this.#audit.record({
        companyId: actor.companyId,
        actorId: actor.userId,
        at: assessment.assessedAt,
        action: "supplier.risk_assessed",
        subjectType: "party",
        subjectId: input.supplierPartyId,
        summary: assessment.summary,
        details: {
          supplier: input.supplierName,
          // The GST number is business identification, not a secret; the account numbers that are
          // secret never leave `supplier-risk-adapters.ts` unmasked.
          gstin: input.gstin ?? "none",
          level: assessment.level,
          confidence: assessment.confidence,
          warnings: assessment.warnings.map((warning) => warning.code).join(", "),
          fingerprint: assessment.fingerprint,
        },
      });
    }
    return assessment;
  }

  async assessmentsFor(actor: ActorContext, partyId: Id): Promise<readonly SupplierRiskAssessment[]> {
    this.#require(actor, SUPPLIER_RISK_VIEW_PERMISSION);
    return this.#assessments.listForParty(actor.companyId, partyId);
  }

  /**
   * A person deciding to go ahead anyway, with their reason kept.
   *
   * Pinned to the fingerprint, so accepting "their GST number was cancelled" today does not
   * silently cover a bank-account change that appears next week.
   */
  async acknowledge(actor: ActorContext, assessment: SupplierRiskAssessment, reason: string): Promise<RiskAcknowledgement> {
    this.#require(actor, SUPPLIER_RISK_ACKNOWLEDGE_PERMISSION);
    if (assessment.companyId !== actor.companyId) {
      throw notFound("SUPPLIER_RISK_UNKNOWN", "We could not find that supplier check.");
    }
    if (reason.trim() === "") {
      throw invalid("SUPPLIER_RISK_REASON_REQUIRED", "Please say why it is alright to go ahead; the reason is kept with the supplier.");
    }
    if (assessment.level === "INFORMATION") {
      throw conflict("SUPPLIER_RISK_NOTHING_TO_ACCEPT", "There is nothing on this supplier that needs accepting.");
    }

    const existing = await this.#acknowledgements.findByFingerprint(actor.companyId, assessment.fingerprint);
    if (existing !== null) return existing;

    const at = this.#clock.now().toISOString();
    const acknowledgement: RiskAcknowledgement = {
      assessmentFingerprint: assessment.fingerprint,
      supplierPartyId: assessment.supplierPartyId,
      acknowledgedBy: actor.userId,
      acknowledgedAt: at,
      reason,
      accepted: [...new Set(assessment.warnings.filter((warning) => warning.level !== "INFORMATION").map((warning) => warning.code))] as SupplierRiskCode[],
    };
    await this.#acknowledgements.insert(actor.companyId, acknowledgement);
    await this.#audit.record({
      companyId: actor.companyId,
      actorId: actor.userId,
      at,
      action: "supplier.risk_acknowledged",
      subjectType: "party",
      subjectId: assessment.supplierPartyId,
      summary: `The warnings about ${assessment.supplierName} were accepted. Reason kept on record: ${reason}`,
      details: {
        supplier: assessment.supplierName,
        level: assessment.level,
        accepted: acknowledgement.accepted.join(", "),
        fingerprint: assessment.fingerprint,
      },
      overrideReason: reason,
    });
    return acknowledgement;
  }

  /**
   * Whether a bill from this supplier may go ahead without anyone looking.
   *
   * Only a `SERIOUS` level stops anything, and only until someone with the permission accepts it.
   * `CAUTION` and `INFORMATION` are shown and never block — a warning that stops work is one people
   * learn to click past.
   */
  async isClearedToProceed(actor: ActorContext, assessment: SupplierRiskAssessment): Promise<{ readonly cleared: boolean; readonly reason: string }> {
    if (assessment.level !== "SERIOUS") return { cleared: true, reason: assessment.summary };
    const acknowledgement = await this.#acknowledgements.findByFingerprint(actor.companyId, assessment.fingerprint);
    return acknowledgement === null
      ? { cleared: false, reason: assessment.summary }
      : { cleared: true, reason: `These warnings were accepted on ${acknowledgement.acknowledgedAt.slice(0, 10)}. Reason kept on record: ${acknowledgement.reason}` };
  }

  // --------------------------------------------------------------------------- internals

  async #policyFor(companyId: CompanyId, on: IsoDate): Promise<RiskPolicy> {
    return this.#policy === undefined ? DEFAULT_RISK_POLICY : this.#policy.policyFor(companyId, on);
  }

  #require(actor: ActorContext, permission: string): void {
    if (!actor.permissions.includes(permission)) {
      throw forbidden("PERMISSION_DENIED", "You do not have permission to see supplier checks. Ask the owner to give you access.", { details: { permission } });
    }
  }
}

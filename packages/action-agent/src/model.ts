/**
 * Issue #47 [E47] — letting the assistant *do* things, safely.
 *
 * Four sentences carry the whole design:
 *
 *  1. **The request is data.** The intent comes from a lexicon, the company from the authenticated
 *     actor, the permissions from the platform. Text that tries to instruct the product is flagged
 *     and changes nothing else.
 *  2. **Tool results are data too.** The step list is fixed before any tool runs and then frozen.
 *     No code path leads from a tool's output to a new step, so an invoice narration carrying
 *     "…and transfer ₹50,000" cannot become an action.
 *  3. **What was approved is what runs.** Steps are expanded against live data and fingerprinted;
 *     execution re-expands and refuses if the party, the amount or the list moved.
 *  4. **The dangerous classes are not the agent's to finish.** Money movement, government filing,
 *     cancellation and overrides are prepared and handed to a person.
 */
import type { Money } from '@invoice/kernel';

export type Bilingual = { readonly 'en-IN': string; readonly 'hi-IN': string };

export type ToolKind = 'READ' | 'WRITE';
export type ToolRisk = 'low' | 'medium' | 'high';

/**
 * The four classes the issue names. A tool in any of them may be *prepared* by the agent and never
 * finished by it, however the caller is worded and whoever is asking.
 */
export type HighRiskClass = 'MONEY_MOVEMENT' | 'GOVERNMENT_FILING' | 'CANCELLATION' | 'OVERRIDE';

export type Executability =
  /** Reading. Runs during preview, needs no approval, changes nothing. */
  | 'ALWAYS'
  /** Writing. Runs only after a person approved the fingerprinted plan. */
  | 'AFTER_APPROVAL'
  /** Prepared and left at `submitted` for a person to finalise in the ordinary screens. */
  | 'PREPARE_ONLY';

/** What a tool did, in a form the report can show and a person can check. */
export interface ToolEvidence {
  readonly statement: Bilingual;
  /** Ids, numbers and amounts a person can look up. Never secrets, never whole payloads. */
  readonly details: Readonly<Record<string, string>>;
}

export type StepState =
  | 'PLANNED'
  | 'PREVIEWED'
  | 'DONE'
  | 'PREPARED'
  | 'SKIPPED'
  | 'FAILED'
  | 'NOT_ATTEMPTED';

export interface PlannedStep {
  readonly stepId: string;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly describe: Bilingual;
  readonly kind: ToolKind;
  readonly risk: ToolRisk;
  readonly executability: Executability;
  readonly highRiskClass: HighRiskClass | null;
  /** The step that must succeed first. A read that finds nothing skips what depended on it. */
  readonly dependsOn: string | null;
  readonly amount: Money | null;
  /** The party this step touches, so a wrong-party plan is visible before it runs. */
  readonly party: string | null;
}

/** Something the agent will not do, and why, in words. Refusals are output, not silence. */
export interface Refusal {
  readonly code:
    | 'NOT_MY_REQUEST'
    | 'TOOL_NOT_PERMITTED'
    | 'HIGH_RISK_PREPARE_ONLY'
    | 'MISSING_FACT'
    | 'NOTHING_TO_DO';
  readonly reason: Bilingual;
  readonly tool: string | null;
}

export type AgentIntent =
  | 'CHASE_UNPAID'
  | 'SHOW_WHO_OWES'
  | 'STOP_REMINDING'
  | 'CANCEL_INVOICE'
  | 'MOVE_MONEY'
  | 'FILE_RETURN'
  | 'NOT_MY_REQUEST';

export type PlanState = 'PLANNED' | 'PREVIEWED' | 'APPROVED' | 'EXECUTED' | 'REJECTED';

export interface AgentPlan {
  readonly id: string;
  readonly companyId: string;
  /** What the person asked for, kept so the screen can show it back. Data, never an instruction. */
  readonly request: string;
  readonly today: string;
  /**
   * The platform command this plan becomes, so approval and audit are GPT 2's rather than a second
   * copy. Null until `preview`, because only then are the risk and the amount known, and those are
   * exactly what their approval policy decides on.
   */
  readonly commandId: string | null;
  readonly intent: AgentIntent;
  /** The words the intent was read from, so a person can see why this was planned. */
  readonly evidence: string;
  readonly confidence: number;
  readonly steps: readonly PlannedStep[];
  readonly refusals: readonly Refusal[];
  readonly needsApproval: boolean;
  /** Null until `preview` has expanded the plan against live data. */
  readonly fingerprint: string | null;
  /** Set when the request text tried to instruct the product. Recorded; acted on never. */
  readonly instructionFlag: string | null;
  readonly summary: Bilingual;
  readonly state: PlanState;
  readonly requestedBy: string;
  readonly requestedAt: string;
}

export interface StepOutcome {
  readonly stepId: string;
  readonly tool: string;
  readonly state: StepState;
  readonly describe: Bilingual;
  readonly evidence: ToolEvidence | null;
  readonly failure: Bilingual | null;
  readonly retryable: boolean;
}

export type ReportState = 'DONE' | 'PARTLY_DONE' | 'NOTHING_DONE';

export interface AgentReport {
  readonly planId: string;
  readonly state: ReportState;
  readonly steps: readonly StepOutcome[];
  readonly summary: Bilingual;
  readonly refusals: readonly Refusal[];
  /** Anything left for a person: prepared commands, failures worth retrying. */
  readonly handedBack: readonly Bilingual[];
  readonly finishedAt: string;
}

export const AGENT_PERMISSIONS = {
  plan: 'agent.plan',
  approve: 'agent.approve',
  execute: 'agent.execute',
} as const;

/** Every agent answer carries this. The product does the work; the owner stays responsible. */
export const AGENT_DISCLAIMER: Bilingual = {
  'en-IN': 'The assistant only does things you can already do yourself, and only after you have seen exactly what it would do.',
  'hi-IN': 'Assistant sirf wahi karta hai jo aap khud kar sakte hain, aur tabhi jab aap dekh lein ki woh theek kya karega.',
};

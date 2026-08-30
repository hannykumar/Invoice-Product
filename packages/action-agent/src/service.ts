/**
 * Issue #47 [E47] — the action agent.
 *
 * The lifecycle is GPT 2's `PlatformCommandService` (#6): idempotency, `draft → submitted →
 * approved → finalised`, approval policy by action, risk and amount, and the redacted audit trail.
 * None of that is reimplemented here. What this service adds is the part that is specific to a
 * machine acting on a person's behalf:
 *
 *  - reading a request without letting the request decide anything;
 *  - expanding it against live data so a person sees real parties and real amounts;
 *  - pinning that expansion, so what was approved is what runs;
 *  - refusing to finish the four dangerous classes at all.
 */
import { conflict, forbidden, invalid, notAllowed, notFound, type Clock, type IsoDate } from '@invoice/kernel';
import type { ActorContext, PermissionPort } from '@invoice/ledger';
import type { PlatformCommandService, RequestContext } from '../../platform/src/index.ts';
import { fingerprintOf } from './fingerprint.ts';
import {
  AGENT_PERMISSIONS,
  type AgentPlan,
  type AgentReport,
  type Bilingual,
  type PlannedStep,
  type Refusal,
  type ReportState,
  type StepOutcome,
  type ToolEvidence,
} from './model.ts';
import { ASK_INSTEAD, WHAT_I_CAN_DO, understandRequest } from './planning.ts';
import type { AgentPlanStore, AgentRequest, PartyDirectoryPort } from './ports.ts';
import { expand, type ReadResult, type RecipeContext } from './recipes.ts';
import type { ToolRegistry } from './registry.ts';

/** Reused from #34: text that tries to instruct the product is recorded and changes nothing. */
import { looksLikeAnInstruction } from '../../assistant/src/language.ts';

export const AGENT_ACTION = 'agent.run';

export interface ActionAgentDeps {
  readonly registry: ToolRegistry;
  readonly commands: PlatformCommandService;
  readonly contextFor: (actor: ActorContext) => RequestContext;
  readonly parties: PartyDirectoryPort;
  readonly store: AgentPlanStore;
  readonly permissions: PermissionPort;
  readonly clock: Clock;
  readonly idFactory?: () => string;
  /** How long any one tool may take before the step is failed and the rest carries on. */
  readonly toolDeadlineMs?: number;
}

const bilingual = (en: string, hi: string): Bilingual => ({ 'en-IN': en, 'hi-IN': hi });

const dedupe = (refusals: readonly Refusal[]): readonly Refusal[] => {
  const seen = new Set<string>();
  return refusals.filter((refusal) => {
    const key = `${refusal.code}:${refusal.tool ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export class ActionAgentService {
  readonly #registry: ToolRegistry;
  readonly #commands: PlatformCommandService;
  readonly #contextFor: (actor: ActorContext) => RequestContext;
  readonly #parties: PartyDirectoryPort;
  readonly #store: AgentPlanStore;
  readonly #permissions: PermissionPort;
  readonly #clock: Clock;
  readonly #newId: () => string;
  readonly #deadlineMs: number;

  constructor(deps: ActionAgentDeps) {
    this.#registry = deps.registry;
    this.#commands = deps.commands;
    this.#contextFor = deps.contextFor;
    this.#parties = deps.parties;
    this.#store = deps.store;
    this.#permissions = deps.permissions;
    this.#clock = deps.clock;
    this.#newId = deps.idFactory ?? (() => crypto.randomUUID());
    this.#deadlineMs = deps.toolDeadlineMs ?? 5_000;
  }

  /** What tools this person could have the assistant use. Never more than they hold themselves. */
  capabilities(actor: ActorContext) {
    this.#permissions.require(actor, AGENT_PERMISSIONS.plan, 'ask the assistant to do something');
    return this.#registry.available(actor).map((tool) => ({
      name: tool.name,
      kind: tool.kind,
      risk: tool.risk,
      executability: tool.executability,
      summary: tool.summary,
    }));
  }

  /**
   * Reads the request and records what it thinks was meant. Runs no tool and changes nothing.
   *
   * The platform command is created here, so from the very first moment there is an audited record
   * of what was asked — including a request the agent refuses.
   */
  async plan(actor: ActorContext, request: AgentRequest): Promise<AgentPlan> {
    this.#permissions.require(actor, AGENT_PERMISSIONS.plan, 'ask the assistant to do something');
    const understood = understandRequest(request.text);
    const flag = looksLikeAnInstruction(request.text);
    const at = this.#clock.now().toISOString();
    const id = this.#newId();

    const unsure = understood.confidence < ASK_INSTEAD;
    const refusals: Refusal[] = unsure ? [{ code: 'NOT_MY_REQUEST', tool: null, reason: WHAT_I_CAN_DO }] : [];

    const plan: AgentPlan = {
      id,
      companyId: actor.companyId,
      request: request.text,
      today: request.today,
      commandId: null,
      intent: unsure ? 'NOT_MY_REQUEST' : understood.intent,
      evidence: understood.evidence,
      confidence: understood.confidence,
      steps: [],
      refusals,
      needsApproval: false,
      fingerprint: null,
      instructionFlag: flag,
      summary: understood.intent === 'NOT_MY_REQUEST' || unsure
        ? WHAT_I_CAN_DO
        : bilingual('Let me look at your books and show you exactly what I would do.', 'Main aapki bahi dekh kar aapko dikhata hoon ki theek kya karunga.'),
      state: 'PLANNED',
      requestedBy: actor.userId,
      requestedAt: at,
    };
    await this.#store.put(plan);
    this.#record(actor, plan.id, 'agent.requested', {
      intent: plan.intent,
      confidence: String(understood.confidence),
      // The words that matched, not the request: an audit trail records what was asked of the
      // product, and the raw text may hold anything at all.
      matched: understood.evidence,
      instructionFlag: flag ?? '',
    });
    return plan;
  }

  /**
   * Expands the plan against live data.
   *
   * Read tools run for real here — that is the whole point, since a preview built from anything
   * other than the present state is a preview of a different business. Write tools cannot run:
   * the runner handed to the recipes refuses anything that is not a read.
   */
  async preview(actor: ActorContext, planId: string): Promise<AgentPlan> {
    this.#permissions.require(actor, AGENT_PERMISSIONS.plan, 'see what the assistant would do');
    const plan = await this.#require(actor, planId);
    if (plan.state === 'EXECUTED') throw notAllowed('AGENT_PLAN_DONE', 'This has already been done.');
    const expansion = await this.#expand(actor, plan);

    const steps = expansion.steps;
    const needsApproval = steps.some((step) => step.executability !== 'ALWAYS');

    // The command is created here rather than at `plan`, because GPT 2's approval policy decides on
    // the action, the risk and the amount — and none of those are known until the request has been
    // expanded against the books. A plan that only reads is genuinely low risk, and saying so is
    // what lets it run without troubling anybody for an approval.
    const command = this.#commands.create(this.#contextFor(actor), {
      action: AGENT_ACTION,
      risk: this.#riskOf(steps),
      idempotencyKey: `agent:${plan.id}`,
      payload: { intent: plan.intent, planId: plan.id },
      ...this.#amountOf(steps),
    });

    const next: AgentPlan = {
      ...plan,
      commandId: command.id,
      steps,
      // The same refusal can be reached from two directions — the lexicon not recognising a
      // request, and the expansion having nothing to expand. A person should read it once.
      refusals: dedupe([...plan.refusals, ...expansion.refusals]),
      needsApproval,
      fingerprint: fingerprintOf(plan.intent, steps),
      summary: expansion.summary,
      state: 'PREVIEWED',
    };
    await this.#store.put(next);
    if (needsApproval && command.status === 'draft') {
      this.#commands.transition(this.#contextFor(actor), command.id, 'submitted', 'The assistant showed the person what it would do.');
    }
    this.#record(actor, plan.id, 'agent.previewed', {
      steps: String(steps.length),
      writes: String(steps.filter((step) => step.kind === 'WRITE').length),
      fingerprint: next.fingerprint ?? '',
    });
    return next;
  }

  /** A person agreeing to exactly this list. The fingerprint they saw is the one they pin. */
  async approve(actor: ActorContext, planId: string, fingerprint: string): Promise<AgentPlan> {
    this.#permissions.require(actor, AGENT_PERMISSIONS.approve, 'approve what the assistant would do');
    const plan = await this.#require(actor, planId);
    if (plan.state !== 'PREVIEWED') {
      throw notAllowed('AGENT_NOT_PREVIEWED', 'Nothing can be approved before you have seen what it would do.');
    }
    if (plan.fingerprint !== fingerprint) {
      throw conflict('AGENT_PLAN_CHANGED', 'What you are approving is not what was shown to you. Look at it again.');
    }
    if (!plan.needsApproval) {
      throw notAllowed('AGENT_NOTHING_TO_APPROVE', 'Nothing here changes anything, so there is nothing to approve.');
    }
    this.#commands.transition(this.#contextFor(actor), plan.commandId as string, 'approved', 'Approved by the person who asked.');
    const next: AgentPlan = { ...plan, state: 'APPROVED' };
    await this.#store.put(next);
    this.#record(actor, plan.id, 'agent.approved', { fingerprint });
    return next;
  }

  async reject(actor: ActorContext, planId: string, reason: string): Promise<AgentPlan> {
    this.#permissions.require(actor, AGENT_PERMISSIONS.approve, 'refuse what the assistant would do');
    const plan = await this.#require(actor, planId);
    if (plan.commandId === null) throw notAllowed('AGENT_NOT_PREVIEWED', 'There is nothing here to refuse yet.');
    this.#commands.transition(this.#contextFor(actor), plan.commandId, 'rejected', reason);
    const next: AgentPlan = { ...plan, state: 'REJECTED' };
    await this.#store.put(next);
    this.#record(actor, plan.id, 'agent.rejected', { reason });
    return next;
  }

  /**
   * Does the work.
   *
   * The plan is expanded **again** first and compared with what was approved. A bill paid, a
   * dispute raised or a customer opting out in the meantime changes the fingerprint, and this
   * refuses rather than doing something nobody agreed to. Only then do write tools run, each under
   * the actor's own permissions, re-checked here because an approval is not a licence that
   * outlives the permission it was built on.
   */
  async execute(actor: ActorContext, planId: string, input: { fingerprint: string; idempotencyKey: string }): Promise<AgentReport> {
    this.#permissions.require(actor, AGENT_PERMISSIONS.execute, 'let the assistant do this');
    if (input.idempotencyKey.trim() === '') {
      throw invalid('AGENT_IDEMPOTENCY_KEY_REQUIRED', 'Every run needs a key, so asking twice cannot do it twice.');
    }
    const replay = await this.#store.findReport(actor.companyId, `${planId}:${input.idempotencyKey}`);
    if (replay !== null) return replay;

    const plan = await this.#require(actor, planId);
    if (plan.commandId === null) {
      throw notAllowed('AGENT_NOT_PREVIEWED', 'Nothing can run before you have seen what it would do.');
    }
    // Before anything runs, every step is checked against the permissions this person holds *now*.
    // A plan is not a licence: an approval given yesterday cannot outlive the permission it rested
    // on, and one unusable step stops the whole run rather than doing the rest of somebody's work.
    for (const step of plan.steps) this.#registry.requirePermitted(actor, step.tool);
    if (plan.needsApproval && plan.state !== 'APPROVED') {
      throw notAllowed('AGENT_APPROVAL_REQUIRED', 'This changes something, so it needs your approval before it can run.');
    }
    if (plan.fingerprint !== input.fingerprint) {
      throw conflict('AGENT_PLAN_CHANGED', 'What you are running is not what was shown to you. Look at it again.');
    }

    const expansion = await this.#expand(actor, plan);
    const current = fingerprintOf(plan.intent, expansion.steps);
    if (current !== plan.fingerprint) {
      // Something moved between the approval and now — a bill paid, a dispute raised, a customer
      // who asked to be left alone. Nobody agreed to the new list, so nobody gets it.
      this.#record(actor, plan.id, 'agent.refused_changed', { approved: plan.fingerprint ?? '', now: current });
      throw conflict(
        'AGENT_PLAN_CHANGED',
        'Your books changed since you approved this, so what you agreed to is no longer what would happen. Have another look and I will do the new version.',
      );
    }

    const readByTool = new Map(expansion.reads.map((read) => [read.tool, read]));
    const outcomes: StepOutcome[] = [];
    const stopped = new Set<string>();

    for (const step of plan.steps) {
      if (step.dependsOn !== null && stopped.has(step.dependsOn)) {
        outcomes.push(this.#outcome(step, 'NOT_ATTEMPTED', null, bilingual(
          'This was not attempted, because the step it depends on did not finish.',
          'Yeh koshish nahin ki gayi, kyunki jispar yeh nirbhar tha woh poora nahin hua.',
        ), false));
        continue;
      }
      try {
        const tool = this.#registry.requirePermitted(actor, step.tool);
        if (tool.kind === 'READ') {
          const read = readByTool.get(step.tool);
          const evidence = read === undefined
            ? null
            : tool.evidence(tool.parse(step.input as never), read.output as never);
          outcomes.push(this.#outcome(step, 'DONE', evidence, null, false));
          continue;
        }
        if (tool.executability === 'PREPARE_ONLY') {
          // Prepared, and left where a person must finish it. The agent never moves it further.
          const prepared = this.#commands.create(this.#contextFor(actor), {
            action: step.tool,
            risk: 'high',
            idempotencyKey: `agent-prepared:${plan.id}:${step.stepId}`,
            payload: { ...step.input, preparedByAgent: true, planId: plan.id },
            ...(step.amount === null ? {} : { amountPaise: step.amount.minor }),
          });
          this.#commands.transition(this.#contextFor(actor), prepared.id, 'submitted', 'Prepared by the assistant; a person must finish it.');
          outcomes.push(this.#outcome(step, 'PREPARED', {
            statement: bilingual(
              `Prepared and waiting for you: ${step.describe['en-IN']}`,
              `Taiyar hai, aapka intezar kar raha hai: ${step.describe['hi-IN']}`,
            ),
            details: { commandId: prepared.id, tool: step.tool },
          }, null, false));
          continue;
        }
        const parsed = tool.parse(step.input as never);
        const output = await this.#withDeadline(tool.run(actor, parsed, this.#deadlineMs), step.tool);
        outcomes.push(this.#outcome(step, 'DONE', tool.evidence(parsed, output as never), null, false));
        this.#record(actor, plan.id, 'agent.step_done', { tool: step.tool, step: step.stepId, party: step.party ?? '' });
      } catch (error) {
        stopped.add(step.stepId);
        const message = error instanceof Error ? error.message : 'This could not be completed.';
        outcomes.push(this.#outcome(step, 'FAILED', null, bilingual(message, message), true));
        this.#record(actor, plan.id, 'agent.step_failed', { tool: step.tool, step: step.stepId, why: message });
      }
    }

    const failed = outcomes.filter((outcome) => outcome.state === 'FAILED');
    const did = outcomes.filter((outcome) => outcome.state === 'DONE' || outcome.state === 'PREPARED');
    const writesDone = outcomes.filter((outcome) => outcome.state === 'DONE' && plan.steps.find((step) => step.stepId === outcome.stepId)?.kind === 'WRITE');
    const state: ReportState = failed.length > 0 ? (did.length > 0 ? 'PARTLY_DONE' : 'NOTHING_DONE') : 'DONE';

    const report: AgentReport = {
      planId: plan.id,
      state,
      steps: outcomes,
      refusals: plan.refusals,
      summary: state === 'DONE'
        ? bilingual(
            `Done: ${writesDone.length} thing${writesDone.length === 1 ? '' : 's'} carried out.`,
            `Ho gaya: ${writesDone.length} kaam poore hue.`,
          )
        : state === 'PARTLY_DONE'
          ? bilingual(
              `${writesDone.length} done, ${failed.length} could not be completed. Nothing was left half-finished — each one either happened or did not.`,
              `${writesDone.length} ho gaye, ${failed.length} nahin ho paye. Koi kaam aadha nahin chhoda — har ek ya to hua ya nahin hua.`,
            )
          : bilingual('Nothing was carried out.', 'Kuch nahin ho paya.'),
      handedBack: [
        ...outcomes.filter((outcome) => outcome.state === 'PREPARED').map((outcome) => outcome.evidence?.statement ?? outcome.describe),
        ...failed.map((outcome) => bilingual(
          `${outcome.describe['en-IN']} — you can try this one again.`,
          `${outcome.describe['hi-IN']} — ise aap dobara try kar sakte hain.`,
        )),
      ],
      finishedAt: this.#clock.now().toISOString(),
    };

    await this.#store.putReport(actor.companyId, `${planId}:${input.idempotencyKey}`, report);
    await this.#store.put({ ...plan, state: 'EXECUTED' });
    this.#finish(actor, plan.commandId, state === 'NOTHING_DONE' && failed.length > 0 ? 'failed' : 'finalised', report.summary['en-IN']);
    this.#record(actor, plan.id, 'agent.reported', { state, done: String(did.length), failed: String(failed.length) });
    return report;
  }

  async plans(actor: ActorContext): Promise<readonly AgentPlan[]> {
    this.#permissions.require(actor, AGENT_PERMISSIONS.plan, 'see what the assistant has been asked to do');
    return this.#store.list(actor.companyId);
  }

  async report(actor: ActorContext, planId: string): Promise<AgentReport | null> {
    this.#permissions.require(actor, AGENT_PERMISSIONS.plan, 'see what the assistant did');
    await this.#require(actor, planId);
    return this.#store.reportFor(actor.companyId, planId);
  }

  // ------------------------------------------------------------------------------- the internals

  /**
   * Expansion, with a runner that can only read.
   *
   * A recipe asking for a write here throws. That is the structural half of "tool results are
   * data": the step list is produced before anything runs, and nothing a tool returns can add to
   * it, because the only thing that builds steps is this function and it is finished before
   * `execute` begins.
   */
  async #expand(actor: ActorContext, plan: AgentPlan) {
    let counter = 0;
    const context: RecipeContext = {
      actor,
      registry: this.#registry,
      parties: this.#parties,
      today: plan.today as IsoDate,
      readTool: async (name, input): Promise<ReadResult> => {
        const tool = this.#registry.requirePermitted(actor, name);
        if (tool.kind !== 'READ') {
          throw forbidden('AGENT_PREVIEW_WOULD_WRITE', 'A preview may only look at your books, never change them.');
        }
        const parsed = tool.parse(input as never);
        const output = await this.#withDeadline(tool.run(actor, parsed, this.#deadlineMs), name);
        return { tool: name, input: input as Record<string, unknown>, output, describe: tool.describe(parsed) };
      },
      nextStepId: () => `${plan.id}-${String((counter += 1)).padStart(2, '0')}`,
    };
    // The request is re-read rather than remembered as steps: the intent is already settled and
    // pinned on the plan, and only the party and document words are taken from the text again.
    const understood = understandRequest(plan.request);
    return expand(context, { ...understood, intent: plan.intent });
  }

  /**
   * The risk the platform's approval policy sees.
   *
   * A plan that only reads is `low` and needs nobody's approval — a person should not have to sign
   * for being shown their own figures. Anything that writes is at least `medium`.
   */
  #riskOf(steps: readonly PlannedStep[]): 'low' | 'medium' | 'high' {
    if (steps.some((step) => step.risk === 'high' || step.executability === 'PREPARE_ONLY')) return 'high';
    return steps.some((step) => step.kind === 'WRITE') ? 'medium' : 'low';
  }

  /** What the whole plan is worth, so an amount threshold in the approval policy can bite. */
  #amountOf(steps: readonly PlannedStep[]): { amountPaise?: bigint } {
    const total = steps.reduce((sum, step) => sum + (step.amount?.minor ?? 0n), 0n);
    return total === 0n ? {} : { amountPaise: total };
  }

  /**
   * Closes the platform command.
   *
   * A read-only plan was never submitted for approval, so it is walked through the states here
   * rather than being allowed to skip them: the record of what happened should look the same
   * whether or not a person had to be asked.
   */
  #finish(actor: ActorContext, commandId: string, ending: 'finalised' | 'failed', reason: string): void {
    const context = this.#contextFor(actor);
    let status = this.#commands.get(context, commandId).status;
    if (status === 'draft') {
      this.#commands.transition(context, commandId, 'submitted', 'Nothing here changes anything.');
      status = 'submitted';
    }
    if (status === 'submitted') {
      this.#commands.transition(context, commandId, 'approved', 'Nothing here changes anything, so no approval was needed.');
    }
    this.#commands.transition(context, commandId, ending, reason);
  }

  #outcome(step: PlannedStep, state: StepOutcome['state'], evidence: ToolEvidence | null, failure: Bilingual | null, retryable: boolean): StepOutcome {
    return { stepId: step.stepId, tool: step.tool, state, describe: step.describe, evidence, failure, retryable };
  }

  /** A tool that never returns must not hold the rest of the work hostage. */
  async #withDeadline<T>(work: Promise<T>, tool: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`"${tool}" took too long to answer, so this step was stopped. Nothing was left half-done.`)),
            this.#deadlineMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #record(actor: ActorContext, correlationId: string, action: string, details: Readonly<Record<string, string>>): void {
    this.#commands.audit.append({
      companyId: actor.companyId,
      actorId: actor.userId,
      action,
      correlationId,
      before: null,
      after: { ...details },
    });
  }

  async #require(actor: ActorContext, planId: string): Promise<AgentPlan> {
    const plan = await this.#store.find(actor.companyId, planId);
    if (plan === null) throw notFound('AGENT_PLAN_NOT_FOUND', 'That request does not exist in this business.');
    return plan;
  }
}

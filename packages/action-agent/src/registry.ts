/**
 * Issue #47 [E47] — the tool registry, and the policy it refuses to let anyone break.
 *
 * The high-risk policy is enforced **at registration**, not at call time. A tool that moves money,
 * files a return, cancels a document or overrides a control cannot be registered as anything but
 * `PREPARE_ONLY`; a write cannot be registered as needing no approval; a read cannot claim to need
 * one. So the policy is a property of the registry rather than a rule every future author has to
 * remember, and the test that proves it is a test of the machinery.
 */
import { forbidden, invalid, notFound, type Money } from '@invoice/kernel';
import type { ActorContext } from '@invoice/ledger';
import type {
  Bilingual,
  Executability,
  HighRiskClass,
  ToolEvidence,
  ToolKind,
  ToolRisk,
} from './model.ts';

export interface ToolDefinition<Input = unknown, Output = unknown> {
  readonly name: string;
  readonly kind: ToolKind;
  readonly risk: ToolRisk;
  readonly highRiskClass?: HighRiskClass;
  readonly executability: Executability;
  /** Every one is required. The agent borrows the actor's permissions; it holds none of its own. */
  readonly permissions: readonly string[];
  readonly summary: Bilingual;
  /** Turns loose input into a typed one, or throws. A missing fact is never filled in. */
  parse(input: unknown): Input;
  /** The sentence the preview shows. It must name the party and the amount if there are any. */
  describe(input: Input): Bilingual;
  amountOf?(input: Input): Money | null;
  partyOf?(input: Input): string | null;
  run(actor: ActorContext, input: Input, deadlineMs: number): Promise<Output>;
  evidence(input: Input, output: Output): ToolEvidence;
}

const policyProblem = (tool: ToolDefinition<never, never>): string | null => {
  if (tool.highRiskClass !== undefined && tool.executability !== 'PREPARE_ONLY') {
    return `"${tool.name}" is ${tool.highRiskClass.toLowerCase().replace('_', ' ')}, which the assistant may only prepare for a person to finish.`;
  }
  if (tool.kind === 'WRITE' && tool.executability === 'ALWAYS') {
    return `"${tool.name}" changes something, so it cannot be registered as needing no approval.`;
  }
  if (tool.kind === 'READ' && tool.executability !== 'ALWAYS') {
    return `"${tool.name}" only reads, so it must not ask a person to approve it.`;
  }
  if (tool.permissions.length === 0) {
    return `"${tool.name}" declares no permission, so nothing would stop anybody from running it.`;
  }
  return null;
};

export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition<never, never>>();

  register<Input, Output>(tool: ToolDefinition<Input, Output>): this {
    const problem = policyProblem(tool as unknown as ToolDefinition<never, never>);
    if (problem !== null) throw new Error(`Tool policy: ${problem}`);
    if (this.#tools.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered.`);
    this.#tools.set(tool.name, tool as unknown as ToolDefinition<never, never>);
    return this;
  }

  /** The tool, or a NOT_FOUND. A name the agent invented is a bug, not a silent no-op. */
  require(name: string): ToolDefinition<never, never> {
    const tool = this.#tools.get(name);
    if (tool === undefined) throw notFound('AGENT_TOOL_UNKNOWN', `There is no "${name}" the assistant can use.`);
    return tool;
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  /** Only what this person could do themselves. The agent never widens anybody's reach. */
  available(actor: ActorContext): readonly ToolDefinition<never, never>[] {
    const held = new Set(actor.permissions);
    return [...this.#tools.values()].filter((tool) => tool.permissions.every((permission) => held.has(permission)));
  }

  permits(actor: ActorContext, name: string): boolean {
    const tool = this.#tools.get(name);
    if (tool === undefined) return false;
    const held = new Set(actor.permissions);
    return tool.permissions.every((permission) => held.has(permission));
  }

  /**
   * The check that runs before planning and **again** before execution.
   *
   * Twice, because permissions can be revoked between a plan being approved and it being run, and
   * an approved plan is not a licence that outlives the permission it was built on.
   */
  requirePermitted(actor: ActorContext, name: string): ToolDefinition<never, never> {
    const tool = this.require(name);
    const held = new Set(actor.permissions);
    const missing = tool.permissions.filter((permission) => !held.has(permission));
    if (missing.length > 0) {
      throw forbidden(
        'AGENT_TOOL_NOT_PERMITTED',
        `You do not have permission to ${tool.summary['en-IN'].toLowerCase()}, so the assistant cannot do it for you either.`,
        { details: { tool: name, missing: missing.join(', ') } },
      );
    }
    return tool;
  }

  parseFor(name: string, input: unknown): unknown {
    const tool = this.require(name);
    try {
      return tool.parse(input);
    } catch (error) {
      throw invalid('AGENT_TOOL_INPUT_INVALID', error instanceof Error ? error.message : `"${name}" was given something it cannot use.`, {
        details: { tool: name },
      });
    }
  }

  names(): readonly string[] {
    return [...this.#tools.keys()].sort();
  }
}

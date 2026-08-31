/** Issue #47 [E47] — what the agent needs from outside the tool registry. */
import type { IsoDate } from '@invoice/kernel';
import type { ActorContext } from '@invoice/ledger';
import type { AgentPlan, AgentReport } from './model.ts';

export interface ResolvedParty {
  readonly partyId: string;
  readonly name: string;
}

/**
 * Turning "ABC" into a customer.
 *
 * It returns every match rather than the best one. One match is a fact; several are a question the
 * agent must ask; none is a refusal. Picking the nearest name would be the product deciding whose
 * money it is, which is exactly the decision it must never make on its own.
 */
export interface PartyDirectoryPort {
  resolve(actor: ActorContext, text: string): Promise<readonly ResolvedParty[]>;
  nameOf(actor: ActorContext, partyId: string): Promise<string>;
}

export interface AgentPlanStore {
  put(plan: AgentPlan): Promise<void>;
  find(companyId: string, id: string): Promise<AgentPlan | null>;
  list(companyId: string): Promise<readonly AgentPlan[]>;
  putReport(companyId: string, key: string, report: AgentReport): Promise<void>;
  findReport(companyId: string, key: string): Promise<AgentReport | null>;
  reportFor(companyId: string, planId: string): Promise<AgentReport | null>;
}

export interface AgentRequest {
  /** What the person asked for, in their words. Data — never an instruction to this product. */
  readonly text: string;
  readonly today: IsoDate;
}

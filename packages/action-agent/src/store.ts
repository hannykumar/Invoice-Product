/** Issue #47 [E47] — plans and reports, company-scoped at every read. */
import type { AgentPlan, AgentReport } from './model.ts';
import type { AgentPlanStore } from './ports.ts';

export class InMemoryAgentPlanStore implements AgentPlanStore {
  readonly #plans = new Map<string, AgentPlan>();
  readonly #reports = new Map<string, AgentReport>();
  readonly #byPlan = new Map<string, AgentReport>();

  async put(plan: AgentPlan): Promise<void> {
    this.#plans.set(`${plan.companyId}:${plan.id}`, plan);
  }

  async find(companyId: string, id: string): Promise<AgentPlan | null> {
    const plan = this.#plans.get(`${companyId}:${id}`);
    return plan !== undefined && plan.companyId === companyId ? plan : null;
  }

  async list(companyId: string): Promise<readonly AgentPlan[]> {
    return [...this.#plans.values()]
      .filter((plan) => plan.companyId === companyId)
      .sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1));
  }

  async putReport(companyId: string, key: string, report: AgentReport): Promise<void> {
    this.#reports.set(`${companyId}:${key}`, report);
    this.#byPlan.set(`${companyId}:${report.planId}`, report);
  }

  async findReport(companyId: string, key: string): Promise<AgentReport | null> {
    return this.#reports.get(`${companyId}:${key}`) ?? null;
  }

  async reportFor(companyId: string, planId: string): Promise<AgentReport | null> {
    return this.#byPlan.get(`${companyId}:${planId}`) ?? null;
  }
}

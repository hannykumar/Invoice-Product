/** Issue #47 [E47] — plans and reports, company-scoped at every read. */
import { conflict } from '@invoice/kernel';
import type { AgentPlan, AgentReport } from './model.ts';
import type { AgentPlanStore, Page } from './ports.ts';

export const REPORT_EXISTS = () => conflict('AGENT_REPORT_EXISTS', 'This run has already been reported.');

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

  async list(companyId: string, page?: Page): Promise<readonly AgentPlan[]> {
    // Reversed first, so the stable sort puts the later-saved of two same-moment plans first.
    const plans = [...this.#plans.values()]
      .filter((plan) => plan.companyId === companyId)
      .reverse()
      .sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : a.requestedAt > b.requestedAt ? -1 : 0));
    if (page === undefined) return plans;
    const from = page.after === undefined ? 0 : plans.findIndex((plan) => plan.id === page.after) + 1;
    return plans.slice(from, from + page.limit);
  }

  async putReport(companyId: string, key: string, report: AgentReport): Promise<void> {
    if (this.#reports.has(`${companyId}:${key}`)) throw REPORT_EXISTS();
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

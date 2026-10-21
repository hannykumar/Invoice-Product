/**
 * Issue #23 [E23] — an in-memory store, company-scoped at every read.
 *
 * Every lookup filters on the company id even though the map keys already contain it, because a
 * store that is only safe when the key is built correctly is one typo from leaking another
 * business's customers.
 *
 * Issue #366 — it behaves as `PostgresReminderRepository` does: the same order, the same pages, the
 * same refusals. `packages/collections/test/reminder-repository-contract.ts` runs against both.
 */
import { conflict, notFound, type CompanyId, type PartyId } from '@invoice/kernel';
import type { ContactPreference, Dispute, OptOut, PromiseToPay, Reminder } from './model.ts';
import type { Page, ReminderRepository } from './ports.ts';

export const reminderDuplicate = () => conflict('REMINDER_DUPLICATE', 'This reminder has already been recorded.');
export const reminderNotFound = () => notFound('REMINDER_NOT_FOUND', 'That reminder does not exist in this business.');

/** One page of an already-sorted list. An `after` that is not in the list yields an empty page. */
const pageOf = <T>(sorted: T[], keyOf: (item: T) => string, page?: Page): T[] => {
  if (page === undefined) return sorted;
  const start = page.after === undefined ? 0 : sorted.findIndex((item) => keyOf(item) === page.after) + 1;
  return page.after !== undefined && start === 0 ? [] : sorted.slice(start, start + page.limit);
};
const ascending = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export class InMemoryReminderRepository implements ReminderRepository {
  readonly #reminders = new Map<string, Reminder>();
  readonly #preferences = new Map<string, ContactPreference>();
  readonly #optOuts = new Map<string, OptOut>();
  readonly #promises = new Map<string, PromiseToPay>();
  readonly #disputes = new Map<string, Dispute>();

  async insert(reminder: Reminder): Promise<void> {
    const id = `${reminder.companyId}:${reminder.id}`;
    if (this.#reminders.has(id) || (await this.findByKey(reminder.companyId, reminder.reminderKey)) !== null) throw reminderDuplicate();
    this.#reminders.set(id, reminder);
  }

  async update(reminder: Reminder): Promise<void> {
    const id = `${reminder.companyId}:${reminder.id}`;
    if (!this.#reminders.has(id)) throw reminderNotFound();
    const clash = await this.findByKey(reminder.companyId, reminder.reminderKey);
    if (clash !== null && clash.id !== reminder.id) throw reminderDuplicate();
    this.#reminders.set(id, reminder);
  }

  async findByKey(companyId: CompanyId, key: string): Promise<Reminder | null> {
    return [...this.#reminders.values()].find((r) => r.companyId === companyId && r.reminderKey === key) ?? null;
  }

  async findById(companyId: CompanyId, id: string): Promise<Reminder | null> {
    const found = this.#reminders.get(`${companyId}:${id}`);
    return found !== undefined && found.companyId === companyId ? found : null;
  }

  async list(companyId: CompanyId, page?: Page): Promise<readonly Reminder[]> {
    const sorted = [...this.#reminders.values()]
      .filter((r) => r.companyId === companyId)
      .sort((a, b) => ascending(b.scheduledAt, a.scheduledAt) || ascending(b.id, a.id));
    return pageOf(sorted, (r) => r.id, page);
  }

  async savePreference(preference: ContactPreference): Promise<void> {
    this.#preferences.set(`${preference.companyId}:${preference.partyId}:${preference.channel}`, preference);
  }

  async preferences(companyId: CompanyId, partyId: PartyId, page?: Page): Promise<readonly ContactPreference[]> {
    const sorted = [...this.#preferences.values()]
      .filter((p) => p.companyId === companyId && p.partyId === partyId)
      .sort((a, b) => ascending(a.channel, b.channel));
    return pageOf(sorted, (p) => p.channel, page);
  }

  async saveOptOut(optOut: OptOut): Promise<void> {
    this.#optOuts.set(`${optOut.companyId}:${optOut.partyId}`, optOut);
  }

  async removeOptOut(companyId: CompanyId, partyId: PartyId): Promise<void> {
    this.#optOuts.delete(`${companyId}:${partyId}`);
  }

  async optOut(companyId: CompanyId, partyId: PartyId): Promise<OptOut | null> {
    const found = this.#optOuts.get(`${companyId}:${partyId}`);
    return found !== undefined && found.companyId === companyId ? found : null;
  }

  async savePromise(promise: PromiseToPay): Promise<void> {
    this.#promises.set(`${promise.companyId}:${promise.id}`, promise);
  }

  async promises(companyId: CompanyId, page?: Page): Promise<readonly PromiseToPay[]> {
    const sorted = [...this.#promises.values()]
      .filter((p) => p.companyId === companyId)
      .sort((a, b) => ascending(a.recordedAt, b.recordedAt) || ascending(a.id, b.id));
    return pageOf(sorted, (p) => p.id, page);
  }

  async saveDispute(dispute: Dispute): Promise<void> {
    this.#disputes.set(`${dispute.companyId}:${dispute.id}`, dispute);
  }

  async disputes(companyId: CompanyId, page?: Page): Promise<readonly Dispute[]> {
    const sorted = [...this.#disputes.values()]
      .filter((d) => d.companyId === companyId)
      .sort((a, b) => ascending(a.raisedAt, b.raisedAt) || ascending(a.id, b.id));
    return pageOf(sorted, (d) => d.id, page);
  }
}

/**
 * Issue #23 [E23] — an in-memory store, company-scoped at every read.
 *
 * Every lookup filters on the company id even though the map keys already contain it, because a
 * store that is only safe when the key is built correctly is one typo from leaking another
 * business's customers.
 */
import type { CompanyId, PartyId } from '@invoice/kernel';
import type { ContactPreference, Dispute, OptOut, PromiseToPay, Reminder } from './model.ts';
import type { ReminderRepository } from './ports.ts';

export class InMemoryReminderRepository implements ReminderRepository {
  readonly #reminders = new Map<string, Reminder>();
  readonly #preferences = new Map<string, ContactPreference>();
  readonly #optOuts = new Map<string, OptOut>();
  readonly #promises = new Map<string, PromiseToPay>();
  readonly #disputes = new Map<string, Dispute>();

  async insert(reminder: Reminder): Promise<void> {
    this.#reminders.set(`${reminder.companyId}:${reminder.id}`, reminder);
  }

  async update(reminder: Reminder): Promise<void> {
    this.#reminders.set(`${reminder.companyId}:${reminder.id}`, reminder);
  }

  async findByKey(companyId: CompanyId, key: string): Promise<Reminder | null> {
    return [...this.#reminders.values()].find((r) => r.companyId === companyId && r.reminderKey === key) ?? null;
  }

  async findById(companyId: CompanyId, id: string): Promise<Reminder | null> {
    const found = this.#reminders.get(`${companyId}:${id}`);
    return found !== undefined && found.companyId === companyId ? found : null;
  }

  async list(companyId: CompanyId): Promise<readonly Reminder[]> {
    return [...this.#reminders.values()]
      .filter((r) => r.companyId === companyId)
      .sort((a, b) => (a.scheduledAt < b.scheduledAt ? 1 : -1));
  }

  async savePreference(preference: ContactPreference): Promise<void> {
    this.#preferences.set(`${preference.companyId}:${preference.partyId}:${preference.channel}`, preference);
  }

  async preferences(companyId: CompanyId, partyId: PartyId): Promise<readonly ContactPreference[]> {
    return [...this.#preferences.values()].filter((p) => p.companyId === companyId && p.partyId === partyId);
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

  async promises(companyId: CompanyId): Promise<readonly PromiseToPay[]> {
    return [...this.#promises.values()].filter((p) => p.companyId === companyId);
  }

  async saveDispute(dispute: Dispute): Promise<void> {
    this.#disputes.set(`${dispute.companyId}:${dispute.id}`, dispute);
  }

  async disputes(companyId: CompanyId): Promise<readonly Dispute[]> {
    return [...this.#disputes.values()].filter((d) => d.companyId === companyId);
  }
}

import type { CompanyId, PartyId } from '@invoice/kernel';
import type {
  CollectionCommunication,
  CollectionDispute,
  CollectionPreference,
  PaymentPromise,
  ScheduledReminder,
} from './model.ts';
import type { CollectionRepository } from './ports.ts';

const tenantParty = (companyId: CompanyId, partyId: PartyId) => `${companyId}:${partyId}`;

export class InMemoryCollectionRepository implements CollectionRepository {
  readonly #preferences = new Map<string, CollectionPreference>();
  readonly #reminders = new Map<string, ScheduledReminder>();
  readonly #reminderKeys = new Map<string, string>();
  readonly #promises = new Map<string, PaymentPromise>();
  readonly #disputes = new Map<string, CollectionDispute>();
  readonly #communications = new Map<string, CollectionCommunication>();

  async preference(companyId: CompanyId, partyId: PartyId) { return this.#preferences.get(tenantParty(companyId, partyId)) ?? null; }
  async savePreference(preference: CollectionPreference) { this.#preferences.set(tenantParty(preference.companyId, preference.partyId), preference); }
  async insertReminder(reminder: ScheduledReminder) {
    const key = `${reminder.companyId}:${reminder.deduplicationKey}`;
    if (this.#reminderKeys.has(key)) throw new Error('A reminder already uses this deduplication key.');
    this.#reminders.set(reminder.id, reminder);
    this.#reminderKeys.set(key, reminder.id);
  }
  async updateReminder(reminder: ScheduledReminder) {
    const found = this.#reminders.get(reminder.id);
    if (found === undefined || found.companyId !== reminder.companyId) throw new Error('Reminder was not found.');
    this.#reminders.set(reminder.id, reminder);
  }
  async reminderByKey(companyId: CompanyId, key: string) {
    const id = this.#reminderKeys.get(`${companyId}:${key}`);
    return id === undefined ? null : this.#reminders.get(id) ?? null;
  }
  async reminders(companyId: CompanyId) { return [...this.#reminders.values()].filter((item) => item.companyId === companyId); }
  async insertPromise(promise: PaymentPromise) { this.#promises.set(promise.id, promise); }
  async updatePromise(promise: PaymentPromise) { this.#promises.set(promise.id, promise); }
  async promises(companyId: CompanyId, partyId: PartyId) { return [...this.#promises.values()].filter((item) => item.companyId === companyId && item.partyId === partyId); }
  async insertDispute(dispute: CollectionDispute) { this.#disputes.set(dispute.id, dispute); }
  async updateDispute(dispute: CollectionDispute) { this.#disputes.set(dispute.id, dispute); }
  async disputes(companyId: CompanyId, partyId: PartyId) { return [...this.#disputes.values()].filter((item) => item.companyId === companyId && item.partyId === partyId); }
  async insertCommunication(communication: CollectionCommunication) { this.#communications.set(communication.id, communication); }
  async communications(companyId: CompanyId, partyId?: PartyId) {
    return [...this.#communications.values()].filter((item) => item.companyId === companyId && (partyId === undefined || item.partyId === partyId));
  }
}

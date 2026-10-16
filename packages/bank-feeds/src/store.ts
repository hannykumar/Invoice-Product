/**
 * Issue #366 — where BankFeedService keeps its records. Before #366 these were private Maps inside
 * the service; this port is the smallest seam that lets the same service run on memory or on
 * PostgreSQL (postgres-store.ts) without changing what it does.
 */
import type { BankFeedAccount, BankFeedAuditEvent, BankFeedConnection, BankFeedTransaction, SyncResult } from './model.ts';

/** Keyset page: at most `limit` rows after the row whose id is `after`, in the order they were written. */
export interface Page { readonly limit?: number; readonly after?: string }

/** `${accountId}:${providerTransactionId}` — how a provider transaction already imported is recognised. */
export const providerKey = (accountId: string, providerTransactionId: string): string => `${accountId}:${providerTransactionId}`;

export interface BankFeedStore {
  /**
   * The connection with this id. Memory returns it whichever company it belongs to, so the service
   * can answer TENANT_ISOLATION as it always has; PostgreSQL's row-level security hides another
   * company's row, so there the answer is NOT_FOUND. Either way the caller is refused.
   */
  connection(companyId: string, id: string): Promise<BankFeedConnection | null>;
  connections(companyId: string, page?: Page): Promise<readonly BankFeedConnection[]>;
  /** Insert or replace. */
  saveConnection(connection: BankFeedConnection): Promise<void>;
  accounts(companyId: string, connectionId: string, page?: Page): Promise<readonly BankFeedAccount[]>;
  /** Insert or replace. */
  saveAccount(account: BankFeedAccount): Promise<void>;
  /** Which of these provider transactions are already imported, as `providerKey`s. */
  knownProviderTransactions(companyId: string, keys: readonly { accountId: string; providerTransactionId: string }[]): Promise<ReadonlySet<string>>;
  /** Imported transactions are final: added, never changed. */
  addTransactions(transactions: readonly BankFeedTransaction[]): Promise<void>;
  transactions(companyId: string, connectionId: string, page?: Page): Promise<readonly BankFeedTransaction[]>;
  countTransactions(companyId: string, connectionId: string): Promise<number>;
  syncResult(companyId: string, connectionId: string, idempotencyKey: string): Promise<SyncResult | null>;
  saveSyncResult(companyId: string, connectionId: string, idempotencyKey: string, result: SyncResult): Promise<void>;
  record(event: BankFeedAuditEvent): Promise<void>;
  audit(companyId: string, connectionId?: string, page?: Page): Promise<readonly BankFeedAuditEvent[]>;
}

const paged = <T extends { id: string }>(rows: readonly T[], page?: Page): readonly T[] => {
  const start = page?.after === undefined ? 0 : rows.findIndex((row) => row.id === page.after) + 1;
  return Object.freeze(rows.slice(start, page?.limit === undefined ? undefined : start + page.limit));
};

/** What the service did with its Maps, unchanged. */
export class InMemoryBankFeedStore implements BankFeedStore {
  readonly #connections = new Map<string, BankFeedConnection>();
  readonly #accounts = new Map<string, BankFeedAccount>();
  readonly #transactions = new Map<string, BankFeedTransaction>();
  readonly #providerTransactionKeys = new Set<string>();
  readonly #syncKeys = new Map<string, SyncResult>();
  readonly #audit: BankFeedAuditEvent[] = [];

  async connection(_companyId: string, id: string) { return this.#connections.get(id) ?? null; }
  async connections(companyId: string, page?: Page) { return paged([...this.#connections.values()].filter((item) => item.companyId === companyId), page); }
  async saveConnection(connection: BankFeedConnection) { this.#connections.set(connection.id, connection); }
  async accounts(companyId: string, connectionId: string, page?: Page) { return paged([...this.#accounts.values()].filter((item) => item.companyId === companyId && item.connectionId === connectionId), page); }
  async saveAccount(account: BankFeedAccount) { this.#accounts.set(account.id, account); }
  async knownProviderTransactions(companyId: string, keys: readonly { accountId: string; providerTransactionId: string }[]) {
    return new Set(keys.map((key) => providerKey(key.accountId, key.providerTransactionId)).filter((key) => this.#providerTransactionKeys.has(`${companyId}:${key}`)));
  }
  async addTransactions(transactions: readonly BankFeedTransaction[]) {
    for (const transaction of transactions) {
      this.#transactions.set(transaction.id, transaction);
      this.#providerTransactionKeys.add(`${transaction.companyId}:${providerKey(transaction.accountId, transaction.providerTransactionId)}`);
    }
  }
  async transactions(companyId: string, connectionId: string, page?: Page) { return paged([...this.#transactions.values()].filter((item) => item.companyId === companyId && item.connectionId === connectionId), page); }
  async countTransactions(companyId: string, connectionId: string) { return (await this.transactions(companyId, connectionId)).length; }
  async syncResult(companyId: string, connectionId: string, idempotencyKey: string) { return this.#syncKeys.get(`${companyId}:${connectionId}:${idempotencyKey}`) ?? null; }
  async saveSyncResult(companyId: string, connectionId: string, idempotencyKey: string, result: SyncResult) { this.#syncKeys.set(`${companyId}:${connectionId}:${idempotencyKey}`, result); }
  async record(event: BankFeedAuditEvent) { this.#audit.push(event); }
  async audit(companyId: string, connectionId?: string, page?: Page) { return paged(this.#audit.filter((event) => event.companyId === companyId && (!connectionId || event.connectionId === connectionId)), page); }
}

import { createHash, randomUUID } from 'node:crypto';
import { ConnectorError } from '../../platform/src/connectors.ts';
import { PlatformError } from '../../platform/src/types.ts';
import type { BankFeedAccount, BankFeedAuditEvent, BankFeedConnection, BankFeedContext, BankFeedProviderAdapter, BankFeedTransaction, ProviderAccount, ProviderAccountPage, SyncResult } from './model.ts';

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const frozen = <T>(value: T): T => Object.freeze(value);
const validDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
const safeMask = (value: string): boolean => /[*xX•]/.test(value) && !/\d{9,}/.test(value.replace(/\D/g, ''));

export class BankFeedService {
  readonly #adapters: ReadonlyMap<string, BankFeedProviderAdapter>;
  readonly #connections = new Map<string, BankFeedConnection>();
  readonly #accounts = new Map<string, BankFeedAccount>();
  readonly #transactions = new Map<string, BankFeedTransaction>();
  readonly #providerTransactionKeys = new Map<string, string>();
  readonly #syncKeys = new Map<string, SyncResult>();
  readonly #audit: BankFeedAuditEvent[] = [];
  readonly #now: () => Date;

  constructor(adapters: readonly BankFeedProviderAdapter[], now: () => Date = () => new Date()) {
    this.#adapters = new Map(adapters.map((adapter) => [adapter.provider, adapter]));
    this.#now = now;
  }

  async startConsent(context: BankFeedContext, input: { provider: string; redirectUri: string }): Promise<BankFeedConnection> {
    this.#require(context, 'bank.feed.manage');
    const adapter = this.#adapters.get(input.provider);
    if (!adapter) throw new PlatformError('NOT_FOUND', 'This bank connection provider is not supported.');
    if (!/^https:\/\//.test(input.redirectUri) && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//.test(input.redirectUri)) throw new Error('Use a secure return address for bank permission.');
    const id = randomUUID();
    const pending: BankFeedConnection = frozen({ id, companyId: context.companyId, provider: input.provider, providerConsentId: null, consentUrl: null, status: 'PENDING_CONSENT', consentExpiresAt: null, connectedAt: null, disconnectedAt: null, lastSyncedAt: null, syncStatus: 'IDLE', lastError: null, createdAt: this.#now().toISOString() });
    this.#connections.set(id, pending);
    try {
      const consent = await adapter.startConsent({ companyId: context.companyId, connectionId: id, redirectUri: input.redirectUri });
      const result = frozen({ ...pending, providerConsentId: consent.providerConsentId, consentUrl: consent.consentUrl, consentExpiresAt: consent.expiresAt });
      this.#connections.set(id, result);
      this.#record(context, result, 'bank_feed.consent_started', { provider: result.provider, consentExpiresAt: result.consentExpiresAt });
      return result;
    } catch (error) {
      this.#connections.set(id, frozen({ ...pending, status: 'ERROR', lastError: this.#message(error) }));
      throw error;
    }
  }

  async completeConsent(context: BankFeedContext, connectionId: string, authorizationCode: string): Promise<BankFeedConnection> {
    this.#require(context, 'bank.feed.manage');
    const connection = this.#get(context, connectionId);
    if (connection.status !== 'PENDING_CONSENT' || !connection.providerConsentId) throw new PlatformError('INVALID_TRANSITION', 'This bank permission request cannot be completed.');
    if (!authorizationCode.trim()) throw new Error('The bank permission response is missing.');
    const result = await this.#adapter(connection).completeConsent({ companyId: context.companyId, providerConsentId: connection.providerConsentId, authorizationCode });
    const seen = new Set<string>();
    for (const account of result.accounts) {
      this.#validateAccount(account);
      if (seen.has(account.providerAccountId)) throw new Error('The provider returned the same bank account twice.');
      seen.add(account.providerAccountId);
    }
    for (const account of result.accounts) this.#saveAccount(connection, account);
    const connected = frozen({ ...connection, consentUrl: null, consentExpiresAt: result.consentExpiresAt, status: 'CONNECTED' as const, connectedAt: this.#now().toISOString(), lastError: null });
    this.#connections.set(connection.id, connected);
    this.#record(context, connected, 'bank_feed.connected', { provider: connected.provider, accountCount: result.accounts.length, consentExpiresAt: connected.consentExpiresAt });
    return connected;
  }

  async sync(context: BankFeedContext, connectionId: string, idempotencyKey: string): Promise<SyncResult> {
    this.#require(context, 'bank.feed.sync');
    if (!idempotencyKey.trim()) throw new Error('A sync idempotency key is required.');
    const connection = this.#get(context, connectionId);
    const syncKey = `${context.companyId}:${connectionId}:${idempotencyKey}`;
    const prior = this.#syncKeys.get(syncKey);
    if (prior) return prior;
    if (connection.status !== 'CONNECTED' || !connection.providerConsentId) throw new PlatformError('INVALID_TRANSITION', connection.status === 'TOKEN_EXPIRED' ? 'Bank permission expired. Reconnect this account before syncing.' : 'Connect this bank account before syncing.');
    if (connection.consentExpiresAt && Date.parse(connection.consentExpiresAt) <= this.#now().getTime()) {
      const expired = frozen({ ...connection, status: 'TOKEN_EXPIRED' as const, syncStatus: 'FAILED' as const, lastError: 'Bank permission expired. Reconnect to continue.' });
      this.#connections.set(connection.id, expired);
      this.#record(context, expired, 'bank_feed.token_expired', {});
      throw new PlatformError('INVALID_TRANSITION', expired.lastError!);
    }
    const processing = frozen({ ...connection, syncStatus: 'PROCESSING' as const, lastError: null });
    this.#connections.set(connection.id, processing);
    this.#record(context, processing, 'bank_feed.sync_started', { idempotencyKey });
    const accounts = this.#accountsFor(context, connection.id);
    try {
      const page = await this.#adapter(connection).sync({ companyId: context.companyId, providerConsentId: connection.providerConsentId, cursors: Object.fromEntries(accounts.map((account) => [account.providerAccountId, account.cursor])), idempotencyKey });
      const staged = this.#validatePage(context, connection, accounts, page.accounts);
      for (const account of staged.accounts) this.#accounts.set(account.id, account);
      for (const transaction of staged.transactions) { this.#transactions.set(transaction.id, transaction); this.#providerTransactionKeys.set(`${context.companyId}:${connection.id}:${transaction.accountId}:${transaction.providerTransactionId}`, transaction.id); }
      const succeeded = frozen({ ...processing, syncStatus: 'SUCCEEDED' as const, lastSyncedAt: this.#now().toISOString(), lastError: null });
      this.#connections.set(connection.id, succeeded);
      const result: SyncResult = frozen({ connection: succeeded, imported: staged.transactions.length, duplicates: staged.duplicates, transactions: frozen(staged.transactions) });
      this.#syncKeys.set(syncKey, result);
      this.#record(context, succeeded, 'bank_feed.sync_succeeded', { imported: result.imported, duplicates: result.duplicates, accountCount: staged.accounts.length });
      return result;
    } catch (error) {
      const status = error instanceof ConnectorError && error.code === 'UNAUTHORIZED' ? 'TOKEN_EXPIRED' as const : 'CONNECTED' as const;
      const failed = frozen({ ...processing, status, syncStatus: 'FAILED' as const, lastError: this.#message(error) });
      this.#connections.set(connection.id, failed);
      this.#record(context, failed, status === 'TOKEN_EXPIRED' ? 'bank_feed.token_expired' : 'bank_feed.sync_failed', { retryable: error instanceof ConnectorError ? error.retryable : false, code: error instanceof ConnectorError ? error.code : 'INVALID_PROVIDER_DATA' });
      throw error;
    }
  }

  async disconnect(context: BankFeedContext, connectionId: string, idempotencyKey: string): Promise<BankFeedConnection> {
    this.#require(context, 'bank.feed.manage');
    const connection = this.#get(context, connectionId);
    if (connection.status === 'DISCONNECTED') return connection;
    if (connection.providerConsentId && connection.status !== 'REVOKED') await this.#adapter(connection).revoke({ companyId: context.companyId, providerConsentId: connection.providerConsentId, idempotencyKey });
    for (const account of this.#accountsFor(context, connection.id)) this.#accounts.set(account.id, frozen({ ...account, active: false }));
    const disconnected = frozen({ ...connection, status: 'DISCONNECTED' as const, consentUrl: null, disconnectedAt: this.#now().toISOString(), syncStatus: 'IDLE' as const, lastError: null });
    this.#connections.set(connection.id, disconnected);
    this.#record(context, disconnected, 'bank_feed.disconnected', { historicalTransactionsPreserved: this.transactions(context, connection.id).length });
    return disconnected;
  }

  markRevoked(context: BankFeedContext, connectionId: string): BankFeedConnection {
    this.#require(context, 'bank.feed.manage');
    const connection = this.#get(context, connectionId);
    for (const account of this.#accountsFor(context, connection.id)) this.#accounts.set(account.id, frozen({ ...account, active: false }));
    const revoked = frozen({ ...connection, status: 'REVOKED' as const, consentUrl: null, syncStatus: 'IDLE' as const, lastError: 'The bank withdrew permission for this connection.' });
    this.#connections.set(connection.id, revoked);
    this.#record(context, revoked, 'bank_feed.revoked', { historicalDataPreserved: true });
    return revoked;
  }

  connections(context: BankFeedContext): readonly BankFeedConnection[] { this.#requireAny(context); return frozen([...this.#connections.values()].filter((item) => item.companyId === context.companyId)); }
  accounts(context: BankFeedContext, connectionId: string): readonly BankFeedAccount[] { this.#requireAny(context); this.#get(context, connectionId); return frozen(this.#accountsFor(context, connectionId)); }
  transactions(context: BankFeedContext, connectionId: string): readonly BankFeedTransaction[] { this.#requireAny(context); this.#get(context, connectionId); return frozen([...this.#transactions.values()].filter((item) => item.companyId === context.companyId && item.connectionId === connectionId)); }
  audit(context: BankFeedContext, connectionId?: string): readonly BankFeedAuditEvent[] { this.#requireAny(context); return frozen(this.#audit.filter((event) => event.companyId === context.companyId && (!connectionId || event.connectionId === connectionId))); }

  #validatePage(context: BankFeedContext, connection: BankFeedConnection, known: readonly BankFeedAccount[], pages: readonly ProviderAccountPage[]) {
    const accountByProvider = new Map(known.map((account) => [account.providerAccountId, account]));
    const accounts: BankFeedAccount[] = [];
    const transactions: BankFeedTransaction[] = [];
    const stagedKeys = new Set<string>();
    let duplicates = 0;
    for (const page of pages) {
      const account = accountByProvider.get(page.providerAccountId);
      if (!account) throw new Error('The provider returned a bank account outside this connection.');
      if (page.balanceAsOf !== null && Number.isNaN(Date.parse(page.balanceAsOf))) throw new Error('The provider returned an uncertain account balance.');
      for (const item of page.transactions) {
        if (!item.providerTransactionId || !validDate(item.bookedOn) || !item.description.trim() || item.amountMinor <= 0n) throw new Error('The provider returned an incomplete bank transaction.');
        const key = `${context.companyId}:${connection.id}:${account.id}:${item.providerTransactionId}`;
        if (this.#providerTransactionKeys.has(key) || stagedKeys.has(key)) { duplicates += 1; continue; }
        stagedKeys.add(key);
        const debitPaise = item.direction === 'DEBIT' ? item.amountMinor : 0n;
        const creditPaise = item.direction === 'CREDIT' ? item.amountMinor : 0n;
        transactions.push(frozen({ id: randomUUID(), companyId: context.companyId, connectionId: connection.id, accountId: account.id, providerTransactionId: item.providerTransactionId, bookedOn: item.bookedOn, description: item.description.trim(), debitPaise, creditPaise, ...(item.reference ? { reference: item.reference } : {}), fingerprint: digest(`${context.companyId}\u0000${connection.id}\u0000${account.id}\u0000${item.providerTransactionId}`), importedAt: this.#now().toISOString() }));
      }
      accounts.push(frozen({ ...account, balancePaise: page.balanceMinor, balanceAsOf: page.balanceAsOf, cursor: page.nextCursor }));
    }
    return { accounts, transactions, duplicates };
  }

  #saveAccount(connection: BankFeedConnection, account: ProviderAccount): void { const current = [...this.#accounts.values()].find((item) => item.companyId === connection.companyId && item.connectionId === connection.id && item.providerAccountId === account.providerAccountId); const saved = frozen({ id: current?.id ?? randomUUID(), companyId: connection.companyId, connectionId: connection.id, providerAccountId: account.providerAccountId, displayName: account.displayName, maskedAccountNumber: account.maskedAccountNumber, accountType: account.accountType, currency: 'INR' as const, balancePaise: current?.balancePaise ?? null, balanceAsOf: current?.balanceAsOf ?? null, cursor: current?.cursor ?? null, active: true }); this.#accounts.set(saved.id, saved); }
  #validateAccount(account: ProviderAccount): void { if (!account.providerAccountId || !account.displayName.trim() || account.currency !== 'INR' || !['CURRENT', 'SAVINGS', 'CASH_CREDIT', 'OTHER'].includes(account.accountType) || !safeMask(account.maskedAccountNumber)) throw new Error('The provider returned an unsupported or unsafe bank account.'); }
  #accountsFor(context: BankFeedContext, connectionId: string): BankFeedAccount[] { return [...this.#accounts.values()].filter((item) => item.companyId === context.companyId && item.connectionId === connectionId); }
  #get(context: BankFeedContext, id: string): BankFeedConnection { const connection = this.#connections.get(id); if (!connection) throw new PlatformError('NOT_FOUND', 'Bank connection was not found.'); if (connection.companyId !== context.companyId) throw new PlatformError('TENANT_ISOLATION', 'This bank connection belongs to another company.'); return connection; }
  #adapter(connection: BankFeedConnection): BankFeedProviderAdapter { const adapter = this.#adapters.get(connection.provider); if (!adapter) throw new PlatformError('NOT_FOUND', 'This bank connection provider is not available.'); return adapter; }
  #require(context: BankFeedContext, permission: string): void { if (!context.permissions.has(permission)) throw new PlatformError('FORBIDDEN', 'You do not have permission to manage live bank connections.'); }
  #requireAny(context: BankFeedContext): void { if (!context.permissions.has('bank.feed.manage') && !context.permissions.has('bank.feed.sync') && !context.permissions.has('bank.balance.read')) throw new PlatformError('FORBIDDEN', 'You do not have permission to view live bank connections.'); }
  #message(error: unknown): string { if (error instanceof ConnectorError) return error.code === 'UNAUTHORIZED' ? 'Bank permission expired. Reconnect to continue.' : 'The bank is temporarily unavailable. Your last successful import is unchanged; try again.'; return error instanceof Error ? error.message : 'The bank sync could not be completed.'; }
  #record(context: BankFeedContext, connection: BankFeedConnection, action: BankFeedAuditEvent['action'], details: Record<string, unknown>): void { this.#audit.push(frozen({ id: randomUUID(), companyId: context.companyId, actorId: context.actorId, action, connectionId: connection.id, occurredAt: this.#now().toISOString(), details: frozen({ ...details }) })); }
}

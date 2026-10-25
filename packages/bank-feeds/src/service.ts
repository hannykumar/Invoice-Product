import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ConnectorError } from '../../platform/src/connectors.ts';
import { PlatformError } from '../../platform/src/types.ts';
import type { BankFeedAccount, BankFeedAuditEvent, BankFeedConnection, BankFeedConsentRequest, BankFeedContext, ConsentReturnPolicy, BankFeedProviderAdapter, BankFeedTransaction, ConsentStart, ProviderAccount, ProviderAccountPage, SyncResult } from './model.ts';
import { InMemoryBankFeedStore, providerKey, type BankFeedStore, type Page } from './store.ts';

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const frozen = <T>(value: T): T => Object.freeze(value);
const validDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
const safeMask = (value: string): boolean => /[*xX•]/.test(value) && !/\d{9,}/.test(value.replace(/\D/g, ''));
const CHANGED = 'This bank connection changed while the bank was answering. Open it again and retry.';
const RETURN_REFUSED = 'The bank can only send you back to this app. Start again from Bank feeds.';
const NOT_SET_UP = 'Bank connections are not set up on this server yet, so no bank was asked.';
const STATE_REFUSED = 'This bank reply does not belong to a request you started here, or it was already used or has run out of time. Start again from Bank feeds.';
/** Issue #402 — how long the bank's reply may take to come back after a request starts. */
const CONSENT_STATE_LIFETIME_MS = 30 * 60 * 1000;
/**
 * Issue #402 — the page the bank sends the customer back to: the app's start page, the one address
 * the web server always serves the app on (#393). The app reads the bank's `code` and `state` there.
 */
export const BANK_RETURN_PATH = '/';
const loopback = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;

/** Each allowed origin joined to the fixed return page. Refuses an origin that is not https or loopback. */
const returnAddresses = (policy: ConsentReturnPolicy): readonly string[] => {
  if (!/^\/[A-Za-z0-9/_-]*$/.test(policy.path)) throw new Error('The bank return page must be a plain path on this app.');
  return Object.freeze(policy.origins.map((value) => {
    const origin = new URL(value).origin;
    if (origin !== value.replace(/\/+$/, '') || (!origin.startsWith('https://') && !loopback.test(origin))) throw new Error(`The bank return origin ${value} must be https, or localhost for development.`);
    return `${origin}${policy.path}`;
  }));
};

export class BankFeedService {
  readonly #adapters: ReadonlyMap<string, BankFeedProviderAdapter>;
  readonly #store: BankFeedStore;
  readonly #now: () => Date;
  readonly #returnAddresses: readonly string[];

  /**
   * Issue #366: `store` is where the records live — memory by default, or PostgresBankFeedStore.
   *
   * The bank is never called inside a unit of work (unit-of-work-v1: the company's lock would be
   * held while the bank answers). Each command reads in one short action, lets go, calls the bank,
   * then writes in a second action that re-reads and re-checks what could have changed meanwhile
   * (the connection's state, the sync key, the cursors). A provider failure is written in an action
   * of its own, so it is committed before the error reaches the caller. The caller must therefore
   * not wrap these commands in a unit of work of its own (apps/api: `postCallingOut`).
   *
   * Issue #402: `consentReturn` is the only place the bank may send the customer back to. With no
   * origins, no consent can start.
   */
  constructor(adapters: readonly BankFeedProviderAdapter[], now: () => Date = () => new Date(), store: BankFeedStore = new InMemoryBankFeedStore(), consentReturn: ConsentReturnPolicy = { origins: [], path: BANK_RETURN_PATH }) {
    this.#adapters = new Map(adapters.map((adapter) => [adapter.provider, adapter]));
    this.#now = now;
    this.#store = store;
    this.#returnAddresses = returnAddresses(consentReturn);
  }

  /**
   * Issue #402: the return address is one of the server's own (`redirectUri` may only name one of
   * them; left out, the first is used), and a fresh random `state` is bound to this connection, this
   * company and this person. The caller gets `state` once; the bank must send it back.
   */
  async startConsent(context: BankFeedContext, input: { provider: string; redirectUri?: string }): Promise<BankFeedConsentRequest> {
    this.#require(context, 'bank.feed.manage');
    const adapter = this.#adapters.get(input.provider);
    if (!adapter) throw new PlatformError('NOT_FOUND', 'This bank connection provider is not supported.');
    const redirectUri = this.#returnAddress(input.redirectUri);
    const id = randomUUID();
    const state = randomBytes(32).toString('base64url');
    const pending: BankFeedConnection = frozen({ id, companyId: context.companyId, provider: input.provider, providerConsentId: null, consentUrl: null, status: 'PENDING_CONSENT', consentExpiresAt: null, connectedAt: null, disconnectedAt: null, lastSyncedAt: null, syncStatus: 'IDLE', lastError: null, createdAt: this.#now().toISOString() });
    await this.#act(context, async () => {
      await this.#store.saveConnection(pending);
      await this.#store.saveConsentState(frozen({ companyId: context.companyId, connectionId: id, stateHash: digest(state), startedBy: context.actorId, expiresAt: new Date(this.#now().getTime() + CONSENT_STATE_LIFETIME_MS).toISOString() }));
    });
    // Only the provider's answer is caught. A database error is never caught and carried on from.
    let consent: ConsentStart;
    try {
      consent = await adapter.startConsent({ companyId: context.companyId, connectionId: id, redirectUri, state });
    } catch (error) {
      await this.#act(context, async () => {
        const current = await this.#get(context, id);
        if (current.status === 'PENDING_CONSENT' && current.providerConsentId === null) await this.#store.saveConnection(frozen({ ...current, status: 'ERROR', lastError: this.#message(error) }));
      });
      throw error;
    }
    const connection = await this.#act(context, async () => {
      const current = await this.#get(context, id);
      if (current.status !== 'PENDING_CONSENT' || current.providerConsentId !== null) throw new PlatformError('INVALID_TRANSITION', CHANGED);
      const result = frozen({ ...current, providerConsentId: consent.providerConsentId, consentUrl: consent.consentUrl, consentExpiresAt: consent.expiresAt });
      await this.#store.saveConnection(result);
      await this.#record(context, result, 'bank_feed.consent_started', { provider: result.provider, consentExpiresAt: result.consentExpiresAt });
      return result;
    });
    return frozen({ connection, state });
  }

  /**
   * Issue #402: `state` must be the one handed out when this connection's request started, by the
   * same person in the same company, unused and in time. It is spent before the bank is asked, so a
   * reply can be used once; if the bank then refuses, the request ends in ERROR and starts again.
   */
  async completeConsent(context: BankFeedContext, connectionId: string, authorizationCode: string, state: string): Promise<BankFeedConnection> {
    this.#require(context, 'bank.feed.manage');
    if (!authorizationCode.trim()) throw new Error('The bank permission response is missing.');
    const connection = await this.#act(context, async () => {
      const current = await this.#get(context, connectionId);
      if (current.status !== 'PENDING_CONSENT' || !current.providerConsentId) throw new PlatformError('INVALID_TRANSITION', 'This bank permission request cannot be completed.');
      if (!state.trim() || !(await this.#store.useConsentState(context.companyId, connectionId, digest(state), context.actorId, this.#now().toISOString()))) throw new PlatformError('FORBIDDEN', STATE_REFUSED);
      return current;
    });
    let result: Awaited<ReturnType<BankFeedProviderAdapter['completeConsent']>>;
    try {
      result = await this.#adapter(connection).completeConsent({ companyId: context.companyId, providerConsentId: connection.providerConsentId!, authorizationCode });
      this.#validateConsent(result.accounts);
    } catch (error) {
      await this.#act(context, async () => {
        const current = await this.#get(context, connectionId);
        if (current.status === 'PENDING_CONSENT' && current.providerConsentId === connection.providerConsentId) await this.#store.saveConnection(frozen({ ...current, status: 'ERROR', consentUrl: null, lastError: this.#message(error) }));
      });
      throw error;
    }
    return this.#act(context, async () => {
      // Completed, disconnected or revoked while the bank was answering: nothing is written twice.
      const current = await this.#get(context, connectionId);
      if (current.status !== 'PENDING_CONSENT' || current.providerConsentId !== connection.providerConsentId) throw new PlatformError('INVALID_TRANSITION', 'This bank permission request cannot be completed.');
      const existing = await this.#store.accounts(context.companyId, current.id);
      for (const account of result.accounts) await this.#saveAccount(current, existing, account);
      const connected = frozen({ ...current, consentUrl: null, consentExpiresAt: result.consentExpiresAt, status: 'CONNECTED' as const, connectedAt: this.#now().toISOString(), lastError: null });
      await this.#store.saveConnection(connected);
      await this.#record(context, connected, 'bank_feed.connected', { provider: connected.provider, accountCount: result.accounts.length, consentExpiresAt: connected.consentExpiresAt });
      return connected;
    });
  }

  async sync(context: BankFeedContext, connectionId: string, idempotencyKey: string): Promise<SyncResult> {
    this.#require(context, 'bank.feed.sync');
    if (!idempotencyKey.trim()) throw new Error('A sync idempotency key is required.');
    // Action 1: check, mark the sync started, and read the cursors.
    const start = await this.#act(context, async (): Promise<{ prior: SyncResult } | { refused: PlatformError } | { connection: BankFeedConnection; accounts: readonly BankFeedAccount[] }> => {
      const connection = await this.#get(context, connectionId);
      const prior = await this.#store.syncResult(context.companyId, connectionId, idempotencyKey);
      if (prior) return { prior };
      if (connection.status !== 'CONNECTED' || !connection.providerConsentId) throw new PlatformError('INVALID_TRANSITION', connection.status === 'TOKEN_EXPIRED' ? 'Bank permission expired. Reconnect this account before syncing.' : 'Connect this bank account before syncing.');
      if (connection.consentExpiresAt && Date.parse(connection.consentExpiresAt) <= this.#now().getTime()) {
        const expired = frozen({ ...connection, status: 'TOKEN_EXPIRED' as const, syncStatus: 'FAILED' as const, lastError: 'Bank permission expired. Reconnect to continue.' });
        await this.#store.saveConnection(expired);
        await this.#record(context, expired, 'bank_feed.token_expired', {});
        return { refused: new PlatformError('INVALID_TRANSITION', expired.lastError!) }; // thrown once this is committed
      }
      const processing = frozen({ ...connection, syncStatus: 'PROCESSING' as const, lastError: null });
      await this.#store.saveConnection(processing);
      await this.#record(context, processing, 'bank_feed.sync_started', { idempotencyKey });
      return { connection: processing, accounts: await this.#store.accounts(context.companyId, connection.id) };
    });
    if ('prior' in start) return start.prior;
    if ('refused' in start) throw start.refused;
    const { connection, accounts } = start;

    // The bank, outside any unit of work. Only its answer and the answer's validation are caught.
    let pages: readonly ProviderAccountPage[];
    try {
      pages = (await this.#adapter(connection).sync({ companyId: context.companyId, providerConsentId: connection.providerConsentId!, cursors: Object.fromEntries(accounts.map((account) => [account.providerAccountId, account.cursor])), idempotencyKey })).accounts;
      this.#validatePage(accounts, pages);
    } catch (error) {
      // Committed in its own action before the caller hears of the failure.
      await this.#act(context, async () => {
        const current = await this.#get(context, connectionId);
        const status = error instanceof ConnectorError && error.code === 'UNAUTHORIZED' ? 'TOKEN_EXPIRED' as const : 'CONNECTED' as const;
        // A disconnect or revocation made meanwhile stands; the failure is still recorded.
        const failed = current.status === 'CONNECTED' ? frozen({ ...current, status, syncStatus: 'FAILED' as const, lastError: this.#message(error) }) : current;
        if (failed !== current) await this.#store.saveConnection(failed);
        await this.#record(context, failed, failed.status === 'TOKEN_EXPIRED' ? 'bank_feed.token_expired' : 'bank_feed.sync_failed', { retryable: error instanceof ConnectorError ? error.retryable : false, code: error instanceof ConnectorError ? error.code : 'INVALID_PROVIDER_DATA' });
      });
      throw error;
    }

    // Action 2: re-check and write. Another sync may have landed meanwhile (same key: its result is
    // returned; another key: its lines count as duplicates and its newer cursor is kept).
    return this.#act(context, async () => {
      const current = await this.#get(context, connectionId);
      const prior = await this.#store.syncResult(context.companyId, connectionId, idempotencyKey);
      if (prior) return prior;
      if (current.status !== 'CONNECTED') throw new PlatformError('INVALID_TRANSITION', 'Connect this bank account before syncing.');
      const fresh = await this.#store.accounts(context.companyId, current.id);
      const staged = await this.#stage(context, current, accounts, fresh, pages);
      for (const account of staged.accounts) await this.#store.saveAccount(account);
      await this.#store.addTransactions(staged.transactions);
      const succeeded = frozen({ ...current, syncStatus: 'SUCCEEDED' as const, lastSyncedAt: this.#now().toISOString(), lastError: null });
      await this.#store.saveConnection(succeeded);
      const result: SyncResult = frozen({ connection: succeeded, imported: staged.transactions.length, duplicates: staged.duplicates, transactions: frozen(staged.transactions) });
      await this.#store.saveSyncResult(context.companyId, current.id, idempotencyKey, result);
      await this.#record(context, succeeded, 'bank_feed.sync_succeeded', { imported: result.imported, duplicates: result.duplicates, accountCount: pages.length });
      return result;
    });
  }

  async disconnect(context: BankFeedContext, connectionId: string, idempotencyKey: string): Promise<BankFeedConnection> {
    this.#require(context, 'bank.feed.manage');
    const connection = await this.#get(context, connectionId);
    if (connection.status === 'DISCONNECTED') return connection;
    if (connection.providerConsentId && connection.status !== 'REVOKED') await this.#adapter(connection).revoke({ companyId: context.companyId, providerConsentId: connection.providerConsentId, idempotencyKey });
    return this.#act(context, async () => {
      const current = await this.#get(context, connectionId);
      if (current.status === 'DISCONNECTED') return current; // a second disconnect landed first
      await this.#deactivateAccounts(context, current.id);
      const disconnected = frozen({ ...current, status: 'DISCONNECTED' as const, consentUrl: null, disconnectedAt: this.#now().toISOString(), syncStatus: 'IDLE' as const, lastError: null });
      await this.#store.saveConnection(disconnected);
      await this.#record(context, disconnected, 'bank_feed.disconnected', { historicalTransactionsPreserved: await this.#store.countTransactions(context.companyId, current.id) });
      return disconnected;
    });
  }

  async markRevoked(context: BankFeedContext, connectionId: string): Promise<BankFeedConnection> {
    this.#require(context, 'bank.feed.manage');
    return this.#act(context, async () => {
      const connection = await this.#get(context, connectionId);
      await this.#deactivateAccounts(context, connection.id);
      const revoked = frozen({ ...connection, status: 'REVOKED' as const, consentUrl: null, syncStatus: 'IDLE' as const, lastError: 'The bank withdrew permission for this connection.' });
      await this.#store.saveConnection(revoked);
      await this.#record(context, revoked, 'bank_feed.revoked', { historicalDataPreserved: true });
      return revoked;
    });
  }

  async connections(context: BankFeedContext, page?: Page): Promise<readonly BankFeedConnection[]> { this.#requireAny(context); return this.#store.connections(context.companyId, page); }
  async accounts(context: BankFeedContext, connectionId: string, page?: Page): Promise<readonly BankFeedAccount[]> { this.#requireAny(context); await this.#get(context, connectionId); return this.#store.accounts(context.companyId, connectionId, page); }
  async transactions(context: BankFeedContext, connectionId: string, page?: Page): Promise<readonly BankFeedTransaction[]> { this.#requireAny(context); await this.#get(context, connectionId); return this.#store.transactions(context.companyId, connectionId, page); }
  async audit(context: BankFeedContext, connectionId?: string, page?: Page): Promise<readonly BankFeedAuditEvent[]> { this.#requireAny(context); return this.#store.audit(context.companyId, connectionId, page); }

  /** Throws on anything the provider sent that cannot be trusted. Writes nothing. */
  #validatePage(known: readonly BankFeedAccount[], pages: readonly ProviderAccountPage[]): void {
    const providerIds = new Set(known.map((account) => account.providerAccountId));
    for (const page of pages) {
      if (!providerIds.has(page.providerAccountId)) throw new Error('The provider returned a bank account outside this connection.');
      if (page.balanceAsOf !== null && Number.isNaN(Date.parse(page.balanceAsOf))) throw new Error('The provider returned an uncertain account balance.');
      for (const item of page.transactions) if (!item.providerTransactionId || !validDate(item.bookedOn) || !item.description.trim() || item.amountMinor <= 0n) throw new Error('The provider returned an incomplete bank transaction.');
    }
  }

  /**
   * The validated page as records: new transactions, repeats counted as duplicates, cursors advanced.
   * `read` is what the bank was asked from; `fresh` is the same accounts now. An account whose cursor
   * moved meanwhile was advanced by another sync: its newer cursor and balance are kept.
   */
  async #stage(context: BankFeedContext, connection: BankFeedConnection, read: readonly BankFeedAccount[], fresh: readonly BankFeedAccount[], pages: readonly ProviderAccountPage[]) {
    const accountByProvider = new Map(read.map((account) => [account.providerAccountId, account]));
    const now = new Map(fresh.map((account) => [account.id, account]));
    const imported = await this.#store.knownProviderTransactions(context.companyId, pages.flatMap((page) => page.transactions.map((item) => ({ accountId: accountByProvider.get(page.providerAccountId)!.id, providerTransactionId: item.providerTransactionId }))));
    const accounts: BankFeedAccount[] = [];
    const transactions: BankFeedTransaction[] = [];
    const stagedKeys = new Set<string>();
    let duplicates = 0;
    for (const page of pages) {
      const account = accountByProvider.get(page.providerAccountId)!;
      for (const item of page.transactions) {
        const key = providerKey(account.id, item.providerTransactionId);
        if (imported.has(key) || stagedKeys.has(key)) { duplicates += 1; continue; }
        stagedKeys.add(key);
        const debitPaise = item.direction === 'DEBIT' ? item.amountMinor : 0n;
        const creditPaise = item.direction === 'CREDIT' ? item.amountMinor : 0n;
        transactions.push(frozen({ id: randomUUID(), companyId: context.companyId, connectionId: connection.id, accountId: account.id, providerTransactionId: item.providerTransactionId, bookedOn: item.bookedOn, description: item.description.trim(), debitPaise, creditPaise, ...(item.reference ? { reference: item.reference } : {}), fingerprint: digest(`${context.companyId}\u0000${connection.id}\u0000${account.id}\u0000${item.providerTransactionId}`), importedAt: this.#now().toISOString() }));
      }
      const current = now.get(account.id);
      if (current === undefined || current.cursor !== account.cursor) continue;
      accounts.push(frozen({ ...current, balancePaise: page.balanceMinor, balanceAsOf: page.balanceAsOf, cursor: page.nextCursor }));
    }
    return { accounts, transactions, duplicates };
  }

  #act<T>(context: BankFeedContext, work: () => Promise<T>): Promise<T> { return this.#store.action(context.companyId, work); }
  async #saveAccount(connection: BankFeedConnection, existing: readonly BankFeedAccount[], account: ProviderAccount): Promise<void> { const current = existing.find((item) => item.providerAccountId === account.providerAccountId); const saved = frozen({ id: current?.id ?? randomUUID(), companyId: connection.companyId, connectionId: connection.id, providerAccountId: account.providerAccountId, displayName: account.displayName, maskedAccountNumber: account.maskedAccountNumber, accountType: account.accountType, currency: 'INR' as const, balancePaise: current?.balancePaise ?? null, balanceAsOf: current?.balanceAsOf ?? null, cursor: current?.cursor ?? null, active: true }); await this.#store.saveAccount(saved); }
  #validateConsent(accounts: readonly ProviderAccount[]): void {
    const seen = new Set<string>();
    for (const account of accounts) {
      this.#validateAccount(account);
      if (seen.has(account.providerAccountId)) throw new Error('The provider returned the same bank account twice.');
      seen.add(account.providerAccountId);
    }
  }
  #returnAddress(requested: string | undefined): string {
    const [first] = this.#returnAddresses;
    if (first === undefined) throw new PlatformError('FORBIDDEN', NOT_SET_UP);
    if (requested === undefined || requested === '') return first;
    if (!this.#returnAddresses.includes(requested)) throw new Error(RETURN_REFUSED);
    return requested;
  }
  #validateAccount(account: ProviderAccount): void { if (!account.providerAccountId || !account.displayName.trim() || account.currency !== 'INR' || !['CURRENT', 'SAVINGS', 'CASH_CREDIT', 'OTHER'].includes(account.accountType) || !safeMask(account.maskedAccountNumber)) throw new Error('The provider returned an unsupported or unsafe bank account.'); }
  async #deactivateAccounts(context: BankFeedContext, connectionId: string): Promise<void> { for (const account of await this.#store.accounts(context.companyId, connectionId)) await this.#store.saveAccount(frozen({ ...account, active: false })); }
  async #get(context: BankFeedContext, id: string): Promise<BankFeedConnection> { const connection = await this.#store.connection(context.companyId, id); if (!connection) throw new PlatformError('NOT_FOUND', 'Bank connection was not found.'); if (connection.companyId !== context.companyId) throw new PlatformError('TENANT_ISOLATION', 'This bank connection belongs to another company.'); return connection; }
  #adapter(connection: BankFeedConnection): BankFeedProviderAdapter { const adapter = this.#adapters.get(connection.provider); if (!adapter) throw new PlatformError('NOT_FOUND', 'This bank connection provider is not available.'); return adapter; }
  #require(context: BankFeedContext, permission: string): void { if (!context.permissions.has(permission)) throw new PlatformError('FORBIDDEN', 'You do not have permission to manage live bank connections.'); }
  #requireAny(context: BankFeedContext): void { if (!context.permissions.has('bank.feed.manage') && !context.permissions.has('bank.feed.sync') && !context.permissions.has('bank.balance.read')) throw new PlatformError('FORBIDDEN', 'You do not have permission to view live bank connections.'); }
  #message(error: unknown): string { if (error instanceof ConnectorError) return error.code === 'UNAUTHORIZED' ? 'Bank permission expired. Reconnect to continue.' : 'The bank is temporarily unavailable. Your last successful import is unchanged; try again.'; return error instanceof Error ? error.message : 'The bank sync could not be completed.'; }
  #record(context: BankFeedContext, connection: BankFeedConnection, action: BankFeedAuditEvent['action'], details: Record<string, unknown>): Promise<void> { return this.#store.record(frozen({ id: randomUUID(), companyId: context.companyId, actorId: context.actorId, action, connectionId: connection.id, occurredAt: this.#now().toISOString(), details: frozen({ ...details }) })); }
}

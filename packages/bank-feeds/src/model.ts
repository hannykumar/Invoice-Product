export type BankFeedPermission = 'bank.feed.manage' | 'bank.feed.sync' | 'bank.balance.read';

export interface BankFeedContext {
  readonly companyId: string;
  readonly actorId: string;
  readonly permissions: ReadonlySet<string>;
}

export type ConnectionStatus = 'PENDING_CONSENT' | 'CONNECTED' | 'TOKEN_EXPIRED' | 'REVOKED' | 'DISCONNECTED' | 'ERROR';
export type SyncStatus = 'IDLE' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED';

export interface BankFeedConnection {
  readonly id: string;
  readonly companyId: string;
  readonly provider: string;
  readonly providerConsentId: string | null;
  readonly consentUrl: string | null;
  readonly status: ConnectionStatus;
  readonly consentExpiresAt: string | null;
  readonly connectedAt: string | null;
  readonly disconnectedAt: string | null;
  readonly lastSyncedAt: string | null;
  readonly syncStatus: SyncStatus;
  readonly lastError: string | null;
  readonly createdAt: string;
}

export interface BankFeedAccount {
  readonly id: string;
  readonly companyId: string;
  readonly connectionId: string;
  readonly providerAccountId: string;
  readonly displayName: string;
  readonly maskedAccountNumber: string;
  readonly accountType: 'CURRENT' | 'SAVINGS' | 'CASH_CREDIT' | 'OTHER';
  readonly currency: 'INR';
  readonly balancePaise: bigint | null;
  readonly balanceAsOf: string | null;
  readonly cursor: string | null;
  readonly active: boolean;
}

/** Compatible with bank-reconciliation's published ImportedBankTransaction subset. */
export interface BankFeedTransaction {
  readonly id: string;
  readonly companyId: string;
  readonly connectionId: string;
  readonly accountId: string;
  readonly providerTransactionId: string;
  readonly bookedOn: string;
  readonly description: string;
  readonly debitPaise: bigint;
  readonly creditPaise: bigint;
  readonly reference?: string;
  readonly fingerprint: string;
  readonly importedAt: string;
}

/**
 * Issue #402 — what ties the bank's reply to the request that asked for it. `state` itself is
 * handed to the person who started the request once and never stored; only its SHA-256 is kept.
 * It belongs to one connection, one company and one person, runs out at `expiresAt`, and is used once.
 */
export interface BankFeedConsentState {
  readonly companyId: string;
  readonly connectionId: string;
  readonly stateHash: string;
  readonly startedBy: string;
  readonly expiresAt: string;
}

/** A started request and the `state` the bank must send back with its answer. */
export interface BankFeedConsentRequest {
  readonly connection: BankFeedConnection;
  readonly state: string;
}

/**
 * Issue #402 — where the bank may send the customer back to: this app's own origins and one fixed
 * page. Origins are `https://…`, or `http://localhost` / `http://127.0.0.1` for development.
 */
export interface ConsentReturnPolicy {
  readonly origins: readonly string[];
  readonly path: string;
}

export interface ConsentStart {
  readonly providerConsentId: string;
  readonly consentUrl: string;
  readonly expiresAt: string;
}

export interface ProviderAccount {
  readonly providerAccountId: string;
  readonly displayName: string;
  /** Masked display value only. Never a full account number. */
  readonly maskedAccountNumber: string;
  readonly accountType: BankFeedAccount['accountType'];
  readonly currency: string;
}

export interface ProviderTransaction {
  readonly providerTransactionId: string;
  readonly bookedOn: string;
  readonly description: string;
  readonly amountMinor: bigint;
  readonly direction: 'CREDIT' | 'DEBIT';
  readonly reference?: string;
}

export interface ProviderAccountPage {
  readonly providerAccountId: string;
  readonly transactions: readonly ProviderTransaction[];
  readonly balanceMinor: bigint | null;
  readonly balanceAsOf: string | null;
  readonly nextCursor: string | null;
}

export interface ProviderSyncPage {
  readonly accounts: readonly ProviderAccountPage[];
}

export interface BankFeedProviderAdapter {
  readonly provider: string;
  /** `redirectUri` is one of the service's allowed return addresses; `state` must come back with the bank's answer. */
  startConsent(input: { readonly companyId: string; readonly connectionId: string; readonly redirectUri: string; readonly state: string }): Promise<ConsentStart>;
  completeConsent(input: { readonly companyId: string; readonly providerConsentId: string; readonly authorizationCode: string }): Promise<{ readonly consentExpiresAt: string; readonly accounts: readonly ProviderAccount[] }>;
  sync(input: { readonly companyId: string; readonly providerConsentId: string; readonly cursors: Readonly<Record<string, string | null>>; readonly idempotencyKey: string }): Promise<ProviderSyncPage>;
  revoke(input: { readonly companyId: string; readonly providerConsentId: string; readonly idempotencyKey: string }): Promise<void>;
}

export interface SyncResult {
  readonly connection: BankFeedConnection;
  readonly imported: number;
  readonly duplicates: number;
  readonly transactions: readonly BankFeedTransaction[];
}

export interface BankFeedAuditEvent {
  readonly id: string;
  readonly companyId: string;
  readonly actorId: string;
  readonly action: 'bank_feed.consent_started' | 'bank_feed.connected' | 'bank_feed.sync_started' | 'bank_feed.sync_succeeded' | 'bank_feed.sync_failed' | 'bank_feed.token_expired' | 'bank_feed.revoked' | 'bank_feed.disconnected';
  readonly connectionId: string;
  readonly occurredAt: string;
  readonly details: Readonly<Record<string, unknown>>;
}

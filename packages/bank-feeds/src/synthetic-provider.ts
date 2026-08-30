import { ConnectorError } from '../../platform/src/connectors.ts';
import type { BankFeedProviderAdapter, ConsentStart, ProviderAccount, ProviderSyncPage, ProviderTransaction } from './model.ts';

export class SyntheticBankFeedProvider implements BankFeedProviderAdapter {
  readonly provider: string;
  #mode: 'healthy' | 'outage' | 'expired' = 'healthy';
  #transactions = new Map<string, ProviderTransaction[]>();
  #revoked = new Set<string>();
  #syncCount = 0;
  #replay = false;
  constructor(provider = 'sandbox-aa') { this.provider = provider; }
  setMode(mode: 'healthy' | 'outage' | 'expired'): void { this.#mode = mode; }
  replayFromStartOnce(): void { this.#replay = true; }
  addTransaction(accountId: string, transaction: ProviderTransaction): void { this.#transactions.set(accountId, [...(this.#transactions.get(accountId) ?? []), transaction]); }
  get syncCount(): number { return this.#syncCount; }

  async startConsent(input: { companyId: string; connectionId: string; redirectUri: string }): Promise<ConsentStart> { return { providerConsentId: `consent-${input.companyId}-${input.connectionId}`, consentUrl: `https://sandbox.bank.example/authorise/${input.connectionId}`, expiresAt: '2027-08-30T00:00:00.000Z' }; }
  async completeConsent(input: { companyId: string; providerConsentId: string; authorizationCode: string }): Promise<{ consentExpiresAt: string; accounts: readonly ProviderAccount[] }> {
    if (input.authorizationCode !== 'sandbox-approved') throw new ConnectorError('UNAUTHORIZED', false);
    return { consentExpiresAt: '2027-08-30T00:00:00.000Z', accounts: [{ providerAccountId: `current-${input.companyId}`, displayName: 'Business current account', maskedAccountNumber: 'XXXXXX1234', accountType: 'CURRENT', currency: 'INR' }] };
  }
  async sync(input: { companyId: string; providerConsentId: string; cursors: Readonly<Record<string, string | null>>; idempotencyKey: string }): Promise<ProviderSyncPage> {
    this.#syncCount += 1;
    if (this.#mode === 'outage') throw new ConnectorError('OUTAGE', true);
    if (this.#mode === 'expired' || this.#revoked.has(input.providerConsentId)) throw new ConnectorError('UNAUTHORIZED', false);
    const replay = this.#replay; this.#replay = false;
    return { accounts: Object.entries(input.cursors).map(([providerAccountId, cursor]) => { const all = this.#transactions.get(providerAccountId) ?? []; const offset = replay || cursor === null ? 0 : Number(cursor); const transactions = all.slice(offset); const balanceMinor = all.reduce((total, item) => total + (item.direction === 'CREDIT' ? item.amountMinor : -item.amountMinor), 100_000_00n); return { providerAccountId, transactions, balanceMinor, balanceAsOf: '2026-08-30T06:00:00.000Z', nextCursor: String(all.length) }; }) };
  }
  async revoke(input: { providerConsentId: string }): Promise<void> { this.#revoked.add(input.providerConsentId); }
}

import { ConnectorError, type ConnectorGateway } from '../../platform/src/connectors.ts';
import type { BankFeedProviderAdapter, ConsentStart, ProviderAccount, ProviderSyncPage, ProviderTransaction } from './model.ts';

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConnectorError('INVALID_REQUEST', false);
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value) throw new ConnectorError('INVALID_REQUEST', false);
  return value;
};
const nullableText = (value: unknown): string | null => value === null ? null : text(value);
const minor = (value: unknown): bigint => {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) throw new ConnectorError('INVALID_REQUEST', false);
  return BigInt(value);
};

/** E08 gateway adapter. OAuth codes pass through once and are never returned or stored here. */
export class ConnectorBankFeedAdapter implements BankFeedProviderAdapter {
  readonly provider: string;
  readonly #gateway: ConnectorGateway;
  constructor(provider: string, gateway: ConnectorGateway) { this.provider = provider; this.#gateway = gateway; }

  async startConsent(input: { companyId: string; connectionId: string; redirectUri: string }): Promise<ConsentStart> {
    const response = await this.#gateway.execute('banking', { tenantId: input.companyId, operation: 'start_consent', payload: { provider: this.provider, redirectUri: input.redirectUri }, idempotencyKey: `consent:${input.connectionId}`, correlationId: input.connectionId });
    return { providerConsentId: text(response.payload.providerConsentId), consentUrl: text(response.payload.consentUrl), expiresAt: text(response.payload.expiresAt) };
  }

  async completeConsent(input: { companyId: string; providerConsentId: string; authorizationCode: string }): Promise<{ consentExpiresAt: string; accounts: readonly ProviderAccount[] }> {
    const response = await this.#gateway.execute('banking', { tenantId: input.companyId, operation: 'complete_consent', payload: { provider: this.provider, providerConsentId: input.providerConsentId, authorizationCode: input.authorizationCode }, idempotencyKey: `complete:${input.providerConsentId}`, correlationId: input.providerConsentId });
    const accounts = response.payload.accounts;
    if (!Array.isArray(accounts)) throw new ConnectorError('INVALID_REQUEST', false);
    return { consentExpiresAt: text(response.payload.consentExpiresAt), accounts: accounts.map((item) => { const value = object(item); return { providerAccountId: text(value.providerAccountId), displayName: text(value.displayName), maskedAccountNumber: text(value.maskedAccountNumber), accountType: text(value.accountType) as ProviderAccount['accountType'], currency: text(value.currency) }; }) };
  }

  async sync(input: { companyId: string; providerConsentId: string; cursors: Readonly<Record<string, string | null>>; idempotencyKey: string }): Promise<ProviderSyncPage> {
    const response = await this.#gateway.execute('banking', { tenantId: input.companyId, operation: 'sync', payload: { provider: this.provider, providerConsentId: input.providerConsentId, cursors: input.cursors }, idempotencyKey: input.idempotencyKey, correlationId: input.providerConsentId });
    if (!Array.isArray(response.payload.accounts)) throw new ConnectorError('INVALID_REQUEST', false);
    return { accounts: response.payload.accounts.map((item) => { const value = object(item); if (!Array.isArray(value.transactions)) throw new ConnectorError('INVALID_REQUEST', false); return { providerAccountId: text(value.providerAccountId), balanceMinor: value.balanceMinor === null ? null : minor(value.balanceMinor), balanceAsOf: nullableText(value.balanceAsOf), nextCursor: nullableText(value.nextCursor), transactions: value.transactions.map((transaction): ProviderTransaction => { const row = object(transaction); return { providerTransactionId: text(row.providerTransactionId), bookedOn: text(row.bookedOn), description: text(row.description), amountMinor: minor(row.amountMinor), direction: text(row.direction) as ProviderTransaction['direction'], ...(row.reference === undefined ? {} : { reference: text(row.reference) }) }; }) }; }) };
  }

  async revoke(input: { companyId: string; providerConsentId: string; idempotencyKey: string }): Promise<void> {
    await this.#gateway.execute('banking', { tenantId: input.companyId, operation: 'revoke', payload: { provider: this.provider, providerConsentId: input.providerConsentId }, idempotencyKey: input.idempotencyKey, correlationId: input.providerConsentId });
  }
}

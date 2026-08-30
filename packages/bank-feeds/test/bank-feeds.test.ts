import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectorError } from '../../platform/src/connectors.ts';
import { PlatformError } from '../../platform/src/types.ts';
import { BankFeedService, SyntheticBankFeedProvider, type BankFeedContext } from '../src/index.ts';

const now = new Date('2026-08-30T12:00:00.000Z');
const context = (companyId = 'company-a', permissions = new Set(['bank.feed.manage', 'bank.feed.sync', 'bank.balance.read'])): BankFeedContext => ({ companyId, actorId: `owner-${companyId}`, permissions });
const connect = async (service: BankFeedService, actor = context()) => {
  const pending = await service.startConsent(actor, { provider: 'sandbox-aa', redirectUri: 'https://app.example/bank/callback' });
  return service.completeConsent(actor, pending.id, 'sandbox-approved');
};

test('sandbox onboarding requires explicit consent and stores only masked account details', async () => {
  const provider = new SyntheticBankFeedProvider();
  const service = new BankFeedService([provider], () => now);
  const pending = await service.startConsent(context(), { provider: provider.provider, redirectUri: 'https://app.example/bank/callback' });
  assert.equal(pending.status, 'PENDING_CONSENT');
  assert.match(pending.consentUrl!, /^https:\/\//);
  const connected = await service.completeConsent(context(), pending.id, 'sandbox-approved');
  assert.equal(connected.status, 'CONNECTED');
  const [account] = service.accounts(context(), connected.id);
  assert.equal(account?.maskedAccountNumber, 'XXXXXX1234');
  assert.equal(JSON.stringify({ connected, account, audit: service.audit(context()) }).includes('sandbox-approved'), false);
  await assert.rejects(service.startConsent(context('company-a', new Set()), { provider: provider.provider, redirectUri: 'https://app.example/callback' }), /permission/i);
});

test('incremental sync normalizes INR balances and is idempotent under key and cursor replay', async () => {
  const provider = new SyntheticBankFeedProvider();
  const service = new BankFeedService([provider], () => now);
  const connection = await connect(service);
  provider.addTransaction('current-company-a', { providerTransactionId: 'txn-1', bookedOn: '2026-08-29', description: 'UPI settlement', amountMinor: 12_345n, direction: 'CREDIT', reference: 'UTR-1' });
  const first = await service.sync(context(), connection.id, 'daily-2026-08-30');
  assert.equal(first.imported, 1);
  assert.equal(first.transactions[0]?.creditPaise, 12_345n);
  assert.equal(first.transactions[0]?.debitPaise, 0n);
  assert.equal(service.accounts(context(), connection.id)[0]?.balancePaise, 100_123_45n);
  const sameKey = await service.sync(context(), connection.id, 'daily-2026-08-30');
  assert.equal(sameKey, first);
  assert.equal(provider.syncCount, 1);
  provider.replayFromStartOnce();
  const replay = await service.sync(context(), connection.id, 'cursor-replay');
  assert.equal(replay.imported, 0);
  assert.equal(replay.duplicates, 1);
  assert.equal(service.transactions(context(), connection.id).length, 1);
});

test('outage keeps the last cursor recoverable and retry imports once', async () => {
  const provider = new SyntheticBankFeedProvider();
  const service = new BankFeedService([provider], () => now);
  const connection = await connect(service);
  provider.addTransaction('current-company-a', { providerTransactionId: 'txn-1', bookedOn: '2026-08-30', description: 'NEFT receipt', amountMinor: 50_000n, direction: 'CREDIT' });
  provider.setMode('outage');
  await assert.rejects(service.sync(context(), connection.id, 'attempt-1'), (error: unknown) => error instanceof ConnectorError && error.code === 'OUTAGE');
  assert.equal(service.accounts(context(), connection.id)[0]?.cursor, null);
  assert.equal(service.connections(context())[0]?.syncStatus, 'FAILED');
  provider.setMode('healthy');
  const recovered = await service.sync(context(), connection.id, 'attempt-2');
  assert.equal(recovered.imported, 1);
  assert.equal(service.accounts(context(), connection.id)[0]?.cursor, '1');
});

test('token expiry and provider revocation block sync without deleting history', async () => {
  const provider = new SyntheticBankFeedProvider();
  const service = new BankFeedService([provider], () => now);
  const connection = await connect(service);
  provider.addTransaction('current-company-a', { providerTransactionId: 'txn-1', bookedOn: '2026-08-30', description: 'Rent', amountMinor: 25_000n, direction: 'DEBIT' });
  await service.sync(context(), connection.id, 'first');
  provider.setMode('expired');
  await assert.rejects(service.sync(context(), connection.id, 'expired'), /UNAUTHORIZED/);
  assert.equal(service.connections(context())[0]?.status, 'TOKEN_EXPIRED');
  assert.equal(service.transactions(context(), connection.id).length, 1);
  const revoked = service.markRevoked(context(), connection.id);
  assert.equal(revoked.status, 'REVOKED');
  assert.equal(service.accounts(context(), connection.id)[0]?.active, false);
  assert.equal(service.transactions(context(), connection.id).length, 1);
});

test('disconnect revokes provider access but preserves historical accounting data', async () => {
  const provider = new SyntheticBankFeedProvider();
  const service = new BankFeedService([provider], () => now);
  const connection = await connect(service);
  provider.addTransaction('current-company-a', { providerTransactionId: 'txn-1', bookedOn: '2026-08-30', description: 'Card settlement', amountMinor: 9_900n, direction: 'CREDIT' });
  await service.sync(context(), connection.id, 'first');
  const disconnected = await service.disconnect(context(), connection.id, 'disconnect-once');
  assert.equal(disconnected.status, 'DISCONNECTED');
  assert.equal(service.transactions(context(), connection.id).length, 1);
  assert.equal(service.accounts(context(), connection.id)[0]?.active, false);
  await assert.rejects(service.sync(context(), connection.id, 'later'), /Connect this bank account/);
});

test('connections, transactions and actions are isolated by company', async () => {
  const provider = new SyntheticBankFeedProvider();
  const service = new BankFeedService([provider], () => now);
  const connection = await connect(service, context('company-a'));
  assert.equal(service.connections(context('company-b')).length, 0);
  assert.throws(() => service.accounts(context('company-b'), connection.id), (error: unknown) => error instanceof PlatformError && error.code === 'TENANT_ISOLATION');
  await assert.rejects(service.sync(context('company-b'), connection.id, 'cross-company'), (error: unknown) => error instanceof PlatformError && error.code === 'TENANT_ISOLATION');
  assert.equal(service.audit(context('company-b')).length, 0);
});

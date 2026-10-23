import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectorError } from '../../platform/src/connectors.ts';
import { PlatformError } from '../../platform/src/types.ts';
import { BankFeedService, SyntheticBankFeedProvider, type BankFeedContext } from '../src/index.ts';

const now = new Date('2026-08-30T12:00:00.000Z');
const context = (companyId = 'company-a', permissions = new Set(['bank.feed.manage', 'bank.feed.sync', 'bank.balance.read'])): BankFeedContext => ({ companyId, actorId: `owner-${companyId}`, permissions });
const RETURN = { origins: ['https://app.example'], path: '/bank-feed-return' };
const connect = async (service: BankFeedService, actor = context()) => {
  const { connection, state } = await service.startConsent(actor, { provider: 'sandbox-aa' });
  return service.completeConsent(actor, connection.id, 'sandbox-approved', state);
};

test('sandbox onboarding requires explicit consent and stores only masked account details', async () => {
  const provider = new SyntheticBankFeedProvider();
  const service = new BankFeedService([provider], () => now, undefined, RETURN);
  const { connection: pending, state } = await service.startConsent(context(), { provider: provider.provider, redirectUri: 'https://app.example/bank-feed-return' });
  assert.equal(pending.status, 'PENDING_CONSENT');
  assert.match(pending.consentUrl!, /^https:\/\//);
  const connected = await service.completeConsent(context(), pending.id, 'sandbox-approved', state);
  assert.equal(connected.status, 'CONNECTED');
  const [account] = await service.accounts(context(), connected.id);
  assert.equal(account?.maskedAccountNumber, 'XXXXXX1234');
  assert.equal(JSON.stringify({ connected, account, audit: (await service.audit(context())) }).includes('sandbox-approved'), false);
  await assert.rejects(service.startConsent(context('company-a', new Set()), { provider: provider.provider }), /permission/i);
});

test('incremental sync normalizes INR balances and is idempotent under key and cursor replay', async () => {
  const provider = new SyntheticBankFeedProvider();
  const service = new BankFeedService([provider], () => now, undefined, RETURN);
  const connection = await connect(service);
  provider.addTransaction('current-company-a', { providerTransactionId: 'txn-1', bookedOn: '2026-08-29', description: 'UPI settlement', amountMinor: 12_345n, direction: 'CREDIT', reference: 'UTR-1' });
  const first = await service.sync(context(), connection.id, 'daily-2026-08-30');
  assert.equal(first.imported, 1);
  assert.equal(first.transactions[0]?.creditPaise, 12_345n);
  assert.equal(first.transactions[0]?.debitPaise, 0n);
  assert.equal((await service.accounts(context(), connection.id))[0]?.balancePaise, 100_123_45n);
  const sameKey = await service.sync(context(), connection.id, 'daily-2026-08-30');
  assert.equal(sameKey, first);
  assert.equal(provider.syncCount, 1);
  provider.replayFromStartOnce();
  const replay = await service.sync(context(), connection.id, 'cursor-replay');
  assert.equal(replay.imported, 0);
  assert.equal(replay.duplicates, 1);
  assert.equal((await service.transactions(context(), connection.id)).length, 1);
});

test('outage keeps the last cursor recoverable and retry imports once', async () => {
  const provider = new SyntheticBankFeedProvider();
  const service = new BankFeedService([provider], () => now, undefined, RETURN);
  const connection = await connect(service);
  provider.addTransaction('current-company-a', { providerTransactionId: 'txn-1', bookedOn: '2026-08-30', description: 'NEFT receipt', amountMinor: 50_000n, direction: 'CREDIT' });
  provider.setMode('outage');
  await assert.rejects(service.sync(context(), connection.id, 'attempt-1'), (error: unknown) => error instanceof ConnectorError && error.code === 'OUTAGE');
  assert.equal((await service.accounts(context(), connection.id))[0]?.cursor, null);
  assert.equal((await service.connections(context()))[0]?.syncStatus, 'FAILED');
  provider.setMode('healthy');
  const recovered = await service.sync(context(), connection.id, 'attempt-2');
  assert.equal(recovered.imported, 1);
  assert.equal((await service.accounts(context(), connection.id))[0]?.cursor, '1');
});

test('token expiry and provider revocation block sync without deleting history', async () => {
  const provider = new SyntheticBankFeedProvider();
  const service = new BankFeedService([provider], () => now, undefined, RETURN);
  const connection = await connect(service);
  provider.addTransaction('current-company-a', { providerTransactionId: 'txn-1', bookedOn: '2026-08-30', description: 'Rent', amountMinor: 25_000n, direction: 'DEBIT' });
  await service.sync(context(), connection.id, 'first');
  provider.setMode('expired');
  await assert.rejects(service.sync(context(), connection.id, 'expired'), /UNAUTHORIZED/);
  assert.equal((await service.connections(context()))[0]?.status, 'TOKEN_EXPIRED');
  assert.equal((await service.transactions(context(), connection.id)).length, 1);
  const revoked = await service.markRevoked(context(), connection.id);
  assert.equal(revoked.status, 'REVOKED');
  assert.equal((await service.accounts(context(), connection.id))[0]?.active, false);
  assert.equal((await service.transactions(context(), connection.id)).length, 1);
});

test('disconnect revokes provider access but preserves historical accounting data', async () => {
  const provider = new SyntheticBankFeedProvider();
  const service = new BankFeedService([provider], () => now, undefined, RETURN);
  const connection = await connect(service);
  provider.addTransaction('current-company-a', { providerTransactionId: 'txn-1', bookedOn: '2026-08-30', description: 'Card settlement', amountMinor: 9_900n, direction: 'CREDIT' });
  await service.sync(context(), connection.id, 'first');
  const disconnected = await service.disconnect(context(), connection.id, 'disconnect-once');
  assert.equal(disconnected.status, 'DISCONNECTED');
  assert.equal((await service.transactions(context(), connection.id)).length, 1);
  assert.equal((await service.accounts(context(), connection.id))[0]?.active, false);
  await assert.rejects(service.sync(context(), connection.id, 'later'), /Connect this bank account/);
});

test('connections, transactions and actions are isolated by company', async () => {
  const provider = new SyntheticBankFeedProvider();
  const service = new BankFeedService([provider], () => now, undefined, RETURN);
  const connection = await connect(service, context('company-a'));
  assert.equal((await service.connections(context('company-b'))).length, 0);
  await assert.rejects(service.accounts(context('company-b'), connection.id), (error: unknown) => error instanceof PlatformError && error.code === 'TENANT_ISOLATION');
  await assert.rejects(service.sync(context('company-b'), connection.id, 'cross-company'), (error: unknown) => error instanceof PlatformError && error.code === 'TENANT_ISOLATION');
  assert.equal((await service.audit(context('company-b'))).length, 0);
});

/** Records what the bank was asked, so a test can see the return address and `state` it got. */
class WatchedProvider extends SyntheticBankFeedProvider {
  readonly starts: { redirectUri: string; state: string }[] = [];
  completes = 0;
  override startConsent(input: Parameters<SyntheticBankFeedProvider['startConsent']>[0]) { this.starts.push({ redirectUri: input.redirectUri, state: input.state }); return super.startConsent(input); }
  override completeConsent(input: Parameters<SyntheticBankFeedProvider['completeConsent']>[0]) { this.completes += 1; return super.completeConsent(input); }
}

test('#402: the bank is only told to send the customer back to this app, never to an address the caller names', async () => {
  const provider = new WatchedProvider();
  const service = new BankFeedService([provider], () => now, undefined, { origins: ['https://app.example', 'http://localhost:4173'], path: '/bank-feed-return' });
  for (const redirectUri of ['https://example.invalid/collect', 'https://app.example.invalid/bank-feed-return', 'https://app.example/elsewhere', 'https://app.example/bank-feed-return?next=https://example.invalid', 'http://localhost:9999/bank-feed-return', 'javascript:alert(1)']) {
    await assert.rejects(service.startConsent(context(), { provider: provider.provider, redirectUri }), /only send you back to this app/);
  }
  assert.equal(provider.starts.length, 0, 'the bank is never asked with an outside return address');
  assert.deepEqual(await service.connections(context()), [], 'nothing is saved for a refused return address');
  await service.startConsent(context(), { provider: provider.provider });
  await service.startConsent(context(), { provider: provider.provider, redirectUri: 'http://localhost:4173/bank-feed-return' });
  assert.deepEqual(provider.starts.map((start) => start.redirectUri), ['https://app.example/bank-feed-return', 'http://localhost:4173/bank-feed-return']);
  await assert.rejects(new BankFeedService([provider], () => now).startConsent(context(), { provider: provider.provider }), /not set up on this server/);
  assert.throws(() => new BankFeedService([provider], () => now, undefined, { origins: ['http://app.example'], path: '/bank-feed-return' }), /must be https/);
});

test('#402: each request gets its own random state, sent to the bank and never stored or shown again', async () => {
  const provider = new WatchedProvider();
  const service = new BankFeedService([provider], () => now, undefined, RETURN);
  const first = await service.startConsent(context(), { provider: provider.provider });
  const second = await service.startConsent(context(), { provider: provider.provider });
  assert.match(first.state, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.state, second.state);
  assert.deepEqual(provider.starts.map((start) => start.state), [first.state, second.state]);
  const kept = JSON.stringify({ connections: await service.connections(context()), audit: await service.audit(context()) });
  assert.equal(kept.includes(first.state) || kept.includes(second.state), false);
});

test("#402: a reply carrying someone else's request, or no request, cannot complete a pending connection", async () => {
  const provider = new WatchedProvider();
  const service = new BankFeedService([provider], () => now, undefined, RETURN);
  const victim = context();
  const colleague: BankFeedContext = { ...context(), actorId: 'accountant-company-a' };
  const { connection, state } = await service.startConsent(victim, { provider: provider.provider });
  const attacker = await service.startConsent(colleague, { provider: provider.provider });
  for (const wrong of ['', '   ', attacker.state, `${state}x`]) {
    await assert.rejects(service.completeConsent(victim, connection.id, 'sandbox-approved', wrong), (error: unknown) => error instanceof PlatformError && error.code === 'FORBIDDEN');
  }
  await assert.rejects(service.completeConsent(colleague, connection.id, 'sandbox-approved', state), /does not belong to a request you started/, 'another person in the same company cannot use it');
  await assert.rejects(service.completeConsent(context('company-b'), connection.id, 'sandbox-approved', state), /another company|does not belong/i, 'another company cannot use it');
  assert.equal(provider.completes, 0, 'the bank is never asked to exchange the code');
  assert.equal((await service.connections(victim)).find((item) => item.id === connection.id)?.status, 'PENDING_CONSENT');
  assert.equal((await service.completeConsent(victim, connection.id, 'sandbox-approved', state)).status, 'CONNECTED', 'wrong guesses do not spend the real one');
});

test('#402: a request can be used once, and runs out', async () => {
  const provider = new WatchedProvider();
  let clock = now;
  const service = new BankFeedService([provider], () => clock, undefined, RETURN);
  const { connection, state } = await service.startConsent(context(), { provider: provider.provider });
  const both = await Promise.allSettled([service.completeConsent(context(), connection.id, 'sandbox-approved', state), service.completeConsent(context(), connection.id, 'sandbox-approved', state)]);
  assert.deepEqual(both.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(provider.completes, 1, 'only one reply reaches the bank');
  await assert.rejects(service.completeConsent(context(), connection.id, 'sandbox-approved', state), /cannot be completed/);

  const refused = await service.startConsent(context(), { provider: provider.provider });
  await assert.rejects(service.completeConsent(context(), refused.connection.id, 'stolen-code', refused.state));
  assert.equal((await service.connections(context())).find((item) => item.id === refused.connection.id)?.status, 'ERROR', 'a refused code ends the request; start again');
  await assert.rejects(service.completeConsent(context(), refused.connection.id, 'sandbox-approved', refused.state), /cannot be completed/);

  const late = await service.startConsent(context(), { provider: provider.provider });
  clock = new Date(now.getTime() + 31 * 60 * 1000);
  await assert.rejects(service.completeConsent(context(), late.connection.id, 'sandbox-approved', late.state), /run out of time/);
});

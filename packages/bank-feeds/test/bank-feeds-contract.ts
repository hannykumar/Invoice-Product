/**
 * Issue #366 — one contract suite for the bank-feed store, run against memory
 * (bank-feeds-contract.test.ts) and PostgreSQL (bank-feeds-contract.integration.test.ts).
 * Everything is synthetic: random ids, invented banks, masked account numbers only.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectorError } from '../../platform/src/connectors.ts';
import { BankFeedService, SyntheticBankFeedProvider, type BankFeedAccount, type BankFeedConnection, type BankFeedContext, type BankFeedStore, type BankFeedTransaction, type Page } from '../src/index.ts';

export interface BankFeedHarness {
  store: BankFeedStore;
  /** A company and a person in it, wherever the implementation keeps them. */
  company(): Promise<{ companyId: string; userId: string }>;
  /** One business action: everything `work` writes is kept together, or (where `atomic`) nothing is when it throws. */
  write<T>(companyId: string, work: () => Promise<T>): Promise<T>;
  /** Whether a failed action's writes are undone (a database) or not (memory has no transaction). */
  atomic: boolean;
}

const at = '2026-08-30T12:00:00.000Z';
const BIG = 9_007_199_254_740_993n; // above 2^53: must not pass through a float

const walk = async <T extends { id: string }>(fetch: (page: Page) => Promise<readonly T[]>, limit = 2): Promise<string[]> => {
  const seen: string[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await fetch(after === undefined ? { limit } : { limit, after });
    assert.ok(page.length <= limit);
    if (page.length === 0) return seen;
    seen.push(...page.map((row) => row.id));
    after = page[page.length - 1]!.id;
  }
};

export const pendingConnection = (companyId: string, over: Partial<BankFeedConnection> = {}): BankFeedConnection => ({
  id: crypto.randomUUID(), companyId, provider: 'sandbox-aa', providerConsentId: `consent-${crypto.randomUUID()}`, consentUrl: 'https://sandbox.bank.example/authorise/x',
  status: 'PENDING_CONSENT', consentExpiresAt: '2027-08-30T00:00:00.000Z', connectedAt: null, disconnectedAt: null, lastSyncedAt: null,
  syncStatus: 'IDLE', lastError: null, createdAt: at, ...over,
});
const anAccount = (c: BankFeedConnection, over: Partial<BankFeedAccount> = {}): BankFeedAccount => ({
  id: crypto.randomUUID(), companyId: c.companyId, connectionId: c.id, providerAccountId: `acct-${crypto.randomUUID()}`, displayName: 'Business current account',
  maskedAccountNumber: 'XXXXXX1234', accountType: 'CURRENT', currency: 'INR', balancePaise: null, balanceAsOf: null, cursor: null, active: true, ...over,
});
const aLine = (a: BankFeedAccount, over: Partial<BankFeedTransaction> = {}): BankFeedTransaction => {
  const providerTransactionId = `txn-${crypto.randomUUID()}`;
  return { id: crypto.randomUUID(), companyId: a.companyId, connectionId: a.connectionId, accountId: a.id, providerTransactionId, bookedOn: '2026-08-29',
    description: 'UPI settlement', debitPaise: 0n, creditPaise: 12_345n, fingerprint: `fp-${providerTransactionId}`, importedAt: at, ...over };
};

export const bankFeedContract = (name: string, make: () => BankFeedHarness, skip: string | false = false): void => {
  const setup = async () => {
    const h = make();
    const { companyId, userId } = await h.company();
    const connection = pendingConnection(companyId);
    const account = anAccount(connection);
    await h.write(companyId, async () => { await h.store.saveConnection(connection); await h.store.saveAccount(account); });
    return { h, companyId, userId, connection, account };
  };

  test(`${name}: a connection is saved, replaced and read back exactly`, { skip }, async () => {
    const { h, companyId, connection } = await setup();
    assert.deepEqual(await h.store.connection(companyId, connection.id), connection);
    const connected = { ...connection, consentUrl: null, status: 'CONNECTED' as const, connectedAt: '2026-08-30T12:01:00.000Z', lastSyncedAt: '2026-08-30T12:02:00.000Z', syncStatus: 'FAILED' as const, lastError: 'बैंक अभी उपलब्ध नहीं है' };
    await h.write(companyId, () => h.store.saveConnection(connected));
    assert.deepEqual(await h.store.connection(companyId, connection.id), connected);
    assert.equal(await h.store.connection(companyId, crypto.randomUUID()), null);
  });

  test(`${name}: connections are listed in the order made, a page at a time, and only for their company`, { skip }, async () => {
    const { h, companyId, connection } = await setup();
    const more = [pendingConnection(companyId), pendingConnection(companyId, { providerConsentId: null, consentUrl: null, consentExpiresAt: null })];
    await h.write(companyId, async () => { for (const c of more) await h.store.saveConnection(c); });
    const expected = [connection.id, ...more.map((c) => c.id)];
    assert.deepEqual((await h.store.connections(companyId)).map((c) => c.id), expected);
    assert.deepEqual(await walk((page) => h.store.connections(companyId, page)), expected);
    const other = await h.company();
    assert.deepEqual(await h.store.connections(other.companyId), []);
    assert.deepEqual(await h.store.accounts(other.companyId, connection.id), []);
    assert.deepEqual(await h.store.transactions(other.companyId, connection.id), []);
  });

  test(`${name}: an account keeps its exact balance and cursor, and a save replaces it`, { skip }, async () => {
    const { h, companyId, connection, account } = await setup();
    assert.deepEqual(await h.store.accounts(companyId, connection.id), [account]);
    const synced = { ...account, balancePaise: BIG, balanceAsOf: '2026-08-30T06:00:00.000Z', cursor: 'cursor-7' };
    const second = anAccount(connection, { accountType: 'CASH_CREDIT', balancePaise: -BIG });
    await h.write(companyId, async () => { await h.store.saveAccount(synced); await h.store.saveAccount(second); });
    assert.deepEqual(await h.store.accounts(companyId, connection.id), [synced, second]);
    assert.deepEqual(await walk((page) => h.store.accounts(companyId, connection.id, page), 1), [account.id, second.id]);
  });

  test(`${name}: imported lines are added once, recognised again, counted and paged in order`, { skip }, async () => {
    const { h, companyId, connection, account } = await setup();
    const lines = [aLine(account, { reference: 'UTR-1', creditPaise: BIG }), aLine(account, { debitPaise: 25_000n, creditPaise: 0n, description: 'दुकान का किराया' }), aLine(account)];
    await h.write(companyId, () => h.store.addTransactions(lines));
    await h.write(companyId, () => h.store.addTransactions([]));
    assert.deepEqual(await h.store.transactions(companyId, connection.id), lines);
    assert.equal(await h.store.countTransactions(companyId, connection.id), 3);
    assert.deepEqual(await walk((page) => h.store.transactions(companyId, connection.id, page)), lines.map((line) => line.id));
    const known = await h.store.knownProviderTransactions(companyId, [
      { accountId: account.id, providerTransactionId: lines[0]!.providerTransactionId },
      { accountId: account.id, providerTransactionId: 'never-seen' },
      { accountId: crypto.randomUUID(), providerTransactionId: lines[1]!.providerTransactionId },
    ]);
    assert.deepEqual([...known], [`${account.id}:${lines[0]!.providerTransactionId}`]);
    assert.deepEqual([...await h.store.knownProviderTransactions(companyId, [])], []);
  });

  test(`${name}: a sync result is kept under its key and returned whole`, { skip }, async () => {
    const { h, companyId, connection, account } = await setup();
    const lines = [aLine(account), aLine(account, { reference: 'NEFT-2' })];
    const result = { connection: { ...connection, status: 'CONNECTED' as const, syncStatus: 'SUCCEEDED' as const }, imported: 2, duplicates: 1, transactions: lines };
    await h.write(companyId, async () => { await h.store.addTransactions(lines); await h.store.saveSyncResult(companyId, connection.id, 'daily-1', result); });
    assert.deepEqual(await h.store.syncResult(companyId, connection.id, 'daily-1'), result);
    assert.equal(await h.store.syncResult(companyId, connection.id, 'daily-2'), null);
    assert.equal(await h.store.syncResult((await h.company()).companyId, connection.id, 'daily-1'), null);
  });

  test(`${name}: the audit trail is read back by connection, in order, a page at a time`, { skip }, async () => {
    const { h, companyId, userId, connection } = await setup();
    const other = pendingConnection(companyId);
    const event = (connectionId: string, action: 'bank_feed.sync_started' | 'bank_feed.sync_succeeded') => ({ id: crypto.randomUUID(), companyId, actorId: userId, action, connectionId, occurredAt: at, details: { idempotencyKey: 'daily-1', imported: 2 } });
    await h.write(companyId, async () => {
      await h.store.saveConnection(other);
      await h.store.record(event(connection.id, 'bank_feed.sync_started'));
      await h.store.record(event(other.id, 'bank_feed.sync_started'));
      await h.store.record(event(connection.id, 'bank_feed.sync_succeeded'));
    });
    const trail = await h.store.audit(companyId, connection.id);
    assert.deepEqual(trail.map((e) => [e.action, e.connectionId, e.actorId, e.occurredAt, e.details]), [
      ['bank_feed.sync_started', connection.id, userId, at, { idempotencyKey: 'daily-1', imported: 2 }],
      ['bank_feed.sync_succeeded', connection.id, userId, at, { idempotencyKey: 'daily-1', imported: 2 }],
    ]);
    assert.equal((await h.store.audit(companyId)).length, 3);
    assert.equal((await walk((page) => h.store.audit(companyId, undefined, page))).length, 3);
    assert.deepEqual(await h.store.audit((await h.company()).companyId), []);
  });

  test(`${name}: what a failed action wrote is gone with it`, { skip }, async (t) => {
    const { h, companyId, userId, connection, account } = await setup();
    if (!h.atomic) { t.skip('memory has no transaction to roll back'); return; }
    await assert.rejects(h.write(companyId, async () => {
      await h.store.saveConnection({ ...connection, status: 'CONNECTED' });
      await h.store.saveAccount({ ...account, cursor: 'moved' });
      await h.store.addTransactions([aLine(account)]);
      await h.store.record({ id: crypto.randomUUID(), companyId, actorId: userId, action: 'bank_feed.connected', connectionId: connection.id, occurredAt: at, details: {} });
      throw new Error('abandoned');
    }), /abandoned/);
    assert.deepEqual(await h.store.connection(companyId, connection.id), connection);
    assert.deepEqual(await h.store.accounts(companyId, connection.id), [account]);
    assert.equal(await h.store.countTransactions(companyId, connection.id), 0);
    assert.deepEqual(await h.store.audit(companyId), []);
  });

  // The service on this store: the bank-feeds.test.ts stories, each command as one action.
  test(`${name}: the service connects, syncs once per key, skips replays, survives an outage and keeps history on disconnect`, { skip }, async () => {
    const h = make();
    const { companyId, userId } = await h.company();
    const context: BankFeedContext = { companyId, actorId: userId, permissions: new Set(['bank.feed.manage', 'bank.feed.sync', 'bank.balance.read']) };
    const provider = new SyntheticBankFeedProvider();
    const service = new BankFeedService([provider], () => new Date(at), h.store);
    const run = <T>(work: () => Promise<T>) => h.write(companyId, work);

    const pending = await run(() => service.startConsent(context, { provider: provider.provider, redirectUri: 'https://app.example/bank/callback' }));
    const connection = await run(() => service.completeConsent(context, pending.id, 'sandbox-approved'));
    assert.equal(connection.status, 'CONNECTED');
    assert.equal((await service.connections(context))[0]?.consentUrl, null);
    provider.addTransaction(`current-${companyId}`, { providerTransactionId: 'txn-1', bookedOn: '2026-08-29', description: 'UPI settlement', amountMinor: 12_345n, direction: 'CREDIT', reference: 'UTR-1' });

    const first = await run(() => service.sync(context, connection.id, 'daily-2026-08-30'));
    assert.equal(first.imported, 1);
    assert.equal((await service.accounts(context, connection.id))[0]?.balancePaise, 100_123_45n);
    assert.deepEqual(await run(() => service.sync(context, connection.id, 'daily-2026-08-30')), first);
    assert.equal(provider.syncCount, 1);
    provider.replayFromStartOnce();
    const replay = await run(() => service.sync(context, connection.id, 'cursor-replay'));
    assert.deepEqual([replay.imported, replay.duplicates], [0, 1]);

    // #340 must keep the failure's record: the provider's error is caught inside the action, which commits.
    provider.addTransaction(`current-${companyId}`, { providerTransactionId: 'txn-2', bookedOn: '2026-08-30', description: 'NEFT receipt', amountMinor: 50_000n, direction: 'CREDIT' });
    provider.setMode('outage');
    await run(() => assert.rejects(service.sync(context, connection.id, 'attempt-1'), (error: unknown) => error instanceof ConnectorError && error.code === 'OUTAGE'));
    assert.equal((await service.connections(context))[0]?.syncStatus, 'FAILED');
    assert.equal((await service.accounts(context, connection.id))[0]?.cursor, '1');
    provider.setMode('healthy');
    assert.equal((await run(() => service.sync(context, connection.id, 'attempt-2'))).imported, 1);

    const disconnected = await run(() => service.disconnect(context, connection.id, 'disconnect-once'));
    assert.equal(disconnected.status, 'DISCONNECTED');
    assert.equal((await service.transactions(context, connection.id)).length, 2);
    assert.equal((await service.accounts(context, connection.id))[0]?.active, false);
    await assert.rejects(run(() => service.sync(context, connection.id, 'later')), /Connect this bank account/);
    assert.deepEqual((await service.audit(context, connection.id)).map((event) => event.action), [
      'bank_feed.consent_started', 'bank_feed.connected', 'bank_feed.sync_started', 'bank_feed.sync_succeeded', 'bank_feed.sync_started', 'bank_feed.sync_succeeded',
      'bank_feed.sync_started', 'bank_feed.sync_failed', 'bank_feed.sync_started', 'bank_feed.sync_succeeded', 'bank_feed.disconnected',
    ]);
    assert.equal(JSON.stringify(await service.audit(context), (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value)).includes('sandbox-approved'), false);

    const other = await h.company();
    const outsider: BankFeedContext = { ...context, companyId: other.companyId, actorId: other.userId };
    const refused = (error: unknown) => ['NOT_FOUND', 'TENANT_ISOLATION'].includes((error as { code?: string }).code ?? '');
    await assert.rejects(service.accounts(outsider, connection.id), refused);
    await assert.rejects(h.write(other.companyId, () => service.sync(outsider, connection.id, 'cross-company')), refused);
    assert.deepEqual(await service.connections(outsider), []);
  });

  test(`${name}: an expired permission and a revocation stop syncing and keep the imported lines`, { skip }, async () => {
    const h = make();
    const { companyId, userId } = await h.company();
    const context: BankFeedContext = { companyId, actorId: userId, permissions: new Set(['bank.feed.manage', 'bank.feed.sync', 'bank.balance.read']) };
    const provider = new SyntheticBankFeedProvider();
    const service = new BankFeedService([provider], () => new Date(at), h.store);
    const run = <T>(work: () => Promise<T>) => h.write(companyId, work);
    const pending = await run(() => service.startConsent(context, { provider: provider.provider, redirectUri: 'https://app.example/bank/callback' }));
    const connection = await run(() => service.completeConsent(context, pending.id, 'sandbox-approved'));
    provider.addTransaction(`current-${companyId}`, { providerTransactionId: 'txn-1', bookedOn: '2026-08-30', description: 'Rent', amountMinor: 25_000n, direction: 'DEBIT' });
    await run(() => service.sync(context, connection.id, 'first'));
    provider.setMode('expired');
    await run(() => assert.rejects(service.sync(context, connection.id, 'expired'), /UNAUTHORIZED/));
    assert.equal((await service.connections(context))[0]?.status, 'TOKEN_EXPIRED');
    const revoked = await run(() => service.markRevoked(context, connection.id));
    assert.equal(revoked.status, 'REVOKED');
    assert.equal((await service.accounts(context, connection.id))[0]?.active, false);
    const [line] = await service.transactions(context, connection.id);
    assert.deepEqual([line?.debitPaise, line?.creditPaise, line?.bookedOn], [25_000n, 0n, '2026-08-30']);
  });
};

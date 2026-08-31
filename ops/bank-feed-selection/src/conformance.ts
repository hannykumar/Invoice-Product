/**
 * Issue #52 [X04] — what a candidate provider's sandbox has to prove before we build on it.
 *
 * "Obtain a sandbox" should end in a green run, not a signed PDF. This harness takes any
 * `BankFeedProviderAdapter` — #24's synthetic one today, a real provider's tomorrow — and puts it
 * through the behaviours the contract in `docs/contracts/bank-feeds-v1.md` depends on. A provider
 * that fails any of them is not a provider we can build reconciliation on, whatever the commercial
 * terms say.
 *
 * The first check is the one that matters most: **a masked account number and nothing that looks
 * like a credential**. A sandbox that hands back a full account number in a field we did not ask
 * for tells us what the production one will do.
 */
import type { BankFeedProviderAdapter, ProviderAccount, ProviderTransaction } from '@invoice/bank-feeds';

export type CheckState = 'PASSED' | 'FAILED' | 'NOT_ATTEMPTED';

export interface ConformanceCheck {
  readonly id: string;
  readonly what: string;
  readonly why: string;
  readonly state: CheckState;
  readonly detail: string;
}

export interface ConformanceReport {
  readonly provider: string;
  readonly checks: readonly ConformanceCheck[];
  readonly passed: boolean;
  readonly summary: string;
}

const SECRET_SHAPES: readonly { readonly kind: string; readonly match: RegExp }[] = [
  { kind: 'a full account number', match: /\b\d{9,18}\b/ },
  { kind: 'an IFSC code', match: /\b[A-Z]{4}0[A-Z0-9]{6}\b/ },
  { kind: 'a password or PIN', match: /\b(?:password|passwd|pin|otp|mpin)\b/i },
  { kind: 'a token', match: /\b(?:access[_-]?token|refresh[_-]?token|bearer)\b/i },
];

const secretIn = (value: unknown): string | null => {
  // Amounts arrive as `bigint`, which `JSON.stringify` refuses to serialise — and a long digit
  // string is exactly what the account-number pattern looks for, so amounts are rendered as a
  // marker rather than as digits. A ₹48,750 credit is not a leaked account number.
  const text = JSON.stringify(value ?? '', (_key, item: unknown) => (typeof item === 'bigint' ? '<amount>' : item));
  for (const shape of SECRET_SHAPES) if (shape.match.test(text)) return shape.kind;
  return null;
};

const check = (id: string, what: string, why: string, state: CheckState, detail: string): ConformanceCheck =>
  ({ id, what, why, state, detail });

/**
 * Runs the suite.
 *
 * Every failure is reported rather than thrown, because the useful output of a sandbox trial is
 * the whole list — a provider we will go back to with four questions, not one.
 */
export interface ConformanceOptions {
  readonly companyId: string;
  readonly redirectUri: string;
  /**
   * The code the provider's own sandbox expects back from its consent screen. Every sandbox has its
   * own; it is passed in rather than guessed, and it is never a credential — it is exchanged once.
   */
  readonly authorizationCode: string;
}

export const runConformance = async (
  adapter: BankFeedProviderAdapter,
  options: ConformanceOptions,
): Promise<ConformanceReport> => {
  const checks: ConformanceCheck[] = [];
  const failed = new Set<string>();
  /**
   * Runs one check, unless something it depends on has already failed.
   *
   * A check that could not be attempted says so rather than passing on an empty result — a sandbox
   * that returned nothing must not read as "no secrets found, all clear".
   */
  const record = async (id: string, what: string, why: string, dependsOn: readonly string[], run: () => Promise<string>): Promise<void> => {
    const blocked = dependsOn.filter((dependency) => failed.has(dependency));
    if (blocked.length > 0) {
      checks.push(check(id, what, why, 'NOT_ATTEMPTED', `Not attempted, because ${blocked.join(' and ')} failed first.`));
      failed.add(id);
      return;
    }
    try {
      checks.push(check(id, what, why, 'PASSED', await run()));
    } catch (error) {
      checks.push(check(id, what, why, 'FAILED', error instanceof Error ? error.message : String(error)));
      failed.add(id);
    }
  };

  let providerConsentId = '';
  let accounts: readonly ProviderAccount[] = [];

  await record('consent.start', 'Consent begins away from us',
    'The shopkeeper must grant permission at the provider, not by typing a bank password into our screen.',
    [], async () => {
      const started = await adapter.startConsent({ companyId: options.companyId, connectionId: 'conformance-1', redirectUri: options.redirectUri });
      if (!started.providerConsentId || !started.consentUrl) throw new Error('No consent id or consent URL was returned.');
      if (!/^https:\/\//.test(started.consentUrl)) throw new Error(`The consent URL is not https: ${started.consentUrl}`);
      providerConsentId = started.providerConsentId;
      return `Consent starts at ${new URL(started.consentUrl).host}, expiring ${started.expiresAt}.`;
    });

  await record('consent.complete', 'The authorisation code is exchanged once',
    'An authorisation code that can be replayed is a credential. It passes through and is never stored.',
    ['consent.start'], async () => {
      const completed = await adapter.completeConsent({ companyId: options.companyId, providerConsentId, authorizationCode: options.authorizationCode });
      if (completed.accounts.length === 0) throw new Error('No accounts were returned after consent.');
      accounts = completed.accounts;
      return `${completed.accounts.length} account(s), consent expiring ${completed.consentExpiresAt}.`;
    });

  await record('accounts.masked', 'Accounts come back masked, and carry no secrets',
    'We display an account to a person without ever holding the number. A provider that sends the full number has told us how it treats data.',
    ['consent.complete'], async () => {
      for (const account of accounts) {
        if (!/[*xX•]/.test(account.maskedAccountNumber)) {
          throw new Error(`"${account.maskedAccountNumber}" does not look masked.`);
        }
        const leak = secretIn(account);
        if (leak !== null) throw new Error(`The account payload contains what looks like ${leak}.`);
      }
      return `${accounts.length} account(s), all masked, nothing credential-shaped.`;
    });

  let firstCursors: Record<string, string | null> = {};
  let firstTransactions: readonly ProviderTransaction[] = [];

  await record('sync.fields', 'Every transaction has the fields reconciliation needs',
    'Booking date, description, amount and direction are what #22 matches on. A missing field is a manual reconciliation.',
    ['consent.complete'], async () => {
      // The first fetch asks for every account we were given, from the beginning.
      const opening = Object.fromEntries(accounts.map((account) => [account.providerAccountId, null]));
      const page = await adapter.sync({ companyId: options.companyId, providerConsentId, cursors: opening, idempotencyKey: 'conformance-sync-1' });
      firstTransactions = page.accounts.flatMap((account) => account.transactions);
      firstCursors = Object.fromEntries(page.accounts.map((account) => [account.providerAccountId, account.nextCursor]));
      if (firstTransactions.length === 0) throw new Error('The sandbox returned no transactions, so nothing can be checked.');
      for (const transaction of firstTransactions) {
        if (!transaction.providerTransactionId) throw new Error('A transaction has no provider identifier, so duplicates cannot be detected.');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(transaction.bookedOn)) throw new Error(`"${transaction.bookedOn}" is not a plain calendar date.`);
        if (transaction.description.trim() === '') throw new Error('A transaction has no description; there is nothing for a person to recognise.');
        if (typeof transaction.amountMinor !== 'bigint') throw new Error('Amounts must arrive as exact minor units, never as a floating-point number.');
        if (transaction.amountMinor <= 0n) throw new Error('An amount is not positive; direction carries the sign, not the amount.');
        if (transaction.direction !== 'CREDIT' && transaction.direction !== 'DEBIT') throw new Error('A transaction has no direction.');
      }
      const leak = secretIn(firstTransactions);
      if (leak !== null) throw new Error(`A transaction payload contains what looks like ${leak}.`);
      return `${firstTransactions.length} transaction(s), every required field present.`;
    });

  await record('sync.idempotent', 'The same fetch twice returns the same thing',
    'A retry after a timeout must not double-count a shopkeeper’s money.',
    ['sync.fields'], async () => {
      const opening = Object.fromEntries(accounts.map((account) => [account.providerAccountId, null]));
      const again = await adapter.sync({ companyId: options.companyId, providerConsentId, cursors: opening, idempotencyKey: 'conformance-sync-1' });
      const ids = again.accounts.flatMap((account) => account.transactions).map((transaction) => transaction.providerTransactionId);
      const first = firstTransactions.map((transaction) => transaction.providerTransactionId);
      if (JSON.stringify(ids) !== JSON.stringify(first)) throw new Error('Repeating a fetch with the same key returned different transactions.');
      return 'Repeating the fetch returned the same transactions.';
    });

  await record('sync.cursor', 'A cursor moves forward and does not repeat what we have',
    'Without a cursor every sync re-imports everything and reconciliation drowns in duplicates.',
    ['sync.fields'], async () => {
      const next = await adapter.sync({ companyId: options.companyId, providerConsentId, cursors: firstCursors, idempotencyKey: 'conformance-sync-2' });
      const repeated = next.accounts
        .flatMap((account) => account.transactions)
        .filter((transaction) => firstTransactions.some((seen) => seen.providerTransactionId === transaction.providerTransactionId));
      if (repeated.length > 0) throw new Error(`${repeated.length} transaction(s) came back after their cursor.`);
      return 'The cursor advanced and nothing was sent twice.';
    });

  await record('revoke', 'Permission can be taken back, and taking it back is idempotent',
    'A shopkeeper must be able to stop this without ringing anybody, and a failed revoke must be safe to retry.',
    ['consent.complete'], async () => {
      await adapter.revoke({ companyId: options.companyId, providerConsentId, idempotencyKey: 'conformance-revoke-1' });
      await adapter.revoke({ companyId: options.companyId, providerConsentId, idempotencyKey: 'conformance-revoke-1' });
      return 'Revoked, and revoking again was accepted.';
    });

  const notPassed = checks.filter((item) => item.state !== 'PASSED');
  return {
    provider: adapter.provider,
    checks,
    passed: notPassed.length === 0,
    summary: notPassed.length === 0
      ? `${adapter.provider}: all ${checks.length} checks passed. This sandbox is one we can build on.`
      : `${adapter.provider}: ${notPassed.length} of ${checks.length} checks did not pass — ${notPassed.map((item) => item.id).join(', ')}. Go back to the provider with these before signing anything.`,
  };
};

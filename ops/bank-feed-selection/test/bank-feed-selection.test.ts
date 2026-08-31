/**
 * Issue #52 [X04] — the tests that matter.
 *
 * Two of them are the acceptance criteria: a credential-scraping route can never be recommended,
 * and a recommendation cannot be produced out of facts nobody has confirmed. The rest prove the
 * conformance harness actually catches what it claims to, by handing it providers that misbehave in
 * each of the specific ways a real one might.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { SyntheticBankFeedProvider, type BankFeedProviderAdapter, type ProviderAccount, type ProviderSyncPage } from '@invoice/bank-feeds';
import {
  CANDIDATES,
  CRITERIA,
  known,
  marginAgainstPlan,
  monthlyCost,
  recommend,
  runConformance,
  scoreCandidate,
  unknown,
  type Candidate,
} from '../src/index.ts';

const TODAY = '2026-08-31';

const seeded = (): SyntheticBankFeedProvider => {
  const provider = new SyntheticBankFeedProvider();
  provider.addTransaction('current-c1', { providerTransactionId: 'upi-1', bookedOn: '2026-08-29', description: 'UPI settlement', amountMinor: 48_750_00n, direction: 'CREDIT', reference: 'SYNTHETIC-UTR-1' });
  provider.addTransaction('current-c1', { providerTransactionId: 'neft-1', bookedOn: '2026-08-29', description: 'Shop rent NEFT', amountMinor: 25_000_00n, direction: 'DEBIT' });
  return provider;
};

const options = { companyId: 'c1', redirectUri: 'https://karobar.example/return', authorizationCode: 'sandbox-approved' };

/** A provider that is correct except in one named way, so each check is proved to bite. */
const brokenIn = (breakage: 'account' | 'date' | 'float' | 'duplicate-key' | 'no-cursor'): BankFeedProviderAdapter => {
  const inner = seeded();
  return {
    provider: `broken-${breakage}`,
    startConsent: (input) => inner.startConsent(input),
    async completeConsent(input) {
      const result = await inner.completeConsent(input);
      if (breakage !== 'account') return result;
      const accounts: ProviderAccount[] = result.accounts.map((account) => ({ ...account, maskedAccountNumber: '50100123456789' }));
      return { ...result, accounts };
    },
    async sync(input): Promise<ProviderSyncPage> {
      const page = await inner.sync(input);
      if (breakage === 'date') {
        return { accounts: page.accounts.map((account) => ({ ...account, transactions: account.transactions.map((t) => ({ ...t, bookedOn: '29/08/2026' })) })) };
      }
      if (breakage === 'float') {
        return { accounts: page.accounts.map((account) => ({ ...account, transactions: account.transactions.map((t) => ({ ...t, amountMinor: 48750.5 as unknown as bigint })) })) };
      }
      if (breakage === 'duplicate-key') {
        return { accounts: page.accounts.map((account) => ({ ...account, transactions: account.transactions.map((t) => ({ ...t, providerTransactionId: '' })) })) };
      }
      if (breakage === 'no-cursor') {
        // Ignores the cursor and sends everything again, every time.
        return inner.sync({ ...input, cursors: Object.fromEntries(Object.keys(input.cursors).map((key) => [key, null])) });
      }
      return page;
    },
    revoke: (input) => inner.revoke(input),
  };
};

describe('a route that holds the shopkeeper’s banking password', () => {
  it('is disqualified before anything is scored', () => {
    const candidate = CANDIDATES.find((item) => item.accessModel === 'CREDENTIAL_SHARING');
    assert.ok(candidate);
    const score = scoreCandidate(candidate);
    assert.equal(score.verdict, 'DISQUALIFIED');
    assert.equal(score.score, null, 'not a low score to be outweighed by price');
    assert.match(score.reason['en-IN'], /at any price/);
  });

  it('cannot be recommended even when it scores best on everything else', () => {
    const perfect: Candidate = {
      id: 'too-good', name: 'Scrapes credentials, free, every bank, instant',
      accessModel: 'CREDENTIAL_SHARING',
      summary: { 'en-IN': 'x', 'hi-IN': 'x' },
      assessments: Object.fromEntries(CRITERIA.map((criterion) => [criterion.id, known(5, 'CONFIRMED', 'test', TODAY)])),
      cost: known({ monthlyPlatformFeePaise: 0n, perConnectionPaise: 0n, perSyncPaise: 0n, oneOffPaise: 0n }, 'CONFIRMED', 'test', TODAY),
      openQuestions: [],
    };
    const report = recommend([perfect], TODAY);
    assert.equal(report.chosen, null);
    assert.equal(report.scores[0]?.verdict, 'DISQUALIFIED');
  });
});

describe('nothing is guessed', () => {
  it('refuses to score a candidate whose essential facts nobody has confirmed', () => {
    const aggregator = CANDIDATES.find((item) => item.id === 'account_aggregator');
    assert.ok(aggregator);
    const score = scoreCandidate(aggregator);
    assert.equal(score.verdict, 'CANNOT_SAY_YET');
    assert.equal(score.score, null);
    assert.match(score.reason['en-IN'], /guess dressed as arithmetic/);
  });

  it('defers with the questions to ask when no route can be scored', () => {
    const unscorable = CANDIDATES.filter((item) => item.id !== 'statement_upload');
    const report = recommend(unscorable, TODAY);
    assert.equal(report.chosen, null);
    assert.ok(report.deferral);
    assert.ok(report.deferral.toAsk.length >= 8, 'and says exactly what to ask, of whom');
    assert.match(report.deferral.why['en-IN'], /documented reason to defer/);
  });

  it('recommends the statement upload today, because it is the only route we actually know', () => {
    const report = recommend(CANDIDATES, TODAY);
    assert.ok(report.chosen);
    assert.equal(report.chosen.candidate.id, 'statement_upload');
    assert.equal(report.chosen.verdict, 'RECOMMENDED');
    // And the live-feed routes are not pretended to be worse — they are unknown.
    for (const id of ['account_aggregator', 'direct_bank_api', 'partner_aggregator']) {
      assert.equal(report.scores.find((score) => score.candidate.id === id)?.verdict, 'CANNOT_SAY_YET');
    }
  });

  it('changes its mind when a provider actually answers', () => {
    const aggregator = CANDIDATES.find((item) => item.id === 'account_aggregator') as Candidate;
    const answered: Candidate = {
      ...aggregator,
      assessments: {
        consent_and_revocation: known(5, 'CONFIRMED', 'Provider’s written answer', TODAY),
        accounting_use_permitted: known(5, 'CONFIRMED', 'Provider’s written answer', TODAY),
        bank_coverage: known(4, 'CONFIRMED', 'Provider’s written answer', TODAY),
        cost: known(3, 'CONFIRMED', 'Quotation', TODAY),
        sandbox_availability: known(5, 'CONFIRMED', 'Sandbox granted', TODAY),
        startup_eligibility: known(4, 'CONFIRMED', 'Provider’s written answer', TODAY),
        data_freshness: known(5, 'CONFIRMED', 'Provider’s written answer', TODAY),
        history_depth: unknown('Still not answered.'),
      },
      cost: aggregator.cost,
      openQuestions: [],
    };
    const baseline = CANDIDATES.filter((item) => item.id === 'statement_upload');
    const mixed = recommend([answered, ...baseline], TODAY);
    // It becomes scorable, which is the change that matters — and it does not automatically win.
    assert.equal(mixed.scores.find((score) => score.candidate.id === 'account_aggregator')?.verdict, 'VIABLE');
    assert.ok(mixed.scores.find((score) => score.candidate.id === 'account_aggregator')?.missing.includes('history_depth'),
      'a non-essential unknown does not block a verdict, and is still reported');

    // And on these weights the free, universal, already-built route still wins on a merely good
    // answer. That is the model saying something true: replacing it has to be worth paying for.
    assert.equal(mixed.chosen?.candidate.id, 'statement_upload');

    const excellent: Candidate = {
      ...answered,
      assessments: Object.fromEntries(CRITERIA.map((criterion) => [criterion.id, known(5, 'CONFIRMED', 'Provider’s written answer', TODAY)])),
    };
    const strong = recommend([excellent, ...baseline], TODAY);
    assert.equal(strong.chosen?.candidate.id, 'account_aggregator', 'a live feed wins when it is strong on everything, freshness included');
  });
});

describe('the cost model', () => {
  it('is arithmetic on a quotation, in paise', () => {
    const cost = monthlyCost(
      { monthlyPlatformFeePaise: 25_000_00n, perConnectionPaise: 40_00n, perSyncPaise: 20n, oneOffPaise: 150_000_00n },
      { connections: 500, syncsPerConnectionPerMonth: 30, amortiseOneOffOverMonths: 24 },
    );
    assert.equal(cost.platform, 2_500_000n);
    assert.equal(cost.connections, 2_000_000n);
    assert.equal(cost.syncs, 300_000n);
    assert.equal(cost.amortisedOneOff, 625_000n);
    assert.equal(cost.total, 5_425_000n);
    assert.equal(cost.perConnection, 10_850n);
  });

  it('says plainly when a route cannot pay for itself under the plan it sits in', () => {
    const cost = monthlyCost(
      { monthlyPlatformFeePaise: 0n, perConnectionPaise: 600_00n, perSyncPaise: 0n, oneOffPaise: 0n },
      { connections: 100, syncsPerConnectionPerMonth: 30, amortiseOneOffOverMonths: 12 },
    );
    const margin = marginAgainstPlan(cost, 499_00n);
    assert.equal(margin.sustainable, false);
    assert.match(margin.sentence['en-IN'], /cannot pay for itself/);
  });

  it('gets cheaper per business as more of them connect, which is the whole shape of the decision', () => {
    const shape = { monthlyPlatformFeePaise: 25_000_00n, perConnectionPaise: 40_00n, perSyncPaise: 20n, oneOffPaise: 150_000_00n };
    const small = monthlyCost(shape, { connections: 100, syncsPerConnectionPerMonth: 30, amortiseOneOffOverMonths: 24 });
    const large = monthlyCost(shape, { connections: 10_000, syncsPerConnectionPerMonth: 30, amortiseOneOffOverMonths: 24 });
    assert.ok(large.perConnection < small.perConnection);
  });
});

describe('the sandbox conformance harness', () => {
  it('passes the one sandbox we have', async () => {
    const report = await runConformance(seeded(), options);
    assert.equal(report.passed, true, report.summary);
    assert.equal(report.checks.length, 7);
  });

  it('catches a provider that returns a full account number', async () => {
    const report = await runConformance(brokenIn('account'), options);
    assert.equal(report.passed, false);
    const check = report.checks.find((item) => item.id === 'accounts.masked');
    assert.equal(check?.state, 'FAILED');
    assert.match(check.detail, /does not look masked/);
  });

  it('catches dates that are not calendar dates, and amounts that are not exact', async () => {
    const dates = await runConformance(brokenIn('date'), options);
    assert.match(dates.checks.find((item) => item.id === 'sync.fields')?.detail ?? '', /not a plain calendar date/);
    const floats = await runConformance(brokenIn('float'), options);
    assert.match(floats.checks.find((item) => item.id === 'sync.fields')?.detail ?? '', /exact minor units/);
  });

  it('catches a provider whose transactions cannot be deduplicated', async () => {
    const report = await runConformance(brokenIn('duplicate-key'), options);
    assert.match(report.checks.find((item) => item.id === 'sync.fields')?.detail ?? '', /duplicates cannot be detected/);
  });

  it('catches a provider that ignores the cursor and resends everything', async () => {
    const report = await runConformance(brokenIn('no-cursor'), options);
    assert.equal(report.passed, false);
    assert.match(report.checks.find((item) => item.id === 'sync.cursor')?.detail ?? '', /came back after their cursor/);
  });

  it('does not let a check pass on an empty result when something earlier failed', async () => {
    // A provider that refuses consent: everything downstream is unattempted, not "clean".
    const inner = seeded();
    const refusing: BankFeedProviderAdapter = {
      provider: 'refuses',
      startConsent: (input) => inner.startConsent(input),
      async completeConsent() { throw new Error('UNAUTHORIZED'); },
      sync: (input) => inner.sync(input),
      revoke: (input) => inner.revoke(input),
    };
    const report = await runConformance(refusing, options);
    assert.equal(report.passed, false);
    assert.equal(report.checks.find((item) => item.id === 'accounts.masked')?.state, 'NOT_ATTEMPTED');
    assert.equal(report.checks.find((item) => item.id === 'sync.fields')?.state, 'NOT_ATTEMPTED');
    assert.match(report.checks.find((item) => item.id === 'accounts.masked')?.detail ?? '', /Not attempted/);
  });
});

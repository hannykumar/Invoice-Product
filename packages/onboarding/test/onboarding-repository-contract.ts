/**
 * Issue #366 — one contract suite for where a setup is kept, run against memory
 * (onboarding-repository-contract.test.ts) and against PostgreSQL as the application role
 * (onboarding-repository-contract.integration.test.ts).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isoDate, rupees, type CompanyId, type UserId } from '@invoice/kernel';
import { emptyAnswers, emptySteps, type OnboardingSession } from '../src/model.ts';
import type { OnboardingRepository } from '../src/repository.ts';

export interface OnboardingRepositoryHarness {
  readonly repository: OnboardingRepository;
  /** A company and a person: rows that exist wherever the implementation keeps them. */
  company(): Promise<CompanyId>;
  user(): Promise<UserId>;
  /** Runs `work` as one business action — a unit of work on PostgreSQL, a plain call in memory. */
  write<T>(companyId: CompanyId, work: () => Promise<T>): Promise<T>;
}

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

export const sessionOf = (companyId: CompanyId, userId: UserId, over: Partial<OnboardingSession> = {}): OnboardingSession => ({
  id: crypto.randomUUID(),
  companyId,
  state: 'IN_PROGRESS',
  steps: emptySteps(),
  answers: emptyAnswers(),
  createdBy: userId,
  createdAt: '2026-08-29T09:00:00.000Z',
  updatedAt: '2026-08-29T09:00:00.000Z',
  openingVoucherId: null,
  version: 1,
  ...over,
});

/** A step saved with a wrong answer kept, money beyond a JavaScript number, and Hindi text. */
const halfDone = (session: OnboardingSession): OnboardingSession => ({
  ...session,
  answers: {
    ...session.answers,
    business: { legalName: 'Meera Bakers', businessType: 'BAKERY', stateCode: '08', addressLines: ['12 Station Road'] },
    taxProfile: { registration: 'REGULAR', gstin: '08AAAAA0000A1Z9', booksStartDate: isoDate('2026-04-01') },
    rates: [{ code: '1905', kind: 'GOODS', ratePercentTimes100: 500n, basis: 'Our accountant, letter of 2 April' }],
    openingBalances: [{ accountCode: '1110', label: 'Cash in hand', debit: rupees(9_007_199_254_740n, 93n), credit: rupees(0) }],
  },
  steps: {
    ...session.steps,
    business: { state: 'DONE', problems: [], completedAt: '2026-08-29T09:05:00.000Z' },
    tax_profile: {
      state: 'NEEDS_ATTENTION',
      problems: [{ code: 'GSTIN_CHECKSUM', field: 'gstin', message: { 'en-IN': 'A digit was probably mistyped.', 'hi-IN': 'शायद एक अंक गलत लिखा गया।' } }],
      completedAt: null,
    },
  },
  updatedAt: '2026-08-29T09:05:00.000Z',
  version: session.version + 1,
});

export const onboardingRepositoryContract = (name: string, harness: () => OnboardingRepositoryHarness, skip: string | false = false): void => {
  const scene = async () => {
    const h = harness();
    return { h, companyId: await h.company(), userId: await h.user() };
  };

  test(`${name}: a setup comes back exactly as it was saved, by id, by key and as the open one`, { skip }, async () => {
    const { h, companyId, userId } = await scene();
    const session = sessionOf(companyId, userId);
    await h.write(companyId, () => h.repository.insert(session, 'start-1'));
    assert.deepEqual(await h.repository.findById(companyId, session.id), session);
    assert.deepEqual(await h.repository.findByIdempotencyKey(companyId, 'start-1'), session);
    assert.deepEqual(await h.repository.findOpenForCompany(companyId), session);
    assert.equal(await h.repository.findByIdempotencyKey(companyId, 'start-2'), null);
    assert.equal(await h.repository.findById(companyId, crypto.randomUUID()), null);
  });

  test(`${name}: a wrong answer, big money and Hindi survive a save untouched`, { skip }, async () => {
    const { h, companyId, userId } = await scene();
    const session = sessionOf(companyId, userId);
    await h.write(companyId, () => h.repository.insert(session, 'k'));
    const next = halfDone(session);
    await h.write(companyId, () => h.repository.update(next, session.version));
    const back = await h.repository.findById(companyId, session.id);
    assert.deepEqual(back, next);
    assert.equal(back?.answers.openingBalances[0]?.debit.minor, 900_719_925_474_093n);
    assert.equal(typeof back?.answers.rates[0]?.ratePercentTimes100, 'bigint');
  });

  test(`${name}: the same key twice is one setup`, { skip }, async () => {
    const { h, companyId, userId } = await scene();
    await h.write(companyId, () => h.repository.insert(sessionOf(companyId, userId), 'k'));
    await assert.rejects(h.write(companyId, () => h.repository.insert(sessionOf(companyId, userId), 'k')), code('ONBOARDING_ALREADY_STARTED'));
  });

  test(`${name}: a save made on an old copy is refused, and the newer one kept`, { skip }, async () => {
    const { h, companyId, userId } = await scene();
    const session = sessionOf(companyId, userId);
    await h.write(companyId, () => h.repository.insert(session, 'k'));
    const mine = halfDone(session);
    await h.write(companyId, () => h.repository.update(mine, 1));
    await assert.rejects(h.write(companyId, () => h.repository.update({ ...session, version: 2, updatedAt: '2026-08-29T09:06:00.000Z' }, 1)), code('ONBOARDING_CONCURRENT_EDIT'));
    assert.deepEqual(await h.repository.findById(companyId, session.id), mine);
  });

  test(`${name}: saving a setup that does not exist says so`, { skip }, async () => {
    const { h, companyId, userId } = await scene();
    await assert.rejects(h.write(companyId, () => h.repository.update(sessionOf(companyId, userId), 1)), code('ONBOARDING_NOT_FOUND'));
  });

  test(`${name}: a finished setup is no longer the open one`, { skip }, async () => {
    const { h, companyId, userId } = await scene();
    const session = sessionOf(companyId, userId);
    await h.write(companyId, () => h.repository.insert(session, 'k'));
    const done: OnboardingSession = { ...session, state: 'COMPLETED', version: 2, updatedAt: '2026-08-29T10:00:00.000Z' };
    await h.write(companyId, () => h.repository.update(done, 1));
    assert.equal(await h.repository.findOpenForCompany(companyId), null);
    assert.deepEqual(await h.repository.findById(companyId, session.id), done);
  });

  test(`${name}: one business never sees another's setup`, { skip }, async () => {
    const a = await scene();
    const b = await scene();
    const session = sessionOf(a.companyId, a.userId);
    await a.h.write(a.companyId, () => a.h.repository.insert(session, 'same-key'));
    assert.equal(await b.h.repository.findById(b.companyId, session.id), null);
    assert.equal(await b.h.repository.findByIdempotencyKey(b.companyId, 'same-key'), null);
    assert.equal(await b.h.repository.findOpenForCompany(b.companyId), null);
    // The same key in another business is that business's own setup.
    await b.h.write(b.companyId, () => b.h.repository.insert(sessionOf(b.companyId, b.userId), 'same-key'));
    assert.deepEqual(await a.h.repository.findByIdempotencyKey(a.companyId, 'same-key'), session);
  });
};

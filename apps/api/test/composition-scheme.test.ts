/**
 * Issue #296 — the scheme history is append-only and safe under concurrent presses: the same request
 * id applies once, a different change that lands first is a conflict, and previewing writes nothing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainError, isoDate } from '@invoice/kernel';
import {
  applySchemeChange, compositionRateOn, forgetScheme, previewSchemeChange, registrationHistoryOf, schemeDuring, schemeHistoryOf, schemeOn,
  type SchemeContext,
} from '../src/composition-scheme.ts';

const COMPANY = 'scheme-test-company';
const context = (over: Partial<SchemeContext> = {}): SchemeContext => ({
  companyId: COMPANY, gstin: '29AAAAA0000A1ZY', declaredBy: 'owner', today: isoDate('2026-10-27'),
  billsIssuedSince: async () => { await new Promise((resolve) => setImmediate(resolve)); return 0; },
  goodsItemCount: () => 3, ...over,
});
const join = (extra: Record<string, unknown> = {}) => ({
  scheme: 'COMPOSITION', effectiveFrom: '2027-04-01', category: 'MANUFACTURER_OR_TRADER', withinLimit: true, noInterState: true, noEcommerce: true,
  rateConfirmed: true, requestId: 'r1', ...extra,
});

test('the same request id pressed twice at once applies once', async () => {
  forgetScheme(COMPANY);
  const preview = await previewSchemeChange(context(), join());
  assert.equal(preview.ok, true);
  const results = await Promise.all([
    applySchemeChange(context(), { ...join(), token: preview.token }),
    applySchemeChange(context(), { ...join(), token: preview.token }),
  ]);
  assert.equal(schemeHistoryOf(COMPANY).length, 1);
  assert.deepEqual(results.map((r) => r.deduplicated).sort(), [false, true]);
});

test('two different changes at once: one lands, the other is told to look again', async () => {
  forgetScheme(COMPANY);
  const a = await previewSchemeChange(context(), join({ requestId: 'a' }));
  const b = await previewSchemeChange(context(), join({ requestId: 'b', category: 'RESTAURANT' }));
  const settled = await Promise.allSettled([
    applySchemeChange(context(), { ...join({ requestId: 'a' }), token: a.token }),
    applySchemeChange(context(), { ...join({ requestId: 'b', category: 'RESTAURANT' }), token: b.token }),
  ]);
  assert.equal(schemeHistoryOf(COMPANY).length, 1, 'never two entries on one date');
  const failed = settled.filter((s) => s.status === 'rejected') as PromiseRejectedResult[];
  assert.equal(failed.length, 1);
  assert.ok(failed[0]!.reason instanceof DomainError && failed[0]!.reason.code === 'COMPOSITION_CHANGED_SINCE_PREVIEW');
});

test('previewing never writes, and a change that does not hold gives no token', async () => {
  forgetScheme(COMPANY);
  await previewSchemeChange(context(), join());
  assert.equal(schemeHistoryOf(COMPANY).length, 0);
  const refused = await previewSchemeChange(context(), join({ withinLimit: false }));
  assert.equal(refused.token, null);
  await assert.rejects(applySchemeChange(context(), { ...join(), token: 'x' }), (e) => e instanceof DomainError);
});

test('the scheme on a date, the months it spans, and the rate follow the history', async () => {
  forgetScheme(COMPANY);
  const first = await previewSchemeChange(context(), join());
  await applySchemeChange(context(), { ...join(), token: first.token });
  const leaveInput = { scheme: 'REGULAR', effectiveFrom: '2027-10-01', requestId: 'leave' };
  const leave = await previewSchemeChange(context(), leaveInput);
  assert.equal(leave.ok, true, JSON.stringify(leave.blockers));
  await applySchemeChange(context(), { ...leaveInput, token: leave.token });

  assert.equal(schemeOn(COMPANY, '2027-03-31'), 'REGULAR');
  assert.equal(schemeOn(COMPANY, '2027-04-01'), 'COMPOSITION');
  assert.equal(schemeOn(COMPANY, '2027-09-30'), 'COMPOSITION');
  assert.equal(schemeOn(COMPANY, '2027-10-01'), 'REGULAR');
  assert.equal(schemeDuring(COMPANY, '2027-05-01', '2027-05-31'), 'COMPOSITION');
  assert.equal(schemeDuring(COMPANY, '2027-03-01', '2027-03-31'), 'REGULAR');
  assert.equal(schemeDuring(COMPANY, '2027-03-15', '2027-04-14'), 'BOTH');
  assert.equal(schemeDuring(COMPANY, '2027-09-15', '2027-10-14'), 'BOTH');
  assert.equal(compositionRateOn(COMPANY, '2027-06-01')?.rateBasisPoints, 100n);
  assert.equal(compositionRateOn(COMPANY, '2027-11-01'), null);
  assert.deepEqual(registrationHistoryOf(COMPANY).map((c) => c.registration), ['COMPOSITION', 'REGULAR']);
});

test('a services-only choice is refused for a business that keeps goods, and a past date over issued bills is refused', async () => {
  forgetScheme(COMPANY);
  const services = await previewSchemeChange(context(), join({ category: 'SERVICES_ONLY' }));
  assert.equal(services.ok, false);
  assert.match(services.blockers.map((b) => b['en-IN']).join(' '), /goods/);
  const covered = await previewSchemeChange(context({ billsIssuedSince: async () => 2 }), join({ effectiveFrom: '2026-04-01' }));
  assert.equal(covered.ok, false);
  assert.match(covered.blockers.map((b) => b['en-IN']).join(' '), /2 bills have already been issued/);
});

test('a rate that cannot split in two, or is typed badly, is refused', async () => {
  forgetScheme(COMPANY);
  await assert.rejects(previewSchemeChange(context(), join({ ratePercent: '1.01' })), (e) => e instanceof DomainError && e.code === 'COMPOSITION_RATE');
  await assert.rejects(previewSchemeChange(context(), join({ ratePercent: 'abc' })), (e) => e instanceof DomainError && e.code === 'COMPOSITION_RATE');
  const typed = await previewSchemeChange(context(), join({ ratePercent: '1.5', rateConfirmed: false }));
  assert.equal(typed.ok, true, 'a rate the owner typed is theirs; no separate confirmation is asked');
  assert.equal(typed.change?.rateBasis, 'BUSINESS_DECLARED');
});

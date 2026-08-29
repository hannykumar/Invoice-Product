/**
 * Issue #54 [X06] acceptance criteria, enforced automatically.
 *
 *  - "Every production compliance rule has an approved source"
 *  - "Changes generate actionable review tasks"
 *  - "Marketing/blog sources are not treated as legal authority"
 *
 * plus the required broken/stale source audit and the trace from a decision to its source and its
 * test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isoDate, DomainError } from '@invoice/kernel';
import { ComplianceRegister, defaultRegister, isOfficiallyPublished, OFFICIAL_DOMAINS } from '../src/register.ts';
import { SOURCES, UTGST_PENDING_VERIFICATION_NAMES, UTGST_TERRITORY_NAMES } from '../src/sources.ts';
import { RULE_SOURCE_LINKS } from '../src/rule-links.ts';
import { DECISION_LOG } from '../src/decision-log.ts';
import { LEGAL_AUTHORITIES, type ComplianceSource } from '../src/types.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TODAY = isoDate('2026-08-29');

const withSource = (overrides: Partial<ComplianceSource>): ComplianceSource => ({
  ...(SOURCES[0] as ComplianceSource),
  ...overrides,
});

test('every source names its authority, its provision, where it came from and when we read it', () => {
  assert.ok(SOURCES.length > 0);
  const ids = SOURCES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate source id');
  for (const s of SOURCES) {
    assert.ok(s.provision.trim().length > 0, `${s.id} names no provision`);
    assert.ok(s.quotedText.length > 40, `${s.id} quotes nothing the rule can stand on`);
    assert.ok(s.publisher.trim().length > 0, `${s.id} names no publisher`);
    assert.ok(isOfficiallyPublished(s.url), `${s.id} is not hosted by the authority that issued it`);
    assert.ok(s.retrievedOn <= TODAY, `${s.id} claims to have been read in the future`);
    assert.ok(s.reviewDue > s.retrievedOn, `${s.id} has no future review date`);
  }
});

test('a blog, a newsletter or a vendor page can never approve a rule', () => {
  const register = new ComplianceRegister(
    [withSource({ id: 'blog-1', authority: 'COMMENTARY', url: 'https://cbic-gst.gov.in/some-summary' })],
    [{ ruleId: 'made.up', ruleVersion: '1', sourceIds: ['blog-1'], tests: ['somewhere'] }],
    [],
  );
  const verdict = register.mayApprove('made.up', '1', TODAY);
  assert.equal(verdict.approved, false);
  assert.ok(
    verdict.reasons.some((r) => /rests only on commentary or guidance/.test(r)),
    verdict.reasons.join(' | '),
  );
  assert.ok(!LEGAL_AUTHORITIES.includes('COMMENTARY'));
  assert.ok(!LEGAL_AUTHORITIES.includes('CIRCULAR'), 'a circular is the administration reading the law, not the law');
});

test('an official announcement is not the instrument that enacts it', () => {
  // The GST Council announces a rate change days before the notification that makes it law.
  // The announcement is reliable and useful, and charging a customer on the strength of it would
  // be charging them on the strength of an intention.
  const register = new ComplianceRegister(
    [withSource({ id: 'announcement', authority: 'PRESS_RELEASE' })],
    [{ ruleId: 'gst.rate', ruleVersion: '1', sourceIds: ['announcement'], tests: ['t'] }],
    [],
  );
  const verdict = register.mayApprove('gst.rate', '1', TODAY);
  assert.equal(verdict.approved, false);
  assert.ok(verdict.reasons.some((r) => /rests only on commentary or guidance/.test(r)));
  assert.ok(!LEGAL_AUTHORITIES.includes('PRESS_RELEASE'));

  // It is still worth recording, and the shipped register does record one.
  const shipped = defaultRegister().source('gst-council-56th-press-release');
  assert.equal(shipped.authority, 'PRESS_RELEASE');
  assert.match(shipped.quotedText, /2 rate structure with a Standard Rate of 18% and a Merit Rate of 5%/);
  assert.match(shipped.quotedText, /22 September 2025/);
});

test('the register records that the shipped rate table predates the 2025 restructuring', () => {
  const entry = defaultRegister().decisions().find((d) => d.id === 'dl-rate-table-predates-2025-restructure');
  assert.ok(entry !== undefined, 'a known-stale rate table must be written down, not remembered');
  assert.match(entry.rationale, /22 September 2025/);
  assert.match(entry.rationale, /current as of 1 April 2023/);
  assert.deepEqual(entry.sourceIds, ['gst-council-56th-press-release']);
});

test('a statute hosted somewhere other than the authority’s own site is refused', () => {
  assert.equal(isOfficiallyPublished('https://some-consultant.example.com/igst-act'), false);
  assert.equal(isOfficiallyPublished('https://cbic-gst.gov.in/anything'), true);
  assert.equal(isOfficiallyPublished('not a url'), false);
  assert.ok(
    OFFICIAL_DOMAINS.every((d) => d.endsWith('.gov.in') || d.endsWith('.nic.in')),
    'only Indian government domains count as official',
  );

  const register = new ComplianceRegister(
    [withSource({ id: 's', url: 'https://taxblog.example.com/igst-act-section-8' })],
    [{ ruleId: 'r', ruleVersion: '1', sourceIds: ['s'], tests: ['t'] }],
    [],
  );
  const verdict = register.mayApprove('r', '1', TODAY);
  assert.equal(verdict.approved, false);
  assert.ok(verdict.reasons.some((r) => /not hosted by the authority/.test(r)));
});

test('a source we could not read first-hand cannot approve a rule', () => {
  const register = new ComplianceRegister(
    [withSource({ id: 's', verification: 'SECOND_HAND' })],
    [{ ruleId: 'r', ruleVersion: '1', sourceIds: ['s'], tests: ['t'] }],
    [],
  );
  assert.ok(register.mayApprove('r', '1', TODAY).reasons.some((x) => /not read first-hand/.test(x)));
});

test('a rule with no test cannot be approved, however good its source', () => {
  const register = new ComplianceRegister(
    [withSource({ id: 's' })],
    [{ ruleId: 'r', ruleVersion: '1', sourceIds: ['s'], tests: [] }],
    [],
  );
  const verdict = register.mayApprove('r', '1', TODAY);
  assert.equal(verdict.approved, false);
  assert.ok(verdict.reasons.some((x) => /names no test/.test(x)));
});

test('a withdrawn or superseded source blocks every rule that cites it, and raises a task', () => {
  const withdrawn = new ComplianceRegister(
    [withSource({ id: 's', state: 'WITHDRAWN' })],
    [{ ruleId: 'r', ruleVersion: '1', sourceIds: ['s'], tests: ['t'] }],
    [],
  );
  assert.ok(withdrawn.mayApprove('r', '1', TODAY).reasons.some((x) => /withdrawn/.test(x)));
  const tasks = withdrawn.reviewQueue(TODAY);
  assert.ok(tasks.some((t) => t.kind === 'WITHDRAWN_SOURCE' && t.severity === 'BLOCKING'));

  const superseded = new ComplianceRegister(
    [withSource({ id: 's', state: 'SUPERSEDED', supersededBy: 's-2026' })],
    [{ ruleId: 'r', ruleVersion: '1', sourceIds: ['s'], tests: ['t'] }],
    [],
  );
  const supersededTask = superseded.reviewQueue(TODAY).find((t) => t.kind === 'SUPERSEDED_SOURCE');
  assert.ok(supersededTask !== undefined);
  assert.match(supersededTask.summary, /replaced by s-2026/);
});

test('a source that is overdue for review becomes work, not a silent assumption', () => {
  const stale = new ComplianceRegister(
    [withSource({ id: 's', retrievedOn: isoDate('2024-01-01'), reviewDue: isoDate('2025-01-01'), state: 'ACTIVE' })],
    [],
    [],
  );
  const task = stale.reviewQueue(TODAY).find((t) => t.kind === 'STALE_SOURCE');
  assert.ok(task !== undefined);
  assert.match(task.summary, /due for review on 2025-01-01/);
  assert.equal(task.severity, 'ACTION_REQUIRED');

  const fresh = new ComplianceRegister([withSource({ id: 's', state: 'ACTIVE' })], [], []);
  assert.equal(fresh.reviewQueue(TODAY).some((t) => t.kind === 'STALE_SOURCE'), false);
});

test('the shipped register approves exactly the rules we intend, and no others', () => {
  const register = defaultRegister();
  for (const link of RULE_SOURCE_LINKS) {
    const verdict = register.mayApprove(link.ruleId, link.ruleVersion, TODAY);
    assert.equal(verdict.approved, true, `${link.ruleId}@${link.ruleVersion}: ${verdict.reasons.join(' | ')}`);
  }
  // A rule nobody linked cannot be approved by accident.
  const unlinked = register.mayApprove('gst.eway.applicability', '2026.04.01', TODAY);
  assert.equal(unlinked.approved, false);
  assert.ok(unlinked.reasons.some((r) => /not linked to any source/.test(r)));
});

test('the shipped register has no blocking work outstanding, and says what is pending', () => {
  const tasks = defaultRegister().reviewQueue(TODAY);
  const blocking = tasks.filter((t) => t.severity === 'BLOCKING');
  assert.deepEqual(blocking, [], blocking.map((t) => `${t.kind}: ${t.summary}`).join('\n'));

  // The one entry we could not fully verify is visible as work rather than hidden.
  const pending = tasks.find((t) => t.kind === 'UNREVIEWED_SOURCE' && t.subject === 'utgst-act-2017-s1-2');
  assert.ok(pending !== undefined, 'the partially verified UTGST extent clause must be on the queue');
  assert.match(pending.summary, /amended/);
});

test('a decision traces to its provision, its quoted words and its tests', () => {
  const trace = defaultRegister().trace('gst.tax_split', '2026.08.29');
  assert.equal(trace.rule, 'gst.tax_split@2026.08.29');
  const provisions = trace.sources.map((s) => `${s.id} ${s.provision}`);
  assert.ok(provisions.some((p) => p.includes('igst-act-2017-s7')));
  assert.ok(provisions.some((p) => p.includes('igst-act-2017-s8')));
  assert.ok(provisions.some((p) => p.includes('utgst-act-2017-s7')));
  for (const s of trace.sources) {
    assert.ok(s.quotedText.length > 40, `${s.id} must carry the words the rule stands on`);
    assert.ok(s.url.startsWith('https://'));
  }
  assert.ok(trace.tests.length >= 4);
  assert.ok(
    trace.decisions.some((d) => d.id === 'dl-delhi-puducherry-state-tax'),
    'the interpretation behind this rule travels with it',
  );
});

test('every test the register names actually exists', () => {
  const testFiles: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.test.ts')) testFiles.push(full);
    }
  };
  walk(join(repoRoot, 'packages'));
  const corpus = testFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

  const missing: string[] = [];
  for (const link of RULE_SOURCE_LINKS) {
    for (const name of link.tests) {
      const title = name.includes('›') ? (name.split('›').pop() as string).trim() : name;
      if (!corpus.includes(title)) missing.push(`${link.ruleId}: ${title}`);
    }
  }
  assert.deepEqual(missing, [], `the register names tests that do not exist:\n${missing.join('\n')}`);
});

test('the decision log records what was decided, why, and what would settle it', () => {
  assert.ok(DECISION_LOG.length > 0);
  const ids = DECISION_LOG.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const d of DECISION_LOG) {
    assert.ok(d.question.endsWith('?'), `${d.id} does not record a question`);
    assert.ok(d.rationale.length > 80, `${d.id} does not explain itself`);
    assert.ok(d.whatWouldResolveIt.length > 20, `${d.id} does not say what would settle it`);
    assert.ok(d.decidedBy.includes('countersignature'), `${d.id} must be honest about who decided it`);
    for (const sourceId of d.sourceIds) {
      assert.ok(defaultRegister().has(sourceId), `${d.id} cites unknown source ${sourceId}`);
    }
  }
  const unsupported = DECISION_LOG.filter((d) => d.kind === 'UNSUPPORTED_SCENARIO');
  assert.ok(unsupported.length >= 2, 'scenarios we deliberately do not support must be written down');
});

test('the union territory lists are disjoint, and the pending one is not silently used', () => {
  const overlap = UTGST_TERRITORY_NAMES.filter((n) => UTGST_PENDING_VERIFICATION_NAMES.includes(n));
  assert.deepEqual(overlap, [], 'a territory cannot be both settled and pending');
  assert.ok(UTGST_PENDING_VERIFICATION_NAMES.includes('Ladakh'));
  for (const name of ['Delhi', 'Puducherry', 'Jammu and Kashmir']) {
    assert.ok(
      !UTGST_TERRITORY_NAMES.includes(name),
      `${name} is a union territory the UTGST Act does not extend to, so it must carry State tax`,
    );
  }
});

test('asking for a source that does not exist fails loudly', () => {
  assert.throws(() => defaultRegister().source('no-such-source'), (e: unknown) =>
    e instanceof DomainError && e.code === 'REGISTER_SOURCE_NOT_FOUND');
});

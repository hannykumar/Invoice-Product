/**
 * Issue #1 [E01] acceptance criteria, enforced automatically:
 *
 *  1. "A new agent can explain every core workflow without reading prior conversations"
 *     -> every workflow has ordered steps, a named owning module and issue per step,
 *        documented failure modes, and a reachable state machine for each stateful record.
 *  2. "Terms are used consistently across product, API and UI specifications"
 *     -> the glossary is internally consistent, and no specification page uses an
 *        accounting or GST term that the glossary does not define.
 *  3. "Every later issue can link to this specification"
 *     -> all 55 issues appear exactly once in the ownership map with an owner and a module,
 *        GPT 1 dependencies resolve, and every relative link and anchor in docs/ exists.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { repoRoot, loadGlossary, loadWorkflows, loadStates, loadOwnership } from '../spec-docs/render.ts';

const TOTAL_ISSUES = 55;
const AGENTS = ['GPT1', 'GPT2', 'GPT3'] as const;
const WAVES = ['weeks-1-2', 'weeks-3-5', 'weeks-6-8', 'weeks-9-11', 'weeks-12-14'];

const glossary = loadGlossary();
const workflows = loadWorkflows();
const states = loadStates();
const ownership = loadOwnership();

const markdownFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? markdownFiles(join(dir, e.name)) : e.name.endsWith('.md') ? [join(dir, e.name)] : [],
  );

const docFiles = markdownFiles(join(repoRoot, 'docs'));

test('every issue appears exactly once in the ownership map', () => {
  const numbers = ownership.issues.map((i) => i.issue);
  assert.equal(numbers.length, TOTAL_ISSUES, `expected ${TOTAL_ISSUES} issues in the ownership map`);
  assert.equal(new Set(numbers).size, TOTAL_ISSUES, 'duplicate issue numbers in the ownership map');
  for (let n = 1; n <= TOTAL_ISSUES; n += 1) {
    assert.ok(numbers.includes(n), `issue #${n} is missing from the ownership map`);
  }
});

test('every issue has a valid owner, a module path, a scope and a title', () => {
  for (const e of ownership.issues) {
    assert.ok((AGENTS as readonly string[]).includes(e.owner), `#${e.issue} has unknown owner ${e.owner}`);
    assert.ok(e.module.trim().length > 0, `#${e.issue} has no module path`);
    assert.ok(e.scope.trim().length > 10, `#${e.issue} has no usable scope sentence`);
    assert.ok(e.title.trim().length > 0, `#${e.issue} has no title`);
  }
});

test('GPT 1 issues declare resolvable dependencies and a delivery wave', () => {
  const known = new Set(ownership.issues.map((i) => i.issue));
  const mine = ownership.issues.filter((i) => i.owner === 'GPT1');
  assert.equal(mine.length, 18, 'GPT 1 owns 18 issues');
  for (const e of mine) {
    assert.ok(e.dependsOn !== undefined, `#${e.issue} must declare dependsOn`);
    for (const d of e.dependsOn ?? []) {
      assert.ok(known.has(d), `#${e.issue} depends on unknown issue #${d}`);
      assert.notEqual(d, e.issue, `#${e.issue} cannot depend on itself`);
    }
    assert.ok(WAVES.includes(e.wave ?? ''), `#${e.issue} has an unknown wave ${e.wave}`);
  }
});

test('no GPT 1 dependency cycle exists', () => {
  const deps = new Map(ownership.issues.filter((i) => i.dependsOn !== undefined).map((i) => [i.issue, i.dependsOn ?? []]));
  const state = new Map<number, 'visiting' | 'done'>();
  const walk = (n: number, path: number[]): void => {
    if (state.get(n) === 'done') return;
    assert.notEqual(state.get(n), 'visiting', `dependency cycle: ${[...path, n].map((x) => `#${x}`).join(' -> ')}`);
    state.set(n, 'visiting');
    for (const d of deps.get(n) ?? []) walk(d, [...path, n]);
    state.set(n, 'done');
  };
  for (const n of deps.keys()) walk(n, []);
});

test('glossary terms are unique, complete and localised', () => {
  const ids = glossary.terms.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate glossary term ids');
  const canonicals = glossary.terms.map((t) => t.canonical.toLowerCase());
  assert.equal(new Set(canonicals).size, canonicals.length, 'duplicate canonical glossary terms');
  for (const t of glossary.terms) {
    for (const locale of glossary.locales) {
      assert.ok((t.plain[locale] ?? '').trim().length > 0, `${t.id} has no plain wording for ${locale}`);
    }
    assert.ok(t.definition.length > 20, `${t.id} needs a real definition`);
    assert.ok(t.example.length > 10, `${t.id} needs an example`);
    for (const other of t.notTheSameAs) {
      assert.ok(ids.includes(other), `${t.id} contrasts with unknown term ${other}`);
    }
  }
});

test('an alternative name never points at two different terms', () => {
  const seen = new Map<string, string>();
  for (const t of glossary.terms) {
    for (const alias of t.alsoCalled) {
      const key = alias.toLowerCase();
      const previous = seen.get(key);
      assert.equal(previous, undefined, `"${alias}" is listed under both ${previous} and ${t.id}`);
      seen.set(key, t.id);
    }
  }
});

test('a canonical term is never used as another term alias', () => {
  const canonical = new Map(glossary.terms.map((t) => [t.canonical.toLowerCase(), t.id]));
  for (const t of glossary.terms) {
    for (const alias of t.alsoCalled) {
      const owner = canonical.get(alias.toLowerCase());
      assert.ok(
        owner === undefined || owner === t.id,
        `"${alias}" is the canonical name of ${owner} but is listed as an alias of ${t.id}`,
      );
    }
  }
});

test('every workflow step names a real issue and an owning module that agrees with the ownership map', () => {
  const byIssue = new Map(ownership.issues.map((i) => [i.issue, i]));
  assert.ok(workflows.workflows.length >= 9, 'the nine core workflows must all be documented');
  for (const flow of workflows.workflows) {
    assert.ok(flow.steps.length > 0, `${flow.id} has no steps`);
    assert.ok(flow.failureModes.length > 0, `${flow.id} documents no failure modes`);
    assert.ok(flow.plain.length > 0, `${flow.id} has no plain-language summary`);
    flow.steps.forEach((s, index) => {
      assert.equal(s.n, index + 1, `${flow.id} steps must be numbered from 1 without gaps`);
      assert.ok(byIssue.has(s.issue), `${flow.id} step ${s.n} references unknown issue #${s.issue}`);
      assert.ok(s.output.trim().length > 0, `${flow.id} step ${s.n} has no result`);
      assert.ok(['user', 'system', 'supplier'].includes(s.actor), `${flow.id} step ${s.n} has unknown actor ${s.actor}`);
    });
  }
});

test('all nine core workflows named in the product specification are present', () => {
  const required = ['sale', 'purchase', 'return', 'payment', 'banking', 'inventory', 'gst', 'transport', 'approval'];
  const present = workflows.workflows.map((w) => w.id);
  for (const r of required) assert.ok(present.includes(r), `workflow "${r}" is missing`);
});

test('state machines are complete: every transition endpoint exists and every state is reachable', () => {
  const groups = new Set(Object.keys(states.userFacingStateGroups));
  for (const [name, m] of Object.entries(states.machines)) {
    const stateNames = Object.keys(m.states);
    assert.ok(stateNames.length > 1, `${name} needs more than one state`);
    for (const [sn, sd] of Object.entries(m.states)) {
      assert.ok(groups.has(sd.group), `${name}.${sn} uses unknown user-facing group ${sd.group}`);
      assert.ok(sd.plain.trim().length > 0, `${name}.${sn} has no plain wording`);
    }
    for (const t of m.transitions) {
      assert.ok(stateNames.includes(t.from), `${name}: transition from unknown state ${t.from}`);
      assert.ok(stateNames.includes(t.to), `${name}: transition to unknown state ${t.to}`);
    }
    const initial = stateNames[0] as string;
    const reachable = new Set([initial]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of m.transitions) {
        if (reachable.has(t.from) && !reachable.has(t.to)) {
          reachable.add(t.to);
          grew = true;
        }
      }
    }
    for (const sn of stateNames) {
      assert.ok(reachable.has(sn), `${name}.${sn} is unreachable from ${initial}`);
    }
    for (const sn of stateNames) {
      const isTerminal = (m.states[sn] as { terminal: boolean }).terminal;
      const hasOutgoing = m.transitions.some((t) => t.from === sn);
      assert.equal(hasOutgoing, !isTerminal, `${name}.${sn}: terminal flag disagrees with its transitions`);
    }
  }
});

test('state machines are owned by the agent that owns their issue', () => {
  const byIssue = new Map(ownership.issues.map((i) => [i.issue, i]));
  for (const [name, m] of Object.entries(states.machines)) {
    const entry = byIssue.get(m.issue);
    assert.ok(entry !== undefined, `${name} references unknown issue #${m.issue}`);
    assert.equal(entry?.owner, m.owner, `${name} claims owner ${m.owner} but issue #${m.issue} belongs to ${entry?.owner}`);
  }
});

test('specification pages only use accounting terms the glossary defines', () => {
  // Words that carry a specific financial or legal meaning. If a page uses one of these,
  // the glossary must define it, otherwise two agents will read the page differently.
  const controlled = [
    'debit note', 'credit note', 'reverse charge', 'place of supply', 'input tax credit',
    'taxable value', 'invoice value', 'round-off', 'period lock', 'opening balance',
    'idempotency key', 'exception queue', 'audit trail', 'available quantity', 'reservation',
    'ageing', 'allocation', 'on account', 'credit limit', 'rule version', 'effective date',
    'double entry', 'journal line', 'chart of accounts', 'voucher',
  ];
  const defined = new Set(
    glossary.terms.flatMap((t) => [t.canonical.toLowerCase(), ...t.alsoCalled.map((a) => a.toLowerCase())]),
  );
  for (const term of controlled) {
    assert.ok(defined.has(term), `"${term}" is used in the specification but is not defined in the glossary`);
  }
});

test('relative links and anchors inside docs/ resolve', () => {
  const headingAnchor = (line: string): string =>
    line
      .replace(/^#+\s*/, '')
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-');
  const anchorsOf = (file: string): Set<string> =>
    new Set(
      readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.startsWith('#'))
        .map(headingAnchor),
    );

  const linkPattern = /\[[^\]]*\]\((\.\.?\/[^)\s]+)\)/g;
  const problems: string[] = [];
  for (const file of docFiles) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(linkPattern)) {
      const raw = match[1] as string;
      const [path, anchor] = raw.split('#');
      const target = resolve(dirname(file), path as string);
      if (!existsSync(target)) {
        problems.push(`${relative(repoRoot, file)} -> missing file ${raw}`);
        continue;
      }
      if (anchor !== undefined && anchor !== '' && target.endsWith('.md') && !anchorsOf(target).has(anchor)) {
        problems.push(`${relative(repoRoot, file)} -> missing anchor ${raw}`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the ownership map covers every module referenced by a workflow step', () => {
  const norm = (p: string): string => p.trim().replace(/\/+$/, '');
  const modules = new Set(ownership.issues.flatMap((i) => i.module.split('+').map(norm)));
  const missing: string[] = [];
  for (const flow of workflows.workflows) {
    for (const s of flow.steps) {
      // A step may combine two owned modules with " + ", and may name a role rather than a path.
      for (const p of s.module.split('+').map(norm)) {
        if (p === 'owning module') continue;
        if (!modules.has(p)) missing.push(`${flow.id} step ${s.n}: unknown module "${p}"`);
      }
    }
  }
  assert.deepEqual(missing, [], missing.join('\n'));
});

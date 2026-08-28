/**
 * Issue #46 [E46] acceptance criteria, enforced automatically.
 *
 *  - "Accounting terms have plain explanations" -> every vocabulary entry maps to a real
 *    glossary term from issue #1, and every message passes the plain-language linter.
 *  - "Safety confirmations remain understandable rather than being removed" -> every block
 *    and warn message explains why and offers at least one thing the person can do next,
 *    and every safety confirmation named by a task flow exists.
 *  - "Target users complete core tasks without training" -> everyday tasks stay inside the
 *    step budget, and every state a record can be in has plain wording in every locale.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LOCALES,
  allMessages,
  catalogueDir,
  getMessage,
  loadMessages,
  loadStateLabels,
  loadVocabulary,
  placeholdersIn,
  renderMessage,
  permittedSteps,
  stateLabel,
  groupLabel,
  plainWordFor,
  MissingPlaceholderValueError,
  UnknownMessageError,
  type Locale,
} from '../src/index.ts';
import { lintUserFacingText } from '../src/lint.ts';
import { loadGlossary, loadStates } from '../../../tools/spec-docs/render.ts';

const messages = loadMessages();
const vocabulary = loadVocabulary();
const labels = loadStateLabels();
const glossary = loadGlossary();
const states = loadStates();

interface TaskStep {
  n: number;
  name: Record<Locale, string>;
  does: string;
  safetyConfirmations?: string[];
  mustTellUser?: string[];
  resultMessage?: string;
}
interface Task {
  id: string;
  name: Record<Locale, string>;
  everyday: boolean;
  steps: TaskStep[];
}
const taskFlows = JSON.parse(readFileSync(join(catalogueDir, 'task-flows.json'), 'utf8')) as {
  stepBudget: number;
  tasks: Task[];
};

test('message ids are unique and every message is localised', () => {
  const ids = messages.messages.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate message id');
  for (const m of messages.messages) {
    for (const locale of LOCALES) {
      assert.ok((m.text[locale] ?? '').trim().length > 0, `${m.id} has no text for ${locale}`);
      assert.ok((m.why[locale] ?? '').trim().length > 0, `${m.id} has no explanation for ${locale}`);
      for (const s of m.nextSteps) {
        assert.ok((s.label[locale] ?? '').trim().length > 0, `${m.id}/${s.id} has no label for ${locale}`);
      }
    }
  }
});

test('declared placeholders match the placeholders actually used, in every locale', () => {
  for (const m of messages.messages) {
    const declared = new Set(m.placeholders);
    const used = new Set<string>();
    for (const locale of LOCALES) {
      for (const p of placeholdersIn(m.text[locale])) used.add(p);
      for (const p of placeholdersIn(m.why[locale])) used.add(p);
      for (const s of m.nextSteps) for (const p of placeholdersIn(s.label[locale])) used.add(p);
    }
    for (const p of used) assert.ok(declared.has(p), `${m.id} uses {${p}} but does not declare it`);
    for (const p of declared) assert.ok(used.has(p), `${m.id} declares {${p}} but never uses it`);
  }
});

test('the two locales of a message carry the same placeholders', () => {
  for (const m of messages.messages) {
    const en = new Set(placeholdersIn(m.text['en-IN']));
    const hi = new Set(placeholdersIn(m.text['hi-IN']));
    assert.deepEqual([...en].sort(), [...hi].sort(), `${m.id} says different things in each language`);
  }
});

test('a message that stops the user always explains why and offers a way forward', () => {
  for (const m of messages.messages) {
    if (m.severity !== 'block' && m.severity !== 'warn') continue;
    assert.ok(m.why['en-IN'].length > 20, `${m.id} blocks the user without explaining why`);
    assert.ok(m.nextSteps.length > 0, `${m.id} blocks the user with no way forward`);
  }
});

test('every user-facing string passes the plain-language linter', () => {
  const problems: string[] = [];
  for (const m of allMessages()) {
    for (const locale of LOCALES) {
      const parts: [string, string][] = [
        ['text', m.text[locale]],
        ['why', m.why[locale]],
        ...m.nextSteps.map((s): [string, string] => [`step:${s.id}`, s.label[locale]]),
      ];
      for (const [where, value] of parts) {
        for (const issue of lintUserFacingText(value, { locale })) {
          problems.push(`${m.id} (${locale}, ${where}): ${issue.rule} — ${issue.detail}`);
        }
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('every vocabulary entry replaces a real glossary term from issue #1', () => {
  const known = new Set(glossary.terms.map((t) => t.id));
  for (const e of vocabulary.entries) {
    if (e.glossaryOptional === true) continue;
    assert.ok(known.has(e.glossaryTerm), `vocabulary refers to unknown glossary term "${e.glossaryTerm}"`);
    assert.ok(e.avoid.length > 0, `${e.glossaryTerm} lists nothing to avoid`);
    for (const locale of LOCALES) {
      assert.ok(e.inSentence[locale].length > 0, `${e.glossaryTerm} has no example sentence in ${locale}`);
    }
  }
});

test('a term we avoid never appears in the words we actually show', () => {
  const problems: string[] = [];
  for (const e of vocabulary.entries) {
    if (e.internalOnly === true) continue;
    for (const locale of LOCALES) {
      const shown = `${e.say[locale]} ${e.inSentence[locale]}`.toLowerCase();
      for (const avoided of e.avoid) {
        const pattern = new RegExp(`(^|[^a-z])${avoided.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`);
        if (pattern.test(shown)) problems.push(`${e.glossaryTerm} (${locale}) still says "${avoided}"`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('every state in the product specification has plain wording in every language', () => {
  const missing: string[] = [];
  for (const [machine, m] of Object.entries(states.machines)) {
    for (const state of Object.keys(m.states)) {
      const key = `${machine}.${state}`;
      const label = labels.stateLabels[key];
      if (label === undefined) {
        missing.push(key);
        continue;
      }
      for (const locale of LOCALES) {
        assert.ok((label[locale] ?? '').trim().length > 0, `${key} has no wording for ${locale}`);
      }
      assert.doesNotThrow(() => stateLabel(machine, state, 'en-IN'));
    }
  }
  assert.deepEqual(missing, [], `states with no plain wording: ${missing.join(', ')}`);
});

test('state labels never leak an internal state name and every user-facing group is worded', () => {
  for (const [key, label] of Object.entries(labels.stateLabels)) {
    for (const locale of LOCALES) {
      assert.deepEqual(lintUserFacingText(label[locale], { locale }), [], `${key} (${locale}) fails the plain-language rules`);
    }
  }
  for (const group of Object.keys(states.userFacingStateGroups)) {
    assert.ok(groupLabel(group, 'en-IN').length > 0, `group ${group} has no wording`);
  }
});

test('everyday tasks stay inside the step budget', () => {
  for (const task of taskFlows.tasks) {
    if (!task.everyday) continue;
    assert.ok(
      task.steps.length <= taskFlows.stepBudget,
      `${task.id} takes ${task.steps.length} steps, over the budget of ${taskFlows.stepBudget}`,
    );
    task.steps.forEach((s, i) => assert.equal(s.n, i + 1, `${task.id} steps must be numbered from 1`));
  }
});

test('safety confirmations named by a task flow exist and were not quietly dropped', () => {
  const required = taskFlows.tasks.flatMap((t) => t.steps.flatMap((s) => s.safetyConfirmations ?? []));
  assert.ok(required.length > 0, 'the task flows must keep their safety confirmations');
  for (const id of required) {
    const m = getMessage(id);
    assert.ok(['block', 'warn'].includes(m.severity), `${id} is used as a safety confirmation but is only ${m.severity}`);
  }
  const informational = taskFlows.tasks.flatMap((t) => t.steps.flatMap((s) => s.mustTellUser ?? []));
  for (const id of informational) {
    const m = getMessage(id);
    assert.ok(m.why['en-IN'].length > 20, `${id} tells the user something without explaining it`);
    assert.ok(m.nextSteps.length > 0, `${id} leaves the user with nothing to do`);
  }
  for (const t of taskFlows.tasks) {
    for (const s of t.steps) {
      if (s.resultMessage !== undefined) assert.doesNotThrow(() => getMessage(s.resultMessage as string));
    }
  }
});

test('rendering refuses to show a raw placeholder', () => {
  assert.throws(
    () => renderMessage('stock.not_enough', 'en-IN', { itemName: 'Apple box' }),
    MissingPlaceholderValueError,
  );
  assert.throws(() => renderMessage('no.such.message', 'en-IN'), UnknownMessageError);
});

test('rendering produces a complete sentence in both languages', () => {
  const values = {
    itemName: 'Apple box, 10 kg',
    warehouseName: 'Narela godown',
    available: '30',
    required: '70',
    shortfall: '40',
    unit: 'boxes',
  };
  for (const locale of LOCALES) {
    const r = renderMessage('stock.not_enough', locale, values);
    assert.ok(!r.text.includes('{'), 'no placeholder may survive rendering');
    assert.ok(r.text.includes('30') && r.text.includes('70') && r.text.includes('40'));
    assert.ok(r.why.length > 0);
    assert.ok(r.nextSteps.length >= 3, 'a blocked sale must offer more than one way forward');
  }
});

test('actions a user cannot perform are not offered to them', () => {
  const values = {
    itemName: 'Apple box, 10 kg',
    warehouseName: 'Narela godown',
    available: '30',
    required: '70',
    shortfall: '40',
    unit: 'boxes',
  };
  const rendered = renderMessage('stock.not_enough', 'en-IN', values);
  const withoutPermission = permittedSteps(rendered, []);
  assert.ok(
    withoutPermission.every((s) => s.requiresPermission === undefined),
    'a step needing a permission must not be offered to a user without it',
  );
  assert.ok(withoutPermission.length > 0, 'a user without the override permission still needs something to do');
  const withPermission = permittedSteps(rendered, ['inventory.override_negative']);
  assert.equal(withPermission.length, rendered.nextSteps.length);
});

test('the plain word for an accounting term is available, and internal terms stay hidden', () => {
  assert.equal(plainWordFor('receivable', 'en-IN'), 'Money customers owe you');
  assert.equal(plainWordFor('receivable', 'hi-IN'), 'Customer se lena baaki');
  assert.equal(plainWordFor('idempotency-key', 'en-IN'), undefined, 'internal terms are never shown');
  assert.equal(plainWordFor('not-a-term', 'en-IN'), undefined);
});

test('the linter actually catches the wording we are trying to prevent', () => {
  const jargon = lintUserFacingText('Sundry debtors balance as per books.', { locale: 'en-IN' });
  assert.ok(jargon.some((i) => i.rule === 'banned-term'), 'jargon must be caught');
  const technical = lintUserFacingText('Request failed: HTTP 500, transaction aborted.', { locale: 'en-IN' });
  assert.ok(technical.some((i) => i.rule === 'technical-leak'), 'computer-speak must be caught');
  const raw = lintUserFacingText('This bill is PENDING_APPROVAL.', { locale: 'en-IN' });
  assert.ok(raw.some((i) => i.rule === 'raw-state-name'), 'internal state names must be caught');
  const long = lintUserFacingText(`We ${'word '.repeat(30)}end.`, { locale: 'en-IN' });
  assert.ok(long.some((i) => i.rule === 'sentence-too-long'), 'long sentences must be caught');
  assert.deepEqual(lintUserFacingText('You can sell 30 boxes right now.', { locale: 'en-IN' }), []);
});

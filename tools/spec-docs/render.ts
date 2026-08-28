/**
 * Issue #1 [E01] — renders the human-readable specification pages from the
 * machine-readable canonical spec in docs/product/spec/.
 *
 * The JSON files are the single source of truth. The Markdown pages are
 * generated so a term can never drift between the API contracts, the UI
 * vocabulary and the prose. `tools/test/spec-docs.test.ts` fails the build if
 * a page on disk is out of date.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const specDir = join(repoRoot, 'docs', 'product', 'spec');

export interface GlossaryTerm {
  id: string;
  canonical: string;
  plain: Record<string, string>;
  definition: string;
  example: string;
  alsoCalled: string[];
  notTheSameAs: string[];
}
export interface Glossary {
  version: string;
  effectiveFrom: string;
  locales: string[];
  terms: GlossaryTerm[];
}

export interface WorkflowStep {
  n: number;
  step: string;
  actor: string;
  module: string;
  issue: number;
  output: string;
  rules: string[];
}
export interface Workflow {
  id: string;
  name: string;
  plain: string;
  trigger?: string;
  steps: WorkflowStep[];
  failureModes: { case: string; behaviour: string }[];
}

export interface StateDef { group: string; plain: string; terminal: boolean }
export interface Transition { from: string; to: string; event: string; guards?: string[] }
export interface Machine {
  owner: string;
  issue: number;
  consumedBy?: string[];
  states: Record<string, StateDef>;
  transitions: Transition[];
  notes?: string[];
}
export interface States {
  version: string;
  userFacingStateGroups: Record<string, string>;
  machines: Record<string, Machine>;
}

export interface OwnershipEntry {
  issue: number;
  title: string;
  owner: string;
  module: string;
  scope: string;
  dependsOn?: number[];
  wave?: string;
}
export interface Ownership {
  version: string;
  agents: Record<string, string>;
  issues: OwnershipEntry[];
}

const readJson = <T>(name: string): T => JSON.parse(readFileSync(join(specDir, name), 'utf8')) as T;

export const loadGlossary = (): Glossary => readJson<Glossary>('glossary.json');
export const loadWorkflows = (): { version: string; workflows: Workflow[] } =>
  readJson<{ version: string; workflows: Workflow[] }>('workflows.json');
export const loadStates = (): States => readJson<States>('states.json');
export const loadOwnership = (): Ownership => readJson<Ownership>('ownership.json');

const GENERATED = (source: string) =>
  `<!-- GENERATED FILE — do not edit by hand.\n     Source: ${source}\n     Regenerate: node --experimental-strip-types tools/spec-docs/generate.ts -->\n`;

export function renderGlossary(g: Glossary): string {
  const out: string[] = [];
  out.push(GENERATED('docs/product/spec/glossary.json'));
  out.push(`# Financial and GST glossary\n`);
  out.push(
    `Issue [#1](./README.md) defines these words once so that every agent, API field and screen means the same thing by them.\n`,
  );
  out.push(`Glossary version **${g.version}**, effective from **${g.effectiveFrom}**.\n`);
  out.push(
    `Each entry gives the word we use in code and contracts, the plain sentence we show a business owner, what it means, and what it must never be confused with.\n`,
  );
  for (const t of [...g.terms].sort((a, b) => a.canonical.localeCompare(b.canonical, 'en'))) {
    out.push(`## ${t.canonical}\n`);
    out.push(`\`${t.id}\`\n`);
    for (const locale of Object.keys(t.plain)) {
      out.push(`- **Plain (${locale})**: ${t.plain[locale]}`);
    }
    out.push(`- **Means**: ${t.definition}`);
    out.push(`- **Example**: ${t.example}`);
    if (t.alsoCalled.length > 0) out.push(`- **Also called**: ${t.alsoCalled.join(', ')}`);
    if (t.notTheSameAs.length > 0) out.push(`- **Not the same as**: ${t.notTheSameAs.join(', ')}`);
    out.push('');
  }
  return out.join('\n');
}

export function renderWorkflows(w: { version: string; workflows: Workflow[] }): string {
  const out: string[] = [];
  out.push(GENERATED('docs/product/spec/workflows.json'));
  out.push(`# Core business workflows\n`);
  out.push(
    `Issue [#1](./README.md) records every core flow from start to finish, with the module that owns each step. An agent that has read only this page can say what a purchase invoice does without reading any earlier conversation.\n`,
  );
  out.push(`Workflow specification version **${w.version}**.\n`);
  for (const flow of w.workflows) {
    out.push(`## ${flow.name}\n`);
    out.push(`**In plain words:** ${flow.plain}\n`);
    if (flow.trigger !== undefined) out.push(`**Starts when:** ${flow.trigger}\n`);
    out.push(`| # | Step | Who | Owning module | Issue | Result |`);
    out.push(`| --- | --- | --- | --- | --- | --- |`);
    for (const s of flow.steps) {
      out.push(`| ${s.n} | ${s.step} | ${s.actor} | \`${s.module}\` | #${s.issue} | ${s.output} |`);
    }
    out.push('');
    const ruled = flow.steps.filter((s) => s.rules.length > 0);
    if (ruled.length > 0) {
      out.push(`**Rules that must hold**\n`);
      for (const s of ruled) for (const r of s.rules) out.push(`- Step ${s.n} (${s.step}): ${r}`);
      out.push('');
    }
    out.push(`**When things go wrong**\n`);
    out.push(`| Situation | What the product does |`);
    out.push(`| --- | --- |`);
    for (const f of flow.failureModes) out.push(`| ${f.case} | ${f.behaviour} |`);
    out.push('');
  }
  return out.join('\n');
}

export function renderStates(s: States): string {
  const out: string[] = [];
  out.push(GENERATED('docs/product/spec/states.json'));
  out.push(`# Transaction states\n`);
  out.push(
    `Issue [#1](./README.md) fixes the states a record can be in. A module must not invent a state that is not listed here; propose it in \`docs/product/spec/states.json\` first.\n`,
  );
  out.push(`State specification version **${s.version}**.\n`);
  out.push(`## What the user sees\n`);
  out.push(
    `Every internal state maps to one of six groups so screens stay understandable without accounting training.\n`,
  );
  out.push(`| Group | Shown to the user as |`);
  out.push(`| --- | --- |`);
  for (const [k, v] of Object.entries(s.userFacingStateGroups)) out.push(`| \`${k}\` | ${v} |`);
  out.push('');
  for (const [name, m] of Object.entries(s.machines)) {
    out.push(`## ${name}\n`);
    out.push(`Owned by **${m.owner}** under issue **#${m.issue}**.${m.consumedBy !== undefined ? ` Consumed by ${m.consumedBy.join(', ')}.` : ''}\n`);
    out.push(`| State | Group | Plain wording | Final? |`);
    out.push(`| --- | --- | --- | --- |`);
    for (const [sn, sd] of Object.entries(m.states)) {
      out.push(`| \`${sn}\` | ${sd.group} | ${sd.plain} | ${sd.terminal ? 'yes' : 'no'} |`);
    }
    out.push('');
    out.push(`| From | Event | To | Must be true first |`);
    out.push(`| --- | --- | --- | --- |`);
    for (const t of m.transitions) {
      out.push(`| \`${t.from}\` | \`${t.event}\` | \`${t.to}\` | ${(t.guards ?? []).map((g) => `\`${g}\``).join(', ') || '—'} |`);
    }
    out.push('');
    if (m.notes !== undefined && m.notes.length > 0) {
      for (const n of m.notes) out.push(`> ${n}`);
      out.push('');
    }
  }
  return out.join('\n');
}

export function renderOwnership(o: Ownership): string {
  const out: string[] = [];
  out.push(GENERATED('docs/product/spec/ownership.json'));
  out.push(`# Ownership boundaries for all issues\n`);
  out.push(
    `Issue [#1](./README.md) assigns every one of the 55 issues to exactly one agent and one module path, so parallel work cannot collide and no agent reimplements another agent's module.\n`,
  );
  out.push(`Ownership map version **${o.version}**.\n`);
  out.push(`## Agents\n`);
  for (const [k, v] of Object.entries(o.agents)) out.push(`- **${k}** — ${v}`);
  out.push('');
  for (const agent of Object.keys(o.agents)) {
    out.push(`## ${agent}\n`);
    out.push(`| Issue | Title | Module | Scope | Depends on | Wave |`);
    out.push(`| --- | --- | --- | --- | --- | --- |`);
    for (const e of o.issues.filter((i) => i.owner === agent)) {
      const deps = e.dependsOn === undefined ? '—' : e.dependsOn.length === 0 ? 'none' : e.dependsOn.map((d) => `#${d}`).join(', ');
      out.push(`| #${e.issue} | ${e.title} | \`${e.module}\` | ${e.scope} | ${deps} | ${e.wave ?? '—'} |`);
    }
    out.push('');
  }
  return out.join('\n');
}

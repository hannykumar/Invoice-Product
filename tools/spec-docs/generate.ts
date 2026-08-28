/** Issue #1 [E01] — regenerates the specification pages from the canonical JSON. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  repoRoot,
  loadGlossary,
  loadWorkflows,
  loadStates,
  loadOwnership,
  renderGlossary,
  renderWorkflows,
  renderStates,
  renderOwnership,
} from './render.ts';

export const generated: { path: string; render: () => string }[] = [
  { path: join(repoRoot, 'docs', 'product', '01-glossary.md'), render: () => renderGlossary(loadGlossary()) },
  { path: join(repoRoot, 'docs', 'product', '02-workflows.md'), render: () => renderWorkflows(loadWorkflows()) },
  { path: join(repoRoot, 'docs', 'product', '03-states.md'), render: () => renderStates(loadStates()) },
  { path: join(repoRoot, 'docs', 'product', '04-ownership.md'), render: () => renderOwnership(loadOwnership()) },
];

if (process.argv[1] !== undefined && process.argv[1].endsWith('generate.ts')) {
  for (const g of generated) {
    writeFileSync(g.path, g.render(), 'utf8');
    console.log(`wrote ${g.path}`);
  }
}

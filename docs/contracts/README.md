# Cross-agent contracts

Before a shared module is implemented, its contract is published here: data model,
commands and events, API surface, error model, permissions and idempotency behaviour.

| Contract | Version | Owner | Consumed by | Status |
| --- | --- | --- | --- | --- |
| [`ledger`](./ledger.v1.md) | 1.0.0 | GPT 1 (#4) | GPT 1 (#9, #12, #20, #35), GPT 3 (#17, #45) | Published |
| [`ux-vocabulary`](./ux-vocabulary.v1.md) | 1.0.0 | GPT 1 (#46) | GPT 2 (#38), all user-facing modules | Published |
| [`rules-engine`](./rules-engine.v1.md) | 1.0.0 | GPT 1 (#7) | GPT 1 (#9, #11, #12, #25, #34), GPT 3 (#19, #26–#31) | Published |
| [`platform-ports`](./platform-ports.v1.md) | 1.0.0-draft | GPT 2 (#3, #6) | GPT 1, GPT 3 | **Mocked by GPT 1** pending GPT 2 |

| [`platform-command`](./platform-command-v1.md) | 1.0.0 | GPT 2 (#6) | GPT 1, GPT 3 | Published |
| [`connector`](./connector-v1.md) | 1.0.0 | GPT 2 (#8) | GPT 1, GPT 3 | Published |
| [`notification`](./notification-v1.md) | 1.0.0 | GPT 2 (#39) | GPT 1, GPT 3 | Published |
| [`master-data`](./master-data-v1.md) | 1.0.0 | GPT 3 (#5) | GPT 1, GPT 2, GPT 3 | Published |
| [`purchase-intake`](./purchase-intake-v1.md) | 1.0.0 | GPT 3 (#15) | GPT 2, GPT 3 | Published |

## Rules

1. A contract change is a pull request that names every affected issue.
2. Contracts are versioned. A breaking change gets a new major version and both versions run
   until consumers migrate.
3. Where a dependency is unfinished, the consuming agent writes the contract it needs, marks it
   `Mocked by <agent>`, and implements against a mock. The owning agent may change the contract,
   but must do so explicitly and update the contract tests.

Bank statement imports (#21) are platform-owned drafts: they normalize CSV, text-PDF, base64-encoded PDF and base64-encoded XLSX source rows, retain source locations, deduplicate files and transactions per company, and surface uncertain rows or balance inconsistencies for review. They never create ledger postings.

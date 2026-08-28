# Cross-agent contracts

Before a shared module is implemented, its contract is published here: data model,
commands and events, API surface, error model, permissions and idempotency behaviour.

| Contract | Version | Owner | Consumed by | Status |
| --- | --- | --- | --- | --- |
| [`ledger`](./ledger.v1.md) | 1.0.0 | GPT 1 (#4) | GPT 1 (#9, #12, #20, #35), GPT 3 (#17, #45) | Published |
| [`ux-vocabulary`](./ux-vocabulary.v1.md) | 1.0.0 | GPT 1 (#46) | GPT 2 (#38), all user-facing modules | Published |
| [`platform-ports`](./platform-ports.v1.md) | 1.0.0-draft | GPT 2 (#3, #6) | GPT 1, GPT 3 | **Mocked by GPT 1** pending GPT 2 |

## Rules

1. A contract change is a pull request that names every affected issue.
2. Contracts are versioned. A breaking change gets a new major version and both versions run
   until consumers migrate.
3. Where a dependency is unfinished, the consuming agent writes the contract it needs, marks it
   `Mocked by <agent>`, and implements against a mock. The owning agent may change the contract,
   but must do so explicitly and update the contract tests.

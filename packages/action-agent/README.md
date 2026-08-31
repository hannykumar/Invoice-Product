# `@invoice/action-agent` — a safe AI action agent (issue #47)

Lets the assistant *do* authorised work through **typed internal tools**. No screen control, no
browser automation, no shell: what the product cannot do through a registered tool, the agent
cannot do at all. Contract: [`docs/contracts/action-agent-v1.md`](../../docs/contracts/action-agent-v1.md).

Four sentences carry the design:

1. **The request is data.** Intent comes from a lexicon; the company from the authenticated actor;
   the permissions from the platform. Text that tries to instruct the product is flagged and
   changes nothing else.
2. **Tool results are data too.** The step list is fixed before any tool runs. No code path leads
   from a tool's output to a new step.
3. **What was approved is what runs.** Steps are expanded against live data and fingerprinted;
   execution re-expands and refuses if the party, the amount or the list moved.
4. **The dangerous classes are not the agent's to finish.** Money movement, government filing,
   cancellation and overrides are `PREPARE_ONLY` — and the registry *throws* if anyone tries to
   register one as anything else.

```sh
npm run demo:agent   # the issue's own example, then the requests it refuses
npm test             # 28 tests over the real ledger, sales, receivables, reminders and platform
npm run web          # "Ask me to do it", on the Ask screen
```

Built on modules that are not reimplemented here: GPT 2's `PlatformCommandService` (#6) for the
lifecycle, idempotency, approval policy and audit; #23 for reminders; #34 for grounding a figure in
a canonical report; #20 and #35 underneath both.

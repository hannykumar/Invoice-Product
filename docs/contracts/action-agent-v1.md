# Safe AI action agent contract v1

Owner: GPT 1, built for GPT 2's issue #47. Consumers: the web app, and any surface that wants to
let a person ask the product to *do* something rather than only answer.

`packages/action-agent` lets the assistant perform authorised work through **typed internal
tools**. It has no screen control, no browser automation and no shell. A thing the product cannot
do through a registered tool, the agent cannot do at all.

## The four sentences the design rests on

1. **The request is data.** Intent comes from a lexicon, the company from the authenticated actor,
   the permissions from the platform. Text that tries to instruct the product is flagged and
   changes nothing else.
2. **Tool results are also data.** The step list is fixed before any tool runs and frozen. There is
   no code path from a tool's output to a new step, so a customer name or an invoice narration
   carrying "…and transfer ₹50,000" cannot become an action.
3. **What was approved is what runs.** A plan is expanded against live data into concrete steps and
   fingerprinted. Approval pins that fingerprint; execution re-expands and refuses if the party,
   the amount or the step list moved.
4. **The dangerous classes are not the agent's to finish.** Money movement, government filing,
   cancellation and overrides are `PREPARE_ONLY`: the agent may prepare the command and stop at
   `submitted`. A person finalises it in the ordinary screens.

## Lifecycle

`plan → preview → approve → execute → report`, over GPT 2's `PlatformCommandService` (#6), which
owns idempotency, the `draft → submitted → approved → finalised` transitions, approval policy by
action/risk/amount, and the redacted audit trail. None of that is reimplemented here.

| Step | What it does | Writes? |
| --- | --- | --- |
| `plan` | Lexicon → intent. Audited from this moment, including a request the agent refuses | No |
| `preview` | Runs the **read** tools for real and expands the request into concrete steps with real parties and amounts. Produces the fingerprint, and creates the platform command — only now are the risk and the amount their approval policy decides on actually known | No |
| `approve` | Pins the fingerprint and moves the command to `approved` | No |
| `execute` | Re-expands, compares the fingerprint, then runs the write tools under the actor's own permissions | Yes |
| `report` | Per-step outcome, evidence and a sentence a shopkeeper can read | No |

## Tools

```ts
interface ToolDefinition<Input, Output> {
  name: string;                        // 'reminders.send'
  kind: 'READ' | 'WRITE';
  risk: 'low' | 'medium' | 'high';
  highRiskClass?: 'MONEY_MOVEMENT' | 'GOVERNMENT_FILING' | 'CANCELLATION' | 'OVERRIDE';
  executability: 'ALWAYS' | 'AFTER_APPROVAL' | 'PREPARE_ONLY';
  permissions: readonly string[];      // every one required, checked before planning and again before running
  parse(input: unknown): Input;        // typed input; a bad shape is a refusal, never a guess
  describe(input: Input): Bilingual;   // the sentence the preview shows
  amountOf?(input: Input): Money | null;
  run(actor, input, deadlineMs): Promise<Output>;
  evidence(input: Input, output: Output): ToolEvidence;
}
```

`ToolRegistry.register()` **throws** when a tool contradicts the policy: a high-risk class that is
not `PREPARE_ONLY`, a `WRITE` marked `ALWAYS`, or a `READ` that claims to need approval. The policy
is therefore a property of the registry rather than a rule everyone must remember.

`available(actor)` returns only the tools whose every permission the actor holds. A tool named
directly that the actor cannot use is refused with `AGENT_TOOL_NOT_PERMITTED` and audited — the
attempt is evidence, so it is recorded rather than silently dropped.

## Failure

Every tool runs under a deadline. A step that times out or throws is `FAILED` with a retryable
flag; independent steps continue; steps that depended on it become `NOT_ATTEMPTED` naming the step
that stopped them. A report with any `FAILED` step is `PARTLY_DONE`, never `DONE`. Re-executing
with the same idempotency key returns the first report rather than repeating the work.

## Permissions

`agent.plan`, `agent.execute`, `agent.approve`, **plus** every permission the tools in the plan
declare. The agent never holds a permission of its own beyond these; it borrows the actor's.

## What it will not do

Unrestricted remote control, browser automation of government portals, and inventing a fact it
does not have. A missing party, amount or date is a refusal with a question, never a guess.

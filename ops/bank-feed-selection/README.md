# Getting bank transactions: the route, the cost and the recommendation — issue #52 [X04]

```sh
npm run bank:route
```

Prints the comparison, the recommendation, the questions still to be asked, the cost model, and a
conformance run against the one sandbox we have.

## The recommendation, today

**Keep the statement upload. Do not sign a live-feed partnership yet.**

That is not a hedge — it is what the comparison says, and the reasoning is worth stating plainly:

- The statement upload is **already built, free, and works with every bank in India**, because it
  works with a file the customer can already download. It is the only route where every criterion
  is confirmed, and confirmed by our own code and tests rather than by a sales conversation.
- Its one real weakness is freshness: a statement arrives when somebody remembers to upload it. A
  live feed buys that, and only that.
- Every live-feed route is `CANNOT_SAY_YET` — not "worse", **unknown**. The facts that decide it are
  things only a provider can tell us, in writing, and nobody has asked them yet.

This matches the issue's own non-goal, "block launch on live feeds", and its acceptance criterion
of "at least one viable sandbox **or a documented reason to defer**". This is the documented reason.

The bar for replacing the baseline is deliberately high, and the tests say how high: on the weights
in `criteria.ts`, a live feed has to come back strong on nearly everything — freshness included —
before it beats something that is free and universal. A provider that is merely good does not.

## The routes

| Route | What it is | Status |
| --- | --- | --- |
| **Statement upload** | The customer downloads a statement and gives it to us. | Built, tested, scored |
| **Account Aggregator** | India's consent framework. An RBI-licensed NBFC-AA sits between the bank and us; the customer grants a consent naming purpose, duration and frequency, and can revoke it. We would be a financial information *user* — becoming an aggregator is an explicit non-goal. | Unknown until asked |
| **Direct corporate bank APIs** | One integration per bank, for that bank's corporate customers. | Unknown until asked |
| **A technology partner** | One integration, several banks behind it, somebody else maintaining them. | Unknown until asked |
| **Asking for the netbanking login** | — | **Disqualified** |

## The one answer that is not a trade-off

A route that works by holding the shopkeeper's own banking password, PIN or OTP is **disqualified in
code**, before anything is scored — `scoreCandidate` returns `DISQUALIFIED` for it and `recommend`
will not choose it even when it scores five out of five on every other criterion. There is a test
that constructs exactly that candidate — free, instant, every bank — and asserts it still cannot be
recommended.

It is the issue's acceptance criterion, and it is not the kind of thing that should depend on
whoever is in the room when the cheap option is offered.

## Nothing is guessed

Every fact carries a confidence. `PUBLIC_INFORMATION` means somebody read it on the provider's own
site; `CONFIRMED` means the provider told us, in writing, and `source` says where. Anything else is
`UNKNOWN`, and a candidate missing an **essential** criterion cannot be scored at all — the output
is a deferral naming what to ask and of whom.

**No commercial term in `candidates.ts` came from a provider.** The cost figures in the CLI are
illustrative, marked as such on screen, and exist only to show the shape of the arithmetic and where
the line falls. Replace them with a real quotation and re-run before deciding anything.

## What only a person can do

1. Ask the questions `npm run bank:route` prints. They are grouped by who has to answer them.
2. Get quotations, and put them into `candidates.ts` as `known(..., 'CONFIRMED', <who said it>, <date>)`.
3. Ask counsel what being a financial information user requires of us, and what the customer must be
   told — that lands in #55.
4. Obtain a sandbox and run the conformance harness against it.

Most of this needs the company to exist first (#49), because several routes require a corporate
banking relationship or a signed agreement.

## Conformance: what a sandbox has to prove

"Obtain a sandbox" should end in a green run, not a signed PDF. `runConformance()` takes any
`BankFeedProviderAdapter` — #24's synthetic one today, a real provider's tomorrow — and checks:

| Check | Why it is there |
| --- | --- |
| `consent.start` | Consent begins at the provider over https, not by typing a bank password into our screen. |
| `consent.complete` | The authorisation code is exchanged once and never stored. |
| `accounts.masked` | Accounts come back masked, with nothing credential-shaped anywhere in the payload. A sandbox that returns a full account number has told us how the production one behaves. |
| `sync.fields` | Date, description, exact minor-unit amount and direction — what #22 reconciles on. A floating-point amount fails. |
| `sync.idempotent` | The same fetch twice returns the same thing, so a retry after a timeout cannot double-count somebody's money. |
| `sync.cursor` | The cursor advances and nothing is sent twice. |
| `revoke` | Permission can be taken back, and taking it back twice is safe. |

A check whose prerequisite failed reports `NOT_ATTEMPTED`, never a pass — a sandbox that returned
nothing must not read as "no secrets found, all clear". Tests hand the harness providers broken in
each specific way to prove every check bites.

## Known limitations

- The candidate list is the shape of the market, not a shortlist of named vendors. Naming vendors
  without having spoken to them would invite exactly the invented commercial detail this module
  refuses to hold.
- The weights in `criteria.ts` are a judgement. They are in one place, with the reasoning next to
  each one, so they can be argued with and re-run rather than debated in the abstract.
- The conformance harness checks behaviour, not contract terms. Whether accounting use is permitted
  is a question for a lawyer reading an agreement, and it is the criterion weighted second-highest.

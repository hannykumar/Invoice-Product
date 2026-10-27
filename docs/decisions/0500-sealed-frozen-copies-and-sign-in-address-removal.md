# D500 — Old frozen bill copies and sign-in addresses

- **Status:** Accepted for build, 27 Oct 2026. **The one-off in part 1 runs only on the owner's sign-off.**
- **Decision id:** D500 (issue #500, follow-up to #352 and #368)
- **Who chose:** The options and recommendations are the owner's, in issue #500. This records them and what was built.
- **Product impact:** none for the shopkeeper. A reprint of an old bill shows exactly what was issued.

## Law checked (Rule 0)

- CGST Act 2017 s.36 and CGST Rules 2017 rule 56: books of account and records are kept for 72 months from the due date of the annual return; Companies Act 2013 s.128: eight years. Frozen bill copies are part of the books, so **nothing is deleted or reworded**; only how the copy is stored changes (D10).
- DPDP Act 2023 s.8(7) (erase when no longer needed unless a law requires keeping it) and s.12 (right to erasure) with the DPDP Rules 2025, notified 13–14 Nov 2025. Reported commencement of the erasure rules (Rule 8) is 18 months later, about 13 May 2027. **Not verified against the Gazette text in this change** — legal confirms before launch (as D10 already says). A sign-in address is not part of the books, so there is no retention law that keeps it once the person has no live business here.
- Not verified: whether the audit row's own reason text needs a DPDP review; it holds no address.

## Decisions

1. **Frozen copies written before #352 are sealed by a privileged one-off**, `npm run db:seal-frozen`, run as the migration role (the table's owner), never as the server's login. It rewrites only `value`, from plain JSON to the same JSON sealed under the app field key (bound to company, kind and key), after opening each result again and comparing it with the original. One transaction for all companies: all of it lands or none. A preview is the default and writes nothing; applying needs `--apply --approved-by "<name>"` and prints a receipt to keep with the release record. A second run finds nothing. The freeze trigger is switched off for that transaction only and is back on when it commits or rolls back. No row is added or removed; `created_at`, `updated_at`, `frozen` and the key stay as issued.
2. **A removed person's sign-in address is replaced through one audited function**, `anonymise_user(company, user, actor, correlation, reason)`, not by a new `UPDATE (email)` grant. The function runs as its owner with a fixed `search_path`; it works only inside the caller's own company (`app.company_id` must match), for an actor and a person who are both members of it; it refuses a person who still has an active membership in another company (returns `false`: their address is not this company's to remove). It writes `removed-<id>@anonymised.invalid`, clears the phone, blanks the name, deactivates the account, and writes one `audit_events` row naming the actor — never the old address. It is idempotent. `identity_subject` (the provider's opaque id) is left, because the database already forbids changing it once set and the account can no longer sign in.
3. **Master records no posted document refers to are not scrubbed.** The owner's call, left open in #500: retained masters are already justified by the same retention law, and a safe answer needs a referential check across every posted voucher and invoice. Not built; revisit with the DPDP Rules in force.

## Threat model

| Threat | Held by |
| --- | --- |
| A database dump shows a plain PAN or bank number on an old bill | Part 1 (after the one-off runs). Until then, old frozen rows are plaintext — see Limits. |
| A bug or an injected query in the app changes a person's sign-in address to take over their account | Still no `UPDATE (email)` for the app role. The function only ever writes the `.invalid` placeholder, never a caller-supplied address. |
| One company's request removes another company's person or reads across companies | The function requires the caller's own company context and membership of both people, and refuses anyone who also belongs elsewhere. Row-level security is untouched. |
| A removal leaves no trace | One audit row per removal, written in the same transaction as the change. |
| The one-off is run by mistake or twice | Preview by default, named approver for apply, idempotent, round-trip check, single transaction. |
| The one-off is run with the wrong key | Sealing needs `APP_ENCRYPTION_KEYS`; the sealed value is opened again before it is written, and the row is bound to its company, so a copy cannot be moved. Keep the previous key configured so old rows still open. |

## Limits

- The one-off has not been run against any real database; it is tested on a synthetic one. The owner decides when it runs, once, before launch. If no production data exists yet, a wipe-and-reseed is also acceptable (issue #500, option 3).
- Its receipt is printed, not stored in `audit_events` (that table needs a signed-in person as actor). Keep the output.
- Until a release runs it, the `anonymise_user` migration is applied by `npm run db:migrate` like any other; existing placeholder rows need nothing.
- Part 3 is not built.

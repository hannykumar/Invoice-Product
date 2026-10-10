# Database immutability and the application role v1

Owner: GPT 2 (#368). Consumers: every lane that owns a document table (#365, #366), the runtime
composition (#340) and operations (hosting, #346).

**In plain words:** once a bill, a return note, an e-invoice or an entry in the audit trail is
final, the database itself refuses to change or delete it — whatever code asks, and whoever is
connected. A mistake is corrected by a reversal or a note, never by editing.

## The rule in the database

`platform_freeze_posted(status_column, frozen_statuses, columns_that_may_still_change, status_moves)`
is one trigger function for every document table (migration `…_immutable_records_and_app_role`,
`packages/platform/src/immutability-migrations.ts`).

- A row is **frozen** when its status column holds one of the frozen statuses — or always, when
  `frozen_statuses` is `*` (records that are final the moment they are written). A status that is
  missing or unknown counts as frozen.
- A frozen row is **never deleted**.
- On a frozen row only the listed columns may change (cancellation and reversal bookkeeping). The
  comparison is by value, so an `UPDATE` that sets every column, as a repository that saves the
  whole record does, is fine as long as the frozen ones are unchanged.
- A frozen row's **status may only make the listed moves** (`FROM>TO`, or `*>TO` from any frozen
  status). This is what stops a posted record being moved back to a draft status, edited there
  and moved forward again. The module's state machine still decides *when* a move happens; the
  database decides which moves exist at all for a finished record.
- The table can never be emptied (`TRUNCATE`).
- Refusals use SQLSTATE `23001` (`restrict_violation`) and name the table and the column. The
  ledger's older triggers raise `P0001` with a message.

`platform_freeze_with_parent(foreign_key, parent_table, parent_status_column, frozen_statuses)`
does the same for lines whose own row has no status: once the parent is frozen they cannot be
changed, removed, moved to another parent, or joined by a line moved in from elsewhere.

**Who the rules bind.** Triggers bind every role that cannot switch them off. The application
role cannot. The owner of the tables can (that is what owning a table means in PostgreSQL), which
is why the server never connects as the owner and `assertLeastPrivilege` refuses to start if it
does.

### What is frozen today

| Table | Frozen when | May still change | Status moves allowed once frozen |
| --- | --- | --- | --- |
| `audit_events` | always | nothing — append-only | — |
| `command_records` | always | nothing | the approval flow of `platform-command-v1` only |
| `idempotency_keys`, `idempotency_record`, `exception_comments` | always | nothing | — |
| `voucher` | `FINAL`, `REVERSED` | `reversed_by_voucher_id`, `reason` | `FINAL>REVERSED` |
| `journal_line` | parent voucher frozen | nothing | — |
| `purchase_bills` | always | `reversed_by_voucher_id`, `reversal_reason`, `summary` | `POSTED>REVERSED` |
| `purchase_bill_lines`, `purchase_bill_receipts`, `purchase_match_approvals` | always | nothing | — |
| `goods_receipts` | `CONFIRMED`, `CANCELLED` | `cancelled_reason`, `summary` | `CONFIRMED>CANCELLED` |
| `goods_receipt_lines` | parent receipt frozen | nothing | — |
| `goods_receipt_movements` | always | nothing | — |
| `return_notes` | always | `supplier_credit_note_number`, `supplier_credit_note_date` | — |
| `return_note_lines` | always | nothing | — |
| `e_invoices` | `REGISTERED`, `CANCELLED` | cancellation fields, `message`, `updated_at`, `eway_bill_number`, `signed_invoice`, `provider_request_id`, `acknowledged_at`, `cancellable_until`. **Fixed:** IRN, acknowledgement number and date, signed QR code, document particulars, GSTINs | `REGISTERED>CANCELLED`, `CANCELLED>REGISTERED` (a reconcile finds the cancellation did not go through) |
| `eway_bills` | `PART_A_ONLY`, `ACTIVE`, `EXPIRED`, `CANCELLED`, `REJECTED` | vehicle, transporter, validity, consolidation, cancellation and rejection fields, `alert`, `message`, `updated_at`, `generated_at`, `provider_request_id`, `failure_*`. **Fixed:** the e-way bill number, document, value, route, distance | between those five, and to `FAILED` (see limits) |
| `eway_consolidated_trips` | always | nothing | — |
| `itc_decisions`, `itc_claims`, `itc_import_batches` | always | nothing — a change of mind is a new row | — |
| `gst_return_preparations` | `APPROVED`, `EXPORTED`, `SUBMITTING`, `FILED`, `SUBMISSION_FAILED` | `exported_at`, `version`. **Fixed:** the approved snapshot and fingerprint | forward to export, submit and file; back to `DRAFT` (reopen) from everything **except `FILED`** |
| `gst_return_approvals` | always | `withdrawn_at`, `withdrawn_by`, `withdrawn_reason` | — |
| `gst_return_submissions` | `ACCEPTED` | nothing | — |
| `subscription_service_invoices` | `ISSUED`, `PAID`, `FAILED` | `paid_on`, `provider_reference`, `failure_reason` | to `PAID`, to `FAILED`; never back to `DRAFT` |
| `supplier_risk_assessments`, `supplier_risk_acknowledgements` | always | nothing | — |

Each row was checked against the module's service and repository before it was frozen. The list
lives in one place, `FROZEN` in `immutability-migrations.ts`.

### Adding a table (for #365 and #366)

In the migration that creates the table:

```sql
CREATE TRIGGER sales_invoices_frozen BEFORE UPDATE OR DELETE ON sales_invoices
  FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('state', 'FINAL,CANCELLED', 'cancellation_voucher_id,cancelled_by,cancelled_at,cancel_reason,updated_at,version', 'FINAL>CANCELLED');
CREATE TRIGGER sales_invoices_no_truncate BEFORE TRUNCATE ON sales_invoices
  FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();
CREATE TRIGGER sales_invoice_lines_frozen BEFORE UPDATE OR DELETE ON sales_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION platform_freeze_with_parent('invoice_id', 'sales_invoices', 'state', 'FINAL,CANCELLED');
```

and a test like `packages/platform/test/immutability.integration.test.ts`. Tables that are
final when written (stock movements, payments, allocations, cheque events) pass `''` as the status
column and `*` as the frozen statuses. To change what may still change on an existing table, add a migration that drops and
re-creates its trigger, and name the reason in the PR.

### Not frozen yet, and why

Append-only by their schema comments but not verified against a repository, so left to their own
lanes: `master_versions`, `master_snapshots`, `master_merges`, `bank_statement_transactions`,
`bank_feed_transactions`, `subscription_payment_events`, `subscription_usage_events`,
`notification_delivery_events`, `collection_communications`, `compliance_alerts`,
`privacy_consents`, `restore_drills`, `status_incident_updates`, `government_calls` (freezable
once its outcome is settled). Sales bills, payments, allocations and stock movements have no
tables until #365.

### Known limits (decided, not overlooked)

- **A line added to a finished document.** A row trigger cannot tell a line added later from the
  original lines of a document that is final from the moment it is written, so `INSERT` into
  `purchase_bill_lines`, `return_note_lines` or `goods_receipt_lines` is not refused. The header's
  totals cannot change, so the mismatch is detectable. For the ledger the gap is closed: a
  voucher's totals are frozen and its lines must sum to them when the transaction ends. Each
  document table should get the same "lines add up to the header" check from its own lane (#366);
  #365's new tables should be born with it.
- **An e-way bill the portal disowns.** The transport module moves a live e-way bill to `FAILED`
  when a reconcile finds the portal has no such bill, and then generates it again on the same
  row. `FAILED` is not a frozen status, so that move makes the row editable again. It is what the
  product does today (#27), so it is allowed; the transport lane should decide whether a disowned
  bill should instead keep its row and start a new one.
- **Forward moves from an unfrozen status are the module's business.** The database does not stop
  a draft being marked as finished without the module's checks; it stops a finished record being
  changed.
- **The audit trail can be added to.** That is how it is written. The application role can
  insert an event for its current company with any actor and `occurred_at`; it cannot choose the
  event's place in the order (`seq`), set `recorded_at` (the database's clock), or change or
  remove an event.

## The application role

The server connects as a login that is only a member of **`invoice_app`**. Migrations run as the
owner; the two are never the same account.

| `invoice_app` | |
| --- | --- |
| Is | not a superuser, not an owner of anything, `NOBYPASSRLS`, no `CREATEROLE`/`CREATEDB`, no login or password of its own |
| May | `SELECT`, `INSERT`, `UPDATE` on tables; use sequences |
| May not | `DELETE` (except the tables below), `TRUNCATE`, create or alter anything (including temporary tables), switch triggers or row-level security off, write `schema_migrations`, `UPDATE` `audit_events` or set its `seq`/`recorded_at` |
| Identity tables | `UPDATE` only of: `sessions.revoked_at`; `invitations.accepted_at`, `revoked_at`; `users.display_name`, `active`; `companies.legal_name`; `branches.name`. It cannot extend or un-revoke a session, re-open an invitation, or change a sign-in address |
| `DELETE` allowed on | `user_branch_access` only (a person's branch list is replaced when their access changes) |

- Tables created by later migrations get the same grants automatically (default privileges):
  read, add and change — never delete. A table that needs `DELETE` for the application (a draft a
  person may discard) grants it explicitly in its own migration, and never on a table that holds
  posted records.
- Deployment, once per environment (`ops/security/README.md`):
  `CREATE ROLE <login> LOGIN PASSWORD '<from the secret manager>' IN ROLE invoice_app;`
  and the server's `DATABASE_URL` uses that login. The owner's credentials are used by
  `npm run db:migrate` only. The owner needs `CREATEROLE` the first time, to create `invoice_app`.
- `createDatabase()` falls back to the local development database only when `NODE_ENV` is unset,
  `development` or `test`. Any other value without `DATABASE_URL` refuses to start. **Hosting must
  set `NODE_ENV`** (#346).
- `assertLeastPrivilege(db)` is called once at server start (#340). Outside development it refuses
  a connection that is a superuser, bypasses row-level security, or owns the tables.
- A session is stored by the hash of its token (`sessions.token_hash`), like an invitation. Reading
  the table yields nothing that opens a session.

### What the role does and does not protect against

The server sets the company for each transaction (`app.company_id`) from the signed-in session.
Row-level security therefore protects against a query that forgot its `WHERE company_id` — the
ordinary bug — and against one company's request reading another's rows. It is **not** a wall
against an attacker who can run arbitrary SQL as the application role: that attacker can name any
company. What still holds against them is everything above: no deleting or emptying, no editing
finished records or the audit trail, no altering the schema, no usable sessions to read.

## Row-level security

The platform's own tenant tables now force row-level security on `app.company_id`:
`audit_events`, `command_records`, `idempotency_keys`, `exception_items`, `exception_comments`
(through its item), `approval_policies`, `memberships`, `user_branch_access`.

- `users`, `sessions`, `invitations`, `companies` and `branches` are looked up **before** the
  company is known (sign-in, accepting an invitation), so they carry no policy. Sessions and
  invitations hold only token hashes, and the application may change only the columns listed
  above. Their rows (names, e-mail addresses) are readable by the application role across
  companies; the sign-in work of the security phase (#347 onwards) owns that.
- Every other tenant table without a policy is named in the `PENDING` list of the test "every
  table that holds a company's rows enforces row-level security". **Nothing may be added to that
  list.** A lane removes its tables when it moves their repository onto `tenantTransaction`
  (#366), adding the policy `return_notes` uses. The ledger's `read()` uses a plain query today
  and must move first.
- A seed or a script that writes tenant rows must run inside `tenantTransaction`/`unitOfWork`,
  or the policy refuses the write.

## Contract tests

`packages/platform/test/immutability.integration.test.ts`, on real PostgreSQL, with one
connection as the owner and one as an `invoice_app` login: the three "Done when" refusals; the
ways around them (TRUNCATE, disabling a trigger, `row_security = off`, `session_replication_role`,
DDL, temporary tables that shadow a table, moving a record back to a draft status, moving lines
between parents, re-ordering the audit trail, extending a session); the lifecycle moves that must
keep working; row-level security on every platform table; and the whole platform contract suite
of #364 run as the application role. The routes were found by an independent review of this
change and each is a test.

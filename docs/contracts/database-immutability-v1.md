# Database immutability and the application role v1

Owner: GPT 2 (#368). Consumers: every lane that owns a document table (#365, #366), the runtime
composition (#340) and operations (hosting, #346).

**In plain words:** once a bill, a return note, an e-invoice or an entry in the audit trail is
final, the database itself refuses to change or delete it — whatever code asks, and whoever is
connected. A mistake is corrected by a reversal or a note, never by editing.

## The rule in the database

`platform_freeze_posted(status_column, frozen_statuses, columns_that_may_still_change)` is one
trigger function for every document table (migration `…_immutable_records_and_app_role`,
`packages/platform/src/immutability-migrations.ts`).

- A row is **frozen** when its status column holds one of the frozen statuses — or always, when
  the status column is `''` (records that are final the moment they are written).
- A frozen row is **never deleted**.
- On a frozen row only the listed columns may change: the lifecycle (status moves, cancellation
  and reversal bookkeeping). The comparison is by value, so an `UPDATE` that sets every column,
  as a repository that saves the whole record does, is fine as long as the frozen ones are unchanged.
- The table can never be emptied (`TRUNCATE`).
- Which status moves are allowed is still the module's state machine. The database guards the
  figures and the record's existence, not the workflow.
- Refusals use SQLSTATE `23001` (`restrict_violation`) and name the table and the column.
- The rules are triggers, so they hold for every role, including the owner.

`platform_freeze_with_parent(foreign_key, parent_table, parent_status_column, frozen_statuses)`
does the same for lines whose own row has no status: they cannot be changed or removed once the
parent is frozen.

### What is frozen today

| Table | Frozen when | May still change |
| --- | --- | --- |
| `audit_events` | always | nothing — append-only |
| `command_records` | always | `status` |
| `idempotency_keys`, `idempotency_record`, `exception_comments` | always | nothing |
| `voucher`, `journal_line` | once not `DRAFT` (the ledger's own triggers, #4) | reversal bookkeeping |
| `purchase_bills` | always | `state`, `reversed_by_voucher_id`, `reversal_reason`, `summary` |
| `purchase_bill_lines`, `purchase_bill_receipts`, `purchase_match_approvals` | always | nothing |
| `goods_receipts` | `CONFIRMED`, `CANCELLED` | `state`, `cancelled_reason`, `summary` |
| `goods_receipt_lines` | parent receipt frozen | nothing |
| `goods_receipt_movements` | always | nothing |
| `return_notes` | always | `supplier_credit_note_number`, `supplier_credit_note_date` |
| `return_note_lines` | always | nothing |
| `e_invoices` | `REGISTERED`, `CANCELLED` | `status`, cancellation fields, `message`, `updated_at`, `eway_bill_number`, `signed_invoice`, `provider_request_id`, `acknowledged_at`, `cancellable_until`. **Fixed:** IRN, acknowledgement number and date, signed QR code, document particulars, GSTINs |
| `eway_bills` | `PART_A_ONLY`, `ACTIVE`, `EXPIRED`, `CANCELLED`, `REJECTED` | `status`, vehicle, transporter, validity, consolidation, cancellation and rejection fields, `alert`, `message`, `updated_at`, `generated_at`, `provider_request_id`, `failure_*`. **Fixed:** the e-way bill number, document, value, route, distance |
| `eway_consolidated_trips` | always | nothing |
| `itc_decisions`, `itc_claims`, `itc_import_batches` | always | nothing — a change of mind is a new row |
| `gst_return_preparations` | `APPROVED`, `EXPORTED`, `SUBMITTING`, `FILED`, `SUBMISSION_FAILED` | `state`, `exported_at`, `version`. **Fixed:** the approved snapshot and fingerprint |
| `gst_return_approvals` | always | `withdrawn_at`, `withdrawn_by`, `withdrawn_reason` |
| `gst_return_submissions` | `ACCEPTED` | nothing |
| `subscription_service_invoices` | `ISSUED`, `PAID`, `FAILED` | `state`, `paid_on`, `provider_reference`, `failure_reason` |
| `supplier_risk_assessments`, `supplier_risk_acknowledgements` | always | nothing |

Each row was checked against the module's service and repository before it was frozen. The list
lives in one place, `FROZEN` in `immutability-migrations.ts`.

### Adding a table (for #365 and #366)

In the migration that creates the table:

```sql
CREATE TRIGGER sales_invoices_frozen BEFORE UPDATE OR DELETE ON sales_invoices
  FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('state', 'FINAL,CANCELLED', 'state,cancellation_voucher_id,cancelled_by,cancelled_at,cancel_reason,updated_at,version');
CREATE TRIGGER sales_invoices_no_truncate BEFORE TRUNCATE ON sales_invoices
  FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();
CREATE TRIGGER sales_invoice_lines_frozen BEFORE UPDATE OR DELETE ON sales_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION platform_freeze_with_parent('invoice_id', 'sales_invoices', 'state', 'FINAL,CANCELLED');
```

and a test like `packages/platform/test/immutability.integration.test.ts`. Tables that are
final when written (stock movements, payments, allocations, cheque events) use `''` as the status
column. To change what may still change on an existing table, add a migration that drops and
re-creates its trigger, and name the reason in the PR.

### Not frozen yet, and why

Append-only by their schema comments but not verified against a repository, so left to their own
lanes: `master_versions`, `master_snapshots`, `master_merges`, `bank_statement_transactions`,
`bank_feed_transactions`, `subscription_payment_events`, `subscription_usage_events`,
`notification_delivery_events`, `collection_communications`, `compliance_alerts`,
`privacy_consents`, `restore_drills`, `status_incident_updates`, `government_calls` (freezable
once its outcome is settled). Sales bills, payments, allocations and stock movements have no
tables until #365.

Known limit: a line *added* to a document that is final from the moment it is written cannot be
told apart from its original lines by a row trigger. The header totals cannot change, so the
mismatch is detectable; the ledger closes this for vouchers with its balance check.

## The application role

The server connects as a login that is only a member of **`invoice_app`**. Migrations run as the
owner; the two are never the same account.

| `invoice_app` | |
| --- | --- |
| Is | not a superuser, not an owner of anything, `NOBYPASSRLS`, no `CREATEROLE`/`CREATEDB`, no login or password of its own |
| May | `SELECT`, `INSERT`, `UPDATE` on tables; use sequences |
| May not | `DELETE` (except the tables below), `TRUNCATE`, create or alter anything, switch triggers or row-level security off, write `schema_migrations`, `UPDATE` `audit_events` |
| `DELETE` allowed on | `user_branch_access` only (a person's branch list is replaced when their access changes) |

- Tables created by later migrations get the same grants automatically (default privileges):
  read, add and change — never delete. A table that needs `DELETE` for the application (a draft a
  person may discard) grants it explicitly in its own migration, and never on a table that holds
  posted records.
- Deployment, once per environment (`ops/security/README.md`):
  `CREATE ROLE <login> LOGIN PASSWORD '<from the secret manager>' IN ROLE invoice_app;`
  and the server's `DATABASE_URL` uses that login. The owner's credentials are used by
  `npm run db:migrate` only. The owner needs `CREATEROLE` the first time, to create `invoice_app`.
- In production `createDatabase()` refuses to start without `DATABASE_URL`.

## Row-level security

The platform's own tenant tables now force row-level security on `app.company_id`:
`audit_events`, `command_records`, `idempotency_keys`, `exception_items`, `exception_comments`
(through its item), `approval_policies`, `memberships`, `user_branch_access`.

- `users`, `sessions`, `invitations`, `companies` and `branches` are looked up **before** the
  company is known (sign-in, accepting an invitation), so they carry no policy. They are protected
  by unguessable ids and token hashes, and by the code that reads them.
- Every other tenant table without a policy is named in the `PENDING` list of the test "every
  table that holds a company's rows enforces row-level security". **Nothing may be added to that
  list.** A lane removes its tables when it moves their repository onto `tenantTransaction`
  (#366), adding the policy `return_notes` uses. The ledger's `read()` uses a plain query today
  and must move first.
- A seed or a script that writes tenant rows must run inside `tenantTransaction`/`unitOfWork`,
  or the policy refuses the write.

## Contract tests

`packages/platform/test/immutability.integration.test.ts`, on real PostgreSQL, with one
connection as the owner and one as an `invoice_app` login: the three "Done when" refusals, the
ways around them (TRUNCATE, disabling a trigger, `row_security = off`, `session_replication_role`,
DDL), the owner being refused too, the lifecycle moves that must keep working, row-level
security, and the whole platform contract suite of #364 run as the application role.

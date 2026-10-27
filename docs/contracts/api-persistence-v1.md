# API persistence v1

Owner: #340. Builds on [`unit-of-work-v1`](./unit-of-work-v1.md). Affects: #341, #342, #345, #366
(every lane's repositories), and GPT 3's `packages/masters`.

## Which store, decided once

`apps/api/src/persistence.ts` → `openPersistence(env)`, called by `apps/api/src/server.ts` and
`apps/web/server.ts` before the first request.

| `DATABASE_URL` | `NODE_ENV` | Result |
| --- | --- | --- |
| set | any | PostgreSQL. Outside development the login must be a plain member of `invoice_app` (`assertLeastPrivilege`). |
| not set | empty, `development`, `test` | Memory, with the synthetic demo companies. |
| not set | anything else | The process stops: `DATABASE_URL is not set…`. |

## Requests

- A request that changes something (`POST`, `PUT`, `DELETE`) runs as **one action**:
  `asOneAction(db, companyId, work)` opens one `db.unitOfWork` for the session's company and commits
  only after every write started from synchronous code (below) has landed.
- A `GET` runs as `asOneRead(work)`: no transaction, but any write it starts (the walk-in customer,
  created the first time it is read) commits before the answer is sent.
- Work that follows an action (the automatic e-invoice) is an outbox message written in the
  action's own transaction (`uow.enqueue`, topic `einvoice.generate`, dedupe key = the bill). The
  worker sends it after commit (#345).

## The worker (#345)

`npm run worker` (`apps/api/src/worker.ts`), with the same `DATABASE_URL` as the API. **It must run
beside the API whenever the app has a database**; without it e-invoices and recurring work wait.

- Finds companies with due work through `companies_with_due_work(stale interval)`: company ids
  only, from a `SECURITY DEFINER` function owned by the no-login role `invoice_work_finder`, which
  can see only the due-work columns of `outbox_messages` and `recurring_work_status`.
- For each: `OutboxRelay.drain` with the company's handlers (`DemoApplication.outboxHandlers()`),
  then its recurring jobs from `recurring_work_status` (`ops/operations/src/recurring-postgres.ts`).
- Every claim is `FOR UPDATE SKIP LOCKED` with a lease (outbox 60 s, recurring 5 min); results are
  saved only while the claim holds. Delivery is at least once; handlers are idempotent.
- The e-invoice handler calls `EInvoiceService.prepareRegistration` (unit of work), `callPortal`
  (holding nothing) and `completeRegistration` (in the unit of work that marks the message sent).
- The Operations screen lists outbox messages as jobs and `recurring_work_status` as recurring
  work, and replays either (`recurring:<key>` for a recurring job). The API runs no tick.

## Demo data

Memory only. On PostgreSQL nothing synthetic is written: no customer, items, bills, bank lines,
vehicle consent, business details or incidents. `npm run db:seed` writes the synthetic companies
and their three people each, and refuses outside development and tests.

## Records with no module table: `app_records`

Migration `20261016T064205274Z_api_4b8da552ccf1_durable_app_records` (`packages/platform`).

| Column | Meaning |
| --- | --- |
| `company_id`, `kind`, `key` | Primary key. Forced row-level security on `app.company_id`. |
| `value jsonb` | `canonicalJson` (bigint as `{ "$bigint": "…" }`). A removed record is `null`; the application has no `DELETE`. |
| `frozen` | A copy of an issued document. A trigger refuses any change or delete. |

Kinds today: `business_details`, `business_prefill`, `turnover_answers`, `einvoice_exemption`,
`branding`, `upi_id`, `item_tax`, `item_price`, `declared_rate` (frozen, append-only),
`invoice_print`, `note_print`, `challan_print`, `presale_print` (frozen), `eway_movement`,
`sale_delivery`, `export_sale`, `composition_scheme`, `composition_statements` (#296). A module that grows its own table moves its kind's rows there.

Frozen rows written before #352 are plaintext until the owner runs `npm run db:seal-frozen`
(preview by default; `--apply --approved-by "<name>"` to seal; see decision D500). New frozen
rows are sealed when written. A removed member's sign-in address is replaced only through the
SQL function `anonymise_user(company, user, actor, correlation, reason)` (migration
`20261027T224659375Z_platform_c67212a4f613_anonymise_user_function`), which also writes the audit row.

`DurableMap<V>` (`apps/api/src/durable.ts`) is a `Map` whose `set`/`delete` also write here, and
whose company is read back on first open after a restart.

## Master data (`packages/masters`, additive)

`new MasterDataService(commands, audit, units?, storeFor?)`. `storeFor(kind)` returns the store for
one of the 13 `master_records` kinds; the default is the in-memory `VersionedStore`. The API passes a
store that also appends each version to `master_versions` through `PostgresVersionedStore`, inside
the action. Nothing else about the service changes. The async service that reads PostgreSQL
directly remains the masters lane's (#366).

## Files (#341)

Private object storage behind `ObjectStore` (`packages/platform/src/storage.ts`); only the key and
the facts are in PostgreSQL (`stored_files`, forced row-level security, screened once, no delete).

| Route | Who | What |
| --- | --- | --- |
| `POST /api/files/uploads` `{ purpose, fileName, contentType, sizeBytes }` | `purchase_bill`: `ledger.post.purchase`; `branding_logo`: `branding.write` | Checks the name, claimed type and size first (`safety.ts`), then returns `{ file, upload: { url, method: 'PUT', headers, expiresAt } }`, valid 5 minutes. The key is `<company>/<purpose>/<uuid>`, chosen by the server. |
| *the browser* `PUT upload.url` with `upload.headers` | the address itself | The file goes straight to storage, never through the API. |
| `POST /api/files/:id/complete` | as for uploading | Reads the stored file, has it scanned, screens it with `screenAttachment` (#401): `available`, or `quarantined` with `reason` and a shopkeeper's `message`. |
| `GET /api/files/:id/link` | `purchase_bill`: `ledger.post.purchase`; `branding_logo`: `dashboard.read` | An available file only: `{ download: { url } }`, valid 60 seconds, served as an attachment. Another company's id is 404. |

- **Stores:**
  - `SpacesObjectStore`: DigitalOcean Spaces BLR1 (decision 0003), S3 v4 pre-signed URLs, objects `x-amz-acl: private`. Configured by `SPACES_BUCKET`, `SPACES_ACCESS_KEY_ID`, `SPACES_SECRET_ACCESS_KEY` and optionally `SPACES_ENDPOINT` and `SPACES_REGION`.
  - `LocalObjectStore`: a folder (`FILE_STORE_DIR`) and HMAC-signed `/api/files/blob?token=` addresses. Development and tests only. Production without Spaces refuses to issue an address.
- **Virus scan:** a file no scanner has answered for is held (#401). No scanner is chosen for production yet, so there every file is `quarantined` with reason `AWAITING_SCAN`. In development a stand-in answers clean.
- **Limits:** a supplier's bill is a PDF, JPEG, PNG or HEIC of up to 25 MB; a logo is a PNG or JPEG of up to 1 MB.

## Known limits

- Memory is the read path for master data and `app_records`, so **one API process** only. Two would
  not see each other's new customers, items or business details.
- After a failed action that had written master data or app records, every loaded company is read
  back from the database. A request running at that moment may briefly miss a record.
- Only the synthetic companies can be opened. A real company needs its identity (name, GSTIN,
  location) in a table, which arrives with #342's sign-up.
- A `GET` that writes through a module repository (`requireUnitOfWork`) is refused with
  `NO_UNIT_OF_WORK`. None is known; one found is moved to a `POST` or given its own unit of work.
- A recurring job runs inside one action for its company, so a job that calls a portal holds the
  company lock while it does. Splitting those jobs as the e-invoice was split is per module.
- Calls a person waits for stay in the request: e-invoice and e-way bill raised from their screens,
  GST return submission, the supplier and vehicle checks. They still hold the company lock during
  the call.
- External failures and incidents on the Operations screen are the API process's own; the worker's
  are in its log and error tracker.

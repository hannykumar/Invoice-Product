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
- Work that follows an action (the automatic e-invoice) runs in its own unit of work, which waits
  for the action's lock. #345 moves it onto the outbox.

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
`sale_delivery`, `export_sale`. A module that grows its own table moves its kind's rows there.

`DurableMap<V>` (`apps/api/src/durable.ts`) is a `Map` whose `set`/`delete` also write here, and
whose company is read back on first open after a restart.

## Master data (`packages/masters`, additive)

`new MasterDataService(commands, audit, units?, storeFor?)`. `storeFor(kind)` returns the store for
one of the 13 `master_records` kinds; the default is the in-memory `VersionedStore`. The API passes a
store that also appends each version to `master_versions` through `PostgresVersionedStore`, inside
the action. Nothing else about the service changes. The async service that reads PostgreSQL
directly remains the masters lane's (#366).

## Known limits

- Memory is the read path for master data and `app_records`, so **one API process** only. Two would
  not see each other's new customers, items or business details.
- After a failed action that had written master data or app records, every loaded company is read
  back from the database. A request running at that moment may briefly miss a record.
- Only the synthetic companies can be opened. A real company needs its identity (name, GSTIN,
  location) in a table, which arrives with #342's sign-up.
- A `GET` that writes through a module repository (`requireUnitOfWork`) is refused with
  `NO_UNIT_OF_WORK`. None is known; one found is moved to a `POST` or given its own unit of work.
- Recurring jobs run as one action per company on the API's tick, holding the company lock while they
  call a portal. #345 moves them to the worker.

# Live bank feeds contract v1

Owner: issue #24. Dependencies: E08 connector gateway, #21 bank transaction normalization and #22 reconciliation.

## Safety boundary

The customer leaves the product to grant explicit permission at the provider. The service stores an opaque provider consent identifier, masked account details, cursors and imported financial records. It never accepts or stores a bank password, PIN, OTP, access token or refresh token. Provider credentials belong in E08's credential vault.

Live feeds import evidence; they do not post ledger entries or initiate payments. Each normalized transaction exposes the subset consumed by `bank-reconciliation`: company, booking date, description, debit/credit paise, optional reference and fingerprint.

## Lifecycle

`PENDING_CONSENT → CONNECTED → TOKEN_EXPIRED | REVOKED | DISCONNECTED`. Provider and validation failures are visible as `ERROR` or a failed sync. Only `CONNECTED` connections sync. A disconnect revokes provider permission when possible, marks accounts inactive and retains all previously imported transactions.

Sync states are `IDLE`, `PROCESSING`, `SUCCEEDED` and `FAILED`. Cursors advance only after the entire provider response validates. A failed request leaves the previous cursor and transactions unchanged, so a retry is recoverable. Provider transaction IDs are unique per company and linked account, so two accounts remain distinct even if a provider reuses an identifier; an explicit sync idempotency key also returns the prior result.

## Permissions

- `bank.feed.manage`: start/complete consent, disconnect and process revocation.
- `bank.feed.sync`: run incremental imports.
- `bank.balance.read`: view connections, masked accounts, balances and imported transactions.

Tenant identity always comes from the authenticated context. The database tables use forced row-level security on `company_id` as a second boundary.

## Provider adapter

`BankFeedProviderAdapter` exposes `startConsent`, `completeConsent`, `sync` and `revoke`. `ConnectorBankFeedAdapter` maps these operations to E08's `banking` connector. OAuth authorization codes pass through once; they are not returned, audited or persisted. The included synthetic provider uses invented Indian-business data for deterministic sandbox, outage, cursor-replay, expiry and revocation tests.

## Consent return address and `state` (#402, v1.1.0)

The bank sends the customer back only to this app: `BankFeedService` takes a `ConsentReturnPolicy` of allowed origins (`https://…`, or `http://localhost` / `http://127.0.0.1` in development) and one fixed path, `/bank-feed-return`. The API builds the origins from `KAROBAR_PUBLIC_ORIGINS`, or this machine in development, and with none no consent starts. `startConsent` may name one of those addresses in `redirectUri` or leave it out; any other address is refused and the bank is not asked.

`startConsent` returns `{ connection, state }`. `state` is 32 random bytes, passed to the adapter's `startConsent` to send with the bank request, and returned once to the person who started it (the API's `consentState`). Only its SHA-256 is stored, in `bank_feed_consent_states`, with the company, the person who started it and a 30-minute expiry. `completeConsent(context, connectionId, authorizationCode, state)` exchanges the code only when that hash, company and person match and the state is unused and in time; it is spent before the bank is asked, so a reply is used once. A wrong guess spends nothing. If the bank then refuses the code, the connection ends in `ERROR` and consent starts again.

## Known limitations

The first version supports INR current, savings, cash-credit and other deposit accounts. It neither becomes an RBI Account Aggregator nor initiates payments. Production providers and legal/commercial access remain separately approved business work.

## Storage (#366)

`BankFeedService` keeps its records behind `BankFeedStore` (`src/store.ts`): `InMemoryBankFeedStore`, or `PostgresBankFeedStore` (`src/postgres-store.ts`) on `bank_feed_connections`, `bank_feed_accounts`, `bank_feed_transactions`, `bank_feed_syncs` and the platform's `audit_events`. On PostgreSQL every command runs inside the caller's unit of work. Imported lines and sync results are frozen when written. Every list takes an optional `{ limit, after }` page. Another company's connection is answered `NOT_FOUND` on PostgreSQL (row-level security hides it) and `TENANT_ISOLATION` in memory; both refuse.

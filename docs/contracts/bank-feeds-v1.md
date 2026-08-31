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

## Known limitations

The first version supports INR current, savings, cash-credit and other deposit accounts. It neither becomes an RBI Account Aggregator nor initiates payments. Production providers and legal/commercial access remain separately approved business work.

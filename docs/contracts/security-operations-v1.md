# Security operations contract v1

Version 1.1.0 (#366).

Owner: GPT 2, issue #40. Consumers: platform composition and production operations.

## Boundary

Business modules never handle encryption keys, backup object credentials or raw restore data. They
use authenticated `RequestContext`; the security composition layer supplies key, object-storage,
snapshot and restore adapters.

| Operation | Permission | Idempotency/audit expectation |
| --- | --- | --- |
| Publish notice / record consent | `privacy.manage` | Versioned notice and immutable decision event |
| Export one subject | `privacy.export` | Tenant-scoped idempotency key and completion event; export body is not logged |
| Delete one subject | `privacy.delete` | Tenant-scoped idempotency key; blocked by active legal holds or future retention |
| Create/prune backups | `backup.manage` | Tenant-scoped idempotency key; manifest carries schema, checksum, expiry and key ID |
| Restore/drill | `backup.restore` | Validate before replace; every pass/failure is audited |

## Adapter contracts

- `EncryptionKeyProvider.key(keyId)` returns exactly 32 key bytes from a managed provider. A missing
  or malformed key fails closed.
- `BackupSource.snapshot(companyId)` produces one consistent tenant-scoped snapshot.
- `BackupRepository` stores only encrypted payloads and manifests.
- `RestoreTarget.validate` must complete before `RestoreTarget.replace` is called. Authentication,
  decryption, checksum, byte-length or schema failure means `replace` is never called.
- `PrivacyDataStore.exportSubject` and `deleteSubject` must apply the supplied company and subject
  together and return no other tenant’s data.

Expected failures are typed at the platform boundary: `FORBIDDEN`, `TENANT_ISOLATION`, `NOT_FOUND`,
invalid policy/notice, active retention or legal hold, unavailable key, authentication failure,
checksum failure and restore schema validation failure.

## 1.1.0 (#366) — persistence

- `PrivacyService` and `BackupRecoveryService` methods are `async` and keep their records through ports: `PrivacyStore` (`InMemoryPrivacyStore`, `PostgresPrivacyStore`) and `BackupRepository` (`MemoryBackupRepository`, `PostgresBackupRepository` with a `BackupObjectStore` for the encrypted bytes). `BackupRepository` is now `action`, `putPayload`, `save`, `get(companyId, backupId)`, `byKey`, `expired`, `prune`, `deletePayload`, `addDrill`, `drills`.
- Each command runs in one `action`: on PostgreSQL one unit of work; in memory, every change is undone if the action throws. A failed export or deletion therefore leaves the request `requested` and can be retried; it completes and is audited once.
- Encrypted backup bytes are written outside the unit of work and removed again if the manifest is not recorded.
- Another company's request, hold or backup is `NOT_FOUND` (it was `TENANT_ISOLATION`), so its existence is not revealed.
- Retention rules are kept (`privacy_retention_rules`); privacy and backup tables are frozen once settled (see `database-immutability-v1.md`).


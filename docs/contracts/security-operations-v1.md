# Security operations contract v1

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

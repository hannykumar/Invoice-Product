# Security, privacy and recovery baseline — issue #40

This module supplies the executable baseline for protecting tenant financial data. It complements
the authenticated company context in `packages/platform`; it does not replace an external key
manager, object store, database backup tool or independent security audit.

## Controls implemented

- AES-256-GCM encryption with authenticated tenant/backup metadata and a replaceable key-provider
  interface. Production keys must come from a managed KMS/HSM or secret manager; they must never
  be placed in source control, database rows, logs or backup objects.
- Encrypted, checksummed backup objects with tenant ownership, schema version, expiry and key ID.
  Restore decrypts and validates integrity and schema in staging before it may replace data. Backup
  creation and privacy requests use tenant-scoped idempotency keys and reject divergent retries.
- Explicit `backup.manage` and `backup.restore` permissions. A restore attempt and its outcome are
  immutable audit events.
- Versioned privacy consent, subject export and deletion requests. Deletion fails visibly when a
  retention rule or legal hold applies; the product never silently deletes legally retained data.
- Recursive structured-log redaction for credentials, sessions, authorization headers, documents,
  bank statements and connection-string passwords. Stack traces and document bodies are excluded
  from ordinary logs.
- PostgreSQL tables for privacy and recovery evidence with fail-closed row-level tenant policies.

## Threat model

| Threat | Primary control | Residual/operational requirement |
| --- | --- | --- |
| User reads another company’s records | Authenticated company context, permissions and RLS | Set `app.company_id` inside every production database transaction |
| Stolen backup exposes invoices or bank data | AES-256-GCM encryption and separate key provider | Use a managed key service and restrict decrypt permission |
| Backup is corrupt or belongs to another tenant | Authenticated metadata, checksum and staged validation | Store immutable copies in a separate account/project |
| Secrets or documents leak into logs | Structured allow-list fields and recursive redaction | Alert on redaction regressions and restrict log access |
| Deletion destroys records that must be retained | Legal holds, configurable retention and audited blocked state | Legal owner sets applicable periods; code does not invent them |
| Dependency or credential compromise | Lockfile installs, CI dependency audit, key rotation and incident runbook | Add independent penetration testing before production |

## Security baseline

1. Production runs with TLS at every network boundary and encrypted PostgreSQL/object-store disks.
2. Application database roles are not owners and cannot bypass row-level security.
3. Every request gets company and actor identity from the authenticated session, never request data.
   Production persistence uses `tenantTransaction(companyId, work)`, which sets the transaction-local
   PostgreSQL tenant context consumed by row-level security policies.
4. Managed secrets are short-lived where possible, rotated, least-privileged and unavailable to logs.
5. Ordinary logs contain identifiers and outcomes only—not invoice bodies, bank rows, voice data,
   authentication material or encryption keys.
6. Backups use a different failure domain, object immutability and a documented retention policy.
7. A restore drill runs at least quarterly and after material schema or backup-adapter changes.
8. Privacy retention periods and legal holds are configuration approved by the legal owner. This
   implementation deliberately contains no guessed statutory retention period.

## Verification

```sh
npm run security:drill
npm run verify
```

The automated drill creates an encrypted tenant backup, restores it through schema validation,
corrupts a copy, and proves the corrupt copy cannot replace target data. Production restore drills
must additionally follow [`restore-runbook.md`](./restore-runbook.md).

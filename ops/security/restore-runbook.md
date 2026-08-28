# Backup and restore runbook

## Recovery objectives

The production owner must record the agreed recovery point objective (RPO) and recovery time
objective (RTO) for each environment. Until those values are approved and measured, do not claim
that the product meets an availability or disaster-recovery SLA.

## Scheduled backup procedure

1. Authenticate the backup worker with a service identity limited to `backup.manage`.
2. Export one transactionally consistent PostgreSQL snapshot and the matching object manifest.
3. Encrypt before leaving the database network, using the active managed key ID.
4. Store the encrypted object in an immutable, versioned bucket in a separate failure domain.
5. Persist only object key, tenant, schema version, checksum, byte length, key ID and retention time.
6. Alert if creation, encryption, upload or manifest persistence fails. Never log snapshot content.

## Restore drill

1. Open an incident/change record and identify the exact backup, tenant and expected schema version.
2. Use a temporary isolated database with no outbound notification or government-service access.
3. Fetch the encrypted object with a service identity limited to the selected object.
4. Authenticate metadata, decrypt, verify byte length and SHA-256 checksum.
5. Restore into the temporary database; run migrations only when the approved recovery plan says so.
6. Run tenant-isolation, row-count, ledger-balance and representative document checks.
7. Record start/end time, backup age, schema version, results and any manual intervention.
8. Destroy the temporary plaintext copy using the environment’s approved secure-deletion process.

Only after steps 1–7 pass may an authorised operator with `backup.restore` approve replacement of a
damaged environment. A failed validation leaves the target unchanged and creates a failed drill
record. Never test a restore by overwriting the only production copy.

## Incident response

1. Contain: revoke affected sessions/credentials and isolate the affected service or tenant.
2. Preserve: retain audit, access and deployment evidence without copying sensitive documents into
   the incident chat or ticket.
3. Assess: determine tenants, data classes, time window and integrity/availability impact.
4. Recover: use a validated backup and record every override and approval.
5. Notify: the designated privacy/legal owner decides required notifications and timing.
6. Learn: rotate credentials, fix the control, add a regression test and complete a tabletop review.

### Tabletop scenario

Assume a deployment deletes one tenant’s draft invoices at 10:15 while finalised ledger entries
remain intact. The exercise passes only if the team can identify the tenant, stop further writes,
choose a pre-incident backup, prove the restore does not alter another tenant, reconcile restored
drafts to immutable audit events and document the achieved RPO/RTO.

# D10 — Retention periods

- **Status:** Accepted, 7 Oct 2026
- **Decision id:** D10 (tracking issue #362, recorded by #339)
- **Who chose:** The owner (business answer), **pending legal confirmation before launch**. Log and backup periods proposed by the agent.
- **Product impact:** none. This changes how Karobar is built underneath, not what it does for the shopkeeper.

## Context

GST law requires accounts and records to be kept for 72 months from the due date of the annual
return for the year (CGST Act s.36); the Companies Act s.128 requires 8 years. The DPDP Act 2023
requires personal data to be erased when no longer needed, unless a law requires keeping it. The
code has no retention periods today except 8 years for vehicle-record evidence.

## Decision

| Data | Kept for |
| --- | --- |
| Books, invoices, vouchers, GST records, supplier bills, audit trail | **8 years from the end of the financial year**, longer under audit, appeal or legal hold |
| A company that stops paying | Read-only with full export, kept for the same period, then deleted |
| A person who asks to be deleted | Account and personal data outside the books deleted; their name in posted records stays (books are immutable); access removed |
| Application logs | 30 days (proposed) |
| Error-tracker events | 90 days (proposed) |
| Backups | Point-in-time window (7 days) + monthly snapshots for 12 months (proposed) |

Every period is configuration with a source note (as compliance rules are); code never invents
one. `ops/security/privacy.ts` already blocks deletion under a hold or retention.

**This is not legal advice. Legal confirms these periods before the first paying customer.**

## Alternatives

- Keep forever while subscribed: simpler, but holds personal data longer than needed.
- Delete one year after lapse: leaves the business to keep its own statutory copy.

## Consequences

- At flat volume the database reaches ~1.8 TB and files ~4.4 TB by year eight; old years are
  partitioned and rarely read.

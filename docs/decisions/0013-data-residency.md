# D13 — Data residency (DPDP Act 2023)

- **Status:** Accepted, 7 Oct 2026
- **Decision id:** D13 (tracking issue #362, recorded by #339)
- **Who chose:** Chosen by the agent on the recommendation; the owner did not evaluate it technically — revisit if a reason appears.
- **Product impact:** none. This changes where data is kept underneath, not what Karobar does for the shopkeeper.

## Context

Karobar holds other businesses' books, their customers' names and phone numbers, bank details and
PAN. The DPDP Act 2023 does not require data to stay in India (cross-border transfer is allowed
except to countries the government restricts), but shopkeepers and their CAs expect it, and
keeping it in India removes a whole class of risk. Several vendors we need are not in India.

## Decision

**Books, documents, backups, sessions and the identity store stay in an India region.** A vendor
outside India receives **ids only** — never names, phone numbers, emails, GSTIN joined to bank
details, or invoice contents.

| Vendor | Where | Receives | Status |
| --- | --- | --- | --- |
| DigitalOcean BLR1 (app, Postgres, Spaces, logs) | India | Everything we store | D3 |
| Supabase Auth, Mumbai project | India | Users' phone numbers and emails, sign-in events | D1 — **confirm in DPA that auth logs and backups stay in India**, else self-host its auth server in BLR1 |
| SMS provider (TRAI DLT-registered) | India | Phone number and OTP text | To choose |
| Email provider | India | Recipient email and the document the user sends | To choose |
| OCR provider (reading supplier bills) | India, or self-hosted in BLR1 | The supplier bill image | To choose; only a mock exists |
| GSP / IRP (government) | India, regulated | Invoice data the law requires | Offline JSON at launch; live after #50 |
| Razorpay | India | Paying owner's billing details | D9, Phase 4 |
| Sentry | EU (Frankfurt) | Request, company and user ids; scrubbed stack traces | D7 |
| GitHub | US | Source code only; fixtures are synthetic (rule 10) | — |
| WhatsApp (Meta) | Outside India | **Nothing from our servers.** A bill shared on WhatsApp leaves from the user's own phone through the click-to-chat link the app already builds | — |

**WhatsApp Business API is not used at launch.** The interview asked for automatic WhatsApp
sending, but Meta runs that service outside India, so customers' numbers and bills would leave
India from our servers. The safer and simpler option — the user's own "share on WhatsApp" tap,
which already works — is kept. Turning on the Business API later is a business decision, raised
on #362 (system design Q6); it would slot in behind `notification-v1` without changing a screen,
and this table would gain a row with the privacy notice updated (#55).

## Alternatives

- **Relax to "any vendor with a DPA".** Legal under DPDP, but a harder promise to explain and to
  keep.
- **Self-host everything, including error tracking.** Full residency, more to run.

## Consequences

- Every new vendor adds a row here before it receives data, and the privacy notice (#55) lists
  them.
- Logs and error events are redacted with `ops/security` `redactForLog`; a test asserts no phone
  number, GSTIN or amount reaches the error tracker (#358).
- Backups stay in BLR1; any off-site copy goes to another Indian region, not abroad.

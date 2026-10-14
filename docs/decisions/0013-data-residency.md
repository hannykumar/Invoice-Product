# D13 — Data residency (DPDP Act 2023)

- **Status:** Accepted, 10 Oct 2026 (replaces the 7 Oct wording, which wrongly ruled out WhatsApp)
- **Decision id:** D13 (tracking issue #362, recorded by #339)
- **Who chose:** Chosen by the agent on the recommendation; the owner did not evaluate it technically — revisit if a reason appears.
- **Product impact:** none. This says where data is kept and what a provider must sign. **It can
  never remove or switch off a feature in the handbooks.** If keeping a rule here would mean
  dropping a feature, the rule gives way and the question goes to #362.

## Context

Karobar holds other businesses' books, their customers' names and phone numbers, bank details and
PAN. The DPDP Act 2023 does not require data to stay in India: sending it abroad is allowed
except to countries the government restricts, provided there is consent and the processor is
bound by contract. The handbooks require sending bills and reminders on WhatsApp and email (#14,
#23, #39), reading supplier bills (#15), voice (#10), live GST and bank connections (#24, #26,
#27, #33) and a privacy notice that names "which providers receive" data (#55). Some of those
providers run outside India.

## Decision

1. **What we store stays in India:** books, documents, backups, sessions and the identity store.
2. **A provider that must process a message or a document to do its job is allowed** — WhatsApp,
   SMS, email, OCR, speech-to-text, a language model, the GSP, a bank-feed partner — wherever it
   runs, on four conditions:
   - it sits behind the existing adapter (`connector-v1`, `notification-v1`);
   - the business has consented, and the provider is named in the privacy notice (#55);
   - there is a data-processing agreement with it;
   - it receives only what that job needs, and nothing is sent to a country the government
     restricts.
3. **Tools that do not need customer data to work get ids only** — error tracking, monitoring,
   source hosting.
4. Where an India-hosted provider of equal quality exists, prefer it. This is a preference, not a
   gate.

| Provider | Where | Receives | Why it needs it |
| --- | --- | --- | --- |
| DigitalOcean BLR1 (app, Postgres, Spaces, logs) | India | Everything we store | Hosting (D3) |
| Supabase Auth, Mumbai | India | Users' phone numbers and emails | Sign-in (D1); confirm in its agreement where auth logs and backups sit |
| SMS provider (DLT-registered) | India | Phone number, message text | OTP and alerts (#39) |
| Email provider | To choose; India preferred | Recipient, the message and document | Sending bills and reminders (#14, #23) |
| WhatsApp Business provider (Meta) | Outside India | Recipient's number, the message and document | Sending bills and reminders, receiving supplier bills (#14, #15, #23) |
| OCR provider | To choose; India preferred | The supplier bill image | Reading bills (#15) |
| Speech-to-text / language model | To choose | The spoken or typed instruction; never decides money or law | Voice and assistants (#10, #34, #47) |
| GSP / IRP | India, regulated | Invoice and return data the law requires | E-invoice, e-way bill, returns (#26, #27, #33) |
| Bank-feed partner | India, regulated | Consent and bank transactions | Live bank feeds (#24) |
| Vehicle-record source | India, government | Vehicle number | Vehicle check (#29) |
| Razorpay | India | Paying owner's billing details | Subscriptions (D9) |
| Sentry | EU | Ids and scrubbed stack traces only | Error tracking (D7) |
| GitHub | US | Source code; fixtures are synthetic | Development |

## Alternatives

- **Strict: nothing personal leaves India.** This was the 7 Oct wording. It removed automatic
  WhatsApp sending and constrained OCR and voice — features the handbooks define. A decision
  record may not do that, so it is withdrawn.
- **No rule at all.** Legal, but leaves nobody accountable for what each provider receives.

## Consequences

- **WhatsApp is back as the handbooks define it** (#14, #23, #39, #15): it switches on when the
  WhatsApp Business account and provider are set up (owner action). The share-from-your-own-phone
  link keeps working beside it.
- Every new provider adds a row here and to the privacy notice (#55) before it receives data.
- Logs and error events are redacted with `ops/security` `redactForLog`; a test asserts no phone
  number, GSTIN or amount reaches the error tracker (#358).
- Backups stay in India.

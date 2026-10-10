# D1 — Login identity: Supabase Auth in Mumbai

- **Status:** Accepted, 7 Oct 2026
- **Decision id:** D1 (tracking issue #362, recorded by #339)
- **Who chose:** Chosen by the agent on the recommendation; the owner did not evaluate it technically — revisit if a reason appears.
- **Product impact:** none. This changes how Karobar is built underneath, not what it does for the shopkeeper.

## Context

Users are hard-coded in `apps/api/src/runtime.ts` with unsalted SHA-256 passwords. Shopkeepers
sign in with a phone number; CAs often with email. Phone OTP, email verification, recovery,
lockout and MFA are exactly what should not be hand-written. D13 keeps what we store — and the
identity store is something we keep — in India.

Vendor facts checked on 7 Oct 2026:

- **Clerk** hosts in the US only, no region choice ([clerk.com/security](https://clerk.com/security)).
- **Auth0** offers India only on its Private Cloud tier
  ([Auth0 private cloud on AWS](https://auth0.com/docs/deploy-monitor/deploy-private-cloud/private-cloud-on-aws)).
- **Supabase** pins Postgres, Auth and Storage to the project region; Mumbai is `ap-south-1`
  ([Supabase regions](https://supabase.com/docs/guides/platform/regions)). Backups, logs and some
  subprocessors may sit outside the region
  ([summary](https://erfi.dev/reference/supabase-data-residency/)) — to be checked in their DPA.

## Decision

- **Supabase Auth**, project in **Mumbai (ap-south-1)**, used for identity only (not as our
  database). Sign-in by **phone OTP** and **email** (OTP or magic link). MFA available later.
- SMS goes through Supabase's SMS hook to an **India, TRAI-DLT-registered SMS provider**. DLT
  entity, sender id and template registration is an owner action (system design Q7).
- After sign-in the browser hands the Supabase access token to `POST /api/auth/session` once. The
  API verifies it against Supabase's published keys, finds or creates our user by Supabase user
  id, and creates **our own session** in Postgres (the `sessions` table already exists). From then
  on the browser holds only our session cookie (D2).
- `packages/platform` keeps **memberships, roles, permissions and revocation**. Removing a member
  revokes their sessions at once, as `auth.ts` already does; this does not depend on Supabase.
- Prefer verifying the token with `node:crypto` and the JWKS over adding a Supabase SDK.

## Alternatives

- **Own accounts** (`node:crypto` scrypt, sessions in Postgres, OTP through the messaging
  adapter). Full control and residency, no vendor; but we would hand-write OTP, reset, lockout
  and MFA. Kept as the **exit path**.
- **AWS Cognito, Mumbai.** India region, but awkward to customise and ties us to AWS while hosting
  is on DigitalOcean (D3).
- **Clerk / Auth0 public cloud.** Best developer experience; the identity store would sit outside India, against D13 rule 1.

## Consequences

- No password or OTP code in our repository; the pre-launch gate "sign-in via a proven provider"
  is met.
- Supabase is an outside dependency for sign-in only. If it is down, people already signed in keep
  working (our session); new sign-ins fail.
- **Before launch:** confirm in Supabase's DPA where auth logs and backups live. If outside India,
  self-host Supabase's open-source auth server (GoTrue) in BLR1 — same API, no code change.
- Exit path: export users (Supabase is Postgres underneath) to own accounts.
- Cost: Supabase Pro ≈ US$25/month plus SMS at about ₹0.15–0.25 per OTP (estimate).

## Checked against the handbooks (10 Oct 2026)

Handbook #3 asks for secure login, session management and recovery, roles and granular
permissions, invitations, deactivation, access review, and **company and branch** tenancy. This
record changes only who checks the phone number or email. Memberships, roles, permissions,
**branch-level access** (`user_branch_access`, `Member.branchIds`), invitations and revocation
stay in `packages/platform` exactly as built. Handbook #8 and #40 forbid storing portal or bank
passwords; nothing here stores any password.

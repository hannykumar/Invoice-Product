# D3 — Hosting: DigitalOcean Bangalore

- **Status:** Accepted, 7 Oct 2026
- **Decision id:** D3 (tracking issue #362, recorded by #339)
- **Who chose:** Chosen by the agent on the recommendation; the owner did not evaluate it technically — revisit if a reason appears.
- **Product impact:** none. This changes how Karobar is built underneath, not what it does for the shopkeeper.

## Context

Nothing is deployed today. Books must stay in India (D13). The team is small; ops burden must be
low. Uptime target is 99.5% (D8), which one region with point-in-time recovery meets.

## Decision

- **DigitalOcean, Bangalore (BLR1)** for everything we run:
  - **App Platform** (or Droplets with Docker if App Platform is not offered in BLR at
    provisioning time): one web + API service, one worker service, from the same image.
  - **Managed PostgreSQL** in BLR1 on a tier with **point-in-time recovery**, with the built-in
    connection pool (PgBouncer) in front.
  - **Spaces** object storage in BLR1 for files, private, accessed through signed URLs.
- Separate **staging** and **production**: different databases, buckets and keys.

Sources: [DigitalOcean regional availability](https://docs.digitalocean.com/platform/regional-availability/),
[Managed PostgreSQL](https://www.digitalocean.com/products/managed-databases-postgresql) (PITR on
higher tiers).

## Alternatives

- **AWS Mumbai** (ECS/App Runner, RDS, S3). Most mature; more to configure and harder to keep the
  bill predictable for a small team. The natural next step if we outgrow DigitalOcean.
- **Supabase for the database as well.** Fewer vendors, but its backups may sit outside India.

## Consequences

- One vendor, one bill, India region. Rough cost at year-one scale in `docs/architecture.md`.
- Confirm at provisioning: App Platform in BLR, and that the chosen Postgres tier has PITR.
- Moving to AWS later is a lift-and-shift (Docker image, `pg_dump`), not a rewrite.

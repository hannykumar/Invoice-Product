# Access-recovery drill — issue #49 [X01]

The failure this exists to prevent: a provider account that only one person can get into, and that
person is unreachable on the day a filing is due or a bank feed stops.

`npm run vendor:readiness` finds the structural version of it — an access with no named backup, or
no written way back in. This drill finds the version that a register cannot: a recovery route that
is written down and does not actually work.

## Run it quarterly, and after anybody joins or leaves

For each provider account in the register, with the **backup** custodian doing it and the primary
custodian not helping:

1. **Get in without the primary.** Not "could you" — actually sign in.
2. **Reach the recovery route.** Open the recovery mailbox; confirm it is a company address, not a
   personal one, and that at least two people can read it.
3. **Find the second factor.** Backup codes, authenticator seed or hardware key — in the company
   vault, reachable by the backup custodian, and not only on the primary's phone.
4. **Change something harmless and change it back**, to prove the access is real rather than
   read-only in practice.
5. **Check the billing contact** on the provider's own account page matches the register. A card
   that expires with nobody watching ends an integration as effectively as a lost password.

## What counts as a failure

- The backup custodian could not get in unaided.
- The recovery address is a personal mailbox, or only one person can read it.
- The second factor exists on exactly one device.
- The account is on a founder's personal identity with no `justification` and `migrateBy` in the
  register.
- The register and the provider's account page disagree about who the contacts are.

Each failure is fixed the same day and the register updated. A drill that finds nothing twice in a
row usually means it is being run by the person who already has access — swap who runs it.

## After a person leaves

Same day, before anything else: every access where they were custodian or backup gets a new second
person, every shared secret they could have read is rotated, and the drill is run for each. The
register's `custodian` and `backupCustodian` fields are the checklist for this — that is what they
are for.

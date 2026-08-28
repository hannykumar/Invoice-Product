# Contract: `platform-ports` v1.0.0-draft

| | |
| --- | --- |
| **Owner** | GPT 2 — issues #3 (identity and permissions) and #6 (approvals, audit, idempotency) |
| **Written by** | GPT 1 while #3 and #6 are unbuilt, so #4 could proceed. **This is a proposal, not GPT 2's final word.** |
| **Consumed by** | GPT 1 (#4, #9, #11, #12, #20), GPT 3 (#17, #45) |
| **Status** | **Mocked by GPT 1.** Mocks live in `packages/ledger/src/adapters/memory.ts`. |

GPT 2 may change any of this. When it does, the change lands in the port interfaces in
`packages/ledger/src/ports.ts` and nothing in the domain or the service moves, which is the whole
reason the ledger talks to ports rather than to a platform.

## 1. `ActorContext` — who is acting

```ts
interface ActorContext {
  companyId: CompanyId;          // the isolation boundary; never crossed
  branchId: BranchId | null;
  userId: UserId;
  permissions: readonly string[]; // resolved server-side for this company
}
```

Every command takes one. The ledger refuses to act on a record whose `companyId` differs from the
actor's, and it never reads `companyId` from the request body.

## 2. `PermissionPort` — issue #3

```ts
interface PermissionPort {
  require(actor: ActorContext, permission: string, what: string): void; // throws FORBIDDEN
}
```

Permissions the ledger requires:

| Permission | Guards |
| --- | --- |
| `ledger.setup` | Creating a company's chart of accounts and books start date |
| `ledger.post.sale` … `ledger.post.opening_balance` | Posting each voucher type |
| `ledger.post.locked_period` | Posting into a soft-locked month, with a reason |
| `ledger.reverse` | Undoing a final entry |
| `periods.lock`, `periods.reopen`, `periods.hard_lock` | Changing a month's state |

**Assumption for GPT 2 to confirm:** permissions are plain dot-separated strings resolved per
company before the command runs, and the ledger does not need to ask about roles.

## 3. `AuditPort` — issue #6

```ts
interface AuditEvent {
  companyId; actorId; at;          // ISO instant, UTC
  action;                          // "ledger.voucher_posted"
  subjectType; subjectId;
  summary;                         // one plain sentence
  details: Record<string, string>;
  overrideReason?: string;
}
interface AuditPort { record(event: AuditEvent): Promise<void>; }
```

Rules the ledger relies on: append-only, never deleted, and **never carrying a secret**. A test in
`packages/ledger/test/concurrency-and-isolation.test.ts` asserts no credential-shaped key reaches
an event.

**Assumption for GPT 2 to confirm:** audit writing may happen after the transaction commits. The
ledger currently records after commit so that an audit outage cannot block a legitimate posting.
If #6 requires the audit row inside the same transaction, the port gains a transactional variant
and `LedgerService` calls that instead.

## 4. `IdempotencyPort` — issue #6

```ts
interface IdempotencyPort {
  lookup(companyId: CompanyId, key: string): Promise<string | null>;
  remember(companyId: CompanyId, key: string, resultId: string): Promise<void>; // CONFLICT if taken
}
```

Behaviour the ledger depends on:

1. `lookup` and `remember` run inside the caller's transaction, so a rolled-back command frees its
   key. A key from a failed attempt must be reusable — there is a test for exactly this.
2. `remember` fails with a `CONFLICT` `DomainError` if the key already exists.
3. Keys are scoped per company. Two businesses can never collide.

The ledger additionally enforces `UNIQUE (company_id, idempotency_key)` on `voucher` in its own
migration, so a second entry is impossible even if the port is wrong.

## 5. `ApprovalPort` — issue #6, not yet consumed

The ledger does not call approvals. Approval happens before a document reaches the ledger, in the
owning module (#9 for sales, #17 for purchases). Recorded here so no one adds it to #4 by mistake.

## 6. What GPT 1 needs from GPT 2 to remove these mocks

| # | Need | Blocking |
| --- | --- | --- |
| 1 | Real `PermissionPort` from #3, with the permission strings above registered | #4 definition of done |
| 2 | Real `AuditPort` from #6, and a decision on transactional vs post-commit writing | #4 definition of done |
| 3 | Real `IdempotencyPort` from #6 with the rollback semantics in section 4 | #4 definition of done |
| 4 | Row-level security policies on the ledger tables from #3 | #4 security review |
| 5 | Migration runner and CI from #2 | Running `0001_ledger.sql` anywhere but by hand |

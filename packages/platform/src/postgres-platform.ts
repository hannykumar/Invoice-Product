/**
 * Issue #364 — the platform's own records in PostgreSQL: command records and idempotency keys,
 * the exception queue, members, sessions and invitations. The audit trail is in postgres-audit.ts.
 *
 * Each class mirrors its in-memory twin in platform.ts / auth.ts method for method, returning
 * promises; `test/platform-contract.ts` runs one suite against both. Every write runs in the
 * unit of work of #363: called inside a business action it joins that action's transaction, so
 * the command record, its idempotency key and its audit event commit with the bill or not at all.
 */
import { createHash, randomUUID } from "node:crypto";
import type { SqlExecutor, TransactionalExecutor } from "./database.ts";
import type { Invitation, Session } from "./auth.ts";
import { canonicalJson, riskRank, transitions, type Member } from "./platform.ts";
import { reviveJson, type PostgresAuditLog } from "./postgres-audit.ts";
import { PlatformError } from "./types.ts";
import type { ApprovalPolicy, CommandRecord, CommandStatus, ExceptionItem, Id, Permission, RequestContext } from "./types.ts";

type Row = Record<string, unknown>;
const digest = (raw: string): string => createHash("sha256").update(raw).digest("hex");
const iso = (value: unknown): string => (value as Date).toISOString();
const ms = (value: unknown): number => (value as Date).getTime();
const toCommand = (r: Row): CommandRecord => ({
  id: String(r.id), companyId: String(r.company_id), branchId: String(r.branch_id), actorId: String(r.actor_id), action: String(r.action),
  risk: r.risk as CommandRecord["risk"], ...(r.amount_paise === null ? {} : { amountPaise: BigInt(String(r.amount_paise)) }),
  status: r.status as CommandStatus, idempotencyKey: String(r.idempotency_key), payload: reviveJson(r.payload), createdAt: iso(r.created_at),
});
const COMMAND = "id, company_id, branch_id, actor_id, action, risk, amount_paise::text AS amount_paise, status, idempotency_key, payload, created_at";

export class PostgresCommandService {
  readonly #db: TransactionalExecutor;
  public readonly audit: PostgresAuditLog;
  readonly #policies: readonly ApprovalPolicy[];
  constructor(db: TransactionalExecutor, audit: PostgresAuditLog, policies: readonly ApprovalPolicy[] = []) { this.#db = db; this.audit = audit; this.#policies = policies; }

  create(context: RequestContext, input: Omit<CommandRecord, "id" | "companyId" | "branchId" | "actorId" | "status" | "createdAt">): Promise<CommandRecord> {
    if (!input.idempotencyKey.trim()) return Promise.reject(new PlatformError("IDEMPOTENCY_CONFLICT", "An idempotency key is required."));
    const payload = canonicalJson(input.payload);
    return this.#db.unitOfWork(context.companyId, async ({ sql }) => {
      const id = randomUUID();
      // Two servers receiving the same retry at once: one claims the key, the other waits here and then finds it taken.
      const claimed = await sql.query(
        `INSERT INTO idempotency_keys (company_id, action, key, payload_hash, result_json) VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (company_id, action, key) DO NOTHING RETURNING key`,
        [context.companyId, input.action, input.idempotencyKey, digest(payload), JSON.stringify({ commandId: id })],
      );
      if (claimed.rows.length === 0) {
        const existing = (await sql.query("SELECT payload_hash, result_json FROM idempotency_keys WHERE company_id = $1 AND action = $2 AND key = $3", [context.companyId, input.action, input.idempotencyKey])).rows[0] as Row;
        if (existing.payload_hash !== digest(payload)) throw new PlatformError("IDEMPOTENCY_CONFLICT", "This idempotency key was already used with different input.");
        return this.#find(sql, context, String((existing.result_json as { commandId: string }).commandId));
      }
      const { rows } = await sql.query(
        `INSERT INTO command_records (id, company_id, branch_id, actor_id, action, risk, amount_paise, status, idempotency_key, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', $8, $9::jsonb) RETURNING ${COMMAND}`,
        [id, context.companyId, context.branchId, context.actorId, input.action, input.risk, input.amountPaise?.toString() ?? null, input.idempotencyKey, payload],
      );
      const record = toCommand(rows[0] as Row);
      await this.audit.append({ companyId: context.companyId, actorId: context.actorId, action: `${record.action}.created`, correlationId: record.id, before: null, after: { status: record.status, payload: record.payload } });
      return record;
    });
  }

  get(context: RequestContext, id: Id): Promise<CommandRecord> { return this.#db.tenantTransaction(context.companyId, (sql) => this.#find(sql, context, id)); }

  transition(context: RequestContext, id: Id, next: CommandStatus, reason?: string): Promise<CommandRecord> {
    return this.#db.unitOfWork(context.companyId, async ({ sql }) => {
      const current = await this.#find(sql, context, id, "FOR UPDATE");
      if (!transitions[current.status].includes(next)) throw new PlatformError("INVALID_TRANSITION", `Cannot move ${current.status} to ${next}.`);
      const matching = this.#policies.filter((policy) => policy.action === current.action && riskRank[current.risk] >= riskRank[policy.minimumRisk] && (policy.minimumAmountPaise === undefined || (current.amountPaise ?? 0n) >= policy.minimumAmountPaise));
      if (next === "approved") for (const policy of matching) if (!context.permissions.has(policy.requiredPermission)) throw new PlatformError("FORBIDDEN", "You do not have permission to approve this action.");
      if (next === "finalised" && matching.length > 0 && current.status !== "approved") throw new PlatformError("APPROVAL_REQUIRED", "This action requires approval before it can be finalised.");
      const { rows } = await sql.query(`UPDATE command_records SET status = $3 WHERE company_id = $1 AND id = $2 RETURNING ${COMMAND}`, [context.companyId, id, next]);
      await this.audit.append({ companyId: context.companyId, actorId: context.actorId, action: `${current.action}.${next}`, correlationId: id, before: { status: current.status }, after: { status: next }, ...(reason ? { reason } : {}) });
      return toCommand(rows[0] as Row);
    });
  }

  /** Another company's command is "not found": its existence is not revealed (#340: company A asking for B's id gets 404). */
  async #find(sql: SqlExecutor, context: RequestContext, id: Id, lock = ""): Promise<CommandRecord> {
    const { rows } = await sql.query(`SELECT ${COMMAND} FROM command_records WHERE company_id = $1 AND id = $2 ${lock}`, [context.companyId, id]);
    if (rows[0] === undefined) throw new PlatformError("NOT_FOUND", "Command was not found.");
    return toCommand(rows[0]);
  }
}

export class PostgresExceptionQueue {
  readonly #db: TransactionalExecutor;
  readonly #audit: PostgresAuditLog | undefined;
  constructor(db: TransactionalExecutor, audit?: PostgresAuditLog) { this.#db = db; this.#audit = audit; }

  create(context: RequestContext, summary: string, evidence: readonly string[]): Promise<ExceptionItem> {
    if (!summary.trim() || evidence.length === 0) return Promise.reject(new Error("Exceptions need a summary and supporting evidence."));
    return this.#db.unitOfWork(context.companyId, async ({ sql }) => {
      const id = randomUUID();
      await sql.query("INSERT INTO exception_items (id, company_id, status, summary, evidence) VALUES ($1, $2, 'open', $3, $4::jsonb)", [id, context.companyId, summary, JSON.stringify(evidence)]);
      await this.#audit?.append({ companyId: context.companyId, actorId: context.actorId, action: "exception.created", correlationId: id, before: null, after: { status: "open", summary, evidence: [...evidence] } });
      return this.#find(sql, context, id);
    });
  }

  get(context: RequestContext, id: Id): Promise<ExceptionItem> { return this.#db.tenantTransaction(context.companyId, (sql) => this.#find(sql, context, id)); }

  /** The held items of one company, oldest first: what is still waiting for a person after a restart. */
  async open(context: RequestContext): Promise<ExceptionItem[]> {
    return this.#db.tenantTransaction(context.companyId, async (sql) => {
      const { rows } = await sql.query("SELECT id FROM exception_items WHERE company_id = $1 AND status = 'open' ORDER BY created_at, id", [context.companyId]);
      const items: ExceptionItem[] = [];
      for (const row of rows) items.push(await this.#find(sql, context, String(row.id)));
      return items;
    });
  }

  comment(context: RequestContext, id: Id, body: string): Promise<ExceptionItem> {
    if (!body.trim()) return Promise.reject(new Error("Exception comments cannot be empty."));
    return this.#db.unitOfWork(context.companyId, async ({ sql }) => {
      await this.#find(sql, context, id);
      await sql.query("INSERT INTO exception_comments (id, exception_id, actor_id, body) VALUES ($1, $2, $3, $4)", [randomUUID(), id, context.actorId, body]);
      await this.#audit?.append({ companyId: context.companyId, actorId: context.actorId, action: "exception.commented", correlationId: id, before: null, after: { comment: body } });
      return this.#find(sql, context, id);
    });
  }

  resolve(context: RequestContext, id: Id): Promise<ExceptionItem> {
    return this.#db.unitOfWork(context.companyId, async ({ sql }) => {
      const current = await this.#find(sql, context, id);
      await sql.query("UPDATE exception_items SET status = 'resolved' WHERE company_id = $1 AND id = $2", [context.companyId, id]);
      await this.#audit?.append({ companyId: context.companyId, actorId: context.actorId, action: "exception.resolved", correlationId: id, before: { status: current.status }, after: { status: "resolved" } });
      return this.#find(sql, context, id);
    });
  }

  async #find(sql: SqlExecutor, context: RequestContext, id: Id): Promise<ExceptionItem> {
    const { rows } = await sql.query("SELECT id, company_id, status, summary, evidence FROM exception_items WHERE company_id = $1 AND id = $2", [context.companyId, id]);
    const row = rows[0];
    if (row === undefined) throw new PlatformError("NOT_FOUND", "Exception was not found.");
    const comments = await sql.query("SELECT actor_id, body, created_at FROM exception_comments WHERE exception_id = $1 ORDER BY seq", [id]);
    return {
      id: String(row.id), companyId: String(row.company_id), status: row.status as ExceptionItem["status"], summary: String(row.summary), evidence: row.evidence as string[],
      comments: comments.rows.map((c) => ({ actorId: String(c.actor_id), body: String(c.body), createdAt: iso(c.created_at) })),
    };
  }
}

export class PostgresAccessControl {
  readonly #db: TransactionalExecutor;
  constructor(db: TransactionalExecutor) { this.#db = db; }

  grant(member: Member): Promise<void> {
    return this.#db.unitOfWork(member.companyId, async ({ sql }) => {
      await sql.query(
        `INSERT INTO memberships (company_id, user_id, permissions, active) VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (company_id, user_id) DO UPDATE SET permissions = EXCLUDED.permissions, active = EXCLUDED.active`,
        [member.companyId, member.userId, JSON.stringify([...member.permissions]), member.active],
      );
      await sql.query("DELETE FROM user_branch_access WHERE company_id = $1 AND user_id = $2", [member.companyId, member.userId]);
      for (const branchId of member.branchIds) await sql.query("INSERT INTO user_branch_access (company_id, user_id, branch_id) VALUES ($1, $2, $3)", [member.companyId, member.userId, branchId]);
    });
  }

  revoke(companyId: Id, userId: Id): Promise<void> {
    return this.#db.unitOfWork(companyId, async ({ sql }) => { await sql.query("UPDATE memberships SET active = false WHERE company_id = $1 AND user_id = $2", [companyId, userId]); });
  }

  async members(companyId: Id): Promise<readonly Member[]> {
    const { rows } = await this.#db.tenantTransaction(companyId, (sql) => sql.query(
      `SELECT m.user_id, m.permissions, m.active,
              COALESCE((SELECT jsonb_agg(a.branch_id) FROM user_branch_access a WHERE a.company_id = m.company_id AND a.user_id = m.user_id), '[]') AS branch_ids
         FROM memberships m WHERE m.company_id = $1 ORDER BY m.user_id`,
      [companyId],
    ));
    return rows.map((r) => ({ userId: String(r.user_id), companyId, branchIds: new Set(r.branch_ids as string[]), active: Boolean(r.active), permissions: new Set(r.permissions as Permission[]) }));
  }

  async context(companyId: Id, branchId: Id, userId: Id, sessionId: Id): Promise<RequestContext> {
    const member = (await this.members(companyId)).find((m) => m.userId === userId);
    if (!member || !member.active || !member.branchIds.has(branchId)) throw new PlatformError("SESSION_REVOKED", "Your access is no longer active.");
    return { companyId, branchId, actorId: userId, sessionId, permissions: member.permissions };
  }
}

const at = (millis: number): string => new Date(millis).toISOString();
const toSession = (r: Row): Session => ({ id: String(r.id), userId: String(r.user_id), companyId: String(r.company_id), branchId: String(r.branch_id), expiresAt: ms(r.expires_at), ...(r.revoked_at === null ? {} : { revokedAt: ms(r.revoked_at) }) });
const toInvitation = (r: Row): Invitation => ({
  id: String(r.id), companyId: String(r.company_id), branchId: String(r.branch_id), email: String(r.email), permissions: new Set(r.permissions as Permission[]), expiresAt: ms(r.expires_at),
  ...(r.accepted_at === null ? {} : { acceptedAt: ms(r.accepted_at) }), ...(r.revoked_at === null ? {} : { revokedAt: ms(r.revoked_at) }),
});

export class PostgresAuthenticationService {
  readonly #db: TransactionalExecutor;
  readonly #access: PostgresAccessControl;
  readonly #now: () => number;
  constructor(db: TransactionalExecutor, access: PostgresAccessControl, now: () => number = Date.now) { this.#db = db; this.#access = access; this.#now = now; }

  async invite(actor: RequestContext, email: string, permissions: ReadonlySet<Permission>, expiresInMs = 7 * 24 * 60 * 60 * 1000): Promise<{ invitation: Invitation; token: string }> {
    if (!actor.permissions.has("access.review")) throw new PlatformError("FORBIDDEN", "You do not have permission to review access.");
    const token = randomUUID();
    // Only the token's hash is stored; the token itself exists once, in the reply to the person who invited.
    const { rows } = await this.#db.unitOfWork(actor.companyId, ({ sql }) => sql.query(
      "INSERT INTO invitations (id, token_hash, company_id, branch_id, email, permissions, expires_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING *",
      [randomUUID(), digest(token), actor.companyId, actor.branchId, email.toLowerCase(), JSON.stringify([...permissions]), at(this.#now() + expiresInMs)],
    ));
    return { invitation: toInvitation(rows[0] as Row), token };
  }

  async acceptInvitation(token: string, userId: Id): Promise<Invitation> {
    // Looked up before the company is known: the token is the only thing the invited person has.
    const found = (await this.#db.query("SELECT company_id FROM invitations WHERE token_hash = $1", [digest(token)])).rows[0];
    if (found === undefined) throw new Error("INVALID_INVITATION");
    return this.#db.unitOfWork(String(found.company_id), async ({ sql }) => {
      // One statement decides it, so an invitation pressed twice at once is accepted once.
      const { rows } = await sql.query(
        "UPDATE invitations SET accepted_at = $2 WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > $2 RETURNING *",
        [digest(token), at(this.#now())],
      );
      if (rows[0] === undefined) throw new Error("INVALID_INVITATION");
      const accepted = toInvitation(rows[0]);
      await this.#access.grant({ userId, companyId: accepted.companyId, branchIds: new Set([accepted.branchId]), active: true, permissions: accepted.permissions });
      return accepted;
    });
  }

  async createSession(companyId: Id, branchId: Id, userId: Id, ttlMs = 8 * 60 * 60 * 1000): Promise<Session> {
    const { rows } = await this.#db.unitOfWork(companyId, ({ sql }) => sql.query(
      "INSERT INTO sessions (id, company_id, branch_id, user_id, expires_at) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [randomUUID(), companyId, branchId, userId, at(this.#now() + ttlMs)],
    ));
    return toSession(rows[0] as Row);
  }

  async authenticate(sessionId: Id): Promise<RequestContext> {
    // The company comes from the stored session, never from the caller (rule 6).
    const row = /^[0-9a-f-]{36}$/i.test(sessionId) ? (await this.#db.query("SELECT * FROM sessions WHERE id = $1", [sessionId])).rows[0] : undefined;
    const session = row === undefined ? undefined : toSession(row);
    if (!session || session.revokedAt !== undefined || session.expiresAt <= this.#now()) throw new PlatformError("SESSION_EXPIRED", "SESSION_EXPIRED: Sign in again.");
    return this.#access.context(session.companyId, session.branchId, session.userId, session.id);
  }

  async revokeSession(sessionId: Id): Promise<void> {
    const row = (await this.#db.query("SELECT company_id FROM sessions WHERE id = $1", [sessionId])).rows[0];
    if (row === undefined) return;
    await this.#db.unitOfWork(String(row.company_id), async ({ sql }) => { await sql.query("UPDATE sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL", [sessionId, at(this.#now())]); });
  }

  /** Access and every open session end together, in one transaction. */
  revokeMember(companyId: Id, userId: Id): Promise<void> {
    return this.#db.unitOfWork(companyId, async ({ sql }) => {
      await this.#access.revoke(companyId, userId);
      await sql.query("UPDATE sessions SET revoked_at = $3 WHERE company_id = $1 AND user_id = $2 AND revoked_at IS NULL", [companyId, userId, at(this.#now())]);
    });
  }

  review(companyId: Id): Promise<readonly Member[]> { return this.#access.members(companyId); }
}

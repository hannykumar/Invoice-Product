/**
 * Issue #363 — sends what an action queued with `uow.enqueue`, only once that action has committed.
 *
 * A row is claimed with a lease and a claim token, the handler runs outside any transaction (a slow
 * government portal never holds the company lock), and the handler's result is saved in the same
 * unit of work that marks the row sent — but only while the claim token still matches, so a relay
 * whose lease lapsed cannot overwrite the one that took over. Delivery is at least once: handlers
 * must be idempotent on `dedupeKey`. The scheduled worker that calls `drain` is #345.
 */
import { randomUUID } from "node:crypto";
import { outsideUnitOfWork, type TransactionalExecutor, type UnitOfWork } from "./database.ts";

export interface OutboxMessage {
  readonly id: string;
  readonly companyId: string;
  readonly topic: string;
  readonly dedupeKey: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
}

/** Calls out. May return a `save` step, which runs in the unit of work that marks the message sent. */
export type OutboxHandler = (message: OutboxMessage, signal: AbortSignal) => Promise<void | ((uow: UnitOfWork) => Promise<void>)>;

export class OutboxRelay {
  readonly #db: TransactionalExecutor;
  readonly #leaseSeconds: number;
  readonly #maxAttempts: number;

  constructor(db: TransactionalExecutor, options: { leaseSeconds?: number; maxAttempts?: number } = {}) {
    this.#db = db;
    this.#leaseSeconds = options.leaseSeconds ?? 60;
    this.#maxAttempts = options.maxAttempts ?? 10;
  }

  /** Sends this company's due messages for the given topics. Never joins the caller's transaction. */
  drain(companyId: string, handlers: Readonly<Record<string, OutboxHandler>>, limit = 20): Promise<{ sent: number; failed: number }> {
    return outsideUnitOfWork(async () => {
      const token = randomUUID();
      const claimed = await this.#db.tenantTransaction(companyId, (sql) => sql.query(
        `UPDATE outbox_messages SET claim_token = $2, attempts = attempts + 1, updated_at = now(),
                available_at = now() + make_interval(secs => $3)
          WHERE id IN (SELECT id FROM outbox_messages
                        WHERE company_id = $1 AND sent_at IS NULL AND dead_at IS NULL AND available_at <= now()
                          AND topic = ANY($4::text[])
                        ORDER BY created_at, id LIMIT $5 FOR UPDATE SKIP LOCKED)
          RETURNING id, topic, dedupe_key, payload, attempts, created_at`,
        [companyId, token, this.#leaseSeconds, Object.keys(handlers), limit],
      ));
      const messages = claimed.rows
        .sort((a, b) => (a.created_at as Date).getTime() - (b.created_at as Date).getTime())
        .map((r): OutboxMessage => ({
          id: String(r.id), companyId, topic: String(r.topic), dedupeKey: String(r.dedupe_key),
          payload: r.payload as Record<string, unknown>, attempts: Number(r.attempts),
        }));
      let sent = 0;
      let failed = 0;
      for (const message of messages) {
        try {
          // Gives up before the lease ends, so a second relay never sends while this one still is.
          const signal = AbortSignal.timeout((this.#leaseSeconds * 1000) / 2);
          const aborted = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
          const save = await Promise.race([(handlers[message.topic] as OutboxHandler)(message, signal), aborted]);
          await this.#db.unitOfWork(companyId, async (uow) => {
            if (typeof save === "function") await save(uow);
            const marked = await uow.sql.query(
              `UPDATE outbox_messages SET sent_at = now(), claim_token = NULL, last_error = NULL, updated_at = now()
                WHERE id = $1 AND claim_token = $2 RETURNING id`,
              [message.id, token],
            );
            if (marked.rows.length === 0) throw new Error("Another relay took this message over after its lease ran out.");
          });
          sent += 1;
        } catch (error) {
          failed += 1;
          // Exponential back-off, capped at an hour; after maxAttempts the row stays, marked dead, for a person to see.
          await this.#db.tenantTransaction(companyId, (sql) => sql.query(
            `UPDATE outbox_messages
                SET claim_token = NULL, last_error = left($3, 500), updated_at = now(),
                    available_at = now() + make_interval(secs => least(3600, 30 * power(2, attempts - 1))),
                    dead_at = CASE WHEN attempts >= $4 THEN now() END
              WHERE id = $1 AND claim_token = $2`,
            [message.id, token, error instanceof Error ? error.message : String(error), this.#maxAttempts],
          ));
        }
      }
      return { sent, failed };
    });
  }
}

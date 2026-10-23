// Issue #389 — callbacks taken delivery of, kept in PostgreSQL (`government_webhook_events`,
// `government_webhook_rejections`, migration `…_government_webhook_events`).
//
// The unique index on (connector, event_id) is what makes deduplication survive a restart: a
// provider resending an acknowledgement the day after a deploy still gets `DUPLICATE`. A callback
// arrives with no session and no company, so these run on their own short statements rather than
// inside a company's unit of work.

import type { CompanyId } from '@invoice/kernel';
import type { SqlExecutor } from '../../platform/src/database.ts';
import type { WebhookEventRecord, WebhookEventRepository } from './ports.ts';

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));

export class PostgresWebhookEvents implements WebhookEventRepository {
  readonly #db: SqlExecutor;

  constructor(db: SqlExecutor) {
    this.#db = db;
  }

  async find(kind: string, eventId: string): Promise<WebhookEventRecord | null> {
    const row = (await this.#db.query(
      `SELECT connector, event_id, provider_request_id, received_at, call_id::text AS call_id, company_id::text AS company_id, outcome, government_reference
         FROM government_webhook_events WHERE connector = $1 AND event_id = $2`,
      [kind, eventId],
    )).rows[0];
    if (row === undefined) return null;
    return {
      kind: String(row.connector),
      eventId: String(row.event_id),
      providerRequestId: String(row.provider_request_id),
      receivedAt: iso(row.received_at),
      callId: row.call_id === null ? null : String(row.call_id),
      companyId: row.company_id === null ? null : (String(row.company_id) as CompanyId),
      outcome: String(row.outcome),
      governmentReference: row.government_reference === null ? null : String(row.government_reference),
    };
  }

  /** A second delivery racing the first is not an error: the first one written is the record. */
  async insert(record: WebhookEventRecord): Promise<void> {
    await this.#db.query(
      `INSERT INTO government_webhook_events (connector, event_id, provider_request_id, call_id, company_id, outcome, government_reference, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (connector, event_id) DO NOTHING`,
      [record.kind, record.eventId, record.providerRequestId, record.callId, record.companyId, record.outcome, record.governmentReference, record.receivedAt],
    );
  }

  async recordRejected(input: { readonly kind: string; readonly digest: string; readonly at: string; readonly reason: string }): Promise<void> {
    await this.#db.query(
      'INSERT INTO government_webhook_rejections (connector, digest, reason, received_at) VALUES ($1, $2, $3, $4)',
      [input.kind, input.digest, input.reason, input.at],
    );
  }

  async listRejected(): Promise<readonly { readonly kind: string; readonly digest: string; readonly reason: string }[]> {
    const rows = (await this.#db.query('SELECT connector, digest, reason FROM government_webhook_rejections ORDER BY received_at, id')).rows;
    return rows.map((row) => ({ kind: String(row.connector), digest: String(row.digest), reason: String(row.reason) }));
  }
}

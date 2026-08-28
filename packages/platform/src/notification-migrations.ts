import type { Migration } from "./migration-definitions.ts";

export const notificationMigrations: readonly Migration[] = [{
  id: "0007_notification_infrastructure",
  up: `
    CREATE TABLE notification_preferences (company_id uuid NOT NULL REFERENCES companies(id), recipient_id text NOT NULL, channel text NOT NULL CHECK (channel IN ('in_app','email','whatsapp','sms')), enabled boolean NOT NULL DEFAULT true, quiet_from_hour smallint, quiet_to_hour smallint, PRIMARY KEY(company_id, recipient_id, channel));
    CREATE TABLE notifications (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), recipient_id text NOT NULL, channel text NOT NULL, template text NOT NULL, locale text NOT NULL, payload jsonb NOT NULL, deduplication_key text NOT NULL, scheduled_at timestamptz NOT NULL, status text NOT NULL CHECK (status IN ('scheduled','delivered','failed','suppressed')), attempts integer NOT NULL DEFAULT 0, last_error text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(company_id, deduplication_key));
    CREATE TABLE notification_delivery_events (id uuid PRIMARY KEY, notification_id uuid NOT NULL REFERENCES notifications(id), company_id uuid NOT NULL REFERENCES companies(id), event_type text NOT NULL CHECK (event_type IN ('scheduled','suppressed','delivered','failed','opened')), detail text, occurred_at timestamptz NOT NULL DEFAULT now());
    CREATE INDEX notifications_due_idx ON notifications(company_id, status, scheduled_at);
    CREATE INDEX notification_events_timeline_idx ON notification_delivery_events(company_id, notification_id, occurred_at);
  `,
  down: `DROP TABLE IF EXISTS notification_delivery_events; DROP TABLE IF EXISTS notifications; DROP TABLE IF EXISTS notification_preferences;`,
}, {
  id: "0008_notification_policy",
  up: `
    ALTER TABLE notification_preferences ADD COLUMN time_zone text NOT NULL DEFAULT 'UTC';
    ALTER TABLE notifications ADD COLUMN recipient_role text NOT NULL DEFAULT 'customer' CHECK (recipient_role IN ('owner','accountant','staff','customer'));
    ALTER TABLE notifications ADD COLUMN sensitivity text NOT NULL DEFAULT 'public' CHECK (sensitivity IN ('public','internal','restricted'));
    ALTER TABLE notification_delivery_events ADD COLUMN actor_id text NOT NULL DEFAULT 'system';
  `,
  down: `ALTER TABLE notification_delivery_events DROP COLUMN actor_id; ALTER TABLE notifications DROP COLUMN sensitivity; ALTER TABLE notifications DROP COLUMN recipient_role; ALTER TABLE notification_preferences DROP COLUMN time_zone;`,
}];

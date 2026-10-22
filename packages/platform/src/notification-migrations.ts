import type { Migration } from "./migration-definitions.ts";

const NOTIFICATION_TABLES = ["notifications", "notification_delivery_events", "notification_preferences"] as const;

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
}, {
  // Issue #366 — what PostgresNotificationStore (postgres-notifications.ts) needs, and the rules of
  // docs/contracts/database-immutability-v1.md for these three tables.
  id: "20261016T014428445Z_platform_8f4c9566fc43_notifications_postgres_store",
  up: `
    -- The order of writing: the delivery pass and the event timeline page by it.
    ALTER TABLE notifications ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
    ALTER TABLE notification_delivery_events ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
    CREATE UNIQUE INDEX notifications_company_seq_idx ON notifications(company_id, seq);
    CREATE INDEX notifications_due_seq_idx ON notifications(company_id, seq) WHERE status = 'scheduled';
    DROP INDEX notifications_due_idx;
    DROP INDEX notification_events_timeline_idx;
    CREATE INDEX notification_events_timeline_idx ON notification_delivery_events(company_id, notification_id, seq);

    -- An event can only belong to a notification of its own company.
    CREATE UNIQUE INDEX notifications_company_id_idx ON notifications(company_id, id);
    ALTER TABLE notification_delivery_events ADD CONSTRAINT notification_delivery_events_same_company_fk
      FOREIGN KEY (company_id, notification_id) REFERENCES notifications(company_id, id);
    ALTER TABLE notification_delivery_events DROP CONSTRAINT notification_delivery_events_notification_id_fkey;

    -- The record keeps every field the service holds.
    ALTER TABLE notifications ADD CONSTRAINT notifications_channel_check CHECK (channel IN ('in_app','email','whatsapp','sms'));
    ALTER TABLE notifications ADD CONSTRAINT notifications_locale_check CHECK (locale IN ('en-IN','hi-IN'));
    ALTER TABLE notifications ADD CONSTRAINT notifications_attempts_check CHECK (attempts >= 0);
    ALTER TABLE notification_preferences ADD CONSTRAINT notification_preferences_hours_check
      CHECK (quiet_from_hour BETWEEN 0 AND 23 AND quiet_to_hour BETWEEN 0 AND 23);
    -- No time zone given is not the same as UTC chosen; the service reads an absent one as UTC.
    ALTER TABLE notification_preferences ALTER COLUMN time_zone DROP NOT NULL, ALTER COLUMN time_zone DROP DEFAULT;

    -- A delivered or suppressed notification is finished; the timeline is append-only.
    CREATE TRIGGER notifications_frozen BEFORE UPDATE OR DELETE ON notifications
      FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('status', 'delivered,suppressed', '', '');
    CREATE TRIGGER notifications_no_truncate BEFORE TRUNCATE ON notifications
      FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();
    CREATE TRIGGER notification_delivery_events_frozen BEFORE UPDATE OR DELETE ON notification_delivery_events
      FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('', '*', '', '');
    CREATE TRIGGER notification_delivery_events_no_truncate BEFORE TRUNCATE ON notification_delivery_events
      FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();
${NOTIFICATION_TABLES.map((table) => `
    ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
    CREATE POLICY ${table}_tenant ON ${table}
      USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);`).join("")}
  `,
  down: `
${NOTIFICATION_TABLES.map((table) => `
    DROP POLICY IF EXISTS ${table}_tenant ON ${table};
    ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;`).join("")}
    DROP TRIGGER notification_delivery_events_no_truncate ON notification_delivery_events;
    DROP TRIGGER notification_delivery_events_frozen ON notification_delivery_events;
    DROP TRIGGER notifications_no_truncate ON notifications;
    DROP TRIGGER notifications_frozen ON notifications;
    UPDATE notification_preferences SET time_zone = 'UTC' WHERE time_zone IS NULL;
    ALTER TABLE notification_preferences ALTER COLUMN time_zone SET DEFAULT 'UTC', ALTER COLUMN time_zone SET NOT NULL;
    ALTER TABLE notification_preferences DROP CONSTRAINT notification_preferences_hours_check;
    ALTER TABLE notifications DROP CONSTRAINT notifications_attempts_check;
    ALTER TABLE notifications DROP CONSTRAINT notifications_locale_check;
    ALTER TABLE notifications DROP CONSTRAINT notifications_channel_check;
    ALTER TABLE notification_delivery_events ADD CONSTRAINT notification_delivery_events_notification_id_fkey
      FOREIGN KEY (notification_id) REFERENCES notifications(id);
    ALTER TABLE notification_delivery_events DROP CONSTRAINT notification_delivery_events_same_company_fk;
    DROP INDEX notifications_company_id_idx;
    DROP INDEX notification_events_timeline_idx;
    CREATE INDEX notification_events_timeline_idx ON notification_delivery_events(company_id, notification_id, occurred_at);
    CREATE INDEX notifications_due_idx ON notifications(company_id, status, scheduled_at);
    DROP INDEX notifications_due_seq_idx;
    DROP INDEX notifications_company_seq_idx;
    ALTER TABLE notification_delivery_events DROP COLUMN seq;
    ALTER TABLE notifications DROP COLUMN seq;
  `,
}];

import type { Migration } from "./migration-definitions.ts";

/**
 * Issue #340 — what the running app keeps per company that no module has a table for yet: business
 * details, branding, the item rates a business declared, and the frozen print copy of each issued
 * bill and note. One row per record, scoped to its company like every other tenant table.
 *
 * A `frozen` row is a copy of a document as it was issued: the database refuses to change or
 * delete it, so a reprint always shows what the customer was given (rule 2). A record that is
 * taken away (a UPI id removed) keeps its row with a null value.
 *
 * ponytail: one jsonb table for about a dozen small app-level stores. Each moves to a table of its
 * own when its module grows one; the kind names say which rows to move.
 */
export const appRecordMigrations: readonly Migration[] = [{
  id: "20261016T064205274Z_api_4b8da552ccf1_durable_app_records",
  up: `
    CREATE TABLE app_records (
      company_id uuid NOT NULL REFERENCES companies(id),
      kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]*$'),
      key text NOT NULL CHECK (key <> ''),
      value jsonb NOT NULL,
      frozen boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (company_id, kind, key)
    );
    ALTER TABLE app_records ENABLE ROW LEVEL SECURITY;
    ALTER TABLE app_records FORCE ROW LEVEL SECURITY;
    CREATE POLICY app_records_tenant ON app_records
      USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
    CREATE FUNCTION app_records_keep_frozen() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
    BEGIN
      IF OLD.frozen THEN
        RAISE EXCEPTION 'This is the copy of a document as it was issued. It cannot be changed or removed.' USING ERRCODE = 'P0001';
      END IF;
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END $fn$;
    CREATE TRIGGER app_records_keep_frozen BEFORE UPDATE OR DELETE ON app_records FOR EACH ROW EXECUTE FUNCTION app_records_keep_frozen();
    -- No DELETE (#368): taking a record away stores null in its place, and nothing is ever removed.
    GRANT SELECT, INSERT, UPDATE ON app_records TO invoice_app;
  `,
  down: `
    DROP TABLE IF EXISTS app_records;
    DROP FUNCTION IF EXISTS app_records_keep_frozen();
  `,
}];

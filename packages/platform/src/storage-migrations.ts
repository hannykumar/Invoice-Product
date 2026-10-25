import type { Migration } from "./migration-definitions.ts";

/**
 * Issue #341 — the facts about each stored file; the file itself is in private object storage
 * (`storage.ts`). A row is never deleted: a file the screening refused stays, quarantined, with its
 * reason, so the owner can see what was sent and why it was held.
 */
export const storageMigrations: readonly Migration[] = [{
  id: "20261022T170819361Z_platform_151e31495cfd_stored_files",
  up: `
    CREATE TABLE stored_files (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      purpose text NOT NULL CHECK (purpose IN ('purchase_bill', 'branding_logo')),
      object_key text NOT NULL UNIQUE CHECK (object_key LIKE company_id::text || '/' || purpose || '/%'),
      file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200),
      declared_type text NOT NULL,
      declared_bytes bigint NOT NULL CHECK (declared_bytes > 0),
      state text NOT NULL CHECK (state IN ('pending', 'available', 'quarantined')),
      detected_type text,
      size_bytes bigint CHECK (size_bytes >= 0),
      quarantine_reason text,
      quarantine_message text,
      uploaded_by uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (company_id, id),
      CHECK (state <> 'available' OR (detected_type IS NOT NULL AND size_bytes IS NOT NULL)),
      CHECK (state <> 'quarantined' OR quarantine_reason IS NOT NULL)
    );
    CREATE INDEX stored_files_company_purpose_idx ON stored_files (company_id, purpose, created_at DESC);
    CREATE INDEX stored_files_uploaded_by_idx ON stored_files (uploaded_by);
    ALTER TABLE stored_files ENABLE ROW LEVEL SECURITY;
    ALTER TABLE stored_files FORCE ROW LEVEL SECURITY;
    CREATE POLICY stored_files_tenant ON stored_files
      USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
    -- Only the screening's outcome may change, and only once: pending to available or quarantined.
    CREATE FUNCTION stored_files_screen_once() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
    BEGIN
      IF OLD.state <> 'pending' OR (NEW.id, NEW.company_id, NEW.purpose, NEW.object_key, NEW.file_name, NEW.declared_type, NEW.declared_bytes, NEW.uploaded_by, NEW.created_at)
         IS DISTINCT FROM (OLD.id, OLD.company_id, OLD.purpose, OLD.object_key, OLD.file_name, OLD.declared_type, OLD.declared_bytes, OLD.uploaded_by, OLD.created_at) THEN
        RAISE EXCEPTION 'A stored file is screened once; its record is not changed after that.' USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END $fn$;
    CREATE TRIGGER stored_files_screen_once BEFORE UPDATE ON stored_files FOR EACH ROW EXECUTE FUNCTION stored_files_screen_once();
    GRANT SELECT, INSERT, UPDATE ON stored_files TO invoice_app;
  `,
  down: `
    DROP TABLE IF EXISTS stored_files;
    DROP FUNCTION IF EXISTS stored_files_screen_once();
  `,
}];

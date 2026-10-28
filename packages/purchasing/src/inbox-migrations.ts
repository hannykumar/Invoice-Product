// Issue #366 — the purchase inbox's tables (#15, inbox.ts and inbox-store.ts). Lane owner: GPT 3.
//
// Only documents already routed to a company are stored: a document is written in that company's
// unit of work, under that company's row-level security. Attachments are references and measured
// metadata (object-storage key, name, size, SHA-256): the file bytes never come here.
//
// Nothing is ever deleted: a duplicate is `discarded`, an unsafe or doubtful one `quarantined`.
// Once a document reaches `draft_ready` or `discarded` the service never moves it again, so the
// database freezes it there (docs/contracts/database-immutability-v1.md). The status moves the
// service makes before that, all on unfrozen rows:
//   screening → discarded (a file this company already has)
//   screening | failed → extracting → quarantined | failed | draft_ready
//   quarantined (COMPANY_MISMATCH) → received (claimed by a person, assignCompany)
// Drafts and content claims are final when written.

import type { Migration } from "../../platform/src/migration-definitions.ts";
import { enforceTenant, releaseTenant } from "./tenant-policy.ts";

const TABLES = ["purchase_inbox_documents", "purchase_inbox_contents", "purchase_inbox_drafts"];
const DECISION_TABLES = ["purchase_inbox_decisions"];

const noTruncate = (table: string): string => `
    CREATE TRIGGER ${table}_no_truncate BEFORE TRUNCATE ON ${table}
      FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();`;

export const purchaseInboxMigrations: readonly Migration[] = Object.freeze([{
  id: "20261025T110049495Z_purchasing_5fb63110524b_inbox_documents",
  up: `
    CREATE TABLE purchase_inbox_documents (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      branch_id text,
      channel text NOT NULL CHECK (channel IN ('manual_upload','camera','email','whatsapp','einvoice_json','api')),
      -- Who sent it, as the channel reported it (address, display name, provider message id).
      sender jsonb NOT NULL CHECK (jsonb_typeof(sender) = 'object'),
      attachment_id text NOT NULL,
      file_name text NOT NULL,
      declared_mime_type text NOT NULL,
      -- Measured from the bytes at intake (#401), never the sender's claim.
      size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
      sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      -- Where the file is in private object storage. The bytes are not kept in the database.
      storage_key text NOT NULL,
      page_count integer CHECK (page_count > 0),
      received_at timestamptz NOT NULL,
      status text NOT NULL CHECK (status IN ('received','screening','quarantined','extracting','draft_ready','failed','discarded')),
      quarantine_reason text CHECK (quarantine_reason IN ('UNSUPPORTED_FILE_TYPE','FILE_TYPE_MISMATCH','FILE_TOO_LARGE','PASSWORD_PROTECTED',
        'ACTIVE_CONTENT','MALWARE_SUSPECTED','AWAITING_SCAN','COMPANY_NOT_IDENTIFIED','COMPANY_MISMATCH','NOT_AN_INVOICE','UNREADABLE',
        'EXTRACTION_TOO_UNCERTAIN','SIGNATURE_INVALID')),
      status_message text,
      duplicate_of_id uuid,
      attempts integer NOT NULL CHECK (attempts >= 1),
      -- How the company was decided (#400), so a wrong routing can be explained.
      routing jsonb CHECK (routing IS NULL OR jsonb_typeof(routing) = 'object'),
      -- #406: channel, delivery scope (uploader's company or the address delivered to), provider
      -- message id and the file's SHA-256, as inbox.ts builds it. NULL when there was no message id.
      message_key text CHECK (message_key <> ''),
      intake_key text NOT NULL CHECK (intake_key <> ''),
      -- A hold always says why, and only a hold does.
      CHECK ((status = 'quarantined') = (quarantine_reason IS NOT NULL)),
      CHECK ((status = 'discarded') OR duplicate_of_id IS NULL),
      -- The target of the composite keys below, so a link never crosses companies.
      UNIQUE (company_id, id),
      -- #406: one document per redelivered message, even when two arrive at the same moment.
      CONSTRAINT purchase_inbox_documents_message_once UNIQUE (company_id, message_key),
      FOREIGN KEY (company_id, duplicate_of_id) REFERENCES purchase_inbox_documents(company_id, id)
    );
    -- The inbox list, oldest first, and its keyset page (received_at, id).
    CREATE INDEX purchase_inbox_documents_list_idx ON purchase_inbox_documents(company_id, received_at, id);
    -- The inbox filtered by one status ("waiting for review", "held"), in the same order.
    CREATE INDEX purchase_inbox_documents_status_idx ON purchase_inbox_documents(company_id, status, received_at, id);

    -- Which document of a company first held a file: the attachment-level duplicate check of #15.
    -- The primary key refuses a second claim on the same file, however many arrive at once.
    CREATE TABLE purchase_inbox_contents (
      company_id uuid NOT NULL REFERENCES companies(id),
      sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      document_id uuid NOT NULL,
      PRIMARY KEY (company_id, sha256),
      FOREIGN KEY (company_id, document_id) REFERENCES purchase_inbox_documents(company_id, id)
    );

    -- What the document appears to say, for a person to review. Never a posting.
    CREATE TABLE purchase_inbox_drafts (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      document_id uuid NOT NULL,
      source text NOT NULL CHECK (source IN ('einvoice_json','ocr','manual')),
      -- Every extracted field with its confidence and evidence; paise kept as exact strings.
      body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
      created_at timestamptz NOT NULL,
      FOREIGN KEY (company_id, document_id) REFERENCES purchase_inbox_documents(company_id, id),
      -- One draft per document; also the lookup from a document to its draft.
      UNIQUE (company_id, document_id)
    );

    CREATE TRIGGER purchase_inbox_documents_frozen BEFORE UPDATE OR DELETE ON purchase_inbox_documents
      FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('status', 'draft_ready,discarded', '', '');
    CREATE TRIGGER purchase_inbox_contents_frozen BEFORE UPDATE OR DELETE ON purchase_inbox_contents
      FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('', '*', '', '');
    CREATE TRIGGER purchase_inbox_drafts_frozen BEFORE UPDATE OR DELETE ON purchase_inbox_drafts
      FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('', '*', '', '');
    ${TABLES.map(noTruncate).join("")}
    ${enforceTenant(TABLES)}
    -- What arrived never changes; only where it is in the inbox does. No DELETE is granted at all.
    REVOKE UPDATE ON ${TABLES.join(", ")} FROM invoice_app;
    GRANT UPDATE (status, quarantine_reason, status_message, duplicate_of_id, attempts, routing) ON purchase_inbox_documents TO invoice_app;
  `,
  down: `
    REVOKE UPDATE (status, quarantine_reason, status_message, duplicate_of_id, attempts, routing) ON purchase_inbox_documents FROM invoice_app;
    ${releaseTenant([...TABLES].reverse())}
    DROP TABLE IF EXISTS purchase_inbox_drafts;
    DROP TABLE IF EXISTS purchase_inbox_contents;
    DROP TABLE IF EXISTS purchase_inbox_documents;
  `,
}, {
  // Issue #488 — the inbox's pre-tenant holding. A document whose company is not known yet (still
  // being screened, waiting for the virus scanner, delivered to an address several businesses share
  // or none owns) was kept in process memory and lost on a restart.
  //
  // There is NO bypass of row-level security. The holding carries no company, so a company's
  // policy could never show it a row, and none is written: forced row-level security with a single
  // permissive policy for a dedicated no-login role, `invoice_inbox_holder`, that owns the functions
  // below (the shape of #477's `government_call_company`). `invoice_app` has no privilege on either
  // table; it can only call the functions, and the two that a business uses read the business from
  // `app.company_id`, which the session sets — never from an argument.
  //
  // Held: ids, channel, message key, received time, the sender and the file's name, size, hash and
  // storage key as metadata, and the companies whose channel it arrived on. Not held: the file (it
  // is in private object storage) or anything read out of it.
  id: "20261027T225012034Z_purchasing_2446001e6f1a_inbox_holding",
  up: `
    DO $role$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'invoice_inbox_holder') THEN
        CREATE ROLE invoice_inbox_holder NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      END IF;
    END $role$;
    GRANT USAGE ON SCHEMA public TO invoice_inbox_holder;

    CREATE TABLE purchase_inbox_holding (
      id uuid PRIMARY KEY,
      channel text NOT NULL CHECK (channel IN ('manual_upload','camera','email','whatsapp','einvoice_json','api')),
      -- #406: one held document per redelivered message. Null when the provider gave no message id.
      message_key text UNIQUE CHECK (message_key <> ''),
      intake_key text NOT NULL CHECK (intake_key <> ''),
      received_at timestamptz NOT NULL,
      status text NOT NULL CHECK (status IN ('received','screening','quarantined')),
      quarantine_reason text CHECK (quarantine_reason IN ('UNSUPPORTED_FILE_TYPE','FILE_TYPE_MISMATCH','FILE_TOO_LARGE','PASSWORD_PROTECTED',
        'ACTIVE_CONTENT','MALWARE_SUSPECTED','AWAITING_SCAN','COMPANY_NOT_IDENTIFIED','COMPANY_MISMATCH','NOT_AN_INVOICE','UNREADABLE',
        'EXTRACTION_TOO_UNCERTAIN','SIGNATURE_INVALID')),
      status_message text,
      -- Where the file is in private object storage. The bytes are never kept here.
      storage_key text NOT NULL,
      -- The companies whose channel it arrived on: the only ones that may claim it. Empty when it
      -- arrived on nobody's address. Never returned to a business.
      owners uuid[] NOT NULL DEFAULT '{}',
      -- The sender, the file's measured name, size and hash, the address it was delivered to and
      -- what a restart needs to carry on. Metadata only: nothing read from the file.
      metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
      CHECK ((status = 'quarantined') = (quarantine_reason IS NOT NULL))
    );
    CREATE INDEX purchase_inbox_holding_received_idx ON purchase_inbox_holding(received_at);
    CREATE INDEX purchase_inbox_holding_owners_idx ON purchase_inbox_holding USING gin (owners);

    -- What was done to the holding, by ids and a verb. It outlives the rows it describes.
    CREATE TABLE purchase_inbox_holding_trail (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      held_id uuid NOT NULL,
      action text NOT NULL CHECK (action IN ('received','owners_looked_up','claimed','expired')),
      company_id uuid,
      -- Set when a file was left behind by an expiry, so it can still be found and removed.
      storage_key text,
      at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX purchase_inbox_holding_trail_idx ON purchase_inbox_holding_trail(held_id, at);

    ALTER TABLE purchase_inbox_holding ENABLE ROW LEVEL SECURITY;
    ALTER TABLE purchase_inbox_holding FORCE ROW LEVEL SECURITY;
    CREATE POLICY purchase_inbox_holding_holder ON purchase_inbox_holding FOR ALL TO invoice_inbox_holder USING (true) WITH CHECK (true);
    ALTER TABLE purchase_inbox_holding_trail ENABLE ROW LEVEL SECURITY;
    ALTER TABLE purchase_inbox_holding_trail FORCE ROW LEVEL SECURITY;
    CREATE POLICY purchase_inbox_holding_trail_holder ON purchase_inbox_holding_trail FOR INSERT TO invoice_inbox_holder WITH CHECK (true);
    -- Default privileges would hand the application these tables; it gets none.
    REVOKE ALL ON purchase_inbox_holding, purchase_inbox_holding_trail FROM invoice_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_inbox_holding TO invoice_inbox_holder;
    GRANT INSERT ON purchase_inbox_holding_trail TO invoice_inbox_holder;
    CREATE TRIGGER purchase_inbox_holding_trail_no_truncate BEFORE TRUNCATE ON purchase_inbox_holding_trail
      FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();

    -- A new document, or the one already held for this message. Returns the id that is held.
    CREATE FUNCTION purchase_holding_put(p_id uuid, p_channel text, p_message_key text, p_intake_key text, p_received_at timestamptz,
        p_status text, p_reason text, p_message text, p_storage_key text, p_owners uuid[], p_metadata jsonb) RETURNS uuid
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
      DECLARE kept uuid;
      BEGIN
        INSERT INTO purchase_inbox_holding (id, channel, message_key, intake_key, received_at, status, quarantine_reason, status_message, storage_key, owners, metadata)
          VALUES (p_id, p_channel, p_message_key, p_intake_key, p_received_at, p_status, p_reason, p_message, p_storage_key, p_owners, p_metadata)
          ON CONFLICT DO NOTHING RETURNING id INTO kept;
        IF kept IS NOT NULL THEN
          INSERT INTO purchase_inbox_holding_trail (held_id, action) VALUES (kept, 'received');
          RETURN kept;
        END IF;
        SELECT h.id INTO kept FROM purchase_inbox_holding h WHERE h.message_key = p_message_key;
        IF kept IS NULL THEN RAISE EXCEPTION 'HOLDING_ID_TAKEN' USING ERRCODE = '23505'; END IF;
        RETURN kept;
      END
    $fn$;

    -- Only what the service changes while a document is unrouted. With a state given, only from that state.
    CREATE FUNCTION purchase_holding_save(p_id uuid, p_status text, p_reason text, p_message text, p_owners uuid[], p_metadata jsonb,
        p_from_status text, p_from_reason text, p_check boolean) RETURNS boolean
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
      DECLARE changed integer;
      BEGIN
        UPDATE purchase_inbox_holding SET status = p_status, quarantine_reason = p_reason, status_message = p_message, owners = p_owners, metadata = p_metadata
          WHERE id = p_id AND (NOT p_check OR (status = p_from_status AND quarantine_reason IS NOT DISTINCT FROM p_from_reason));
        GET DIAGNOSTICS changed = ROW_COUNT;
        RETURN changed = 1;
      END
    $fn$;

    -- The server's own reads, before any business is involved. The owners are not among the columns.
    CREATE FUNCTION purchase_holding_get(p_id uuid) RETURNS TABLE (id uuid, channel text, message_key text, intake_key text, received_at timestamptz,
        status text, quarantine_reason text, status_message text, storage_key text, metadata jsonb)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
        SELECT h.id, h.channel, h.message_key, h.intake_key, h.received_at, h.status, h.quarantine_reason, h.status_message, h.storage_key, h.metadata
          FROM purchase_inbox_holding h WHERE h.id = p_id
    $fn$;
    CREATE FUNCTION purchase_holding_get_by_message(p_message_key text) RETURNS TABLE (id uuid, channel text, message_key text, intake_key text, received_at timestamptz,
        status text, quarantine_reason text, status_message text, storage_key text, metadata jsonb)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
        SELECT h.id, h.channel, h.message_key, h.intake_key, h.received_at, h.status, h.quarantine_reason, h.status_message, h.storage_key, h.metadata
          FROM purchase_inbox_holding h WHERE h.message_key = p_message_key
    $fn$;
    CREATE FUNCTION purchase_holding_stalled(p_before timestamptz) RETURNS TABLE (id uuid, channel text, message_key text, intake_key text, received_at timestamptz,
        status text, quarantine_reason text, status_message text, storage_key text, metadata jsonb)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
        SELECT h.id, h.channel, h.message_key, h.intake_key, h.received_at, h.status, h.quarantine_reason, h.status_message, h.storage_key, h.metadata
          FROM purchase_inbox_holding h WHERE h.status IN ('received', 'screening') AND h.received_at < p_before ORDER BY h.received_at, h.id
    $fn$;

    -- The narrow lookup (the shape of #477): company ids and nothing else, and every call is on the trail.
    CREATE FUNCTION purchase_holding_channel_owners(p_id uuid) RETURNS uuid[]
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
      DECLARE found uuid[];
      BEGIN
        SELECT h.owners INTO found FROM purchase_inbox_holding h WHERE h.id = p_id;
        INSERT INTO purchase_inbox_holding_trail (held_id, action) VALUES (p_id, 'owners_looked_up');
        RETURN coalesce(found, '{}');
      END
    $fn$;

    -- What a business may see: only its own, from the session's company, and no more than a name and a size.
    CREATE FUNCTION purchase_holding_waiting() RETURNS TABLE (id uuid, channel text, received_at timestamptz, file_name text, size_bytes bigint)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
        SELECT h.id, h.channel, h.received_at, h.metadata #>> '{attachment,fileName}', (h.metadata #>> '{attachment,sizeBytes}')::bigint
          FROM purchase_inbox_holding h
         WHERE nullif(current_setting('app.company_id', true), '')::uuid = ANY (h.owners)
           AND h.status = 'quarantined' AND h.quarantine_reason = 'COMPANY_NOT_IDENTIFIED'
         ORDER BY h.received_at, h.id
    $fn$;
    CREATE FUNCTION purchase_holding_peek(p_id uuid) RETURNS TABLE (id uuid, channel text, message_key text, intake_key text, received_at timestamptz,
        status text, quarantine_reason text, status_message text, storage_key text, metadata jsonb)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
        SELECT h.id, h.channel, h.message_key, h.intake_key, h.received_at, h.status, h.quarantine_reason, h.status_message, h.storage_key, h.metadata
          FROM purchase_inbox_holding h
         WHERE h.id = p_id AND nullif(current_setting('app.company_id', true), '')::uuid = ANY (h.owners)
    $fn$;
    -- The move out: run in the company's unit of work, with the insert into its books.
    CREATE FUNCTION purchase_holding_claim(p_id uuid) RETURNS TABLE (id uuid, channel text, message_key text, intake_key text, received_at timestamptz,
        status text, quarantine_reason text, status_message text, storage_key text, metadata jsonb)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
      DECLARE company uuid := nullif(current_setting('app.company_id', true), '')::uuid;
      BEGIN
        RETURN QUERY
          WITH gone AS (
            DELETE FROM purchase_inbox_holding h WHERE h.id = p_id AND company = ANY (h.owners)
            RETURNING h.id, h.channel, h.message_key, h.intake_key, h.received_at, h.status, h.quarantine_reason, h.status_message, h.storage_key, h.metadata),
          logged AS (
            INSERT INTO purchase_inbox_holding_trail (held_id, action, company_id) SELECT gone.id, 'claimed', company FROM gone)
          SELECT gone.id, gone.channel, gone.message_key, gone.intake_key, gone.received_at, gone.status, gone.quarantine_reason, gone.status_message, gone.storage_key, gone.metadata FROM gone;
      END
    $fn$;

    -- Retention (D10 / #488): everything received before the cut-off goes; the trail keeps the file's key.
    CREATE FUNCTION purchase_holding_expire(p_before timestamptz) RETURNS TABLE (id uuid, storage_key text)
      LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
        WITH gone AS (DELETE FROM purchase_inbox_holding h WHERE h.received_at < p_before RETURNING h.id, h.storage_key),
        logged AS (INSERT INTO purchase_inbox_holding_trail (held_id, action, storage_key) SELECT gone.id, 'expired', gone.storage_key FROM gone)
        SELECT gone.id, gone.storage_key FROM gone
    $fn$;

    GRANT invoice_inbox_holder TO CURRENT_USER;
    ALTER FUNCTION purchase_holding_put(uuid, text, text, text, timestamptz, text, text, text, text, uuid[], jsonb) OWNER TO invoice_inbox_holder;
    ALTER FUNCTION purchase_holding_save(uuid, text, text, text, uuid[], jsonb, text, text, boolean) OWNER TO invoice_inbox_holder;
    ALTER FUNCTION purchase_holding_get(uuid) OWNER TO invoice_inbox_holder;
    ALTER FUNCTION purchase_holding_get_by_message(text) OWNER TO invoice_inbox_holder;
    ALTER FUNCTION purchase_holding_stalled(timestamptz) OWNER TO invoice_inbox_holder;
    ALTER FUNCTION purchase_holding_channel_owners(uuid) OWNER TO invoice_inbox_holder;
    ALTER FUNCTION purchase_holding_waiting() OWNER TO invoice_inbox_holder;
    ALTER FUNCTION purchase_holding_peek(uuid) OWNER TO invoice_inbox_holder;
    ALTER FUNCTION purchase_holding_claim(uuid) OWNER TO invoice_inbox_holder;
    ALTER FUNCTION purchase_holding_expire(timestamptz) OWNER TO invoice_inbox_holder;
    REVOKE ALL ON FUNCTION purchase_holding_put(uuid, text, text, text, timestamptz, text, text, text, text, uuid[], jsonb),
      purchase_holding_save(uuid, text, text, text, uuid[], jsonb, text, text, boolean), purchase_holding_get(uuid),
      purchase_holding_get_by_message(text), purchase_holding_stalled(timestamptz), purchase_holding_channel_owners(uuid),
      purchase_holding_waiting(), purchase_holding_peek(uuid), purchase_holding_claim(uuid), purchase_holding_expire(timestamptz) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION purchase_holding_put(uuid, text, text, text, timestamptz, text, text, text, text, uuid[], jsonb),
      purchase_holding_save(uuid, text, text, text, uuid[], jsonb, text, text, boolean), purchase_holding_get(uuid),
      purchase_holding_get_by_message(text), purchase_holding_stalled(timestamptz), purchase_holding_channel_owners(uuid),
      purchase_holding_waiting(), purchase_holding_peek(uuid), purchase_holding_claim(uuid), purchase_holding_expire(timestamptz) TO invoice_app;
  `,
  down: `
    DROP FUNCTION IF EXISTS purchase_holding_expire(timestamptz);
    DROP FUNCTION IF EXISTS purchase_holding_claim(uuid);
    DROP FUNCTION IF EXISTS purchase_holding_peek(uuid);
    DROP FUNCTION IF EXISTS purchase_holding_waiting();
    DROP FUNCTION IF EXISTS purchase_holding_channel_owners(uuid);
    DROP FUNCTION IF EXISTS purchase_holding_stalled(timestamptz);
    DROP FUNCTION IF EXISTS purchase_holding_get_by_message(text);
    DROP FUNCTION IF EXISTS purchase_holding_get(uuid);
    DROP FUNCTION IF EXISTS purchase_holding_save(uuid, text, text, text, uuid[], jsonb, text, text, boolean);
    DROP FUNCTION IF EXISTS purchase_holding_put(uuid, text, text, text, timestamptz, text, text, text, text, uuid[], jsonb);
    DROP TABLE IF EXISTS purchase_inbox_holding_trail;
    DROP TABLE IF EXISTS purchase_inbox_holding;
  `,
}, {
  // Issue #489 — what a person decided about a document that is already final (`draft_ready` is
  // frozen above): "this became bill X" or "this was set aside, and why". One row per document,
  // written once, never changed.
  id: "20261027T232043686Z_purchasing_fbf195a69b87_inbox_decisions",
  up: `
    CREATE TABLE purchase_inbox_decisions (
      company_id uuid NOT NULL REFERENCES companies(id),
      document_id uuid NOT NULL,
      kind text NOT NULL CHECK (kind IN ('billed','rejected')),
      -- A rejection always says why; a bill names the supplier bill number it was recorded as.
      reason text,
      bill_number text,
      supplier_name text,
      decided_by text NOT NULL CHECK (decided_by <> ''),
      decided_at timestamptz NOT NULL,
      PRIMARY KEY (company_id, document_id),
      FOREIGN KEY (company_id, document_id) REFERENCES purchase_inbox_documents(company_id, id),
      CHECK (kind <> 'rejected' OR coalesce(reason, '') <> ''),
      CHECK (kind <> 'billed' OR coalesce(bill_number, '') <> '')
    );
    CREATE TRIGGER purchase_inbox_decisions_frozen BEFORE UPDATE OR DELETE ON purchase_inbox_decisions
      FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('', '*', '', '');
    ${DECISION_TABLES.map(noTruncate).join("")}
    ${enforceTenant(DECISION_TABLES)}
    REVOKE UPDATE ON ${DECISION_TABLES.join(", ")} FROM invoice_app;
  `,
  down: `
    ${releaseTenant(DECISION_TABLES)}
    DROP TABLE IF EXISTS purchase_inbox_decisions;
  `,
}]);

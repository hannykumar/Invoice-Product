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
  // Issue #489 — what a person decided about a document that is already final (`draft_ready` is
  // frozen above): "this became bill X" or "this was set aside, and why". One row per document,
  // written once, never changed.
  id: "20261027T224823300Z_purchasing_230a407f7be4_inbox_decisions",
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

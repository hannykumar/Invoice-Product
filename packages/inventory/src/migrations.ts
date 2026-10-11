/**
 * Issue #365 — PostgreSQL tables for stock. Design: docs/contracts/sales-schema-v1.md.
 *
 * Stock is the sum of its movements (docs/product/02-workflows.md, Inventory step 1). Movements
 * are append-only. `stock_balances` is that sum kept per item, godown and batch so a sale can be
 * checked without adding up every movement — and it is kept **by the database**: a trigger on
 * `stock_movements` is the only thing that writes it. The application cannot insert or change a
 * balance, so "no balance is edited directly" is a rule of the database, not of our code.
 *
 * `CHECK (on_hand_micro >= 0)` has no exception. Stock never goes below nothing (owner's rule,
 * #262): a movement that would take it there fails, and takes its whole transaction with it.
 */
import type { Migration } from '../../platform/src/migration-definitions.ts';
import { tenantPolicy } from '../../platform/src/immutability-migrations.ts';

const KINDS_IN = ['OPENING', 'PURCHASE_IN', 'SALES_RETURN_IN', 'TRANSFER_IN', 'ADJUSTMENT_IN', 'REVERSAL_IN'];
const KINDS_OUT = ['SALE_OUT', 'PURCHASE_RETURN_OUT', 'TRANSFER_OUT', 'ADJUSTMENT_OUT', 'REVERSAL_OUT'];
const list = (values: readonly string[]): string => values.map((value) => `'${value}'`).join(',');

const PLACE = `
      item_id uuid NOT NULL,
      warehouse_id uuid NOT NULL,
      batch_id uuid,`;
const PLACE_KEYS = `
      FOREIGN KEY (company_id, item_id) REFERENCES master_records(company_id, id),
      FOREIGN KEY (company_id, warehouse_id) REFERENCES master_records(company_id, id),
      FOREIGN KEY (company_id, batch_id) REFERENCES master_records(company_id, id)`;

export const inventoryMigrations: readonly Migration[] = Object.freeze([{
  id: '20261011T142836700Z_inventory_6f9018379927_stock_movements_and_balances',
  up: `
    CREATE TABLE stock_movements (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      ${PLACE}
      serial_numbers jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(serial_numbers) = 'array'),
      -- Why the stock moved, and which way. Both are recorded; neither is read off a sign.
      kind text NOT NULL CHECK (kind IN (${list([...KINDS_IN, ...KINDS_OUT])})),
      direction text NOT NULL CHECK (direction IN ('IN','OUT')),
      -- Always in the item's base unit. What the person typed is kept beside it.
      quantity_micro bigint NOT NULL CHECK (quantity_micro > 0),
      unit_code text NOT NULL CHECK (unit_code <> ''),
      entered_quantity_micro bigint NOT NULL CHECK (entered_quantity_micro > 0),
      entered_unit_code text NOT NULL CHECK (entered_unit_code <> ''),
      unit_cost_paise bigint CHECK (unit_cost_paise >= 0),
      document_date date NOT NULL,
      source_kind text NOT NULL CHECK (source_kind <> ''),
      source_id text NOT NULL CHECK (source_id <> ''),
      source_number text,
      posted_by uuid NOT NULL REFERENCES users(id),
      posted_at timestamptz NOT NULL,
      idempotency_key text NOT NULL CHECK (idempotency_key <> ''),
      reverses_movement_id uuid,
      reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (company_id, id),
      UNIQUE (company_id, idempotency_key),
      -- A movement is undone once.
      UNIQUE (company_id, reverses_movement_id),
      CONSTRAINT stock_movements_direction_of_kind CHECK ((direction = 'IN') = (kind IN (${list(KINDS_IN)}))),
      -- One way only: undoing an imported opening stock is a REVERSAL_OUT that names no single movement (#37).
      CONSTRAINT stock_movements_only_a_reversal_undoes CHECK (reverses_movement_id IS NULL OR kind IN ('REVERSAL_IN','REVERSAL_OUT')),
      CONSTRAINT stock_movements_reversal_says_why CHECK (reverses_movement_id IS NULL OR COALESCE(length(trim(reason)), 0) > 0),
      FOREIGN KEY (company_id, reverses_movement_id) REFERENCES stock_movements(company_id, id),
      ${PLACE_KEYS}
    );
    -- The stock ledger of one item in one godown, "as of" a date, and rebuilding a balance.
    CREATE INDEX stock_movements_place_idx ON stock_movements(company_id, item_id, warehouse_id, batch_id, document_date);
    -- Foreign keys: everything in a godown, everything of a batch.
    CREATE INDEX stock_movements_warehouse_idx ON stock_movements(company_id, warehouse_id);
    CREATE INDEX stock_movements_batch_idx ON stock_movements(company_id, batch_id) WHERE batch_id IS NOT NULL;
    -- The movements of one bill, challan or note, to undo them.
    CREATE INDEX stock_movements_source_idx ON stock_movements(company_id, source_kind, source_id);
    -- Stock reports for a period, and the check for a back-dated movement into a locked month.
    CREATE INDEX stock_movements_date_idx ON stock_movements(company_id, document_date, id);

    CREATE TABLE stock_balances (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES companies(id),
      ${PLACE}
      unit_code text NOT NULL,
      on_hand_micro bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT stock_balances_place_key UNIQUE NULLS NOT DISTINCT (company_id, item_id, warehouse_id, batch_id),
      CONSTRAINT stock_balances_never_negative CHECK (on_hand_micro >= 0),
      ${PLACE_KEYS}
    );
    CREATE INDEX stock_balances_warehouse_idx ON stock_balances(company_id, warehouse_id);
    CREATE INDEX stock_balances_batch_idx ON stock_balances(company_id, batch_id) WHERE batch_id IS NOT NULL;

    -- Every movement moves its balance in the same statement. The addition is one atomic UPDATE,
    -- so two sales of the last units cannot both succeed: the second sees the first's figure and
    -- fails the CHECK. It runs with the table owner's rights because the application may not
    -- write a balance itself; row-level security still applies (it is forced).
    CREATE FUNCTION stock_movement_moves_balance() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
    DECLARE
      balance_unit text;
    BEGIN
      IF NEW.direction = 'IN' THEN
        INSERT INTO stock_balances (company_id, item_id, warehouse_id, batch_id, unit_code, on_hand_micro)
          VALUES (NEW.company_id, NEW.item_id, NEW.warehouse_id, NEW.batch_id, NEW.unit_code, NEW.quantity_micro)
          ON CONFLICT ON CONSTRAINT stock_balances_place_key
          -- An empty stock may be counted in a new unit: a corrected base unit must not strand the item.
          DO UPDATE SET on_hand_micro = stock_balances.on_hand_micro + EXCLUDED.on_hand_micro, updated_at = now(),
            unit_code = CASE WHEN stock_balances.on_hand_micro = 0 THEN EXCLUDED.unit_code ELSE stock_balances.unit_code END
          RETURNING unit_code INTO balance_unit;
      ELSE
        -- Not an upsert: PostgreSQL checks the row it would insert before it looks for the existing
        -- one, and a first row of "minus one" is refused even when there is stock to take it from.
        UPDATE stock_balances SET on_hand_micro = on_hand_micro - NEW.quantity_micro, updated_at = now()
          WHERE company_id = NEW.company_id AND item_id = NEW.item_id AND warehouse_id = NEW.warehouse_id AND batch_id IS NOT DISTINCT FROM NEW.batch_id
          RETURNING unit_code INTO balance_unit;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Nothing of this item is in that godown, so none can leave it.'
            USING ERRCODE = 'check_violation', TABLE = 'stock_balances', CONSTRAINT = 'stock_balances_never_negative';
        END IF;
      END IF;
      IF balance_unit <> NEW.unit_code THEN
        RAISE EXCEPTION 'This stock is counted in %, so it cannot move in %.', balance_unit, NEW.unit_code
          USING ERRCODE = 'check_violation', TABLE = 'stock_movements', CONSTRAINT = 'stock_movements_unit_of_balance';
      END IF;
      RETURN NULL;
    END;
    $$;
    CREATE TRIGGER stock_movements_move_balance AFTER INSERT ON stock_movements
      FOR EACH ROW EXECUTE FUNCTION stock_movement_moves_balance();

    CREATE TABLE stock_reservations (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL REFERENCES companies(id),
      document_id text NOT NULL CHECK (document_id <> ''),
      line_id text NOT NULL CHECK (line_id <> ''),
      ${PLACE}
      quantity_micro bigint NOT NULL CHECK (quantity_micro > 0),
      unit_code text NOT NULL CHECK (unit_code <> ''),
      state text NOT NULL CHECK (state IN ('HELD','CONSUMED','RELEASED','EXPIRED')),
      created_by uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL,
      -- A hold lapses by the clock, with no write, so that an abandoned bill cannot lock goods for ever.
      expires_at timestamptz NOT NULL,
      settled_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT stock_reservations_expires_later CHECK (expires_at > created_at),
      CONSTRAINT stock_reservations_settled_when_over CHECK ((state = 'HELD') = (settled_at IS NULL)),
      ${PLACE_KEYS}
    );
    -- What unfinished bills are holding of one item in one godown: read with the balance to say what can be sold.
    CREATE INDEX stock_reservations_held_idx ON stock_reservations(company_id, item_id, warehouse_id, batch_id) WHERE state = 'HELD';
    -- A bill's own holds, to release or use them.
    CREATE INDEX stock_reservations_document_idx ON stock_reservations(company_id, document_id);
    CREATE INDEX stock_reservations_item_idx ON stock_reservations(company_id, item_id);
    CREATE INDEX stock_reservations_warehouse_idx ON stock_reservations(company_id, warehouse_id);
    CREATE INDEX stock_reservations_batch_idx ON stock_reservations(company_id, batch_id) WHERE batch_id IS NOT NULL;

    -- Issue #368: a movement is final when written. A hold that is over stays over.
    CREATE TRIGGER stock_movements_frozen BEFORE UPDATE OR DELETE ON stock_movements
      FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('', '*', '', '');
    CREATE TRIGGER stock_movements_no_truncate BEFORE TRUNCATE ON stock_movements
      FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();
    CREATE TRIGGER stock_balances_no_truncate BEFORE TRUNCATE ON stock_balances
      FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();
    CREATE TRIGGER stock_reservations_frozen BEFORE UPDATE OR DELETE ON stock_reservations
      FOR EACH ROW EXECUTE FUNCTION platform_freeze_posted('state', 'CONSUMED,RELEASED,EXPIRED', '', '');
    CREATE TRIGGER stock_reservations_no_truncate BEFORE TRUNCATE ON stock_reservations
      FOR EACH STATEMENT EXECUTE FUNCTION platform_no_truncate();

    ${['stock_movements', 'stock_balances', 'stock_reservations'].map(tenantPolicy).join('')}

    -- The application reads a balance and may lock its row (SELECT … FOR UPDATE needs the right to
    -- update at least one column); it can neither create one nor change what is on hand.
    REVOKE INSERT, UPDATE ON stock_balances FROM invoice_app;
    GRANT UPDATE (updated_at) ON stock_balances TO invoice_app;
  `,
  down: `
    DROP TABLE IF EXISTS stock_reservations, stock_balances, stock_movements;
    DROP FUNCTION IF EXISTS stock_movement_moves_balance();
  `,
}]);

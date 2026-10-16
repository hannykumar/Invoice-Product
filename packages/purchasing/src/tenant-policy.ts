// Issue #366 — forced row-level security for this module's tables, in the words `return_notes`
// uses (docs/contracts/database-immutability-v1.md, "Row-level security"). Every table here has
// its own `company_id`, so none needs a policy through its parent.

export const enforceTenant = (tables: readonly string[]): string => tables.map((table) => `
    ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
    CREATE POLICY ${table}_tenant ON ${table}
      USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
      WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);`).join("");

export const releaseTenant = (tables: readonly string[]): string => tables.map((table) => `
    DROP POLICY IF EXISTS ${table}_tenant ON ${table};
    ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;`).join("");

import type { Migration } from "./migration-definitions.ts";

/**
 * Issue #500 — one audited way to remove a sign-in address.
 *
 * The application role may not change `users.email` (immutability migration: it could otherwise
 * re-point a person's sign-in), so account deletion could not remove a removed member's address.
 * Granting `UPDATE (email)` would undo that protection for every code path. Instead the address
 * can be changed by exactly one function, which does nothing else:
 *
 * - it runs as its owner (SECURITY DEFINER) with a fixed search_path;
 * - it acts only inside the caller's own company (`app.company_id` must equal the company named),
 *   for a person who is a member of that company and of no other company with an active
 *   membership, on behalf of an actor who is a member of that company;
 * - it overwrites the email with `removed-<id>@anonymised.invalid` (a reserved `.invalid` name that
 *   can never receive mail), clears the phone, blanks the name and deactivates the person;
 * - it writes one `audit_events` row naming who did it and why, and never the old address;
 * - it is idempotent: a second call changes nothing and writes no second audit row.
 *
 * Nothing is deleted. Posted books keep the person's *name* only as the books name them (CGST Act
 * s.36, Companies Act s.128; ADR D10); the sign-in address is not part of the books.
 * `identity_subject` (the identity provider's opaque id) is left: the database already refuses to
 * change it once set, and an inactive user can never sign in.
 */
export const anonymiseUserMigrations: readonly Migration[] = [{
  id: "20261027T224659375Z_platform_c67212a4f613_anonymise_user_function",
  up: `
    CREATE OR REPLACE FUNCTION anonymise_user(p_company_id uuid, p_user_id uuid, p_actor_id uuid, p_correlation_id text, p_reason text)
    RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $fn$
    DECLARE
      v_previous_user text := current_setting('app.user_id', true);
      v_email text;
    BEGIN
      IF p_company_id IS NULL OR p_user_id IS NULL OR p_actor_id IS NULL
         OR p_company_id IS DISTINCT FROM nullif(current_setting('app.company_id', true), '')::uuid THEN
        RAISE EXCEPTION 'A sign-in address can only be removed from inside the company it belongs to.' USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM memberships WHERE company_id = p_company_id AND user_id = p_actor_id AND active) THEN
        RAISE EXCEPTION 'Only a member of this company can ask for a sign-in address to be removed.' USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM memberships WHERE company_id = p_company_id AND user_id = p_user_id) THEN
        RAISE EXCEPTION 'That person is not a member of this company.' USING ERRCODE = 'insufficient_privilege';
      END IF;
      -- Row-level security hides other companies' memberships; the person's own rows are readable
      -- through the memberships_own policy once app.user_id names them. Restored before returning.
      PERFORM set_config('app.user_id', p_user_id::text, true);
      IF EXISTS (SELECT 1 FROM memberships WHERE user_id = p_user_id AND company_id <> p_company_id AND active) THEN
        PERFORM set_config('app.user_id', coalesce(v_previous_user, ''), true);
        RETURN false; -- still belongs to another company: their address is not ours to remove
      END IF;
      PERFORM set_config('app.user_id', coalesce(v_previous_user, ''), true);
      SELECT email INTO v_email FROM users WHERE id = p_user_id FOR UPDATE;
      IF NOT FOUND THEN RETURN false; END IF;
      IF v_email = 'removed-' || p_user_id::text || '@anonymised.invalid' THEN RETURN true; END IF;
      UPDATE users SET email = 'removed-' || p_user_id::text || '@anonymised.invalid', phone = NULL,
                       display_name = 'Removed account', active = false
        WHERE id = p_user_id;
      INSERT INTO audit_events (id, company_id, actor_id, action, correlation_id, after_json, reason, occurred_at)
        VALUES (gen_random_uuid(), p_company_id, p_actor_id, 'privacy.sign_in_address_removed', p_correlation_id,
                jsonb_build_object('userId', p_user_id), p_reason, now());
      RETURN true;
    END $fn$;
    REVOKE ALL ON FUNCTION anonymise_user(uuid, uuid, uuid, text, text) FROM PUBLIC;
    DO $$ BEGIN
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'invoice_app') THEN
        GRANT EXECUTE ON FUNCTION anonymise_user(uuid, uuid, uuid, text, text) TO invoice_app;
      END IF;
    END $$;
  `,
  down: `DROP FUNCTION IF EXISTS anonymise_user(uuid, uuid, uuid, text, text);`,
}];

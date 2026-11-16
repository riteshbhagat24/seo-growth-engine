-- M1: identity isolation, membership-aware RLS, invitation and profile functions.
-- Prerequisite roles: app_user, auth_user (docker/postgres-init.sql; once by hand on Neon).

-- ── Identity schema: only auth_user (Better Auth) may touch it ──────────────
REVOKE ALL ON SCHEMA auth FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA auth TO auth_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth TO auth_user;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO auth_user;
--> statement-breakpoint
-- auth_user never reads tenant data.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM auth_user;
--> statement-breakpoint

-- ── organizations: visible to the current tenant, or to members (switcher) ──
DROP POLICY org_self ON organizations;
--> statement-breakpoint
CREATE POLICY org_select ON organizations FOR SELECT
  USING (
    id = app_current_org()
    OR EXISTS (SELECT 1 FROM memberships m WHERE m.organization_id = organizations.id AND m.user_id = app_current_user())
  );
--> statement-breakpoint
CREATE POLICY org_insert ON organizations FOR INSERT WITH CHECK (id = app_current_org());
--> statement-breakpoint
CREATE POLICY org_update ON organizations FOR UPDATE USING (id = app_current_org()) WITH CHECK (id = app_current_org());
--> statement-breakpoint
CREATE POLICY org_delete ON organizations FOR DELETE USING (id = app_current_org());
--> statement-breakpoint

-- ── memberships: tenant rows, plus a user's own rows across workspaces ──────
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON memberships
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY membership_self_read ON memberships FOR SELECT USING (user_id = app_current_user());
--> statement-breakpoint

-- ── invitations ──────────────────────────────────────────────────────────────
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON invitations
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());
--> statement-breakpoint

-- ── audit_logs: append-only; org events in-tenant, user events with no org ──
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON audit_logs
  USING (organization_id = app_current_org())
  WITH CHECK (
    organization_id = app_current_org()
    OR (organization_id IS NULL AND actor_user_id = app_current_user())
  );
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM app_user;
--> statement-breakpoint

-- ── platform_settings: read-only to the app ─────────────────────────────────
-- Seed before RLS is forced (FORCE applies to the owner too).
INSERT INTO platform_settings (key, value)
VALUES ('product', '{"name": "Futuready Media", "logoUrl": null, "primary": "#1f4e79", "accent": "#e8833a"}')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY read_all ON platform_settings FOR SELECT USING (true);
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON platform_settings FROM app_user;
--> statement-breakpoint

-- ── Invitations by token ─────────────────────────────────────────────────────
-- Holding the emailed token (app.invite_token = sha256 hex) reveals that one
-- invitation and its workspace name, nothing else.
CREATE POLICY invite_by_token ON invitations FOR SELECT
  USING (token_hash = NULLIF(current_setting('app.invite_token', true), ''));
--> statement-breakpoint
DROP POLICY org_select ON organizations;
--> statement-breakpoint
CREATE POLICY org_select ON organizations FOR SELECT
  USING (
    id = app_current_org()
    OR EXISTS (SELECT 1 FROM memberships m WHERE m.organization_id = organizations.id AND m.user_id = app_current_user())
    OR EXISTS (SELECT 1 FROM invitations i WHERE i.organization_id = organizations.id
               AND i.token_hash = NULLIF(current_setting('app.invite_token', true), ''))
  );
--> statement-breakpoint

-- ── SECURITY DEFINER bridges to auth.users (owned by app_owner) ─────────────
-- They read only identity data, and only for the current user / current tenant.
-- Tenant tables inside them remain subject to (forced) RLS.

CREATE FUNCTION current_user_identity()
  RETURNS TABLE (email text, email_verified boolean, name text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, auth
  AS $$
    SELECT u.email, u.email_verified, u.name FROM auth.users u WHERE u.id = public.app_current_user()
  $$;
--> statement-breakpoint

CREATE FUNCTION org_member_profiles()
  RETURNS TABLE (membership_id uuid, user_id uuid, name text, email text, image text,
                 role member_role, all_clients boolean, joined_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, auth
  AS $$
    SELECT m.id, u.id, u.name, u.email, u.image, m.role, m.all_clients, m.created_at
    FROM public.memberships m
    JOIN auth.users u ON u.id = m.user_id
    WHERE m.organization_id = public.app_current_org()
    ORDER BY m.created_at
  $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION current_user_identity(), org_member_profiles() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION current_user_identity(), org_member_profiles() TO app_user;

-- Tenant isolation foundation (docs/DATABASE_DESIGN.md §1, docs/SECURITY.md §3).
-- Prerequisite: role `app_user` exists (NOBYPASSRLS, not an owner). Created by
-- docker/postgres-init.sql locally and once by hand on Neon.

-- Current tenant from the transaction-local setting written by withTenant().
-- Unset or empty => NULL => policies match nothing (fail closed).
CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.org_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_current_user() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint

-- Runtime privileges: data access only, no DDL.
GRANT USAGE ON SCHEMA public TO app_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_org(), app_current_user() TO app_user;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;
--> statement-breakpoint

-- organizations: a session sees and writes only its current organisation.
-- (M1 adds membership-based listing for the workspace switcher.)
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_self ON organizations
  USING (id = app_current_org())
  WITH CHECK (id = app_current_org());
--> statement-breakpoint

-- websites: standard tenant policy (template for every tenant table).
ALTER TABLE websites ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE websites FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON websites
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

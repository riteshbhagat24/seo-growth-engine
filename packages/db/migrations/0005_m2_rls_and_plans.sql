-- M2: plans, subscriptions, usage, clients, client-scoped access, websites.

-- ── Client scope helper ─────────────────────────────────────────────────────
-- app.client_scope = '*' (all clients) or a comma list of client ids.
-- Rows with client_id NULL (workspace-level) are visible only with '*'.
-- CASE guarantees '*' is never cast to uuid[].
CREATE FUNCTION app_client_allowed(cid uuid) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    SELECT CASE
      WHEN coalesce(current_setting('app.client_scope', true), '') = '*' THEN true
      WHEN cid IS NULL THEN false
      WHEN coalesce(current_setting('app.client_scope', true), '') = '' THEN false
      ELSE cid = ANY (string_to_array(current_setting('app.client_scope', true), ',')::uuid[])
    END
  $$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_client_allowed(uuid) TO app_user;
--> statement-breakpoint

-- ── Plans: seed before RLS is forced, then read-only to the app ─────────────
-- Limit value -1 means unlimited.
INSERT INTO plans (id, name, description, workspace_type, limits, is_default, sort) VALUES
  ('free', 'Free', 'For one website.', 'personal',
   '{"websites":1,"clients":0,"members":1,"pages_crawled_month":500,"keywords":50,"backlinks_monitored":50,"reports_month":2}', true, 10),
  ('pro', 'Pro', 'For a handful of websites.', 'personal',
   '{"websites":5,"clients":0,"members":1,"pages_crawled_month":10000,"keywords":500,"backlinks_monitored":1000,"reports_month":20}', false, 20),
  ('agency_free', 'Agency Free', 'Try the agency features with a small team.', 'agency',
   '{"websites":3,"clients":3,"members":3,"pages_crawled_month":2000,"keywords":200,"backlinks_monitored":200,"reports_month":10}', true, 30),
  ('agency', 'Agency', 'For agencies managing many clients.', 'agency',
   '{"websites":50,"clients":50,"members":15,"pages_crawled_month":100000,"keywords":5000,"backlinks_monitored":10000,"reports_month":200}', false, 40)
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE plans FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY read_all ON plans FOR SELECT USING (true);
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON plans FROM app_user;
--> statement-breakpoint

-- ── Backfill a subscription for every existing workspace ────────────────────
-- organizations has FORCE RLS (applies to the owner too); lift it for this
-- statement only, inside the migration transaction.
ALTER TABLE organizations NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
INSERT INTO subscriptions (organization_id, plan_id, status)
SELECT o.id, CASE o.type WHEN 'agency' THEN 'agency_free' ELSE 'free' END, 'active'
FROM organizations o
ON CONFLICT (organization_id) DO NOTHING;
--> statement-breakpoint
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- ── subscriptions: tenant rows; plan changes are platform-admin only ────────
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON subscriptions
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON subscriptions FROM app_user;
--> statement-breakpoint

-- ── usage_counters ──────────────────────────────────────────────────────────
ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE usage_counters FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON usage_counters
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());
--> statement-breakpoint

-- ── clients: tenant + client scope ──────────────────────────────────────────
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE clients FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON clients
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY client_scope ON clients AS RESTRICTIVE
  USING (app_client_allowed(id))
  WITH CHECK (app_client_allowed(id));
--> statement-breakpoint

-- ── membership_clients: tenant rows, plus a user's own assignments ──────────
ALTER TABLE membership_clients ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE membership_clients FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON membership_clients
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY own_assignments_read ON membership_clients FOR SELECT
  USING (EXISTS (SELECT 1 FROM memberships m WHERE m.id = membership_clients.membership_id AND m.user_id = app_current_user()));
--> statement-breakpoint

-- ── websites: add client scope on top of tenant isolation ──────────────────
CREATE POLICY client_scope ON websites AS RESTRICTIVE
  USING (app_client_allowed(client_id))
  WITH CHECK (app_client_allowed(client_id));

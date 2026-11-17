-- M4: audits, issues, external link checks, Core Web Vitals, on-page analyses, integrations.

-- ── Plans: add the psi_runs_month limit (FORCE RLS applies to the owner too) ─
ALTER TABLE plans NO FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE plans SET limits = limits || jsonb_build_object('psi_runs_month',
  CASE id WHEN 'free' THEN 20 WHEN 'pro' THEN 200 WHEN 'agency_free' THEN 50 WHEN 'agency' THEN 1000 ELSE 20 END)
WHERE NOT limits ? 'psi_runs_month';
--> statement-breakpoint
ALTER TABLE plans FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- ── audits: tenant + visible website ────────────────────────────────────────
ALTER TABLE audits ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audits FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON audits
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY website_visible ON audits AS RESTRICTIVE TO app_user
  USING (EXISTS (SELECT 1 FROM websites w WHERE w.id = audits.website_id))
  WITH CHECK (EXISTS (SELECT 1 FROM websites w WHERE w.id = audits.website_id));
--> statement-breakpoint

-- ── audit_issues / audit_external_links: tenant + visible audit ─────────────
ALTER TABLE audit_issues ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_issues FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON audit_issues
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY audit_visible ON audit_issues AS RESTRICTIVE TO app_user
  USING (EXISTS (SELECT 1 FROM audits a WHERE a.id = audit_issues.audit_id))
  WITH CHECK (EXISTS (SELECT 1 FROM audits a WHERE a.id = audit_issues.audit_id));
--> statement-breakpoint
ALTER TABLE audit_external_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_external_links FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON audit_external_links
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY audit_visible ON audit_external_links AS RESTRICTIVE TO app_user
  USING (EXISTS (SELECT 1 FROM audits a WHERE a.id = audit_external_links.audit_id))
  WITH CHECK (EXISTS (SELECT 1 FROM audits a WHERE a.id = audit_external_links.audit_id));
--> statement-breakpoint

-- ── cwv_results / onpage_analyses: tenant + visible website ─────────────────
ALTER TABLE cwv_results ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE cwv_results FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON cwv_results
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY website_visible ON cwv_results AS RESTRICTIVE TO app_user
  USING (EXISTS (SELECT 1 FROM websites w WHERE w.id = cwv_results.website_id))
  WITH CHECK (EXISTS (SELECT 1 FROM websites w WHERE w.id = cwv_results.website_id));
--> statement-breakpoint
ALTER TABLE onpage_analyses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE onpage_analyses FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON onpage_analyses
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY website_visible ON onpage_analyses AS RESTRICTIVE TO app_user
  USING (EXISTS (SELECT 1 FROM websites w WHERE w.id = onpage_analyses.website_id))
  WITH CHECK (EXISTS (SELECT 1 FROM websites w WHERE w.id = onpage_analyses.website_id));
--> statement-breakpoint

-- ── integrations: tenant only (permission checks in the app) ────────────────
ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE integrations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON integrations
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());

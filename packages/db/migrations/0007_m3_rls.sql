-- M3: jobs, schedules, crawls. Prerequisite role: worker_user (NOBYPASSRLS).

-- ── Worker role: queue tables only ──────────────────────────────────────────
GRANT USAGE ON SCHEMA public TO worker_user;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON jobs, schedules TO worker_user;
--> statement-breakpoint

-- ── jobs ────────────────────────────────────────────────────────────────────
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON jobs
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());
--> statement-breakpoint
-- The worker claims and updates jobs across tenants; it touches tenant data
-- only through app_user + withContext(job.organization_id).
CREATE POLICY worker_all ON jobs TO worker_user USING (true) WITH CHECK (true);
--> statement-breakpoint
-- Tenants see jobs only for websites in their client scope.
CREATE POLICY website_visible ON jobs AS RESTRICTIVE TO app_user
  USING (website_id IS NULL OR EXISTS (SELECT 1 FROM websites w WHERE w.id = jobs.website_id));
--> statement-breakpoint

-- ── schedules ───────────────────────────────────────────────────────────────
ALTER TABLE schedules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE schedules FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON schedules
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY worker_all ON schedules TO worker_user USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY website_visible ON schedules AS RESTRICTIVE TO app_user
  USING (website_id IS NULL OR EXISTS (SELECT 1 FROM websites w WHERE w.id = schedules.website_id));
--> statement-breakpoint

-- ── crawls / crawl_pages: tenant + visible website ──────────────────────────
ALTER TABLE crawls ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE crawls FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON crawls
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY website_visible ON crawls AS RESTRICTIVE TO app_user
  USING (EXISTS (SELECT 1 FROM websites w WHERE w.id = crawls.website_id))
  WITH CHECK (EXISTS (SELECT 1 FROM websites w WHERE w.id = crawls.website_id));
--> statement-breakpoint
ALTER TABLE crawl_pages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE crawl_pages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON crawl_pages
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY crawl_visible ON crawl_pages AS RESTRICTIVE TO app_user
  USING (EXISTS (SELECT 1 FROM crawls c WHERE c.id = crawl_pages.crawl_id))
  WITH CHECK (EXISTS (SELECT 1 FROM crawls c WHERE c.id = crawl_pages.crawl_id));

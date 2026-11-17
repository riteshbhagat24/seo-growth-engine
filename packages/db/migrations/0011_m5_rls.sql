-- M5: Google property mapping, Search Console / GA4 data, keywords.
-- Every table: FORCE RLS, tenant isolation, and (for app_user) visible only
-- when its website is visible in the member's client scope.

ALTER TABLE website_google ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE website_google FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON website_google
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY website_visible ON website_google AS RESTRICTIVE TO app_user
  USING (EXISTS (SELECT 1 FROM websites w WHERE w.id = website_google.website_id))
  WITH CHECK (EXISTS (SELECT 1 FROM websites w WHERE w.id = website_google.website_id));
--> statement-breakpoint

ALTER TABLE gsc_site_daily ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE gsc_site_daily FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON gsc_site_daily
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY website_visible ON gsc_site_daily AS RESTRICTIVE TO app_user
  USING (EXISTS (SELECT 1 FROM websites w WHERE w.id = gsc_site_daily.website_id))
  WITH CHECK (EXISTS (SELECT 1 FROM websites w WHERE w.id = gsc_site_daily.website_id));
--> statement-breakpoint

ALTER TABLE gsc_dim_daily ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE gsc_dim_daily FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON gsc_dim_daily
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY website_visible ON gsc_dim_daily AS RESTRICTIVE TO app_user
  USING (EXISTS (SELECT 1 FROM websites w WHERE w.id = gsc_dim_daily.website_id))
  WITH CHECK (EXISTS (SELECT 1 FROM websites w WHERE w.id = gsc_dim_daily.website_id));
--> statement-breakpoint

ALTER TABLE gsc_daily ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE gsc_daily FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON gsc_daily
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY website_visible ON gsc_daily AS RESTRICTIVE TO app_user
  USING (EXISTS (SELECT 1 FROM websites w WHERE w.id = gsc_daily.website_id))
  WITH CHECK (EXISTS (SELECT 1 FROM websites w WHERE w.id = gsc_daily.website_id));
--> statement-breakpoint

ALTER TABLE ga4_daily ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ga4_daily FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON ga4_daily
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY website_visible ON ga4_daily AS RESTRICTIVE TO app_user
  USING (EXISTS (SELECT 1 FROM websites w WHERE w.id = ga4_daily.website_id))
  WITH CHECK (EXISTS (SELECT 1 FROM websites w WHERE w.id = ga4_daily.website_id));
--> statement-breakpoint

ALTER TABLE keywords ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE keywords FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON keywords
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org());
--> statement-breakpoint
CREATE POLICY website_visible ON keywords AS RESTRICTIVE TO app_user
  USING (EXISTS (SELECT 1 FROM websites w WHERE w.id = keywords.website_id))
  WITH CHECK (EXISTS (SELECT 1 FROM websites w WHERE w.id = keywords.website_id));

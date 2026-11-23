-- M6–M8: backlink acquisition engine (docs/BACKLINKS_INTEGRATION.md).
-- Order matters: the global catalogue and defaults are seeded before RLS is forced (FORCE RLS applies to the owner too).

-- ── updated_at maintenance for rows the engine updates with plain SQL ───────
CREATE OR REPLACE FUNCTION backlinks_touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$
--> statement-breakpoint
CREATE TRIGGER business_profiles_touch BEFORE UPDATE ON business_profiles FOR EACH ROW EXECUTE FUNCTION backlinks_touch_updated_at()
--> statement-breakpoint
CREATE TRIGGER backlink_website_settings_touch BEFORE UPDATE ON backlink_website_settings FOR EACH ROW EXECUTE FUNCTION backlinks_touch_updated_at()
--> statement-breakpoint
CREATE TRIGGER backlink_sources_touch BEFORE UPDATE ON backlink_sources FOR EACH ROW EXECUTE FUNCTION backlinks_touch_updated_at()
--> statement-breakpoint
CREATE TRIGGER backlink_campaigns_touch BEFORE UPDATE ON backlink_campaigns FOR EACH ROW EXECUTE FUNCTION backlinks_touch_updated_at()
--> statement-breakpoint
CREATE TRIGGER backlink_submissions_touch BEFORE UPDATE ON backlink_submissions FOR EACH ROW EXECUTE FUNCTION backlinks_touch_updated_at()
--> statement-breakpoint
-- ── source references: global catalogue or the row's own workspace only ─────
-- source_id is a plain FK (global rows have no organisation), so check visibility here. The function runs
-- as the caller, under RLS: another workspace's source is invisible and therefore rejected.
CREATE OR REPLACE FUNCTION backlinks_check_source_ref() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM backlink_sources s
    WHERE s.id = NEW.source_id AND (s.organization_id IS NULL OR s.organization_id = NEW.organization_id)
  ) THEN
    RAISE EXCEPTION 'source % is not available to this workspace', NEW.source_id USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$
--> statement-breakpoint
CREATE TRIGGER backlink_opportunities_source_ref BEFORE INSERT OR UPDATE OF source_id ON backlink_opportunities FOR EACH ROW EXECUTE FUNCTION backlinks_check_source_ref()
--> statement-breakpoint
CREATE TRIGGER backlink_submissions_source_ref BEFORE INSERT OR UPDATE OF source_id ON backlink_submissions FOR EACH ROW EXECUTE FUNCTION backlinks_check_source_ref()
--> statement-breakpoint
-- ── Global catalogue: 108 sites from packages/db/seed/link_sources.csv + 31 from the standalone curated list ──
-- Reviewed 2026-11-23: none of these destinations has granted automation, so every row is manual_only and
-- unverified (a person submits; the crawler verifies). Four UGC communities are retired: posting there to obtain
-- links breaks their rules. The CSV's confidence, free-tier and research notes are kept in permission_evidence.review.
INSERT INTO backlink_sources (domain, name, source_type, industries, countries, homepage_url, submission_url, adapter_key,
  automation_permission, permission_evidence, requires_account, link_type_expected, curation_status, notes) VALUES
  ('99acres.com', '99acres', 'industry_directory', '{"real_estate"}'::text[], '{"IN"}'::text[], 'https://www.99acres.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "standalone curated list (2026-11-23)", "confidence": "medium"}}'::jsonb, true, 'unknown', 'unverified', NULL),
  ('about.me', 'about.me', 'business_listing', '{}'::text[], '{}'::text[], 'https://about.me/', 'https://about.me', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "high", "free_listing": "freemium", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Free plan $0/yr includes a profile page; paid AI/lead features'),
  ('agencyspotter.com', 'Agency Spotter', 'agency_directory', '{"marketing_agency","professional_services"}'::text[], '{"US"}'::text[], 'https://www.agencyspotter.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "medium", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION", "also_in": "standalone curated list"}}'::jsonb, true, 'unknown', 'unverified', 'Claim or request profile after sign-in; requires 2+ full-time employees; paid subscriptions exist; 403 on fetch'),
  ('agencyvista.com', 'Agency Vista', 'agency_directory', '{"marketing_agency"}'::text[], '{}'::text[], 'https://agencyvista.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'www host has TLS certificate mismatch (use apex domain); free tier unverified'),
  ('alternativeto.net', 'AlternativeTo', 'industry_directory', '{"technology"}'::text[], '{}'::text[], 'https://alternativeto.net/', 'https://alternativeto.net/signup', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "medium", "free_listing": "yes", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION", "also_in": "standalone curated list"}}'::jsonb, true, 'unknown', 'unverified', 'Crowd-sourced free site; adding apps requires sign-up and moderation'),
  ('ambitionbox.com', 'AmbitionBox', 'review_platform', '{}'::text[], '{"IN"}'::text[], 'https://www.ambitionbox.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'India employer reviews (Info Edge); employer claim flow unverified'),
  ('asklaila.com', 'AskLaila', 'business_listing', '{}'::text[], '{"IN"}'::text[], 'https://www.asklaila.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "yes", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', '403 on fetch; current activity unverified'),
  ('avvo.com', 'Avvo', 'industry_directory', '{"professional_services"}'::text[], '{"US"}'::text[], 'https://www.avvo.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "standalone curated list (2026-11-23)", "confidence": "medium"}}'::jsonb, true, 'unknown', 'unverified', 'Lawyers only; licence verification.'),
  ('bark.com', 'Bark', 'business_listing', '{}'::text[], '{}'::text[], 'https://www.bark.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Free seller profile; responding to leads costs paid credits; 403 on fetch'),
  ('bbb.org', 'Better Business Bureau', 'review_platform', '{}'::text[], '{"US"}'::text[], 'https://www.bbb.org/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION", "also_in": "standalone curated list"}}'::jsonb, true, 'unknown', 'unverified', 'Basic business profile free; accreditation is paid; US/Canada; Accreditation process.'),
  ('behance.net', 'Behance', 'business_listing', '{"marketing_agency","professional_services"}'::text[], '{}'::text[], 'https://www.behance.net/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "yes", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Free portfolio via Adobe account; 403 on fetch'),
  ('betalist.com', 'BetaList', 'startup_directory', '{"technology"}'::text[], '{}'::text[], 'https://betalist.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "standalone curated list (2026-11-23)", "confidence": "medium"}}'::jsonb, true, 'unknown', 'unverified', NULL),
  ('bing.com', 'Bing Places for Business', 'business_listing', '{}'::text[], '{}'::text[], 'https://www.bing.com/forbusiness/', 'https://www.bing.com/forbusiness', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "medium", "free_listing": "yes", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'bingplaces.com 301-redirects here; can import from Google Business Profile; page body not readable by fetcher so free status from prior knowledge'),
  ('bingplaces.com', 'Bing Places for Business', 'business_listing', '{}'::text[], '{}'::text[], 'https://www.bingplaces.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "standalone curated list (2026-11-23)", "confidence": "medium"}}'::jsonb, true, 'unknown', 'unverified', 'Business verification required.'),
  ('biz.yelp.com', 'Yelp for Business', 'business_listing', '{}'::text[], '{"US","GB","CA","AU","IE","NZ","DE","FR","SG"}'::text[], 'https://biz.yelp.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "standalone curated list (2026-11-23)", "confidence": "medium"}}'::jsonb, true, 'nofollow', 'unverified', NULL),
  ('britishchambers.org.uk', 'British Chambers of Commerce', 'association', '{}'::text[], '{"GB"}'::text[], 'https://www.britishchambers.org.uk/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "standalone curated list (2026-11-23)", "confidence": "medium"}}'::jsonb, true, 'unknown', 'unverified', NULL),
  ('brownbook.net', 'Brownbook', 'business_listing', '{}'::text[], '{}'::text[], 'https://www.brownbook.net/', 'https://www.brownbook.net/add-business/', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "high", "free_listing": "yes", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, false, 'unknown', 'unverified', 'Two-step add-business form (name/category/country required); site title states free business listings; account need at step 2 not verified'),
  ('business.apple.com', 'Apple Business (Business Connect)', 'business_listing', '{}'::text[], '{}'::text[], 'https://business.apple.com/', 'https://business.apple.com', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "medium", "free_listing": "yes", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'businessconnect.apple.com redirects here; claim location on Apple Maps; page lists no fee for Maps listing; Apple Account and business verification needed'),
  ('business.google.com', 'Google Business Profile', 'business_listing', '{}'::text[], '{}'::text[], 'https://business.google.com/', 'https://business.google.com/create/new', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "high", "free_listing": "yes", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Free per official FAQ; ownership verification required (method varies: video/phone/postcard); physical or service-area business needed'),
  ('business.trustpilot.com', 'Trustpilot', 'review_platform', '{}'::text[], '{}'::text[], 'https://business.trustpilot.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "standalone curated list (2026-11-23)", "confidence": "medium"}}'::jsonb, true, 'nofollow', 'unverified', NULL),
  ('businessconnect.apple.com', 'Apple Business Connect', 'business_listing', '{}'::text[], '{}'::text[], 'https://businessconnect.apple.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "standalone curated list (2026-11-23)", "confidence": "medium"}}'::jsonb, true, 'unknown', 'unverified', 'Apple ID and business verification required.'),
  ('candid.org', 'Candid (GuideStar)', 'industry_directory', '{"nonprofit"}'::text[], '{"US"}'::text[], 'https://candid.org/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "standalone curated list (2026-11-23)", "confidence": "medium"}}'::jsonb, true, 'unknown', 'unverified', NULL),
  ('capterra.com', 'Capterra', 'review_platform', '{"technology"}'::text[], '{}'::text[], 'https://www.capterra.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION", "also_in": "standalone curated list"}}'::jsonb, true, 'nofollow', 'unverified', 'Gartner Digital Markets free basic listing (also syndicates to GetApp/Software Advice); PPC paid; 403 on fetch'),
  ('chamberofcommerce.com', 'ChamberofCommerce.com', 'business_listing', '{}'::text[], '{"US"}'::text[], 'https://www.chamberofcommerce.com/', 'https://www.chamberofcommerce.com/members/add-business', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "medium", "free_listing": "freemium", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Basic listing implied alongside paid Premium membership; private site not affiliated with official local chambers'),
  ('cii.in', 'Confederation of Indian Industry', 'association', '{"manufacturing","professional_services","technology"}'::text[], '{"IN"}'::text[], 'https://www.cii.in/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "standalone curated list (2026-11-23)", "confidence": "medium"}}'::jsonb, true, 'unknown', 'unverified', 'Membership-based.'),
  ('clutch.co', 'Clutch', 'agency_directory', '{"marketing_agency","professional_services","technology"}'::text[], '{}'::text[], 'https://clutch.co/', 'https://vendor.clutch.co/profile/create/basic', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "high", "free_listing": "freemium", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION", "also_in": "standalone curated list"}}'::jsonb, true, 'unknown', 'unverified', 'Basic profile listed at $0; Verified tier $499/yr; Advertiser tier custom pricing; Profiles rely on verified client reviews — never fabricate reviews.'),
  ('contra.com', 'Contra', 'business_listing', '{"marketing_agency","professional_services","technology"}'::text[], '{}'::text[], 'https://contra.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "yes", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Free portfolio profile for independents; paid Pro tier'),
  ('crunchbase.com', 'Crunchbase', 'startup_directory', '{"ecommerce","finance","technology"}'::text[], '{}'::text[], 'https://www.crunchbase.com/', 'https://www.crunchbase.com/add-new', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "medium", "free_listing": "freemium", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION", "also_in": "standalone curated list"}}'::jsonb, true, 'unknown', 'unverified', 'Homepage Create Profile links to /add-new (that page 403s to fetcher); edits moderated; Pro subscription paid'),
  ('cybo.com', 'Cybo', 'business_listing', '{}'::text[], '{}'::text[], 'https://www.cybo.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "yes", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Global business directory; 403 on fetch; free add flow from memory only'),
  ('cylex.us.com', 'Cylex', 'business_listing', '{}'::text[], '{"US"}'::text[], 'https://www.cylex.us.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "medium", "free_listing": "yes", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Free listing per multiple citation lists; part of multi-country Cylex network; 403 on fetch'),
  ('dealroom.co', 'Dealroom', 'startup_directory', '{"technology"}'::text[], '{}'::text[], 'https://dealroom.co/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "yes", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Startups can claim/submit profile free (from memory); data product paid'),
  ('designrush.com', 'DesignRush', 'agency_directory', '{"marketing_agency","professional_services"}'::text[], '{}'::text[], 'https://www.designrush.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "medium", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION", "also_in": "standalone curated list"}}'::jsonb, true, 'unknown', 'unverified', 'Free basic listing per own benefits page and third parties; sponsorship from ~$2000/mo; exact get-listed URL not confirmed (guessed path 404)'),
  ('dev.to', 'DEV Community', 'other', '{"technology"}'::text[], '{}'::text[], 'https://dev.to/', 'https://dev.to', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "medium", "free_listing": "yes", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Open sign-up with many independent authors; DEV++ paid add-on; self-promo norms apply'),
  ('devhunt.org', 'DevHunt', 'industry_directory', '{"technology"}'::text[], '{}'::text[], 'https://devhunt.org/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "medium", "free_listing": "freemium", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Submit requires login; free launch per third-party lists; banner ads $99-199/wk'),
  ('doctolib.fr', 'Doctolib', 'industry_directory', '{"healthcare"}'::text[], '{"FR","DE"}'::text[], 'https://www.doctolib.fr/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "standalone curated list (2026-11-23)", "confidence": "medium"}}'::jsonb, true, 'unknown', 'unverified', NULL),
  ('dribbble.com', 'Dribbble', 'business_listing', '{"marketing_agency","professional_services"}'::text[], '{}'::text[], 'https://dribbble.com/', 'https://dribbble.com/signup/new', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "medium", "free_listing": "freemium", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Signup page live; Pro/Pro+ paid tiers; free posting rights not confirmed'),
  ('europages.co.uk', 'Europages', 'business_listing', '{}'::text[], '{}'::text[], 'https://www.europages.co.uk/', 'https://www.europages.co.uk/en/supplier-registration', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "medium", "free_listing": "freemium", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Create profile link plus paid premium profile; Europe-focused B2B'),
  ('europages.com', 'Europages', 'industry_directory', '{"manufacturing"}'::text[], '{"DE","FR","GB","IE"}'::text[], 'https://www.europages.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "standalone curated list (2026-11-23)", "confidence": "medium"}}'::jsonb, true, 'unknown', 'unverified', NULL),
  ('expertise.com', 'Expertise.com', 'business_listing', '{}'::text[], '{"US"}'::text[], 'https://www.expertise.com/', NULL, 'outreach-email', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "medium", "free_listing": "yes", "checked_on": "2026-11-16", "submission_method": "EDITORIAL_OUTREACH"}}'::jsonb, false, 'unknown', 'unverified', 'Inclusion via Expertise research/screening (no self-submit); portal for updating existing listings; marketing agreements offered'),
  ('exportersindia.com', 'ExportersIndia', 'business_listing', '{"manufacturing"}'::text[], '{"IN"}'::text[], 'https://www.exportersindia.com/', 'https://www.exportersindia.com/register-business-online', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "high", "free_listing": "freemium", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Free listing; name/phone/address/email and at least 3 products or services required'),
  ('ezlocal.com', 'EZlocal', 'business_listing', '{}'::text[], '{"US"}'::text[], 'https://www.ezlocal.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "medium", "free_listing": "yes", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Free listing per citation lists; do not confuse with eLocal (paid); 403 on fetch'),
  ('f6s.com', 'F6S', 'startup_directory', '{"technology"}'::text[], '{}'::text[], 'https://www.f6s.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Bot-check blocks fetch; free company profile from memory only'),
  ('facebook.com', 'Facebook Page', 'business_listing', '{}'::text[], '{}'::text[], 'https://www.facebook.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "yes", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Free business page; requires personal account'),
  ('fazier.com', 'Fazier', 'startup_directory', '{"technology"}'::text[], '{}'::text[], 'https://fazier.com/', 'https://fazier.com/submit', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "medium", "free_listing": "freemium", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Submit Product link confirmed; free launch per third-party lists; premium/ads paid'),
  ('ficci.in', 'FICCI', 'association', '{}'::text[], '{"IN"}'::text[], 'https://ficci.in/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "standalone curated list (2026-11-23)", "confidence": "medium"}}'::jsonb, true, 'unknown', 'unverified', 'Membership-based.'),
  ('foursquare.com', 'Foursquare', 'business_listing', '{"ecommerce","hospitality","other"}'::text[], '{}'::text[], 'https://foursquare.com/', 'https://foursquare.com/venue/claim', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "medium", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION", "also_in": "standalone curated list"}}'::jsonb, true, 'unknown', 'unverified', 'Claim/add reported free; phone verification; some reports of paid expedited claim; consumer app changes - verify flow'),
  ('freeindex.co.uk', 'FreeIndex', 'business_listing', '{}'::text[], '{"GB"}'::text[], 'https://www.freeindex.co.uk/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "high", "free_listing": "yes", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION", "also_in": "standalone curated list"}}'::jsonb, true, 'unknown', 'unverified', 'Homepage: Advertise for FREE on FreeIndex (profile/reviews/leads); UK only; exact add-business URL not captured'),
  ('g2.com', 'G2', 'review_platform', '{"marketing_agency","technology"}'::text[], '{}'::text[], 'https://www.g2.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION", "also_in": "standalone curated list"}}'::jsonb, true, 'nofollow', 'unverified', 'Free basic profile with paid G2 Seller plans; 403 on fetch'),
  ('github.com', 'GitHub Organization', 'business_listing', '{"technology"}'::text[], '{}'::text[], 'https://github.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "yes", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Free org/profile with website field; relevant for tech/SaaS only'),
  ('glassdoor.com', 'Glassdoor', 'review_platform', '{}'::text[], '{}'::text[], 'https://www.glassdoor.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Free employer profile claim; enhanced profile paid'),
  ('goodfirms.co', 'GoodFirms', 'agency_directory', '{"marketing_agency","technology"}'::text[], '{}'::text[], 'https://www.goodfirms.co/', 'https://www.goodfirms.co/get-listed', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "medium", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION", "also_in": "standalone curated list"}}'::jsonb, true, 'unknown', 'unverified', 'Free plan per GoodFirms own pages; reported ~23% acceptance rate; PRO and sponsored placements paid; site returns 403 to automated fetch'),
  ('gravatar.com', 'Gravatar', 'business_listing', '{}'::text[], '{}'::text[], 'https://gravatar.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "yes", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Free public profile with links (Automattic)'),
  ('greatschools.org', 'GreatSchools', 'industry_directory', '{"education"}'::text[], '{"US"}'::text[], 'https://www.greatschools.org/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "standalone curated list (2026-11-23)", "confidence": "medium"}}'::jsonb, true, 'unknown', 'unverified', NULL),
  ('grotal.com', 'Grotal', 'business_listing', '{}'::text[], '{"IN"}'::text[], 'https://www.grotal.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "yes", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Fetch timed out - may be down; verify before shipping'),
  ('growthhackers.com', 'GrowthHackers Community', 'other', '{"marketing_agency","technology"}'::text[], '{}'::text[], 'https://growthhackers.com/', 'https://community.growthhackers.com', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "medium", "free_listing": "yes", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'retired', 'Apply to join; footer shows 2025 copyright so activity level uncertain; Retired from discovery: community rules forbid posting to obtain links.'),
  ('gust.com', 'Gust', 'startup_directory', '{"technology"}'::text[], '{}'::text[], 'https://gust.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Free startup profile from memory; paid tiers'),
  ('hackernoon.com', 'HackerNoon', 'guest_post', '{"technology"}'::text[], '{}'::text[], 'https://hackernoon.com/', NULL, 'outreach-email', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "yes", "checked_on": null, "submission_method": "EDITORIAL_OUTREACH"}}'::jsonb, true, 'unknown', 'unverified', 'Writers submit drafts for editorial review; sponsored options exist'),
  ('hashnode.com', 'Hashnode', 'other', '{"technology"}'::text[], '{}'::text[], 'https://hashnode.com/', 'https://hashnode.com/login', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "high", "free_listing": "freemium", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Free blog plan on hashnode.dev subdomain; Pro $5/seat/mo for custom domain etc'),
  ('healthgrades.com', 'Healthgrades', 'industry_directory', '{"healthcare"}'::text[], '{"US"}'::text[], 'https://www.healthgrades.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "standalone curated list (2026-11-23)", "confidence": "medium"}}'::jsonb, true, 'unknown', 'unverified', NULL),
  ('hotfrog.com', 'Hotfrog', 'business_listing', '{}'::text[], '{}'::text[], 'https://www.hotfrog.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "medium", "free_listing": "yes", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Free Basic Profile via Add your business; email verification; country sites (e.g. .in/.co.uk/.com.au); 403 on fetch'),
  ('inc42.com', 'Inc42', 'guest_post', '{"technology"}'::text[], '{"IN"}'::text[], 'https://inc42.com/', 'https://inc42.com/startup-submission/', 'outreach-email', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "medium", "free_listing": "yes", "checked_on": "2026-11-16", "submission_method": "EDITORIAL_OUTREACH"}}'::jsonb, false, 'unknown', 'unverified', 'Submit Your Startup form (Tally) for editorial consideration; fee not stated; paid Startup Booster packages exist separately; India-only'),
  ('indiamart.com', 'IndiaMART', 'business_listing', '{"ecommerce","manufacturing"}'::text[], '{"IN"}'::text[], 'https://www.indiamart.com/', 'https://seller.indiamart.com/', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "high", "free_listing": "freemium", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION", "also_in": "standalone curated list"}}'::jsonb, true, 'unknown', 'unverified', 'Free listing in 3 steps; name and phone required; minimum 3 products/services; paid seller packages'),
  ('indiehackers.com', 'Indie Hackers', 'other', '{"technology"}'::text[], '{}'::text[], 'https://www.indiehackers.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "yes", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Product pages and posts; 403 on fetch'),
  ('infobel.com', 'Infobel', 'business_listing', '{}'::text[], '{}'::text[], 'https://www.infobel.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'International business directory; 403 on fetch'),
  ('justdial.com', 'Justdial', 'business_listing', '{}'::text[], '{"IN"}'::text[], 'https://www.justdial.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "medium", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION", "also_in": "standalone curated list"}}'::jsonb, true, 'unknown', 'unverified', 'Free listing widely documented; mobile OTP verification typical; aggressive paid package sales calls; 403 on fetch'),
  ('kompass.com', 'Kompass', 'business_listing', '{"manufacturing","professional_services"}'::text[], '{}'::text[], 'https://www.kompass.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION", "also_in": "standalone curated list"}}'::jsonb, true, 'unknown', 'unverified', 'B2B directory with free basic listing historically; 403 on fetch'),
  ('launchingnext.com', 'Launching Next', 'startup_directory', '{"technology"}'::text[], '{}'::text[], 'https://www.launchingnext.com/', 'https://www.launchingnext.com/submit/', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "high", "free_listing": "freemium", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, false, 'unknown', 'unverified', 'Submission free (reviewed daily); optional $99 upgrade for 1-business-day review; sources disagree on link type'),
  ('linkedin.com', 'LinkedIn Company Page', 'business_listing', '{}'::text[], '{}'::text[], 'https://www.linkedin.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "yes", "checked_on": null, "submission_method": "MANUAL_SUBMISSION", "also_in": "standalone curated list"}}'::jsonb, true, 'nofollow', 'unverified', 'Free company page; requires personal LinkedIn account with sufficient history; Company page created by an employee account.'),
  ('lybrate.com', 'Lybrate', 'industry_directory', '{"healthcare"}'::text[], '{"IN"}'::text[], 'https://www.lybrate.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "standalone curated list (2026-11-23)", "confidence": "medium"}}'::jsonb, true, 'unknown', 'unverified', NULL),
  ('magicbricks.com', 'Magicbricks', 'industry_directory', '{"real_estate"}'::text[], '{"IN"}'::text[], 'https://www.magicbricks.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "standalone curated list (2026-11-23)", "confidence": "medium"}}'::jsonb, true, 'unknown', 'unverified', NULL),
  ('manta.com', 'Manta', 'business_listing', '{}'::text[], '{"US"}'::text[], 'https://www.manta.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "medium", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Free company listing per multiple lists; paid marketing upsells; 403 on fetch'),
  ('martech.org', 'MarTech', 'guest_post', '{"marketing_agency"}'::text[], '{}'::text[], 'https://martech.org/', NULL, 'outreach-email', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "yes", "checked_on": null, "submission_method": "EDITORIAL_OUTREACH"}}'::jsonb, false, 'unknown', 'unverified', 'Sister site of Search Engine Land; contributor process unverified'),
  ('martechseries.com', 'MarTech Series', 'guest_post', '{"marketing_agency"}'::text[], '{}'::text[], 'https://martechseries.com/', NULL, 'outreach-email', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "yes", "checked_on": "2026-11-16", "submission_method": "EDITORIAL_OUTREACH"}}'::jsonb, false, 'unknown', 'unverified', 'Guest Authors section exists but no public guidelines; only contact is a sales page - confirm it is not paid placement; Check first: may be paid-only.'),
  ('medium.com', 'Medium', 'other', '{}'::text[], '{}'::text[], 'https://medium.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Free to publish; membership paid for readers; 403 on fetch'),
  ('merchantcircle.com', 'MerchantCircle', 'business_listing', '{}'::text[], '{"US"}'::text[], 'https://www.merchantcircle.com/', 'https://www.merchantcircle.com/business_homepage', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "high", "free_listing": "yes", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Homepage advertises free listing setup in under 5 minutes; site active in 2026'),
  ('microlaunch.net', 'Microlaunch', 'startup_directory', '{"technology"}'::text[], '{}'::text[], 'https://microlaunch.net/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "medium", "free_listing": "freemium", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Free queue per third-party lists; Pro launches paid; New Launch flow requires login'),
  ('mouthshut.com', 'MouthShut', 'review_platform', '{}'::text[], '{"IN"}'::text[], 'https://www.mouthshut.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Indian consumer review site; brand claim flow unverified'),
  ('n49.com', 'n49', 'business_listing', '{}'::text[], '{"CA"}'::text[], 'https://www.n49.com/', 'https://www.n49.com/add-business', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "high", "free_listing": "yes", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'List for free link on homepage; Canada-focused'),
  ('nasscom.in', 'NASSCOM', 'association', '{"technology"}'::text[], '{"IN"}'::text[], 'https://nasscom.in/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "standalone curated list (2026-11-23)", "confidence": "medium"}}'::jsonb, true, 'unknown', 'unverified', 'Membership-based.'),
  ('news.ycombinator.com', 'Hacker News (Show HN)', 'other', '{"technology"}'::text[], '{}'::text[], 'https://news.ycombinator.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "yes", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'retired', 'Show HN posts; strict anti-promotion norms; new accounts limited; Retired from discovery: community rules forbid posting to obtain links.'),
  ('nextdoor.com', 'Nextdoor Business', 'business_listing', '{}'::text[], '{"US"}'::text[], 'https://business.nextdoor.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Free business page; ads paid; available in select countries'),
  ('niche.com', 'Niche', 'review_platform', '{"education"}'::text[], '{"US"}'::text[], 'https://www.niche.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "standalone curated list (2026-11-23)", "confidence": "medium"}}'::jsonb, true, 'unknown', 'unverified', NULL),
  ('opendi.com', 'Opendi', 'business_listing', '{}'::text[], '{}'::text[], 'https://www.opendi.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "freemium", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Network of local directories in 36 countries with country-specific service domains (e.g. service.opendi.co.uk/listings); pricing not stated'),
  ('opentable.com', 'OpenTable', 'business_listing', '{"hospitality"}'::text[], '{"US","GB","CA","AU","DE","IE"}'::text[], 'https://www.opentable.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "standalone curated list (2026-11-23)", "confidence": "medium"}}'::jsonb, true, 'unknown', 'unverified', NULL),
  ('owler.com', 'Owler', 'business_listing', '{}'::text[], '{}'::text[], 'https://www.owler.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "yes", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Company profiles editable by members; fetch timed out'),
  ('peerlist.io', 'Peerlist', 'business_listing', '{"technology"}'::text[], '{}'::text[], 'https://peerlist.io/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "medium", "free_listing": "yes", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Professional profiles plus Launchpad for projects (free per third-party lists); 403 on fetch'),
  ('pinterest.com', 'Pinterest Business', 'business_listing', '{}'::text[], '{}'::text[], 'https://business.pinterest.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "yes", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Free business account with website claim'),
  ('practo.com', 'Practo', 'industry_directory', '{"healthcare"}'::text[], '{"IN","SG"}'::text[], 'https://www.practo.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "standalone curated list (2026-11-23)", "confidence": "medium"}}'::jsonb, true, 'unknown', 'unverified', 'Practitioner registration verification.'),
  ('producthunt.com', 'Product Hunt', 'startup_directory', '{"technology"}'::text[], '{}'::text[], 'https://www.producthunt.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "medium", "free_listing": "yes", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION", "also_in": "standalone curated list"}}'::jsonb, true, 'nofollow', 'unverified', 'Launches free per multiple sources; launch guide at help.producthunt.com; account required; Launches are community-moderated; follow launch guidelines.'),
  ('quora.com', 'Quora', 'other', '{}'::text[], '{}'::text[], 'https://www.quora.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "yes", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'retired', 'Profile and answers; spaces for brands; Retired from discovery: community rules forbid posting to obtain links.'),
  ('reddit.com', 'Reddit', 'other', '{}'::text[], '{}'::text[], 'https://www.reddit.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "yes", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'retired', 'Subreddit rules on self-promotion vary (e.g. r/SEO r/startups); fetch blocked; Retired from discovery: community rules forbid posting to obtain links.'),
  ('rightmove.co.uk', 'Rightmove', 'industry_directory', '{"real_estate"}'::text[], '{"GB"}'::text[], 'https://www.rightmove.co.uk/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "standalone curated list (2026-11-23)", "confidence": "medium"}}'::jsonb, true, 'unknown', 'unverified', 'Agents/developers only.'),
  ('saashub.com', 'SaaSHub', 'industry_directory', '{"technology"}'::text[], '{}'::text[], 'https://www.saashub.com/', 'https://www.saashub.com/services/submit', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "medium", "free_listing": "freemium", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION", "also_in": "standalone curated list"}}'::jsonb, true, 'unknown', 'unverified', 'Product must be submitted and verified first; Submit tool is free; featured placement paid'),
  ('saasworthy.com', 'SaaSworthy', 'industry_directory', '{"technology"}'::text[], '{}'::text[], 'https://www.saasworthy.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Free vendor listing from memory only'),
  ('searchenginejournal.com', 'Search Engine Journal', 'guest_post', '{"marketing_agency"}'::text[], '{}'::text[], 'https://www.searchenginejournal.com/', 'https://www.searchenginejournal.com/write-for-search-engine-journal/', 'outreach-email', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "high", "free_listing": "yes", "checked_on": "2026-11-16", "submission_method": "EDITORIAL_OUTREACH"}}'::jsonb, false, 'unknown', 'unverified', 'Contributor application form reviewed by editors; no promotional links or CTAs allowed; disclosure required; sponsored content via sales only'),
  ('searchengineland.com', 'Search Engine Land', 'guest_post', '{"marketing_agency"}'::text[], '{}'::text[], 'https://searchengineland.com/', NULL, 'outreach-email', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "yes", "checked_on": null, "submission_method": "EDITORIAL_OUTREACH"}}'::jsonb, false, 'unknown', 'unverified', 'Contributor program believed to exist; contribute page returned 403 - confirm guidelines'),
  ('selectedfirms.co', 'SelectedFirms', 'agency_directory', '{"marketing_agency","technology"}'::text[], '{}'::text[], 'https://selectedfirms.co/', 'https://selectedfirms.co/get-listed', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "freemium", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Get Listed page exists; free tier NOT confirmed - verify pricing before shipping; Check first: may be paid-only.'),
  ('shiksha.com', 'Shiksha', 'industry_directory', '{"education"}'::text[], '{"IN"}'::text[], 'https://www.shiksha.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "standalone curated list (2026-11-23)", "confidence": "medium"}}'::jsonb, true, 'unknown', 'unverified', NULL),
  ('smartcustomer.com', 'Smart Customer (formerly Sitejabber business)', 'review_platform', '{}'::text[], '{}'::text[], 'https://www.smartcustomer.com/business/', 'https://biz.smartcustomer.com/register', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "high", "free_listing": "freemium", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'sitejabber.com/business 301-redirects here; Claim your free profile; paid plans at /business/pricing'),
  ('softwaresuggest.com', 'SoftwareSuggest', 'industry_directory', '{"technology"}'::text[], '{"IN"}'::text[], 'https://www.softwaresuggest.com/', 'https://www.softwaresuggest.com/vendors', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "high", "free_listing": "freemium", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Register For Free vendor signup; India-based with global listings; paid lead/PPC upsells'),
  ('sortlist.com', 'Sortlist', 'agency_directory', '{"marketing_agency","professional_services"}'::text[], '{}'::text[], 'https://www.sortlist.com/', 'https://www.sortlist.com/apply', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "medium", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION", "also_in": "standalone curated list"}}'::jsonb, true, 'unknown', 'unverified', 'Free provider profile per help center; asks agencies to join an onboarding webinar; Sortlist+ from 129 EUR/mo; Europe-heavy audience'),
  ('sourceforge.net', 'SourceForge Business Software', 'industry_directory', '{"technology"}'::text[], '{}'::text[], 'https://sourceforge.net/software/', 'https://sourceforge.net/software/vendors/new', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "medium", "free_listing": "freemium", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Basic listings mentioned alongside paid upgrades; cost of basic not stated - check /software/vendors/pricing/'),
  ('startupblink.com', 'StartupBlink', 'startup_directory', '{"technology"}'::text[], '{}'::text[], 'https://www.startupblink.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "yes", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Startup map with free add; 403 on fetch'),
  ('startupindia.gov.in', 'Startup India Hub', 'startup_directory', '{"technology"}'::text[], '{"IN"}'::text[], 'https://www.startupindia.gov.in/', 'https://www.startupindia.gov.in', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "medium", "free_listing": "yes", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Government portal; free profile and DPIIT recognition; profile moderation ~48h; DPIIT needs PAN/incorporation and eligibility (age/entity type); 403 on fetch'),
  ('startupranking.com', 'Startup Ranking', 'startup_directory', '{"technology"}'::text[], '{}'::text[], 'https://www.startupranking.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "yes", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', '403 on fetch; activity unverified'),
  ('startupstash.com', 'Startup Stash', 'industry_directory', '{"technology"}'::text[], '{}'::text[], 'https://startupstash.com/', 'https://startupstash.com/add-listing/', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "medium", "free_listing": "freemium", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Add-listing link confirmed; free submission per third-party lists but pricing not shown on site - verify'),
  ('storeboard.com', 'Storeboard', 'business_listing', '{}'::text[], '{"US"}'::text[], 'https://www.storeboard.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "yes", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', '403 on fetch; free account from memory only'),
  ('sulekha.com', 'Sulekha', 'business_listing', '{}'::text[], '{"IN"}'::text[], 'https://www.sulekha.com/', 'https://www.sulekha.com/list-your-business', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "high", "free_listing": "freemium", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION", "also_in": "standalone curated list"}}'::jsonb, true, 'unknown', 'unverified', 'List Your Business - Free; mobile number mandatory; leads and ads paid; India plus some US cities'),
  ('superbcompanies.com', 'SuperbCompanies', 'agency_directory', '{"marketing_agency","technology"}'::text[], '{}'::text[], 'https://www.superbcompanies.com/', 'https://www.superbcompanies.com/get-listed/', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "freemium", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Get-listed page shows sign-in/register only; free tier NOT confirmed - verify; Check first: may be paid-only.'),
  ('techbehemoths.com', 'TechBehemoths', 'agency_directory', '{"marketing_agency","technology"}'::text[], '{}'::text[], 'https://techbehemoths.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "medium", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Free profile (5 services/2 locations) and free one-time verification per 2026 press release; CORE/PRO paid; weak profiles purged every 6 months; 403 on fetch'),
  ('techjockey.com', 'Techjockey', 'industry_directory', '{"technology"}'::text[], '{"IN"}'::text[], 'https://www.techjockey.com/', 'https://esellerhub.techjockey.com', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "high", "free_listing": "yes", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'FAQ: no listing fees; email verification; each product reviewed before going live; India-focused'),
  ('themanifest.com', 'The Manifest', 'agency_directory', '{"marketing_agency","professional_services","technology"}'::text[], '{}'::text[], 'https://themanifest.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION", "also_in": "standalone curated list"}}'::jsonb, true, 'unknown', 'unverified', 'Clutch sister site; profiles believed to be managed through Clutch vendor account - verify; 403 on fetch'),
  ('thomasnet.com', 'Thomasnet', 'business_listing', '{"manufacturing"}'::text[], '{"US"}'::text[], 'https://www.thomasnet.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION", "also_in": "standalone curated list"}}'::jsonb, true, 'unknown', 'unverified', 'Free supplier listing for North American industrial suppliers (from memory); 403 on fetch'),
  ('thumbtack.com', 'Thumbtack', 'business_listing', '{}'::text[], '{"US"}'::text[], 'https://www.thumbtack.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Free pro profile; pay per lead; US only'),
  ('topdevelopers.co', 'TopDevelopers.co', 'agency_directory', '{"marketing_agency","technology"}'::text[], '{}'::text[], 'https://www.topdevelopers.co/', 'https://www.topdevelopers.co/listing-packages', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "high", "free_listing": "freemium", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Basic listing free (placement from page 2 onward); Premium $399/mo; Sponsored custom'),
  ('tracxn.com', 'Tracxn', 'startup_directory', '{"technology"}'::text[], '{"IN"}'::text[], 'https://tracxn.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Company profile claim flow unverified; core product is paid data platform'),
  ('tradeindia.com', 'TradeIndia', 'business_listing', '{"manufacturing"}'::text[], '{"IN"}'::text[], 'https://www.tradeindia.com/', 'https://www.tradeindia.com/join_now/verification.html', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "medium", "free_listing": "freemium", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION", "also_in": "standalone curated list"}}'::jsonb, true, 'unknown', 'unverified', 'Free account creation (+91 phone field); paid membership plans; free seller listing scope not explicit'),
  ('tripadvisor.com', 'Tripadvisor', 'review_platform', '{"hospitality"}'::text[], '{}'::text[], 'https://www.tripadvisor.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "standalone curated list (2026-11-23)", "confidence": "medium"}}'::jsonb, true, 'nofollow', 'unverified', NULL),
  ('truelocal.com.au', 'True Local', 'business_listing', '{}'::text[], '{"AU"}'::text[], 'https://www.truelocal.com.au/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "yes", "checked_on": null, "submission_method": "MANUAL_SUBMISSION", "also_in": "standalone curated list"}}'::jsonb, true, 'unknown', 'unverified', 'Australia only; 403 on fetch'),
  ('trustpilot.com', 'Trustpilot', 'review_platform', '{}'::text[], '{}'::text[], 'https://www.trustpilot.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Free business account with paid plans; /business URL returned 404 - signup URL unverified'),
  ('trustradius.com', 'TrustRadius', 'review_platform', '{"technology"}'::text[], '{}'::text[], 'https://www.trustradius.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Free vendor profile from memory; 403 on fetch'),
  ('tupalo.co', 'Tupalo', 'business_listing', '{}'::text[], '{}'::text[], 'https://www.tupalo.co/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "yes", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', '403 on fetch; activity level unverified'),
  ('unbiased.co.uk', 'Unbiased', 'industry_directory', '{"finance"}'::text[], '{"GB"}'::text[], 'https://www.unbiased.co.uk/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "standalone curated list (2026-11-23)", "confidence": "medium"}}'::jsonb, true, 'unknown', 'unverified', 'Regulated advisers only.'),
  ('upcity.com', 'UpCity', 'agency_directory', '{"marketing_agency","professional_services"}'::text[], '{"US"}'::text[], 'https://upcity.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "medium", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION", "also_in": "standalone curated list"}}'::jsonb, true, 'unknown', 'unverified', 'Free profile started via inquiry form then UpCity onboarding call; sponsored profiles paid; fetch failed'),
  ('upwork.com', 'Upwork', 'business_listing', '{"marketing_agency","technology"}'::text[], '{}'::text[], 'https://www.upwork.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Free freelancer/agency profile; bidding uses paid Connects; profile approval not guaranteed'),
  ('uschamber.com', 'U.S. Chamber of Commerce', 'association', '{}'::text[], '{"US"}'::text[], 'https://www.uschamber.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "standalone curated list (2026-11-23)", "confidence": "medium"}}'::jsonb, true, 'unknown', 'unverified', NULL),
  ('visualobjects.com', 'Visual Objects', 'agency_directory', '{"marketing_agency","professional_services"}'::text[], '{}'::text[], 'https://visualobjects.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Clutch sister site for creative firms; listing flow not verified'),
  ('vouchedfor.co.uk', 'VouchedFor', 'review_platform', '{"finance","professional_services"}'::text[], '{"GB"}'::text[], 'https://www.vouchedfor.co.uk/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "standalone curated list (2026-11-23)", "confidence": "medium"}}'::jsonb, true, 'unknown', 'unverified', NULL),
  ('wellfound.com', 'Wellfound', 'startup_directory', '{"technology"}'::text[], '{}'::text[], 'https://wellfound.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION", "also_in": "standalone curated list"}}'::jsonb, true, 'unknown', 'unverified', 'Formerly AngelList Talent; free company profile historically; page content not readable'),
  ('yalwa.com', 'Yalwa', 'business_listing', '{}'::text[], '{}'::text[], 'https://www.yalwa.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "yes", "checked_on": null, "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', '403 on fetch; site health/quality should be reviewed before shipping'),
  ('yell.com', 'Yell', 'business_listing', '{}'::text[], '{"GB"}'::text[], 'https://www.yell.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION", "also_in": "standalone curated list"}}'::jsonb, true, 'unknown', 'unverified', 'UK only; free listing historically offered with paid upsells; 403 on fetch'),
  ('yellowpages.ca', 'Yellow Pages Canada', 'business_listing', '{}'::text[], '{"CA"}'::text[], 'https://www.yellowpages.ca/', 'https://solutions.yp.ca/free-listing', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "high", "free_listing": "freemium", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION", "also_in": "standalone curated list"}}'::jsonb, true, 'unknown', 'unverified', 'Free listing page linked from homepage; paid advertising upsells; Canada only'),
  ('yellowpages.com', 'YP.com (Yellow Pages US)', 'business_listing', '{}'::text[], '{"US"}'::text[], 'https://www.yellowpages.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "freemium", "checked_on": null, "submission_method": "MANUAL_SUBMISSION", "also_in": "standalone curated list"}}'::jsonb, true, 'unknown', 'unverified', 'Free basic listing historically via Thryv; 403 on fetch - verify current flow'),
  ('yellowpages.com.au', 'Yellow Pages Australia', 'business_listing', '{}'::text[], '{"AU"}'::text[], 'https://www.yellowpages.com.au/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "standalone curated list (2026-11-23)", "confidence": "medium"}}'::jsonb, true, 'unknown', 'unverified', NULL),
  ('yelp.com', 'Yelp', 'business_listing', '{}'::text[], '{}'::text[], 'https://www.yelp.com/', 'https://biz.yelp.com/claim', 'manual-editorial', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "high", "free_listing": "freemium", "checked_on": "2026-11-16", "submission_method": "MANUAL_SUBMISSION"}}'::jsonb, true, 'unknown', 'unverified', 'Official page: It''s free to be on Yelp; ads/upgrades paid; phone verification typical'),
  ('yourstory.com', 'YourStory', 'guest_post', '{"technology"}'::text[], '{"IN"}'::text[], 'https://yourstory.com/', NULL, 'outreach-email', 'manual_only', '{"review": {"source": "packages/db/seed/link_sources.csv", "confidence": "low", "free_listing": "yes", "checked_on": null, "submission_method": "EDITORIAL_OUTREACH"}}'::jsonb, false, 'unknown', 'unverified', 'Indian startup media; story pitch/submission flow unverified (403 on fetch)'),
  ('zillow.com', 'Zillow (agents)', 'industry_directory', '{"real_estate"}'::text[], '{"US"}'::text[], 'https://www.zillow.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "standalone curated list (2026-11-23)", "confidence": "medium"}}'::jsonb, true, 'unknown', 'unverified', NULL),
  ('zocdoc.com', 'Zocdoc', 'industry_directory', '{"healthcare"}'::text[], '{"US"}'::text[], 'https://www.zocdoc.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "standalone curated list (2026-11-23)", "confidence": "medium"}}'::jsonb, true, 'unknown', 'unverified', NULL),
  ('zomato.com', 'Zomato', 'business_listing', '{"hospitality"}'::text[], '{"IN","AE"}'::text[], 'https://www.zomato.com/', NULL, 'manual-editorial', 'manual_only', '{"review": {"source": "standalone curated list (2026-11-23)", "confidence": "medium"}}'::jsonb, true, 'unknown', 'unverified', NULL)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Platform default rate limits per adapter (workspaces add per-domain limits of their own).
INSERT INTO backlink_domain_limits (scope, key, max_per_day, max_per_week, min_interval_seconds) VALUES
  ('adapter', 'browser-form', 20, 100, 0),
  ('adapter', 'http-form', 30, 150, 0),
  ('adapter', 'listing-api-v1', 50, 250, 0),
  ('adapter', 'wordpress-draft', 5, 20, 0),
  ('adapter', 'outreach-email', 20, 100, 0)
ON CONFLICT DO NOTHING
--> statement-breakpoint
-- ── Plans: automated submissions per month ──────────────────────────────────
ALTER TABLE plans NO FORCE ROW LEVEL SECURITY
--> statement-breakpoint
UPDATE plans SET limits = limits || jsonb_build_object('backlink_submissions_month',
  CASE id WHEN 'free' THEN 20 WHEN 'pro' THEN 200 WHEN 'agency_free' THEN 50 WHEN 'agency' THEN 1000 ELSE 20 END)
WHERE NOT limits ? 'backlink_submissions_month'
--> statement-breakpoint
ALTER TABLE plans FORCE ROW LEVEL SECURITY
--> statement-breakpoint
-- ── RLS: every table forced, tenant isolation bound to app_current_org() ────
--> statement-breakpoint
ALTER TABLE business_profiles ENABLE ROW LEVEL SECURITY
--> statement-breakpoint
ALTER TABLE business_profiles FORCE ROW LEVEL SECURITY
--> statement-breakpoint
CREATE POLICY tenant_isolation ON business_profiles
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org())
--> statement-breakpoint
ALTER TABLE backlink_website_settings ENABLE ROW LEVEL SECURITY
--> statement-breakpoint
ALTER TABLE backlink_website_settings FORCE ROW LEVEL SECURITY
--> statement-breakpoint
CREATE POLICY tenant_isolation ON backlink_website_settings
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org())
--> statement-breakpoint
ALTER TABLE backlink_campaigns ENABLE ROW LEVEL SECURITY
--> statement-breakpoint
ALTER TABLE backlink_campaigns FORCE ROW LEVEL SECURITY
--> statement-breakpoint
CREATE POLICY tenant_isolation ON backlink_campaigns
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org())
--> statement-breakpoint
ALTER TABLE backlink_prospects ENABLE ROW LEVEL SECURITY
--> statement-breakpoint
ALTER TABLE backlink_prospects FORCE ROW LEVEL SECURITY
--> statement-breakpoint
CREATE POLICY tenant_isolation ON backlink_prospects
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org())
--> statement-breakpoint
ALTER TABLE backlink_opportunities ENABLE ROW LEVEL SECURITY
--> statement-breakpoint
ALTER TABLE backlink_opportunities FORCE ROW LEVEL SECURITY
--> statement-breakpoint
CREATE POLICY tenant_isolation ON backlink_opportunities
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org())
--> statement-breakpoint
ALTER TABLE backlink_assets ENABLE ROW LEVEL SECURITY
--> statement-breakpoint
ALTER TABLE backlink_assets FORCE ROW LEVEL SECURITY
--> statement-breakpoint
CREATE POLICY tenant_isolation ON backlink_assets
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org())
--> statement-breakpoint
ALTER TABLE backlink_submissions ENABLE ROW LEVEL SECURITY
--> statement-breakpoint
ALTER TABLE backlink_submissions FORCE ROW LEVEL SECURITY
--> statement-breakpoint
CREATE POLICY tenant_isolation ON backlink_submissions
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org())
--> statement-breakpoint
ALTER TABLE backlink_verifications ENABLE ROW LEVEL SECURITY
--> statement-breakpoint
ALTER TABLE backlink_verifications FORCE ROW LEVEL SECURITY
--> statement-breakpoint
CREATE POLICY tenant_isolation ON backlink_verifications
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org())
--> statement-breakpoint
ALTER TABLE backlink_tasks ENABLE ROW LEVEL SECURITY
--> statement-breakpoint
ALTER TABLE backlink_tasks FORCE ROW LEVEL SECURITY
--> statement-breakpoint
CREATE POLICY tenant_isolation ON backlink_tasks
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org())
--> statement-breakpoint
ALTER TABLE backlink_outreach ENABLE ROW LEVEL SECURITY
--> statement-breakpoint
ALTER TABLE backlink_outreach FORCE ROW LEVEL SECURITY
--> statement-breakpoint
CREATE POLICY tenant_isolation ON backlink_outreach
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org())
--> statement-breakpoint
ALTER TABLE backlink_recovery_campaigns ENABLE ROW LEVEL SECURITY
--> statement-breakpoint
ALTER TABLE backlink_recovery_campaigns FORCE ROW LEVEL SECURITY
--> statement-breakpoint
CREATE POLICY tenant_isolation ON backlink_recovery_campaigns
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org())
--> statement-breakpoint
ALTER TABLE backlink_approvals ENABLE ROW LEVEL SECURITY
--> statement-breakpoint
ALTER TABLE backlink_approvals FORCE ROW LEVEL SECURITY
--> statement-breakpoint
CREATE POLICY tenant_isolation ON backlink_approvals
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org())
--> statement-breakpoint
ALTER TABLE backlink_exclusions ENABLE ROW LEVEL SECURITY
--> statement-breakpoint
ALTER TABLE backlink_exclusions FORCE ROW LEVEL SECURITY
--> statement-breakpoint
CREATE POLICY tenant_isolation ON backlink_exclusions
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org())
--> statement-breakpoint
ALTER TABLE backlink_campaign_settings ENABLE ROW LEVEL SECURITY
--> statement-breakpoint
ALTER TABLE backlink_campaign_settings FORCE ROW LEVEL SECURITY
--> statement-breakpoint
CREATE POLICY tenant_isolation ON backlink_campaign_settings
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org())
--> statement-breakpoint
ALTER TABLE backlink_costs ENABLE ROW LEVEL SECURITY
--> statement-breakpoint
ALTER TABLE backlink_costs FORCE ROW LEVEL SECURITY
--> statement-breakpoint
CREATE POLICY tenant_isolation ON backlink_costs
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org())
--> statement-breakpoint
ALTER TABLE backlink_submission_events ENABLE ROW LEVEL SECURITY
--> statement-breakpoint
ALTER TABLE backlink_submission_events FORCE ROW LEVEL SECURITY
--> statement-breakpoint
CREATE POLICY tenant_isolation ON backlink_submission_events
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org())
--> statement-breakpoint
ALTER TABLE backlink_submission_evidence ENABLE ROW LEVEL SECURITY
--> statement-breakpoint
ALTER TABLE backlink_submission_evidence FORCE ROW LEVEL SECURITY
--> statement-breakpoint
CREATE POLICY tenant_isolation ON backlink_submission_evidence
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org())
--> statement-breakpoint
ALTER TABLE backlink_sources ENABLE ROW LEVEL SECURITY
--> statement-breakpoint
ALTER TABLE backlink_sources FORCE ROW LEVEL SECURITY
--> statement-breakpoint
CREATE POLICY tenant_isolation ON backlink_sources
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org())
--> statement-breakpoint
ALTER TABLE backlink_domain_limits ENABLE ROW LEVEL SECURITY
--> statement-breakpoint
ALTER TABLE backlink_domain_limits FORCE ROW LEVEL SECURITY
--> statement-breakpoint
CREATE POLICY tenant_isolation ON backlink_domain_limits
  USING (organization_id = app_current_org())
  WITH CHECK (organization_id = app_current_org())
--> statement-breakpoint
-- Global catalogue rows (organization_id NULL) are readable by every workspace and writable by none.
-- (UPDATE/DELETE still need tenant_isolation, which never matches a global row.)
--> statement-breakpoint
CREATE POLICY global_read ON backlink_sources FOR SELECT USING (organization_id IS NULL)
--> statement-breakpoint
CREATE POLICY global_read ON backlink_domain_limits FOR SELECT USING (organization_id IS NULL)
--> statement-breakpoint
-- ── Client scope: app_user sees rows only for websites visible to the member ─
--> statement-breakpoint
CREATE POLICY website_visible ON business_profiles AS RESTRICTIVE TO app_user
  USING (EXISTS (SELECT 1 FROM websites w WHERE w.id = business_profiles.website_id))
  WITH CHECK (EXISTS (SELECT 1 FROM websites w WHERE w.id = business_profiles.website_id))
--> statement-breakpoint
CREATE POLICY website_visible ON backlink_website_settings AS RESTRICTIVE TO app_user
  USING (EXISTS (SELECT 1 FROM websites w WHERE w.id = backlink_website_settings.website_id))
  WITH CHECK (EXISTS (SELECT 1 FROM websites w WHERE w.id = backlink_website_settings.website_id))
--> statement-breakpoint
CREATE POLICY website_visible ON backlink_campaigns AS RESTRICTIVE TO app_user
  USING (EXISTS (SELECT 1 FROM websites w WHERE w.id = backlink_campaigns.website_id))
  WITH CHECK (EXISTS (SELECT 1 FROM websites w WHERE w.id = backlink_campaigns.website_id))
--> statement-breakpoint
CREATE POLICY website_visible ON backlink_prospects AS RESTRICTIVE TO app_user
  USING (EXISTS (SELECT 1 FROM websites w WHERE w.id = backlink_prospects.website_id))
  WITH CHECK (EXISTS (SELECT 1 FROM websites w WHERE w.id = backlink_prospects.website_id))
--> statement-breakpoint
CREATE POLICY website_visible ON backlink_opportunities AS RESTRICTIVE TO app_user
  USING (EXISTS (SELECT 1 FROM websites w WHERE w.id = backlink_opportunities.website_id))
  WITH CHECK (EXISTS (SELECT 1 FROM websites w WHERE w.id = backlink_opportunities.website_id))
--> statement-breakpoint
CREATE POLICY website_visible ON backlink_assets AS RESTRICTIVE TO app_user
  USING (EXISTS (SELECT 1 FROM websites w WHERE w.id = backlink_assets.website_id))
  WITH CHECK (EXISTS (SELECT 1 FROM websites w WHERE w.id = backlink_assets.website_id))
--> statement-breakpoint
CREATE POLICY website_visible ON backlink_submissions AS RESTRICTIVE TO app_user
  USING (EXISTS (SELECT 1 FROM websites w WHERE w.id = backlink_submissions.website_id))
  WITH CHECK (EXISTS (SELECT 1 FROM websites w WHERE w.id = backlink_submissions.website_id))
--> statement-breakpoint
CREATE POLICY website_visible ON backlink_verifications AS RESTRICTIVE TO app_user
  USING (EXISTS (SELECT 1 FROM websites w WHERE w.id = backlink_verifications.website_id))
  WITH CHECK (EXISTS (SELECT 1 FROM websites w WHERE w.id = backlink_verifications.website_id))
--> statement-breakpoint
CREATE POLICY website_visible ON backlink_tasks AS RESTRICTIVE TO app_user
  USING (EXISTS (SELECT 1 FROM websites w WHERE w.id = backlink_tasks.website_id))
  WITH CHECK (EXISTS (SELECT 1 FROM websites w WHERE w.id = backlink_tasks.website_id))
--> statement-breakpoint
CREATE POLICY website_visible ON backlink_outreach AS RESTRICTIVE TO app_user
  USING (EXISTS (SELECT 1 FROM websites w WHERE w.id = backlink_outreach.website_id))
  WITH CHECK (EXISTS (SELECT 1 FROM websites w WHERE w.id = backlink_outreach.website_id))
--> statement-breakpoint
CREATE POLICY website_visible ON backlink_recovery_campaigns AS RESTRICTIVE TO app_user
  USING (EXISTS (SELECT 1 FROM websites w WHERE w.id = backlink_recovery_campaigns.website_id))
  WITH CHECK (EXISTS (SELECT 1 FROM websites w WHERE w.id = backlink_recovery_campaigns.website_id))
--> statement-breakpoint
CREATE POLICY website_visible ON backlink_approvals AS RESTRICTIVE TO app_user
  USING (EXISTS (SELECT 1 FROM websites w WHERE w.id = backlink_approvals.website_id))
  WITH CHECK (EXISTS (SELECT 1 FROM websites w WHERE w.id = backlink_approvals.website_id))
--> statement-breakpoint
CREATE POLICY website_visible ON backlink_exclusions AS RESTRICTIVE TO app_user
  USING (website_id IS NULL OR EXISTS (SELECT 1 FROM websites w WHERE w.id = backlink_exclusions.website_id))
  WITH CHECK (website_id IS NULL OR EXISTS (SELECT 1 FROM websites w WHERE w.id = backlink_exclusions.website_id))
--> statement-breakpoint
CREATE POLICY parent_visible ON backlink_campaign_settings AS RESTRICTIVE TO app_user
  USING (EXISTS (SELECT 1 FROM backlink_campaigns p WHERE p.id = backlink_campaign_settings.campaign_id))
  WITH CHECK (EXISTS (SELECT 1 FROM backlink_campaigns p WHERE p.id = backlink_campaign_settings.campaign_id))
--> statement-breakpoint
CREATE POLICY parent_visible ON backlink_costs AS RESTRICTIVE TO app_user
  USING (EXISTS (SELECT 1 FROM backlink_campaigns p WHERE p.id = backlink_costs.campaign_id))
  WITH CHECK (EXISTS (SELECT 1 FROM backlink_campaigns p WHERE p.id = backlink_costs.campaign_id))
--> statement-breakpoint
CREATE POLICY parent_visible ON backlink_submission_events AS RESTRICTIVE TO app_user
  USING (EXISTS (SELECT 1 FROM backlink_submissions p WHERE p.id = backlink_submission_events.submission_id))
  WITH CHECK (EXISTS (SELECT 1 FROM backlink_submissions p WHERE p.id = backlink_submission_events.submission_id))
--> statement-breakpoint
CREATE POLICY parent_visible ON backlink_submission_evidence AS RESTRICTIVE TO app_user
  USING (EXISTS (SELECT 1 FROM backlink_submissions p WHERE p.id = backlink_submission_evidence.submission_id))
  WITH CHECK (EXISTS (SELECT 1 FROM backlink_submissions p WHERE p.id = backlink_submission_evidence.submission_id))
--> statement-breakpoint
-- ── Append-only history and evidence ─────────────────────────────────────────
REVOKE UPDATE, DELETE, TRUNCATE ON backlink_submission_events, backlink_submission_evidence FROM app_user;

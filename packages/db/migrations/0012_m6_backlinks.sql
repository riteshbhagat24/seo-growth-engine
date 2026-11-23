CREATE TABLE "backlink_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"website_id" uuid NOT NULL,
	"campaign_id" uuid,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"snapshot" jsonb NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"note" text,
	CONSTRAINT "backlink_approvals_subject_ck" CHECK (subject_type in ('submission', 'outreach', 'asset', 'autopilot_source')),
	CONSTRAINT "backlink_approvals_status_ck" CHECK (status in ('pending', 'approved', 'rejected', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "backlink_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"website_id" uuid NOT NULL,
	"campaign_id" uuid,
	"opportunity_id" uuid,
	"asset_type" text NOT NULL,
	"title" text,
	"body" text NOT NULL,
	"content_hash" text NOT NULL,
	"max_similarity" numeric(5, 4) DEFAULT '0' NOT NULL,
	"fact_check" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"generator" text NOT NULL,
	"profile_version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backlink_assets_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "backlink_assets_type_ck" CHECK (asset_type in ('short_description', 'long_description', 'company_profile', 'founder_bio', 'directory_listing', 'guest_post_pitch', 'article_draft', 'resource_request', 'partnership_pitch', 'outreach_email', 'recovery_email')),
	CONSTRAINT "backlink_assets_status_ck" CHECK (status in ('draft', 'approved', 'rejected', 'superseded'))
);
--> statement-breakpoint
CREATE TABLE "backlink_campaign_settings" (
	"campaign_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"max_daily_submissions" integer DEFAULT 5 NOT NULL,
	"max_weekly_submissions" integer DEFAULT 20 NOT NULL,
	"allowed_adapters" text[] DEFAULT '{}'::text[] NOT NULL,
	"excluded_domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"approval_required" boolean DEFAULT true NOT NULL,
	"auto_generate_assets" boolean DEFAULT true NOT NULL,
	"allow_listing_updates" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backlink_campaign_settings_daily_ck" CHECK (max_daily_submissions between 0 and 500),
	CONSTRAINT "backlink_campaign_settings_weekly_ck" CHECK (max_weekly_submissions between 0 and 2000)
);
--> statement-breakpoint
CREATE TABLE "backlink_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"website_id" uuid NOT NULL,
	"name" text NOT NULL,
	"industry" text NOT NULL,
	"target_countries" text[] DEFAULT '{}'::text[] NOT NULL,
	"target_keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"target_pages" text[] DEFAULT '{}'::text[] NOT NULL,
	"preferred_categories" text[] DEFAULT '{}'::text[] NOT NULL,
	"min_quality_score" integer DEFAULT 50 NOT NULL,
	"automation_mode" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backlink_campaigns_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "backlink_campaigns_id_site_org_uq" UNIQUE("id","website_id","organization_id"),
	CONSTRAINT "backlink_campaigns_score_ck" CHECK (min_quality_score between 0 and 100),
	CONSTRAINT "backlink_campaigns_mode_ck" CHECK (automation_mode is null or automation_mode in ('autopilot', 'supervised', 'manual')),
	CONSTRAINT "backlink_campaigns_status_ck" CHECK (status in ('draft', 'active', 'paused', 'completed', 'archived')),
	CONSTRAINT "backlink_campaigns_dates_ck" CHECK (ends_at is null or starts_at is null or ends_at > starts_at)
);
--> statement-breakpoint
CREATE TABLE "backlink_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"incurred_on" date NOT NULL,
	"category" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backlink_costs_category_ck" CHECK (category in ('labour', 'listing_fee', 'infrastructure', 'content', 'other')),
	CONSTRAINT "backlink_costs_amount_ck" CHECK (amount >= 0)
);
--> statement-breakpoint
CREATE TABLE "backlink_domain_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"max_per_day" integer NOT NULL,
	"max_per_week" integer NOT NULL,
	"min_interval_seconds" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backlink_domain_limits_scope_ck" CHECK (scope in ('domain', 'adapter')),
	CONSTRAINT "backlink_domain_limits_values_ck" CHECK (max_per_day >= 0 and max_per_week >= 0 and min_interval_seconds >= 0)
);
--> statement-breakpoint
CREATE TABLE "backlink_exclusions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"website_id" uuid,
	"campaign_id" uuid,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backlink_exclusions_kind_ck" CHECK (kind in ('domain', 'url', 'email'))
);
--> statement-breakpoint
CREATE TABLE "backlink_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"website_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"prospect_id" uuid NOT NULL,
	"source_id" uuid,
	"url" text NOT NULL,
	"url_normalized" text NOT NULL,
	"opportunity_type" text NOT NULL,
	"adapter_key" text NOT NULL,
	"discovery_method" text NOT NULL,
	"discovery_source" text NOT NULL,
	"discovery_evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'DISCOVERED' NOT NULL,
	"score" integer,
	"score_breakdown" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reject_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"qualified_at" timestamp with time zone,
	CONSTRAINT "backlink_opportunities_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "backlink_opportunities_id_site_org_uq" UNIQUE("id","website_id","organization_id"),
	CONSTRAINT "backlink_opportunities_campaign_url_uq" UNIQUE("campaign_id","url_normalized"),
	CONSTRAINT "backlink_opportunities_type_ck" CHECK (opportunity_type in ('business_listing', 'industry_directory', 'agency_directory', 'startup_directory', 'resource_page', 'guest_post', 'association', 'partner', 'review_platform', 'other')),
	CONSTRAINT "backlink_opportunities_method_ck" CHECK (discovery_method in ('curated_database', 'user_url', 'csv_import', 'competitor_csv', 'site_expansion', 'search_template_manual', 'permitted_api', 'recovery')),
	CONSTRAINT "backlink_opportunities_status_ck" CHECK (status in ('DISCOVERED', 'QUALIFIED', 'REJECTED', 'EXCLUDED', 'IN_PIPELINE', 'DONE')),
	CONSTRAINT "backlink_opportunities_score_ck" CHECK (score is null or score between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "backlink_outreach" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"website_id" uuid NOT NULL,
	"campaign_id" uuid,
	"opportunity_id" uuid,
	"prospect_id" uuid,
	"submission_id" uuid,
	"outreach_type" text NOT NULL,
	"contact_name" text,
	"contact_email" text,
	"contact_source_url" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"subject" text,
	"body" text,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"last_reply_at" timestamp with time zone,
	"followup_count" integer DEFAULT 0 NOT NULL,
	"next_followup_at" timestamp with time zone,
	"editorial_decision" text,
	"article_url" text,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backlink_outreach_type_ck" CHECK (outreach_type in ('guest_post', 'resource_page', 'partnership', 'recovery', 'other')),
	CONSTRAINT "backlink_outreach_status_ck" CHECK (status in ('draft', 'awaiting_approval', 'approved', 'sent', 'replied', 'follow_up_due', 'accepted', 'declined', 'article_submitted', 'published', 'opted_out', 'closed')),
	CONSTRAINT "backlink_outreach_decision_ck" CHECK (editorial_decision is null or editorial_decision in ('pending', 'accepted', 'rejected', 'revisions_requested'))
);
--> statement-breakpoint
CREATE TABLE "backlink_prospects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"website_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"homepage_url" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"score" integer,
	"score_breakdown" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reject_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"signals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_qualified_at" timestamp with time zone,
	CONSTRAINT "backlink_prospects_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "backlink_prospects_id_site_org_uq" UNIQUE("id","website_id","organization_id"),
	CONSTRAINT "backlink_prospects_site_domain_uq" UNIQUE("organization_id","website_id","domain"),
	CONSTRAINT "backlink_prospects_status_ck" CHECK (status in ('new', 'qualifying', 'qualified', 'rejected', 'excluded', 'error')),
	CONSTRAINT "backlink_prospects_score_ck" CHECK (score is null or score between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "backlink_recovery_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"website_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"detected_lost_at" timestamp with time zone DEFAULT now() NOT NULL,
	"diagnosis" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"outreach_id" uuid,
	"recovered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backlink_recovery_diagnosis_ck" CHECK (diagnosis in ('link_removed', 'page_gone', 'page_noindexed', 'attributes_changed', 'redirected', 'unknown')),
	CONSTRAINT "backlink_recovery_status_ck" CHECK (status in ('open', 'outreach_drafted', 'in_progress', 'recovered', 'abandoned'))
);
--> statement-breakpoint
CREATE TABLE "backlink_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"domain" text NOT NULL,
	"name" text NOT NULL,
	"source_type" text NOT NULL,
	"industries" text[] DEFAULT '{}'::text[] NOT NULL,
	"countries" text[] DEFAULT '{}'::text[] NOT NULL,
	"homepage_url" text NOT NULL,
	"submission_url" text,
	"adapter_key" text NOT NULL,
	"automation_permission" text DEFAULT 'none' NOT NULL,
	"permission_evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"form_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"api_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credentials_enc" text,
	"credentials_hint" text,
	"requires_account" boolean DEFAULT false NOT NULL,
	"link_type_expected" text,
	"curation_status" text DEFAULT 'unverified' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backlink_sources_type_ck" CHECK (source_type in ('business_listing', 'industry_directory', 'agency_directory', 'startup_directory', 'resource_page', 'guest_post', 'association', 'partner', 'review_platform', 'other')),
	CONSTRAINT "backlink_sources_permission_ck" CHECK (automation_permission in ('none', 'manual_only', 'tos_permits_form', 'explicit_permission', 'own_property', 'test_destination')),
	CONSTRAINT "backlink_sources_link_type_ck" CHECK (link_type_expected is null or link_type_expected in ('dofollow', 'nofollow', 'ugc', 'sponsored', 'unknown')),
	CONSTRAINT "backlink_sources_curation_ck" CHECK (curation_status in ('unverified', 'verified', 'retired'))
);
--> statement-breakpoint
CREATE TABLE "backlink_submission_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"message" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backlink_submission_events_actor_ck" CHECK (actor_type in ('user', 'system', 'worker', 'cron'))
);
--> statement-breakpoint
CREATE TABLE "backlink_submission_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"sha256" text,
	"bytes" integer,
	"content" text,
	"data" "bytea",
	"content_type" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backlink_submission_evidence_kind_ck" CHECK (kind in ('screenshot', 'html_snapshot', 'http_exchange', 'confirmation_text', 'email', 'note')),
	CONSTRAINT "backlink_submission_evidence_size_ck" CHECK (data is null or octet_length(data) <= 2097152)
);
--> statement-breakpoint
CREATE TABLE "backlink_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"website_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"source_id" uuid,
	"adapter_key" text NOT NULL,
	"submission_method" text NOT NULL,
	"status" text DEFAULT 'DISCOVERED' NOT NULL,
	"destination_domain" text NOT NULL,
	"submission_url" text,
	"target_url" text NOT NULL,
	"anchor_text" text,
	"asset_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"submitted_at" timestamp with time zone,
	"response" jsonb,
	"confirmation_text" text,
	"error_message" text,
	"live_url" text,
	"published_at" timestamp with time zone,
	"first_detected_at" timestamp with time zone,
	"last_verified_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"lost_at" timestamp with time zone,
	"link_attributes" jsonb,
	"consecutive_misses" integer DEFAULT 0 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"is_update_of" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backlink_submissions_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "backlink_submissions_id_site_org_uq" UNIQUE("id","website_id","organization_id"),
	CONSTRAINT "backlink_submissions_method_ck" CHECK (submission_method in ('official_api', 'authorised_partner', 'public_form', 'browser_automation', 'manual_editorial', 'outreach')),
	CONSTRAINT "backlink_submissions_status_ck" CHECK (status in ('DISCOVERED', 'QUALIFIED', 'CONTENT_READY', 'AWAITING_APPROVAL', 'APPROVED', 'SUBMISSION_QUEUED', 'SUBMITTING', 'SUBMITTED', 'PENDING_VERIFICATION', 'PUBLISHED', 'VERIFIED', 'REJECTED', 'FAILED', 'MANUAL_ACTION_REQUIRED', 'CANCELLED', 'LOST'))
);
--> statement-breakpoint
CREATE TABLE "backlink_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"website_id" uuid NOT NULL,
	"campaign_id" uuid,
	"submission_id" uuid,
	"opportunity_id" uuid,
	"task_type" text NOT NULL,
	"title" text NOT NULL,
	"instructions" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"assigned_to" uuid,
	"due_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"resolution" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backlink_tasks_type_ck" CHECK (task_type in ('captcha_required', 'email_verification', 'login_required', 'manual_submission', 'manual_review', 'outreach_send', 'outreach_reply', 'recovery', 'adapter_error', 'profile_incomplete')),
	CONSTRAINT "backlink_tasks_status_ck" CHECK (status in ('open', 'in_progress', 'done', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "backlink_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"website_id" uuid NOT NULL,
	"submission_id" uuid,
	"source_url" text NOT NULL,
	"target_url" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"result" text NOT NULL,
	"http_status" integer,
	"final_url" text,
	"redirect_chain" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"link_href" text,
	"anchor_text" text,
	"rel" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_nofollow" boolean,
	"is_sponsored" boolean,
	"is_ugc" boolean,
	"page_noindex" boolean,
	"error" text,
	CONSTRAINT "backlink_verifications_result_ck" CHECK (result in ('link_found', 'link_missing', 'page_unavailable', 'blocked_by_robots', 'blocked_by_policy', 'error'))
);
--> statement-breakpoint
CREATE TABLE "backlink_website_settings" (
	"website_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"automation_mode" text DEFAULT 'supervised' NOT NULL,
	"autopilot_source_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"automation_note" text,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backlink_website_settings_mode_ck" CHECK (automation_mode in ('autopilot', 'supervised', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "business_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"website_id" uuid NOT NULL,
	"business_name" text NOT NULL,
	"website_url" text NOT NULL,
	"industry" text NOT NULL,
	"description" text NOT NULL,
	"products_services" text[] DEFAULT '{}'::text[] NOT NULL,
	"target_countries" text[] DEFAULT '{}'::text[] NOT NULL,
	"contact_email" text,
	"contact_phone" text,
	"address" jsonb,
	"social_profiles" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"logo_url" text,
	"brand_descriptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"target_landing_pages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"target_keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"approved_anchor_texts" text[] DEFAULT '{}'::text[] NOT NULL,
	"founder" jsonb,
	"founded_year" integer,
	"verified_facts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_profiles_website_uq" UNIQUE("website_id"),
	CONSTRAINT "business_profiles_status_ck" CHECK (status in ('draft', 'approved'))
);
--> statement-breakpoint
ALTER TABLE "backlink_approvals" ADD CONSTRAINT "backlink_approvals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlink_approvals" ADD CONSTRAINT "backlink_approvals_website_fk" FOREIGN KEY ("website_id","organization_id") REFERENCES "public"."websites"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlink_assets" ADD CONSTRAINT "backlink_assets_website_fk" FOREIGN KEY ("website_id","organization_id") REFERENCES "public"."websites"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlink_assets" ADD CONSTRAINT "backlink_assets_campaign_fk" FOREIGN KEY ("campaign_id","website_id","organization_id") REFERENCES "public"."backlink_campaigns"("id","website_id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlink_assets" ADD CONSTRAINT "backlink_assets_opportunity_fk" FOREIGN KEY ("opportunity_id","website_id","organization_id") REFERENCES "public"."backlink_opportunities"("id","website_id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlink_campaign_settings" ADD CONSTRAINT "backlink_campaign_settings_campaign_fk" FOREIGN KEY ("campaign_id","organization_id") REFERENCES "public"."backlink_campaigns"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlink_campaigns" ADD CONSTRAINT "backlink_campaigns_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlink_campaigns" ADD CONSTRAINT "backlink_campaigns_website_fk" FOREIGN KEY ("website_id","organization_id") REFERENCES "public"."websites"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlink_costs" ADD CONSTRAINT "backlink_costs_campaign_fk" FOREIGN KEY ("campaign_id","organization_id") REFERENCES "public"."backlink_campaigns"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlink_domain_limits" ADD CONSTRAINT "backlink_domain_limits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlink_exclusions" ADD CONSTRAINT "backlink_exclusions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlink_exclusions" ADD CONSTRAINT "backlink_exclusions_website_fk" FOREIGN KEY ("website_id","organization_id") REFERENCES "public"."websites"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlink_opportunities" ADD CONSTRAINT "backlink_opportunities_source_id_backlink_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."backlink_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlink_opportunities" ADD CONSTRAINT "backlink_opportunities_website_fk" FOREIGN KEY ("website_id","organization_id") REFERENCES "public"."websites"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlink_opportunities" ADD CONSTRAINT "backlink_opportunities_campaign_fk" FOREIGN KEY ("campaign_id","website_id","organization_id") REFERENCES "public"."backlink_campaigns"("id","website_id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlink_opportunities" ADD CONSTRAINT "backlink_opportunities_prospect_fk" FOREIGN KEY ("prospect_id","website_id","organization_id") REFERENCES "public"."backlink_prospects"("id","website_id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlink_outreach" ADD CONSTRAINT "backlink_outreach_website_fk" FOREIGN KEY ("website_id","organization_id") REFERENCES "public"."websites"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlink_outreach" ADD CONSTRAINT "backlink_outreach_submission_fk" FOREIGN KEY ("submission_id","website_id","organization_id") REFERENCES "public"."backlink_submissions"("id","website_id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlink_prospects" ADD CONSTRAINT "backlink_prospects_website_fk" FOREIGN KEY ("website_id","organization_id") REFERENCES "public"."websites"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlink_recovery_campaigns" ADD CONSTRAINT "backlink_recovery_campaigns_outreach_id_backlink_outreach_id_fk" FOREIGN KEY ("outreach_id") REFERENCES "public"."backlink_outreach"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlink_recovery_campaigns" ADD CONSTRAINT "backlink_recovery_submission_fk" FOREIGN KEY ("submission_id","website_id","organization_id") REFERENCES "public"."backlink_submissions"("id","website_id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlink_sources" ADD CONSTRAINT "backlink_sources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlink_submission_events" ADD CONSTRAINT "backlink_submission_events_submission_fk" FOREIGN KEY ("submission_id","organization_id") REFERENCES "public"."backlink_submissions"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlink_submission_evidence" ADD CONSTRAINT "backlink_submission_evidence_submission_fk" FOREIGN KEY ("submission_id","organization_id") REFERENCES "public"."backlink_submissions"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlink_submissions" ADD CONSTRAINT "backlink_submissions_source_id_backlink_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."backlink_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlink_submissions" ADD CONSTRAINT "backlink_submissions_website_fk" FOREIGN KEY ("website_id","organization_id") REFERENCES "public"."websites"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlink_submissions" ADD CONSTRAINT "backlink_submissions_campaign_fk" FOREIGN KEY ("campaign_id","website_id","organization_id") REFERENCES "public"."backlink_campaigns"("id","website_id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlink_submissions" ADD CONSTRAINT "backlink_submissions_opportunity_fk" FOREIGN KEY ("opportunity_id","website_id","organization_id") REFERENCES "public"."backlink_opportunities"("id","website_id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlink_submissions" ADD CONSTRAINT "backlink_submissions_update_of_fk" FOREIGN KEY ("is_update_of","organization_id") REFERENCES "public"."backlink_submissions"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlink_tasks" ADD CONSTRAINT "backlink_tasks_website_fk" FOREIGN KEY ("website_id","organization_id") REFERENCES "public"."websites"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlink_tasks" ADD CONSTRAINT "backlink_tasks_submission_fk" FOREIGN KEY ("submission_id","website_id","organization_id") REFERENCES "public"."backlink_submissions"("id","website_id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlink_tasks" ADD CONSTRAINT "backlink_tasks_campaign_fk" FOREIGN KEY ("campaign_id","website_id","organization_id") REFERENCES "public"."backlink_campaigns"("id","website_id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlink_verifications" ADD CONSTRAINT "backlink_verifications_website_fk" FOREIGN KEY ("website_id","organization_id") REFERENCES "public"."websites"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlink_verifications" ADD CONSTRAINT "backlink_verifications_submission_fk" FOREIGN KEY ("submission_id","website_id","organization_id") REFERENCES "public"."backlink_submissions"("id","website_id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backlink_website_settings" ADD CONSTRAINT "backlink_website_settings_website_fk" FOREIGN KEY ("website_id","organization_id") REFERENCES "public"."websites"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_profiles" ADD CONSTRAINT "business_profiles_website_fk" FOREIGN KEY ("website_id","organization_id") REFERENCES "public"."websites"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "backlink_approvals_pending_uq" ON "backlink_approvals" USING btree ("subject_type","subject_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "backlink_approvals_org_idx" ON "backlink_approvals" USING btree ("organization_id","status","requested_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "backlink_assets_hash_uq" ON "backlink_assets" USING btree ("organization_id","website_id","content_hash");--> statement-breakpoint
CREATE INDEX "backlink_assets_opportunity_idx" ON "backlink_assets" USING btree ("organization_id","opportunity_id","asset_type");--> statement-breakpoint
CREATE INDEX "backlink_campaigns_website_idx" ON "backlink_campaigns" USING btree ("organization_id","website_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "backlink_domain_limits_global_uq" ON "backlink_domain_limits" USING btree ("scope","key") WHERE organization_id is null;--> statement-breakpoint
CREATE UNIQUE INDEX "backlink_domain_limits_org_uq" ON "backlink_domain_limits" USING btree ("organization_id","scope","key") WHERE organization_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "backlink_exclusions_uq" ON "backlink_exclusions" USING btree ("organization_id",coalesce("website_id", '00000000-0000-0000-0000-000000000000'::uuid),coalesce("campaign_id", '00000000-0000-0000-0000-000000000000'::uuid),"kind",lower("value"));--> statement-breakpoint
CREATE INDEX "backlink_opportunities_campaign_idx" ON "backlink_opportunities" USING btree ("organization_id","campaign_id","status","score" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "backlink_outreach_status_idx" ON "backlink_outreach" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "backlink_outreach_contact_uq" ON "backlink_outreach" USING btree ("organization_id","website_id",lower("contact_email"),"outreach_type") WHERE status not in ('closed', 'declined', 'opted_out') and contact_email is not null;--> statement-breakpoint
CREATE INDEX "backlink_prospects_score_idx" ON "backlink_prospects" USING btree ("organization_id","website_id","status","score" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "backlink_recovery_open_uq" ON "backlink_recovery_campaigns" USING btree ("submission_id") WHERE status in ('open', 'outreach_drafted', 'in_progress');--> statement-breakpoint
CREATE UNIQUE INDEX "backlink_sources_global_domain_uq" ON "backlink_sources" USING btree ("domain") WHERE organization_id is null;--> statement-breakpoint
CREATE UNIQUE INDEX "backlink_sources_org_domain_uq" ON "backlink_sources" USING btree ("organization_id","domain") WHERE organization_id is not null;--> statement-breakpoint
CREATE INDEX "backlink_submission_events_sub_idx" ON "backlink_submission_events" USING btree ("submission_id","id");--> statement-breakpoint
CREATE INDEX "backlink_submission_evidence_sub_idx" ON "backlink_submission_evidence" USING btree ("submission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "backlink_submissions_no_dupes_uq" ON "backlink_submissions" USING btree ("organization_id","website_id","destination_domain","submission_method") WHERE is_update_of is null and status not in ('REJECTED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE INDEX "backlink_submissions_status_idx" ON "backlink_submissions" USING btree ("organization_id","campaign_id","status");--> statement-breakpoint
CREATE INDEX "backlink_submissions_verify_idx" ON "backlink_submissions" USING btree ("status","last_verified_at") WHERE status in ('SUBMITTED', 'PENDING_VERIFICATION', 'PUBLISHED', 'VERIFIED', 'LOST');--> statement-breakpoint
CREATE INDEX "backlink_tasks_open_idx" ON "backlink_tasks" USING btree ("organization_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "backlink_tasks_open_uq" ON "backlink_tasks" USING btree ("submission_id","task_type") WHERE status in ('open', 'in_progress') and submission_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "backlink_tasks_open_profile_uq" ON "backlink_tasks" USING btree ("campaign_id","task_type") WHERE status in ('open', 'in_progress') and submission_id is null and task_type = 'profile_incomplete';--> statement-breakpoint
CREATE INDEX "backlink_verifications_sub_idx" ON "backlink_verifications" USING btree ("submission_id","checked_at" DESC NULLS LAST);
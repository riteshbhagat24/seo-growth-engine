CREATE TYPE "public"."audit_status" AS ENUM('crawling', 'checking_links', 'analyzing', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."cwv_status" AS ENUM('queued', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."issue_severity" AS ENUM('critical', 'warning', 'notice');--> statement-breakpoint
CREATE TABLE "audit_external_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"audit_id" uuid NOT NULL,
	"url" text NOT NULL,
	"url_hash" text NOT NULL,
	"outcome" text,
	"http_status" integer,
	"error" text,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_external_links_uq" UNIQUE("audit_id","url_hash")
);
--> statement-breakpoint
CREATE TABLE "audit_issues" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"audit_id" uuid NOT NULL,
	"rule" text NOT NULL,
	"severity" "issue_severity" NOT NULL,
	"url" text,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"website_id" uuid NOT NULL,
	"crawl_id" uuid NOT NULL,
	"status" "audit_status" DEFAULT 'crawling' NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"health_score" integer,
	"pages_analyzed" integer DEFAULT 0 NOT NULL,
	"critical" integer DEFAULT 0 NOT NULL,
	"warning" integer DEFAULT 0 NOT NULL,
	"notice" integer DEFAULT 0 NOT NULL,
	"summary" jsonb,
	"external_links_checked" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_by_user_id" uuid,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audits_id_org_uq" UNIQUE("id","organization_id"),
	CONSTRAINT "audits_crawl_uq" UNIQUE("crawl_id")
);
--> statement-breakpoint
CREATE TABLE "cwv_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"website_id" uuid NOT NULL,
	"url" text NOT NULL,
	"strategy" text NOT NULL,
	"status" "cwv_status" DEFAULT 'queued' NOT NULL,
	"metrics" jsonb,
	"error" text,
	"created_by_user_id" uuid,
	"measured_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"credentials_enc" text,
	"key_hint" text,
	"key_version" integer DEFAULT 1 NOT NULL,
	"last_error" text,
	"connected_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integrations_org_provider_uq" UNIQUE("organization_id","provider")
);
--> statement-breakpoint
CREATE TABLE "onpage_analyses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"website_id" uuid NOT NULL,
	"url" text NOT NULL,
	"final_url" text,
	"keyword" text NOT NULL,
	"score" integer NOT NULL,
	"result" jsonb NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crawl_pages" ADD COLUMN "redirects" jsonb;--> statement-breakpoint
ALTER TABLE "crawl_pages" ADD COLUMN "seo" jsonb;--> statement-breakpoint
ALTER TABLE "crawl_pages" ADD COLUMN "inlinks" integer;--> statement-breakpoint
ALTER TABLE "crawl_pages" ADD COLUMN "click_depth" integer;--> statement-breakpoint
ALTER TABLE "audit_external_links" ADD CONSTRAINT "audit_external_links_audit_fk" FOREIGN KEY ("audit_id","organization_id") REFERENCES "public"."audits"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_issues" ADD CONSTRAINT "audit_issues_audit_fk" FOREIGN KEY ("audit_id","organization_id") REFERENCES "public"."audits"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audits" ADD CONSTRAINT "audits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audits" ADD CONSTRAINT "audits_website_fk" FOREIGN KEY ("website_id","organization_id") REFERENCES "public"."websites"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audits" ADD CONSTRAINT "audits_crawl_fk" FOREIGN KEY ("crawl_id","organization_id") REFERENCES "public"."crawls"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cwv_results" ADD CONSTRAINT "cwv_results_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cwv_results" ADD CONSTRAINT "cwv_results_website_fk" FOREIGN KEY ("website_id","organization_id") REFERENCES "public"."websites"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onpage_analyses" ADD CONSTRAINT "onpage_analyses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onpage_analyses" ADD CONSTRAINT "onpage_analyses_website_fk" FOREIGN KEY ("website_id","organization_id") REFERENCES "public"."websites"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_issues_audit_rule_idx" ON "audit_issues" USING btree ("audit_id","rule");--> statement-breakpoint
CREATE INDEX "audits_website_idx" ON "audits" USING btree ("website_id","created_at");--> statement-breakpoint
CREATE INDEX "cwv_results_website_idx" ON "cwv_results" USING btree ("website_id","created_at");--> statement-breakpoint
CREATE INDEX "onpage_analyses_website_idx" ON "onpage_analyses" USING btree ("website_id","created_at");
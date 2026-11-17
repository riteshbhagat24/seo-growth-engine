CREATE TYPE "public"."crawl_page_status" AS ENUM('queued', 'fetched', 'error', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."crawl_status" AS ENUM('queued', 'running', 'completed', 'cancelled', 'failed', 'limit_reached');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "crawl_pages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"crawl_id" uuid NOT NULL,
	"url" text NOT NULL,
	"url_hash" text NOT NULL,
	"depth" integer NOT NULL,
	"source" text DEFAULT 'link' NOT NULL,
	"status" "crawl_page_status" DEFAULT 'queued' NOT NULL,
	"http_status" integer,
	"final_url" text,
	"content_type" text,
	"bytes" integer,
	"duration_ms" integer,
	"title" text,
	"links_out" integer,
	"skip_reason" text,
	"error" text,
	"fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crawl_pages_crawl_url_uq" UNIQUE("crawl_id","url_hash")
);
--> statement-breakpoint
CREATE TABLE "crawls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"website_id" uuid NOT NULL,
	"status" "crawl_status" DEFAULT 'queued' NOT NULL,
	"start_url" text NOT NULL,
	"max_pages" integer NOT NULL,
	"max_depth" integer DEFAULT 10 NOT NULL,
	"pages_found" integer DEFAULT 0 NOT NULL,
	"pages_fetched" integer DEFAULT 0 NOT NULL,
	"robots_txt" text,
	"robots_status" integer,
	"crawl_delay_ms" integer DEFAULT 1000 NOT NULL,
	"sitemap_urls" integer DEFAULT 0 NOT NULL,
	"error" text,
	"job_id" uuid,
	"created_by_user_id" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crawls_id_org_uq" UNIQUE("id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"website_id" uuid,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"idempotency_key" text,
	"progress" jsonb,
	"last_error" text,
	"created_by_user_id" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"website_id" uuid,
	"job_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"interval_minutes" integer NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedules_website_type_uq" UNIQUE("website_id","job_type")
);
--> statement-breakpoint
ALTER TABLE "crawl_pages" ADD CONSTRAINT "crawl_pages_crawl_fk" FOREIGN KEY ("crawl_id","organization_id") REFERENCES "public"."crawls"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawls" ADD CONSTRAINT "crawls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawls" ADD CONSTRAINT "crawls_website_fk" FOREIGN KEY ("website_id","organization_id") REFERENCES "public"."websites"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crawl_pages_queue_idx" ON "crawl_pages" USING btree ("crawl_id","depth","created_at") WHERE status = 'queued';--> statement-breakpoint
CREATE INDEX "crawls_website_idx" ON "crawls" USING btree ("website_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_due_idx" ON "jobs" USING btree ("run_at","priority") WHERE status = 'queued';--> statement-breakpoint
CREATE INDEX "jobs_running_idx" ON "jobs" USING btree ("locked_until") WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "jobs_org_created_idx" ON "jobs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "schedules_due_idx" ON "schedules" USING btree ("next_run_at") WHERE enabled;
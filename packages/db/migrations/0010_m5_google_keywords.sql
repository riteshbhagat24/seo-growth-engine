CREATE TYPE "public"."keyword_intent" AS ENUM('informational', 'navigational', 'commercial', 'transactional');--> statement-breakpoint
ALTER TYPE "public"."verification_method" ADD VALUE 'gsc';--> statement-breakpoint
CREATE TABLE "ga4_daily" (
	"organization_id" uuid NOT NULL,
	"website_id" uuid NOT NULL,
	"date" date NOT NULL,
	"source" text NOT NULL,
	"medium" text NOT NULL,
	"landing_page" text NOT NULL,
	"campaign" text NOT NULL,
	"sessions" integer NOT NULL,
	"engaged_sessions" integer NOT NULL,
	"key_events" real NOT NULL,
	CONSTRAINT "ga4_daily_pk" PRIMARY KEY("website_id","date","source","medium","landing_page","campaign")
);
--> statement-breakpoint
CREATE TABLE "gsc_daily" (
	"organization_id" uuid NOT NULL,
	"website_id" uuid NOT NULL,
	"date" date NOT NULL,
	"query" text NOT NULL,
	"page" text NOT NULL,
	"clicks" integer NOT NULL,
	"impressions" integer NOT NULL,
	"position" real NOT NULL,
	CONSTRAINT "gsc_daily_pk" PRIMARY KEY("website_id","date","query","page")
);
--> statement-breakpoint
CREATE TABLE "gsc_dim_daily" (
	"organization_id" uuid NOT NULL,
	"website_id" uuid NOT NULL,
	"date" date NOT NULL,
	"dimension" text NOT NULL,
	"value" text NOT NULL,
	"clicks" integer NOT NULL,
	"impressions" integer NOT NULL,
	"position" real NOT NULL,
	CONSTRAINT "gsc_dim_daily_pk" PRIMARY KEY("website_id","date","dimension","value")
);
--> statement-breakpoint
CREATE TABLE "gsc_site_daily" (
	"organization_id" uuid NOT NULL,
	"website_id" uuid NOT NULL,
	"date" date NOT NULL,
	"clicks" integer NOT NULL,
	"impressions" integer NOT NULL,
	"position" real NOT NULL,
	CONSTRAINT "gsc_site_daily_pk" PRIMARY KEY("website_id","date")
);
--> statement-breakpoint
CREATE TABLE "keywords" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"website_id" uuid NOT NULL,
	"keyword" text NOT NULL,
	"group_name" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"target_url" text,
	"intent" "keyword_intent",
	"volume" integer,
	"volume_source" text,
	"difficulty" integer,
	"difficulty_source" text,
	"notes" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "website_google" (
	"website_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"gsc_property" text,
	"gsc_synced_from" date,
	"gsc_synced_through" date,
	"gsc_last_sync_at" timestamp with time zone,
	"gsc_error" text,
	"ga4_property" text,
	"ga4_property_name" text,
	"ga4_synced_from" date,
	"ga4_synced_through" date,
	"ga4_last_sync_at" timestamp with time zone,
	"ga4_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "scopes" text[];--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "account_email" text;--> statement-breakpoint
ALTER TABLE "ga4_daily" ADD CONSTRAINT "ga4_daily_website_fk" FOREIGN KEY ("website_id","organization_id") REFERENCES "public"."websites"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_daily" ADD CONSTRAINT "gsc_daily_website_fk" FOREIGN KEY ("website_id","organization_id") REFERENCES "public"."websites"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_dim_daily" ADD CONSTRAINT "gsc_dim_daily_website_fk" FOREIGN KEY ("website_id","organization_id") REFERENCES "public"."websites"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_site_daily" ADD CONSTRAINT "gsc_site_daily_website_fk" FOREIGN KEY ("website_id","organization_id") REFERENCES "public"."websites"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keywords" ADD CONSTRAINT "keywords_website_fk" FOREIGN KEY ("website_id","organization_id") REFERENCES "public"."websites"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_google" ADD CONSTRAINT "website_google_website_fk" FOREIGN KEY ("website_id","organization_id") REFERENCES "public"."websites"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gsc_daily_query_idx" ON "gsc_daily" USING btree ("website_id",lower("query"),"date");--> statement-breakpoint
CREATE UNIQUE INDEX "keywords_website_keyword_uq" ON "keywords" USING btree ("website_id",lower("keyword"));--> statement-breakpoint
CREATE INDEX "keywords_org_idx" ON "keywords" USING btree ("organization_id");
CREATE TYPE "public"."organization_status" AS ENUM('active', 'suspended', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."organization_type" AS ENUM('personal', 'agency');--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"type" "organization_type" NOT NULL,
	"status" "organization_status" DEFAULT 'active' NOT NULL,
	"branding" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "websites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"url" text NOT NULL,
	"domain" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "websites_org_domain_uq" UNIQUE("organization_id","domain"),
	CONSTRAINT "websites_id_org_uq" UNIQUE("id","organization_id")
);
--> statement-breakpoint
ALTER TABLE "websites" ADD CONSTRAINT "websites_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "websites_org_idx" ON "websites" USING btree ("organization_id");
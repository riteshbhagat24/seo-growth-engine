import { sql } from "drizzle-orm";
import { jsonb, pgEnum, pgTable, text, timestamp, unique, uuid, index } from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";

/**
 * Tenancy conventions (see docs/DATABASE_DESIGN.md §1):
 *  - every tenant-owned table has `organization_id` NOT NULL
 *  - parents expose UNIQUE (id, organization_id) so children can use composite FKs
 *  - RLS policies, FORCE RLS and grants live in hand-written SQL migrations
 *    and are enforced by test/schema.test.ts
 */

const id = () =>
  uuid("id")
    .primaryKey()
    .$defaultFn(() => uuidv7());

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => sql`now()`)
};

export const organizationType = pgEnum("organization_type", ["personal", "agency"]);
export const organizationStatus = pgEnum("organization_status", ["active", "suspended", "deleted"]);

export const organizations = pgTable("organizations", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  type: organizationType("type").notNull(),
  status: organizationStatus("status").notNull().default("active"),
  branding: jsonb("branding").$type<{ logoUrl?: string; primary?: string; accent?: string }>().notNull().default({}),
  ...timestamps
});

export const websites = pgTable(
  "websites",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    domain: text("domain").notNull(),
    displayName: text("display_name"),
    ...timestamps
  },
  (t) => [
    unique("websites_org_domain_uq").on(t.organizationId, t.domain),
    unique("websites_id_org_uq").on(t.id, t.organizationId),
    index("websites_org_idx").on(t.organizationId)
  ]
);

export type Organization = typeof organizations.$inferSelect;
export type Website = typeof websites.$inferSelect;

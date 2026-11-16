import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgSchema,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";
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

const createdAt = timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const timestamps = {
  createdAt,
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => sql`now()`)
};

/* ───────────────────────── Identity (schema "auth") ─────────────────────────
 * Owned by Better Auth. Lives in its own schema, reachable only by the
 * `auth_user` role. `app_user` (tenant data) has no access to password hashes
 * or sessions; it reads member profiles through a SECURITY DEFINER function.
 * Property names must match Better Auth's field names.
 */
export const authSchema = pgSchema("auth");

export const users = authSchema.table("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const sessions = authSchema.table(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" })
  },
  (t) => [index("sessions_user_idx").on(t.userId)]
);

export const accounts = authSchema.table(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index("accounts_user_idx").on(t.userId)]
);

export const verifications = authSchema.table(
  "verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)]
);

export const rateLimits = authSchema.table("rate_limits", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull()
});

/* ───────────────────────────── Tenancy (public) ──────────────────────────── */

export const organizationType = pgEnum("organization_type", ["personal", "agency"]);
export const organizationStatus = pgEnum("organization_status", ["active", "suspended", "deleted"]);
export const memberRole = pgEnum("member_role", ["owner", "admin", "manager", "specialist", "viewer", "client"]);
export const invitationStatus = pgEnum("invitation_status", ["pending", "accepted", "revoked"]);

export interface OrgBranding {
  logoUrl?: string;
  primary?: string;
  accent?: string;
}

export const organizations = pgTable("organizations", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  type: organizationType("type").notNull(),
  status: organizationStatus("status").notNull().default("active"),
  branding: jsonb("branding").$type<OrgBranding>().notNull().default({}),
  /** Set only on personal workspaces: guarantees one per user. */
  personalOwnerUserId: uuid("personal_owner_user_id").unique(),
  createdByUserId: uuid("created_by_user_id"),
  ...timestamps
});

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRole("role").notNull(),
    /** false = restricted to assigned clients (M2). */
    allClients: boolean("all_clients").notNull().default(true),
    ...timestamps
  },
  (t) => [
    unique("memberships_org_user_uq").on(t.organizationId, t.userId),
    unique("memberships_id_org_uq").on(t.id, t.organizationId),
    // Exactly zero or one owner per workspace.
    uniqueIndex("memberships_one_owner_uq").on(t.organizationId).where(sql`role = 'owner'`),
    index("memberships_user_idx").on(t.userId)
  ]
);

export const invitations = pgTable(
  "invitations",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: memberRole("role").notNull(),
    /** sha256(token), hex. The raw token only ever exists in the emailed link. */
    tokenHash: text("token_hash").notNull().unique(),
    status: invitationStatus("status").notNull().default("pending"),
    invitedByUserId: uuid("invited_by_user_id").notNull(),
    acceptedByUserId: uuid("accepted_by_user_id"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt
  },
  (t) => [
    uniqueIndex("invitations_pending_email_uq")
      .on(t.organizationId, sql`lower(${t.email})`)
      .where(sql`status = 'pending'`),
    index("invitations_org_idx").on(t.organizationId)
  ]
);

/** Append-only. app_user may INSERT and SELECT (own org) but never UPDATE/DELETE. */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id"),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt
  },
  (t) => [index("audit_logs_org_created_idx").on(t.organizationId, t.createdAt)]
);

/** Global product settings (name, logo, theme). Readable by all; written by platform admins (M11). */
export const platformSettings = pgTable("platform_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
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

export type User = typeof users.$inferSelect;
export type Organization = typeof organizations.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type MemberRole = (typeof memberRole.enumValues)[number];
export type Invitation = typeof invitations.$inferSelect;
export type Website = typeof websites.$inferSelect;

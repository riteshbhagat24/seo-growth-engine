import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  real,
  pgSchema,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  date,
  foreignKey,
  primaryKey,
  bigserial,
  check,
  customType,
  numeric
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
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
    /** Non-empty => the new member is restricted to these clients (always for role "client"). */
    clientIds: uuid("client_ids").array().notNull().default(sql`'{}'::uuid[]`),
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

/* ─────────────────────────── Plans & usage (M2) ─────────────────────────── */

export interface PlanLimits {
  websites: number;
  clients: number;
  members: number;
  pages_crawled_month: number;
  keywords: number;
  backlinks_monitored: number;
  reports_month: number;
  /** Core Web Vitals measurements (PageSpeed Insights runs) per month. */
  psi_runs_month: number;
  /** Automated backlink submissions (adapter executions) per month. Manual submissions don't count. */
  backlink_submissions_month: number;
}
export type LimitKey = keyof PlanLimits;

/** Global, configurable plan catalogue. Readable by all; written by platform admins. */
export const plans = pgTable("plans", {
  id: text("id").primaryKey(), // stable code, e.g. "free"
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  workspaceType: organizationType("workspace_type"), // null = any
  limits: jsonb("limits").$type<PlanLimits>().notNull(),
  features: jsonb("features").$type<Record<string, boolean>>().notNull().default({}),
  isDefault: boolean("is_default").notNull().default(false),
  isPublic: boolean("is_public").notNull().default(true),
  sort: integer("sort").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const subscriptionStatus = pgEnum("subscription_status", ["trialing", "active", "past_due", "canceled", "comped"]);

export const subscriptions = pgTable("subscriptions", {
  organizationId: uuid("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  planId: text("plan_id")
    .notNull()
    .references(() => plans.id),
  status: subscriptionStatus("status").notNull().default("active"),
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
  currentPeriodStart: timestamp("current_period_start", { withTimezone: true }).notNull().defaultNow(),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  /** Per-workspace overrides of plan limits (support / comped deals). */
  overrides: jsonb("overrides").$type<Partial<PlanLimits>>().notNull().default({}),
  /** Reserved for a future billing provider. */
  externalRef: text("external_ref"),
  ...timestamps
});

/** Metered usage per period (flow metrics such as pages crawled). */
export const usageCounters = pgTable(
  "usage_counters",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    metric: text("metric").notNull(),
    periodStart: date("period_start").notNull(),
    value: bigint("value", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.metric, t.periodStart] })]
);

/* ─────────────────────────────── Clients (M2) ───────────────────────────── */

export const clientStatus = pgEnum("client_status", ["active", "archived"]);

export const clients = pgTable(
  "clients",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    website: text("website"),
    contactName: text("contact_name"),
    contactEmail: text("contact_email"),
    notes: text("notes"),
    status: clientStatus("status").notNull().default("active"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps
  },
  (t) => [
    unique("clients_id_org_uq").on(t.id, t.organizationId),
    index("clients_org_idx").on(t.organizationId, t.status)
  ]
);

/** Which clients a restricted member may see (membership.all_clients = false). */
export const membershipClients = pgTable(
  "membership_clients",
  {
    organizationId: uuid("organization_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    clientId: uuid("client_id").notNull(),
    createdAt
  },
  (t) => [
    primaryKey({ columns: [t.membershipId, t.clientId] }),
    foreignKey({
      name: "membership_clients_membership_fk",
      columns: [t.membershipId, t.organizationId],
      foreignColumns: [memberships.id, memberships.organizationId]
    }).onDelete("cascade"),
    foreignKey({
      name: "membership_clients_client_fk",
      columns: [t.clientId, t.organizationId],
      foreignColumns: [clients.id, clients.organizationId]
    }).onDelete("cascade"),
    index("membership_clients_client_idx").on(t.clientId)
  ]
);

/* ─────────────────────────────── Websites (M2) ──────────────────────────── */

export const verificationStatus = pgEnum("verification_status", ["unverified", "verified"]);
export const verificationMethod = pgEnum("verification_method", ["dns_txt", "meta_tag", "html_file", "gsc"]);

export const websites = pgTable(
  "websites",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    clientId: uuid("client_id"),
    url: text("url").notNull(),
    domain: text("domain").notNull(),
    displayName: text("display_name"),
    verificationStatus: verificationStatus("verification_status").notNull().default("unverified"),
    verificationMethod: verificationMethod("verification_method"),
    /** Random, per website; published by the owner in DNS / meta tag / file. Not a secret. */
    verificationToken: text("verification_token")
      .notNull()
      .default(sql`replace(gen_random_uuid()::text, '-', '')`),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    lastVerificationAt: timestamp("last_verification_at", { withTimezone: true }),
    lastVerificationError: text("last_verification_error"),
    ...timestamps
  },
  (t) => [
    unique("websites_org_domain_uq").on(t.organizationId, t.domain),
    unique("websites_id_org_uq").on(t.id, t.organizationId),
    index("websites_org_idx").on(t.organizationId),
    index("websites_client_idx").on(t.clientId),
    foreignKey({
      name: "websites_client_fk",
      columns: [t.clientId, t.organizationId],
      foreignColumns: [clients.id, clients.organizationId]
    })
  ]
);

/* ─────────────────────────────── Jobs (M3) ──────────────────────────────── */

export const jobStatus = pgEnum("job_status", ["queued", "running", "succeeded", "failed", "cancelled"]);

/**
 * Durable job queue + history. app_user sees its tenant's jobs (RLS); the
 * worker claims across tenants through the narrowly-privileged worker_user.
 * organization_id NULL = system job (invisible to tenants).
 */
export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    websiteId: uuid("website_id"),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: jobStatus("status").notNull().default("queued"),
    priority: integer("priority").notNull().default(0),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lockedBy: text("locked_by"),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    idempotencyKey: text("idempotency_key").unique(),
    progress: jsonb("progress").$type<Record<string, unknown>>(),
    lastError: text("last_error"),
    createdByUserId: uuid("created_by_user_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestamps
  },
  (t) => [
    index("jobs_due_idx").on(t.runAt, t.priority).where(sql`status = 'queued'`),
    index("jobs_running_idx").on(t.lockedUntil).where(sql`status = 'running'`),
    index("jobs_org_created_idx").on(t.organizationId, t.createdAt)
  ]
);

/** Recurring work (e.g. weekly crawl). The scheduler enqueues due rows idempotently. */
export const schedules = pgTable(
  "schedules",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    websiteId: uuid("website_id"),
    jobType: text("job_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    intervalMinutes: integer("interval_minutes").notNull(),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    enabled: boolean("enabled").notNull().default(true),
    ...timestamps
  },
  (t) => [
    index("schedules_due_idx").on(t.nextRunAt).where(sql`enabled`),
    unique("schedules_website_type_uq").on(t.websiteId, t.jobType)
  ]
);

/* ────────────────────────────── Crawls (M3) ─────────────────────────────── */

export const crawlStatus = pgEnum("crawl_status", ["queued", "running", "completed", "cancelled", "failed", "limit_reached"]);
export const crawlPageStatus = pgEnum("crawl_page_status", ["queued", "fetched", "error", "skipped"]);

export const crawls = pgTable(
  "crawls",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    websiteId: uuid("website_id").notNull(),
    status: crawlStatus("status").notNull().default("queued"),
    startUrl: text("start_url").notNull(),
    maxPages: integer("max_pages").notNull(),
    maxDepth: integer("max_depth").notNull().default(10),
    pagesFound: integer("pages_found").notNull().default(0),
    pagesFetched: integer("pages_fetched").notNull().default(0),
    robotsTxt: text("robots_txt"),
    robotsStatus: integer("robots_status"),
    crawlDelayMs: integer("crawl_delay_ms").notNull().default(1000),
    sitemapUrls: integer("sitemap_urls").notNull().default(0),
    error: text("error"),
    jobId: uuid("job_id"),
    createdByUserId: uuid("created_by_user_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestamps
  },
  (t) => [
    unique("crawls_id_org_uq").on(t.id, t.organizationId),
    index("crawls_website_idx").on(t.websiteId, t.createdAt),
    foreignKey({
      name: "crawls_website_fk",
      columns: [t.websiteId, t.organizationId],
      foreignColumns: [websites.id, websites.organizationId]
    }).onDelete("cascade")
  ]
);

/** Crawl frontier + fetch results. Resumable: a crawl continues from queued rows. */
export const crawlPages = pgTable(
  "crawl_pages",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull(),
    crawlId: uuid("crawl_id").notNull(),
    url: text("url").notNull(),
    urlHash: text("url_hash").notNull(),
    depth: integer("depth").notNull(),
    source: text("source").notNull().default("link"), // start | link | sitemap
    status: crawlPageStatus("status").notNull().default("queued"),
    httpStatus: integer("http_status"),
    finalUrl: text("final_url"),
    contentType: text("content_type"),
    bytes: integer("bytes"),
    durationMs: integer("duration_ms"),
    title: text("title"),
    linksOut: integer("links_out"),
    skipReason: text("skip_reason"),
    error: text("error"),
    /** Redirect hops: target URLs and their status codes (M4). */
    redirects: jsonb("redirects").$type<{ urls: string[]; statuses: number[] }>(),
    /** SEO signals extracted from the HTML (M4; see @sge/crawler PageSeo). */
    seo: jsonb("seo").$type<Record<string, unknown>>(),
    /** Computed by the audit: internal pages linking here, clicks from the start page. */
    inlinks: integer("inlinks"),
    clickDepth: integer("click_depth"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    createdAt
  },
  (t) => [
    unique("crawl_pages_crawl_url_uq").on(t.crawlId, t.urlHash),
    index("crawl_pages_queue_idx").on(t.crawlId, t.depth, t.createdAt).where(sql`status = 'queued'`),
    foreignKey({
      name: "crawl_pages_crawl_fk",
      columns: [t.crawlId, t.organizationId],
      foreignColumns: [crawls.id, crawls.organizationId]
    }).onDelete("cascade")
  ]
);

/* ───────────────────────── Audits & on-page (M4) ────────────────────────── */

export const auditStatus = pgEnum("audit_status", ["crawling", "checking_links", "analyzing", "completed", "failed", "cancelled"]);
export const issueSeverity = pgEnum("issue_severity", ["critical", "warning", "notice"]);

/** A technical audit: one crawl plus the analysis of it. */
export const audits = pgTable(
  "audits",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    websiteId: uuid("website_id").notNull(),
    crawlId: uuid("crawl_id").notNull(),
    status: auditStatus("status").notNull().default("crawling"),
    trigger: text("trigger").notNull().default("manual"), // manual | schedule
    healthScore: integer("health_score"),
    pagesAnalyzed: integer("pages_analyzed").notNull().default(0),
    critical: integer("critical").notNull().default(0),
    warning: integer("warning").notNull().default(0),
    notice: integer("notice").notNull().default(0),
    /** Issue counts per rule code, plus stats. */
    summary: jsonb("summary").$type<{ rules: Record<string, number>; stats: Record<string, number> }>(),
    externalLinksChecked: integer("external_links_checked").notNull().default(0),
    error: text("error"),
    createdByUserId: uuid("created_by_user_id"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestamps
  },
  (t) => [
    unique("audits_id_org_uq").on(t.id, t.organizationId),
    unique("audits_crawl_uq").on(t.crawlId),
    index("audits_website_idx").on(t.websiteId, t.createdAt),
    foreignKey({ name: "audits_website_fk", columns: [t.websiteId, t.organizationId], foreignColumns: [websites.id, websites.organizationId] }).onDelete("cascade"),
    foreignKey({ name: "audits_crawl_fk", columns: [t.crawlId, t.organizationId], foreignColumns: [crawls.id, crawls.organizationId] }).onDelete("cascade")
  ]
);

export const auditIssues = pgTable(
  "audit_issues",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull(),
    auditId: uuid("audit_id").notNull(),
    rule: text("rule").notNull(),
    severity: issueSeverity("severity").notNull(),
    url: text("url"),
    details: jsonb("details").$type<Record<string, unknown>>(),
    createdAt
  },
  (t) => [
    index("audit_issues_audit_rule_idx").on(t.auditId, t.rule),
    foreignKey({ name: "audit_issues_audit_fk", columns: [t.auditId, t.organizationId], foreignColumns: [audits.id, audits.organizationId] }).onDelete("cascade")
  ]
);

/** External links found by an audit and the result of checking them (resumable). */
export const auditExternalLinks = pgTable(
  "audit_external_links",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull(),
    auditId: uuid("audit_id").notNull(),
    url: text("url").notNull(),
    urlHash: text("url_hash").notNull(),
    outcome: text("outcome"), // null = pending | ok | broken | unverifiable
    httpStatus: integer("http_status"),
    error: text("error"),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    createdAt
  },
  (t) => [
    unique("audit_external_links_uq").on(t.auditId, t.urlHash),
    foreignKey({ name: "audit_external_links_audit_fk", columns: [t.auditId, t.organizationId], foreignColumns: [audits.id, audits.organizationId] }).onDelete("cascade")
  ]
);

export const cwvStatus = pgEnum("cwv_status", ["queued", "completed", "failed"]);

/** Core Web Vitals from PageSpeed Insights (lab) and CrUX via PSI (field). */
export const cwvResults = pgTable(
  "cwv_results",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    websiteId: uuid("website_id").notNull(),
    url: text("url").notNull(),
    strategy: text("strategy").notNull(), // mobile | desktop
    status: cwvStatus("status").notNull().default("queued"),
    metrics: jsonb("metrics").$type<Record<string, unknown>>(),
    error: text("error"),
    createdByUserId: uuid("created_by_user_id"),
    measuredAt: timestamp("measured_at", { withTimezone: true }),
    ...timestamps
  },
  (t) => [
    index("cwv_results_website_idx").on(t.websiteId, t.createdAt),
    foreignKey({ name: "cwv_results_website_fk", columns: [t.websiteId, t.organizationId], foreignColumns: [websites.id, websites.organizationId] }).onDelete("cascade")
  ]
);

export const onpageAnalyses = pgTable(
  "onpage_analyses",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    websiteId: uuid("website_id").notNull(),
    url: text("url").notNull(),
    finalUrl: text("final_url"),
    keyword: text("keyword").notNull(),
    score: integer("score").notNull(),
    result: jsonb("result").$type<Record<string, unknown>>().notNull(),
    createdByUserId: uuid("created_by_user_id"),
    createdAt
  },
  (t) => [
    index("onpage_analyses_website_idx").on(t.websiteId, t.createdAt),
    foreignKey({ name: "onpage_analyses_website_fk", columns: [t.websiteId, t.organizationId], foreignColumns: [websites.id, websites.organizationId] }).onDelete("cascade")
  ]
);

/** Per-workspace third-party credentials, encrypted at rest (AES-256-GCM). */
export const integrations = pgTable(
  "integrations",
  {
    id: id(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(), // psi | google | …
    status: text("status").notNull().default("active"),
    credentialsEnc: text("credentials_enc"),
    /** Last characters of the key, for display only. */
    keyHint: text("key_hint"),
    keyVersion: integer("key_version").notNull().default(1),
    /** OAuth providers: granted scopes and the connected Google account (display only). */
    scopes: text("scopes").array(),
    accountEmail: text("account_email"),
    lastError: text("last_error"),
    connectedByUserId: uuid("connected_by_user_id"),
    ...timestamps
  },
  (t) => [unique("integrations_org_provider_uq").on(t.organizationId, t.provider)]
);

/* ─────────────────────── Google data & keywords (M5) ────────────────────── */

/** Which Google properties feed a website, and how far each sync has got. */
export const websiteGoogle = pgTable(
  "website_google",
  {
    websiteId: uuid("website_id").primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    /** "sc-domain:example.com" or "https://example.com/" */
    gscProperty: text("gsc_property"),
    gscSyncedFrom: date("gsc_synced_from"),
    gscSyncedThrough: date("gsc_synced_through"),
    gscLastSyncAt: timestamp("gsc_last_sync_at", { withTimezone: true }),
    gscError: text("gsc_error"),
    /** "properties/123456789" */
    ga4Property: text("ga4_property"),
    ga4PropertyName: text("ga4_property_name"),
    ga4SyncedFrom: date("ga4_synced_from"),
    ga4SyncedThrough: date("ga4_synced_through"),
    ga4LastSyncAt: timestamp("ga4_last_sync_at", { withTimezone: true }),
    ga4Error: text("ga4_error"),
    ...timestamps
  },
  (t) => [
    foreignKey({ name: "website_google_website_fk", columns: [t.websiteId, t.organizationId], foreignColumns: [websites.id, websites.organizationId] }).onDelete("cascade")
  ]
);

/** Search Console totals per day (exact; includes anonymised queries). */
export const gscSiteDaily = pgTable(
  "gsc_site_daily",
  {
    organizationId: uuid("organization_id").notNull(),
    websiteId: uuid("website_id").notNull(),
    date: date("date").notNull(),
    clicks: integer("clicks").notNull(),
    impressions: integer("impressions").notNull(),
    position: real("position").notNull()
  },
  (t) => [
    primaryKey({ name: "gsc_site_daily_pk", columns: [t.websiteId, t.date] }),
    foreignKey({ name: "gsc_site_daily_website_fk", columns: [t.websiteId, t.organizationId], foreignColumns: [websites.id, websites.organizationId] }).onDelete("cascade")
  ]
);

/** Search Console per day by device or country. */
export const gscDimDaily = pgTable(
  "gsc_dim_daily",
  {
    organizationId: uuid("organization_id").notNull(),
    websiteId: uuid("website_id").notNull(),
    date: date("date").notNull(),
    dimension: text("dimension").notNull(), // device | country
    value: text("value").notNull(),
    clicks: integer("clicks").notNull(),
    impressions: integer("impressions").notNull(),
    position: real("position").notNull()
  },
  (t) => [
    primaryKey({ name: "gsc_dim_daily_pk", columns: [t.websiteId, t.date, t.dimension, t.value] }),
    foreignKey({ name: "gsc_dim_daily_website_fk", columns: [t.websiteId, t.organizationId], foreignColumns: [websites.id, websites.organizationId] }).onDelete("cascade")
  ]
);

/** Search Console per day by query and page (top rows; capped per sync window). */
export const gscDaily = pgTable(
  "gsc_daily",
  {
    organizationId: uuid("organization_id").notNull(),
    websiteId: uuid("website_id").notNull(),
    date: date("date").notNull(),
    query: text("query").notNull(),
    page: text("page").notNull(),
    clicks: integer("clicks").notNull(),
    impressions: integer("impressions").notNull(),
    position: real("position").notNull()
  },
  (t) => [
    primaryKey({ name: "gsc_daily_pk", columns: [t.websiteId, t.date, t.query, t.page] }),
    index("gsc_daily_query_idx").on(t.websiteId, sql`lower(${t.query})`, t.date),
    foreignKey({ name: "gsc_daily_website_fk", columns: [t.websiteId, t.organizationId], foreignColumns: [websites.id, websites.organizationId] }).onDelete("cascade")
  ]
);

/** Google Analytics 4 per day by source / medium / landing page / campaign. */
export const ga4Daily = pgTable(
  "ga4_daily",
  {
    organizationId: uuid("organization_id").notNull(),
    websiteId: uuid("website_id").notNull(),
    date: date("date").notNull(),
    source: text("source").notNull(),
    medium: text("medium").notNull(),
    landingPage: text("landing_page").notNull(),
    campaign: text("campaign").notNull(),
    sessions: integer("sessions").notNull(),
    engagedSessions: integer("engaged_sessions").notNull(),
    keyEvents: real("key_events").notNull()
  },
  (t) => [
    primaryKey({ name: "ga4_daily_pk", columns: [t.websiteId, t.date, t.source, t.medium, t.landingPage, t.campaign] }),
    foreignKey({ name: "ga4_daily_website_fk", columns: [t.websiteId, t.organizationId], foreignColumns: [websites.id, websites.organizationId] }).onDelete("cascade")
  ]
);

export const keywordIntent = pgEnum("keyword_intent", ["informational", "navigational", "commercial", "transactional"]);

/** Tracked keywords. Metrics come from GSC; volume/difficulty only if imported (with their source). */
export const keywords = pgTable(
  "keywords",
  {
    id: id(),
    organizationId: uuid("organization_id").notNull(),
    websiteId: uuid("website_id").notNull(),
    keyword: text("keyword").notNull(),
    groupName: text("group_name"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    targetUrl: text("target_url"),
    intent: keywordIntent("intent"),
    volume: integer("volume"),
    volumeSource: text("volume_source"),
    difficulty: integer("difficulty"),
    difficultySource: text("difficulty_source"),
    notes: text("notes"),
    createdByUserId: uuid("created_by_user_id"),
    ...timestamps
  },
  (t) => [
    uniqueIndex("keywords_website_keyword_uq").on(t.websiteId, sql`lower(${t.keyword})`),
    index("keywords_org_idx").on(t.organizationId),
    foreignKey({ name: "keywords_website_fk", columns: [t.websiteId, t.organizationId], foreignColumns: [websites.id, websites.organizationId] }).onDelete("cascade")
  ]
);

/* ───────────────── Backlink acquisition engine (M6–M8, @sge/backlinks) ──────────────────
 * docs/BACKLINKS_INTEGRATION.md. Column names match the engine's parameterised SQL, so ids
 * default in the database (gen_random_uuid()) rather than in JS. Website-level isolation:
 * campaigns, prospects, opportunities and submissions expose UNIQUE (id, website_id,
 * organization_id), and children reference that triple, so a row can never mix two websites.
 * RLS, triggers, grants and the seed catalogue live in migration 0013.
 */

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });
const tsz = (name: string) => timestamp(name, { withTimezone: true });
const textArray = (name: string) => text(name).array().notNull().default(sql`'{}'::text[]`);
const uuidArray = (name: string) => uuid(name).array().notNull().default(sql`'{}'::uuid[]`);
const json = <T>(name: string, dflt: unknown) => jsonb(name).$type<T>().notNull().default(dflt as T);
const dbId = () => uuid("id").primaryKey().defaultRandom();
const created = () => tsz("created_at").notNull().defaultNow();
const websiteFk = (name: string, t: { websiteId: AnyPgColumn; organizationId: AnyPgColumn }) =>
  foreignKey({ name, columns: [t.websiteId, t.organizationId], foreignColumns: [websites.id, websites.organizationId] }).onDelete("cascade");

export const OPPORTUNITY_TYPES = [
  "business_listing", "industry_directory", "agency_directory", "startup_directory", "resource_page",
  "guest_post", "association", "partner", "review_platform", "other"
] as const;
const inList = (col: string, values: readonly string[]) => sql.raw(`${col} in (${values.map((v) => `'${v}'`).join(", ")})`);

/** The only source of facts the asset generator may use. Editing returns it to draft. */
export const businessProfiles = pgTable(
  "business_profiles",
  {
    id: dbId(),
    organizationId: uuid("organization_id").notNull(),
    websiteId: uuid("website_id").notNull(),
    businessName: text("business_name").notNull(),
    websiteUrl: text("website_url").notNull(),
    industry: text("industry").notNull(),
    description: text("description").notNull(),
    productsServices: textArray("products_services"),
    targetCountries: textArray("target_countries"),
    contactEmail: text("contact_email"),
    contactPhone: text("contact_phone"),
    /** null = no public address; the generator never invents one. */
    address: jsonb("address").$type<Record<string, string>>(),
    socialProfiles: json<Record<string, string>>("social_profiles", {}),
    logoUrl: text("logo_url"),
    brandDescriptions: json<string[]>("brand_descriptions", []),
    targetLandingPages: json<{ url: string; label?: string }[]>("target_landing_pages", []),
    targetKeywords: textArray("target_keywords"),
    approvedAnchorTexts: textArray("approved_anchor_texts"),
    founder: jsonb("founder").$type<{ name: string; title?: string; bio?: string }>(),
    foundedYear: integer("founded_year"),
    /** User-verified facts (awards, certifications, statistics). Only these may be claimed. */
    verifiedFacts: json<string[]>("verified_facts", []),
    status: text("status").notNull().default("draft"),
    approvedBy: uuid("approved_by"),
    approvedAt: tsz("approved_at"),
    version: integer("version").notNull().default(1),
    createdAt: created(),
    updatedAt: tsz("updated_at").notNull().defaultNow()
  },
  (t) => [
    unique("business_profiles_website_uq").on(t.websiteId),
    websiteFk("business_profiles_website_fk", t),
    check("business_profiles_status_ck", inList("status", ["draft", "approved"]))
  ]
);

/** Per-website automation mode. SUPERVISED is the default; AUTOPILOT applies only to listed sources. */
export const backlinkWebsiteSettings = pgTable(
  "backlink_website_settings",
  {
    websiteId: uuid("website_id").primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    automationMode: text("automation_mode").notNull().default("supervised"),
    autopilotSourceIds: uuidArray("autopilot_source_ids"),
    /** Who enabled autopilot and why (SECURITY §7: recorded permission note). */
    automationNote: text("automation_note"),
    updatedBy: uuid("updated_by"),
    createdAt: created(),
    updatedAt: tsz("updated_at").notNull().defaultNow()
  },
  (t) => [
    websiteFk("backlink_website_settings_website_fk", t),
    check("backlink_website_settings_mode_ck", inList("automation_mode", ["autopilot", "supervised", "manual"]))
  ]
);

/** Known destinations. organization_id NULL = the curated global catalogue (read-only to tenants). */
export const backlinkSources = pgTable(
  "backlink_sources",
  {
    id: dbId(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    name: text("name").notNull(),
    sourceType: text("source_type").notNull(),
    industries: textArray("industries"),
    countries: textArray("countries"),
    homepageUrl: text("homepage_url").notNull(),
    submissionUrl: text("submission_url"),
    adapterKey: text("adapter_key").notNull(),
    automationPermission: text("automation_permission").notNull().default("none"),
    permissionEvidence: json<Record<string, unknown>>("permission_evidence", {}),
    formMapping: json<Record<string, unknown>>("form_mapping", {}),
    /** Non-secret API settings (endpoint, base_url, username). */
    apiConfig: json<Record<string, unknown>>("api_config", {}),
    /** AES-256-GCM, bound to "<org>:backlink_source:<id>". Workspace sources only. */
    credentialsEnc: text("credentials_enc"),
    credentialsHint: text("credentials_hint"),
    requiresAccount: boolean("requires_account").notNull().default(false),
    linkTypeExpected: text("link_type_expected"),
    curationStatus: text("curation_status").notNull().default("unverified"),
    notes: text("notes"),
    createdAt: created(),
    updatedAt: tsz("updated_at").notNull().defaultNow()
  },
  (t) => [
    uniqueIndex("backlink_sources_global_domain_uq").on(t.domain).where(sql`organization_id is null`),
    uniqueIndex("backlink_sources_org_domain_uq").on(t.organizationId, t.domain).where(sql`organization_id is not null`),
    check("backlink_sources_type_ck", inList("source_type", OPPORTUNITY_TYPES)),
    check(
      "backlink_sources_permission_ck",
      inList("automation_permission", ["none", "manual_only", "tos_permits_form", "explicit_permission", "own_property", "test_destination"])
    ),
    check("backlink_sources_link_type_ck", sql`link_type_expected is null or ${inList("link_type_expected", ["dofollow", "nofollow", "ugc", "sponsored", "unknown"])}`),
    check("backlink_sources_curation_ck", inList("curation_status", ["unverified", "verified", "retired"]))
  ]
);

export const backlinkCampaigns = pgTable(
  "backlink_campaigns",
  {
    id: dbId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    websiteId: uuid("website_id").notNull(),
    name: text("name").notNull(),
    industry: text("industry").notNull(),
    targetCountries: textArray("target_countries"),
    targetKeywords: textArray("target_keywords"),
    targetPages: textArray("target_pages"),
    preferredCategories: textArray("preferred_categories"),
    minQualityScore: integer("min_quality_score").notNull().default(50),
    /** null = inherit the website's automation mode. */
    automationMode: text("automation_mode"),
    status: text("status").notNull().default("draft"),
    startsAt: tsz("starts_at"),
    endsAt: tsz("ends_at"),
    pausedAt: tsz("paused_at"),
    createdBy: uuid("created_by"),
    createdAt: created(),
    updatedAt: tsz("updated_at").notNull().defaultNow()
  },
  (t) => [
    unique("backlink_campaigns_id_org_uq").on(t.id, t.organizationId),
    unique("backlink_campaigns_id_site_org_uq").on(t.id, t.websiteId, t.organizationId),
    index("backlink_campaigns_website_idx").on(t.organizationId, t.websiteId, t.status),
    websiteFk("backlink_campaigns_website_fk", t),
    check("backlink_campaigns_score_ck", sql`min_quality_score between 0 and 100`),
    check("backlink_campaigns_mode_ck", sql`automation_mode is null or ${inList("automation_mode", ["autopilot", "supervised", "manual"])}`),
    check("backlink_campaigns_status_ck", inList("status", ["draft", "active", "paused", "completed", "archived"])),
    check("backlink_campaigns_dates_ck", sql`ends_at is null or starts_at is null or ends_at > starts_at`)
  ]
);

export const backlinkCampaignSettings = pgTable(
  "backlink_campaign_settings",
  {
    campaignId: uuid("campaign_id").primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    maxDailySubmissions: integer("max_daily_submissions").notNull().default(5),
    maxWeeklySubmissions: integer("max_weekly_submissions").notNull().default(20),
    /** Empty = every implemented adapter. */
    allowedAdapters: textArray("allowed_adapters"),
    excludedDomains: textArray("excluded_domains"),
    approvalRequired: boolean("approval_required").notNull().default(true),
    autoGenerateAssets: boolean("auto_generate_assets").notNull().default(true),
    allowListingUpdates: boolean("allow_listing_updates").notNull().default(false),
    updatedAt: tsz("updated_at").notNull().defaultNow()
  },
  (t) => [
    foreignKey({
      name: "backlink_campaign_settings_campaign_fk",
      columns: [t.campaignId, t.organizationId],
      foreignColumns: [backlinkCampaigns.id, backlinkCampaigns.organizationId]
    }).onDelete("cascade"),
    check("backlink_campaign_settings_daily_ck", sql`max_daily_submissions between 0 and 500`),
    check("backlink_campaign_settings_weekly_ck", sql`max_weekly_submissions between 0 and 2000`)
  ]
);

/** Domain-level qualification, per website. */
export const backlinkProspects = pgTable(
  "backlink_prospects",
  {
    id: dbId(),
    organizationId: uuid("organization_id").notNull(),
    websiteId: uuid("website_id").notNull(),
    domain: text("domain").notNull(),
    homepageUrl: text("homepage_url").notNull(),
    status: text("status").notNull().default("new"),
    score: integer("score"),
    scoreBreakdown: json<unknown[]>("score_breakdown", []),
    rejectReasons: textArray("reject_reasons"),
    signals: json<Record<string, unknown>>("signals", {}),
    firstDiscoveredAt: tsz("first_discovered_at").notNull().defaultNow(),
    lastQualifiedAt: tsz("last_qualified_at")
  },
  (t) => [
    unique("backlink_prospects_id_org_uq").on(t.id, t.organizationId),
    unique("backlink_prospects_id_site_org_uq").on(t.id, t.websiteId, t.organizationId),
    unique("backlink_prospects_site_domain_uq").on(t.organizationId, t.websiteId, t.domain),
    index("backlink_prospects_score_idx").on(t.organizationId, t.websiteId, t.status, t.score.desc()),
    websiteFk("backlink_prospects_website_fk", t),
    check("backlink_prospects_status_ck", inList("status", ["new", "qualifying", "qualified", "rejected", "excluded", "error"])),
    check("backlink_prospects_score_ck", sql`score is null or score between 0 and 100`)
  ]
);

/** Page-level opportunities, per campaign. */
export const backlinkOpportunities = pgTable(
  "backlink_opportunities",
  {
    id: dbId(),
    organizationId: uuid("organization_id").notNull(),
    websiteId: uuid("website_id").notNull(),
    campaignId: uuid("campaign_id").notNull(),
    prospectId: uuid("prospect_id").notNull(),
    sourceId: uuid("source_id").references(() => backlinkSources.id, { onDelete: "set null" }),
    url: text("url").notNull(),
    urlNormalized: text("url_normalized").notNull(),
    opportunityType: text("opportunity_type").notNull(),
    adapterKey: text("adapter_key").notNull(),
    discoveryMethod: text("discovery_method").notNull(),
    discoverySource: text("discovery_source").notNull(),
    discoveryEvidence: json<Record<string, unknown>>("discovery_evidence", {}),
    discoveredAt: tsz("discovered_at").notNull().defaultNow(),
    status: text("status").notNull().default("DISCOVERED"),
    score: integer("score"),
    scoreBreakdown: json<unknown[]>("score_breakdown", []),
    rejectReasons: textArray("reject_reasons"),
    qualifiedAt: tsz("qualified_at")
  },
  (t) => [
    unique("backlink_opportunities_id_org_uq").on(t.id, t.organizationId),
    unique("backlink_opportunities_id_site_org_uq").on(t.id, t.websiteId, t.organizationId),
    unique("backlink_opportunities_campaign_url_uq").on(t.campaignId, t.urlNormalized),
    index("backlink_opportunities_campaign_idx").on(t.organizationId, t.campaignId, t.status, t.score.desc()),
    websiteFk("backlink_opportunities_website_fk", t),
    foreignKey({
      name: "backlink_opportunities_campaign_fk",
      columns: [t.campaignId, t.websiteId, t.organizationId],
      foreignColumns: [backlinkCampaigns.id, backlinkCampaigns.websiteId, backlinkCampaigns.organizationId]
    }).onDelete("cascade"),
    foreignKey({
      name: "backlink_opportunities_prospect_fk",
      columns: [t.prospectId, t.websiteId, t.organizationId],
      foreignColumns: [backlinkProspects.id, backlinkProspects.websiteId, backlinkProspects.organizationId]
    }).onDelete("cascade"),
    check("backlink_opportunities_type_ck", inList("opportunity_type", OPPORTUNITY_TYPES)),
    check(
      "backlink_opportunities_method_ck",
      inList("discovery_method", ["curated_database", "user_url", "csv_import", "competitor_csv", "site_expansion", "search_template_manual", "permitted_api", "recovery"])
    ),
    check("backlink_opportunities_status_ck", inList("status", ["DISCOVERED", "QUALIFIED", "REJECTED", "EXCLUDED", "IN_PIPELINE", "DONE"])),
    check("backlink_opportunities_score_ck", sql`score is null or score between 0 and 100`)
  ]
);

export const ASSET_TYPES = [
  "short_description", "long_description", "company_profile", "founder_bio", "directory_listing", "guest_post_pitch",
  "article_draft", "resource_request", "partnership_pitch", "outreach_email", "recovery_email"
] as const;

/** Generated copy. Never published without the approved profile facts it derives from. */
export const backlinkAssets = pgTable(
  "backlink_assets",
  {
    id: dbId(),
    organizationId: uuid("organization_id").notNull(),
    websiteId: uuid("website_id").notNull(),
    campaignId: uuid("campaign_id"),
    opportunityId: uuid("opportunity_id"),
    assetType: text("asset_type").notNull(),
    title: text("title"),
    body: text("body").notNull(),
    contentHash: text("content_hash").notNull(),
    maxSimilarity: numeric("max_similarity", { precision: 5, scale: 4 }).notNull().default("0"),
    factCheck: json<Record<string, unknown>>("fact_check", {}),
    generator: text("generator").notNull(),
    profileVersion: integer("profile_version").notNull(),
    status: text("status").notNull().default("draft"),
    approvedBy: uuid("approved_by"),
    approvedAt: tsz("approved_at"),
    createdAt: created()
  },
  (t) => [
    unique("backlink_assets_id_org_uq").on(t.id, t.organizationId),
    uniqueIndex("backlink_assets_hash_uq").on(t.organizationId, t.websiteId, t.contentHash),
    index("backlink_assets_opportunity_idx").on(t.organizationId, t.opportunityId, t.assetType),
    websiteFk("backlink_assets_website_fk", t),
    foreignKey({
      name: "backlink_assets_campaign_fk",
      columns: [t.campaignId, t.websiteId, t.organizationId],
      foreignColumns: [backlinkCampaigns.id, backlinkCampaigns.websiteId, backlinkCampaigns.organizationId]
    }).onDelete("cascade"),
    foreignKey({
      name: "backlink_assets_opportunity_fk",
      columns: [t.opportunityId, t.websiteId, t.organizationId],
      foreignColumns: [backlinkOpportunities.id, backlinkOpportunities.websiteId, backlinkOpportunities.organizationId]
    }).onDelete("cascade"),
    check("backlink_assets_type_ck", inList("asset_type", ASSET_TYPES)),
    check("backlink_assets_status_ck", inList("status", ["draft", "approved", "rejected", "superseded"]))
  ]
);

export const SUBMISSION_STATUSES = [
  "DISCOVERED", "QUALIFIED", "CONTENT_READY", "AWAITING_APPROVAL", "APPROVED", "SUBMISSION_QUEUED", "SUBMITTING", "SUBMITTED",
  "PENDING_VERIFICATION", "PUBLISHED", "VERIFIED", "REJECTED", "FAILED", "MANUAL_ACTION_REQUIRED", "CANCELLED", "LOST"
] as const;
const SUBMISSION_METHODS = ["official_api", "authorised_partner", "public_form", "browser_automation", "manual_editorial", "outreach"] as const;

/** One attempt to obtain a link at one destination. Only VERIFIED counts as acquired. */
export const backlinkSubmissions = pgTable(
  "backlink_submissions",
  {
    id: dbId(),
    organizationId: uuid("organization_id").notNull(),
    websiteId: uuid("website_id").notNull(),
    campaignId: uuid("campaign_id").notNull(),
    opportunityId: uuid("opportunity_id").notNull(),
    sourceId: uuid("source_id").references(() => backlinkSources.id, { onDelete: "set null" }),
    adapterKey: text("adapter_key").notNull(),
    submissionMethod: text("submission_method").notNull(),
    status: text("status").notNull().default("DISCOVERED"),
    destinationDomain: text("destination_domain").notNull(),
    submissionUrl: text("submission_url"),
    targetUrl: text("target_url").notNull(),
    anchorText: text("anchor_text"),
    assetIds: uuidArray("asset_ids"),
    payload: json<Record<string, unknown>>("payload", {}),
    submittedAt: tsz("submitted_at"),
    response: jsonb("response").$type<Record<string, unknown>>(),
    confirmationText: text("confirmation_text"),
    errorMessage: text("error_message"),
    /** Where the backlink is expected or observed (listing page, article URL). */
    liveUrl: text("live_url"),
    publishedAt: tsz("published_at"),
    firstDetectedAt: tsz("first_detected_at"),
    lastVerifiedAt: tsz("last_verified_at"),
    verifiedAt: tsz("verified_at"),
    lostAt: tsz("lost_at"),
    linkAttributes: jsonb("link_attributes").$type<Record<string, unknown>>(),
    consecutiveMisses: integer("consecutive_misses").notNull().default(0),
    attemptCount: integer("attempt_count").notNull().default(0),
    isUpdateOf: uuid("is_update_of"),
    createdAt: created(),
    updatedAt: tsz("updated_at").notNull().defaultNow()
  },
  (t) => [
    unique("backlink_submissions_id_org_uq").on(t.id, t.organizationId),
    unique("backlink_submissions_id_site_org_uq").on(t.id, t.websiteId, t.organizationId),
    // One live submission per destination domain + method per website, across all campaigns.
    uniqueIndex("backlink_submissions_no_dupes_uq")
      .on(t.organizationId, t.websiteId, t.destinationDomain, t.submissionMethod)
      .where(sql`is_update_of is null and status not in ('REJECTED', 'FAILED', 'CANCELLED')`),
    index("backlink_submissions_status_idx").on(t.organizationId, t.campaignId, t.status),
    index("backlink_submissions_verify_idx")
      .on(t.status, t.lastVerifiedAt)
      .where(sql`status in ('SUBMITTED', 'PENDING_VERIFICATION', 'PUBLISHED', 'VERIFIED', 'LOST')`),
    websiteFk("backlink_submissions_website_fk", t),
    foreignKey({
      name: "backlink_submissions_campaign_fk",
      columns: [t.campaignId, t.websiteId, t.organizationId],
      foreignColumns: [backlinkCampaigns.id, backlinkCampaigns.websiteId, backlinkCampaigns.organizationId]
    }).onDelete("cascade"),
    foreignKey({
      name: "backlink_submissions_opportunity_fk",
      columns: [t.opportunityId, t.websiteId, t.organizationId],
      foreignColumns: [backlinkOpportunities.id, backlinkOpportunities.websiteId, backlinkOpportunities.organizationId]
    }).onDelete("cascade"),
    foreignKey({
      name: "backlink_submissions_update_of_fk",
      columns: [t.isUpdateOf, t.organizationId],
      foreignColumns: [t.id, t.organizationId]
    }),
    check("backlink_submissions_method_ck", inList("submission_method", SUBMISSION_METHODS)),
    check("backlink_submissions_status_ck", inList("status", SUBMISSION_STATUSES))
  ]
);

/** Append-only status history (app_user may not UPDATE or DELETE). */
export const backlinkSubmissionEvents = pgTable(
  "backlink_submission_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: uuid("organization_id").notNull(),
    submissionId: uuid("submission_id").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    message: text("message"),
    data: json<Record<string, unknown>>("data", {}),
    createdAt: created()
  },
  (t) => [
    index("backlink_submission_events_sub_idx").on(t.submissionId, t.id),
    foreignKey({
      name: "backlink_submission_events_submission_fk",
      columns: [t.submissionId, t.organizationId],
      foreignColumns: [backlinkSubmissions.id, backlinkSubmissions.organizationId]
    }).onDelete("cascade"),
    check("backlink_submission_events_actor_ck", inList("actor_type", ["user", "system", "worker", "cron"]))
  ]
);

/** Confirmation text, HTTP exchanges, HTML snapshots and screenshots (bytes in `data`, ≤ 2 MB each). */
export const backlinkSubmissionEvidence = pgTable(
  "backlink_submission_evidence",
  {
    id: dbId(),
    organizationId: uuid("organization_id").notNull(),
    submissionId: uuid("submission_id").notNull(),
    kind: text("kind").notNull(),
    sha256: text("sha256"),
    bytes: integer("bytes"),
    content: text("content"),
    data: bytea("data"),
    contentType: text("content_type"),
    meta: json<Record<string, unknown>>("meta", {}),
    capturedAt: tsz("captured_at").notNull().defaultNow()
  },
  (t) => [
    index("backlink_submission_evidence_sub_idx").on(t.submissionId),
    foreignKey({
      name: "backlink_submission_evidence_submission_fk",
      columns: [t.submissionId, t.organizationId],
      foreignColumns: [backlinkSubmissions.id, backlinkSubmissions.organizationId]
    }).onDelete("cascade"),
    check("backlink_submission_evidence_kind_ck", inList("kind", ["screenshot", "html_snapshot", "http_exchange", "confirmation_text", "email", "note"])),
    check("backlink_submission_evidence_size_ck", sql`data is null or octet_length(data) <= 2097152`)
  ]
);

/** Every crawler check of a live link. */
export const backlinkVerifications = pgTable(
  "backlink_verifications",
  {
    id: dbId(),
    organizationId: uuid("organization_id").notNull(),
    websiteId: uuid("website_id").notNull(),
    submissionId: uuid("submission_id"),
    sourceUrl: text("source_url").notNull(),
    targetUrl: text("target_url").notNull(),
    checkedAt: tsz("checked_at").notNull().defaultNow(),
    result: text("result").notNull(),
    httpStatus: integer("http_status"),
    finalUrl: text("final_url"),
    redirectChain: json<unknown[]>("redirect_chain", []),
    linkHref: text("link_href"),
    anchorText: text("anchor_text"),
    rel: textArray("rel"),
    isNofollow: boolean("is_nofollow"),
    isSponsored: boolean("is_sponsored"),
    isUgc: boolean("is_ugc"),
    pageNoindex: boolean("page_noindex"),
    error: text("error")
  },
  (t) => [
    index("backlink_verifications_sub_idx").on(t.submissionId, t.checkedAt.desc()),
    websiteFk("backlink_verifications_website_fk", t),
    foreignKey({
      name: "backlink_verifications_submission_fk",
      columns: [t.submissionId, t.websiteId, t.organizationId],
      foreignColumns: [backlinkSubmissions.id, backlinkSubmissions.websiteId, backlinkSubmissions.organizationId]
    }).onDelete("cascade"),
    check(
      "backlink_verifications_result_ck",
      inList("result", ["link_found", "link_missing", "page_unavailable", "blocked_by_robots", "blocked_by_policy", "error"])
    )
  ]
);

/** Human-in-the-loop work: CAPTCHA, login, email verification, manual submissions, recovery… */
export const backlinkTasks = pgTable(
  "backlink_tasks",
  {
    id: dbId(),
    organizationId: uuid("organization_id").notNull(),
    websiteId: uuid("website_id").notNull(),
    campaignId: uuid("campaign_id"),
    submissionId: uuid("submission_id"),
    opportunityId: uuid("opportunity_id"),
    taskType: text("task_type").notNull(),
    title: text("title").notNull(),
    instructions: text("instructions").notNull(),
    payload: json<Record<string, unknown>>("payload", {}),
    status: text("status").notNull().default("open"),
    assignedTo: uuid("assigned_to"),
    dueAt: tsz("due_at"),
    completedAt: tsz("completed_at"),
    resolution: jsonb("resolution").$type<Record<string, unknown>>(),
    createdAt: created()
  },
  (t) => [
    index("backlink_tasks_open_idx").on(t.organizationId, t.status, t.createdAt.desc()),
    uniqueIndex("backlink_tasks_open_uq").on(t.submissionId, t.taskType).where(sql`status in ('open', 'in_progress') and submission_id is not null`),
    uniqueIndex("backlink_tasks_open_profile_uq")
      .on(t.campaignId, t.taskType)
      .where(sql`status in ('open', 'in_progress') and submission_id is null and task_type = 'profile_incomplete'`),
    websiteFk("backlink_tasks_website_fk", t),
    foreignKey({
      name: "backlink_tasks_submission_fk",
      columns: [t.submissionId, t.websiteId, t.organizationId],
      foreignColumns: [backlinkSubmissions.id, backlinkSubmissions.websiteId, backlinkSubmissions.organizationId]
    }).onDelete("cascade"),
    foreignKey({
      name: "backlink_tasks_campaign_fk",
      columns: [t.campaignId, t.websiteId, t.organizationId],
      foreignColumns: [backlinkCampaigns.id, backlinkCampaigns.websiteId, backlinkCampaigns.organizationId]
    }).onDelete("cascade"),
    check(
      "backlink_tasks_type_ck",
      inList("task_type", [
        "captcha_required", "email_verification", "login_required", "manual_submission", "manual_review", "outreach_send",
        "outreach_reply", "recovery", "adapter_error", "profile_incomplete"
      ])
    ),
    check("backlink_tasks_status_ck", inList("status", ["open", "in_progress", "done", "dismissed"]))
  ]
);

/** Publisher CRM: one approved message per publicly listed business contact. */
export const backlinkOutreach = pgTable(
  "backlink_outreach",
  {
    id: dbId(),
    organizationId: uuid("organization_id").notNull(),
    websiteId: uuid("website_id").notNull(),
    campaignId: uuid("campaign_id"),
    opportunityId: uuid("opportunity_id"),
    prospectId: uuid("prospect_id"),
    submissionId: uuid("submission_id"),
    outreachType: text("outreach_type").notNull(),
    contactName: text("contact_name"),
    contactEmail: text("contact_email"),
    /** Contact details must come from a public business source; where we found them. */
    contactSourceUrl: text("contact_source_url"),
    status: text("status").notNull().default("draft"),
    subject: text("subject"),
    body: text("body"),
    approvedBy: uuid("approved_by"),
    approvedAt: tsz("approved_at"),
    sentAt: tsz("sent_at"),
    lastReplyAt: tsz("last_reply_at"),
    followupCount: integer("followup_count").notNull().default(0),
    nextFollowupAt: tsz("next_followup_at"),
    editorialDecision: text("editorial_decision"),
    articleUrl: text("article_url"),
    notes: json<unknown[]>("notes", []),
    createdAt: created()
  },
  (t) => [
    index("backlink_outreach_status_idx").on(t.organizationId, t.status),
    uniqueIndex("backlink_outreach_contact_uq")
      .on(t.organizationId, t.websiteId, sql`lower(${t.contactEmail})`, t.outreachType)
      .where(sql`status not in ('closed', 'declined', 'opted_out') and contact_email is not null`),
    websiteFk("backlink_outreach_website_fk", t),
    foreignKey({
      name: "backlink_outreach_submission_fk",
      columns: [t.submissionId, t.websiteId, t.organizationId],
      foreignColumns: [backlinkSubmissions.id, backlinkSubmissions.websiteId, backlinkSubmissions.organizationId]
    }).onDelete("cascade"),
    check("backlink_outreach_type_ck", inList("outreach_type", ["guest_post", "resource_page", "partnership", "recovery", "other"])),
    check(
      "backlink_outreach_status_ck",
      inList("status", [
        "draft", "awaiting_approval", "approved", "sent", "replied", "follow_up_due", "accepted", "declined", "article_submitted",
        "published", "opted_out", "closed"
      ])
    ),
    check(
      "backlink_outreach_decision_ck",
      sql`editorial_decision is null or ${inList("editorial_decision", ["pending", "accepted", "rejected", "revisions_requested"])}`
    )
  ]
);

export const backlinkRecoveryCampaigns = pgTable(
  "backlink_recovery_campaigns",
  {
    id: dbId(),
    organizationId: uuid("organization_id").notNull(),
    websiteId: uuid("website_id").notNull(),
    submissionId: uuid("submission_id").notNull(),
    detectedLostAt: tsz("detected_lost_at").notNull().defaultNow(),
    diagnosis: text("diagnosis").notNull(),
    details: json<Record<string, unknown>>("details", {}),
    status: text("status").notNull().default("open"),
    outreachId: uuid("outreach_id").references(() => backlinkOutreach.id, { onDelete: "set null" }),
    recoveredAt: tsz("recovered_at"),
    createdAt: created()
  },
  (t) => [
    uniqueIndex("backlink_recovery_open_uq").on(t.submissionId).where(sql`status in ('open', 'outreach_drafted', 'in_progress')`),
    foreignKey({
      name: "backlink_recovery_submission_fk",
      columns: [t.submissionId, t.websiteId, t.organizationId],
      foreignColumns: [backlinkSubmissions.id, backlinkSubmissions.websiteId, backlinkSubmissions.organizationId]
    }).onDelete("cascade"),
    check(
      "backlink_recovery_diagnosis_ck",
      inList("diagnosis", ["link_removed", "page_gone", "page_noindexed", "attributes_changed", "redirected", "unknown"])
    ),
    check("backlink_recovery_status_ck", inList("status", ["open", "outreach_drafted", "in_progress", "recovered", "abandoned"]))
  ]
);

/** Rate limits per destination domain or adapter. organization_id NULL = platform default. */
export const backlinkDomainLimits = pgTable(
  "backlink_domain_limits",
  {
    id: dbId(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    maxPerDay: integer("max_per_day").notNull(),
    maxPerWeek: integer("max_per_week").notNull(),
    minIntervalSeconds: integer("min_interval_seconds").notNull().default(0),
    createdAt: created()
  },
  (t) => [
    uniqueIndex("backlink_domain_limits_global_uq").on(t.scope, t.key).where(sql`organization_id is null`),
    uniqueIndex("backlink_domain_limits_org_uq").on(t.organizationId, t.scope, t.key).where(sql`organization_id is not null`),
    check("backlink_domain_limits_scope_ck", inList("scope", ["domain", "adapter"])),
    check("backlink_domain_limits_values_ck", sql`max_per_day >= 0 and max_per_week >= 0 and min_interval_seconds >= 0`)
  ]
);

/** Excluded domains/URLs and opted-out email addresses (suppression list). */
export const backlinkExclusions = pgTable(
  "backlink_exclusions",
  {
    id: dbId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    websiteId: uuid("website_id"),
    campaignId: uuid("campaign_id"),
    kind: text("kind").notNull(),
    value: text("value").notNull(),
    reason: text("reason"),
    createdAt: created()
  },
  (t) => [
    uniqueIndex("backlink_exclusions_uq").on(
      t.organizationId,
      sql`coalesce(${t.websiteId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      sql`coalesce(${t.campaignId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.kind,
      sql`lower(${t.value})`
    ),
    websiteFk("backlink_exclusions_website_fk", t),
    check("backlink_exclusions_kind_ck", inList("kind", ["domain", "url", "email"]))
  ]
);

/** Costs recorded by the user (labour, listing fees…), for cost per verified link. */
export const backlinkCosts = pgTable(
  "backlink_costs",
  {
    id: dbId(),
    organizationId: uuid("organization_id").notNull(),
    campaignId: uuid("campaign_id").notNull(),
    incurredOn: date("incurred_on").notNull(),
    category: text("category").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("USD"),
    note: text("note"),
    createdAt: created()
  },
  (t) => [
    foreignKey({
      name: "backlink_costs_campaign_fk",
      columns: [t.campaignId, t.organizationId],
      foreignColumns: [backlinkCampaigns.id, backlinkCampaigns.organizationId]
    }).onDelete("cascade"),
    check("backlink_costs_category_ck", inList("category", ["labour", "listing_fee", "infrastructure", "content", "other"])),
    check("backlink_costs_amount_ck", sql`amount >= 0`)
  ]
);

/** Exactly what an approver saw (destination, adapter, values, content) and their decision. */
export const backlinkApprovals = pgTable(
  "backlink_approvals",
  {
    id: dbId(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    websiteId: uuid("website_id").notNull(),
    campaignId: uuid("campaign_id"),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    status: text("status").notNull().default("pending"),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    requestedBy: text("requested_by").notNull(),
    requestedAt: tsz("requested_at").notNull().defaultNow(),
    decidedBy: uuid("decided_by"),
    decidedAt: tsz("decided_at"),
    note: text("note")
  },
  (t) => [
    uniqueIndex("backlink_approvals_pending_uq").on(t.subjectType, t.subjectId).where(sql`status = 'pending'`),
    index("backlink_approvals_org_idx").on(t.organizationId, t.status, t.requestedAt.desc()),
    websiteFk("backlink_approvals_website_fk", t),
    check("backlink_approvals_subject_ck", inList("subject_type", ["submission", "outreach", "asset", "autopilot_source"])),
    check("backlink_approvals_status_ck", inList("status", ["pending", "approved", "rejected", "expired"]))
  ]
);

export type BusinessProfileRow = typeof businessProfiles.$inferSelect;
export type BacklinkCampaign = typeof backlinkCampaigns.$inferSelect;
export type BacklinkSubmission = typeof backlinkSubmissions.$inferSelect;
export type BacklinkSource = typeof backlinkSources.$inferSelect;

export type User = typeof users.$inferSelect;
export type Organization = typeof organizations.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type MemberRole = (typeof memberRole.enumValues)[number];
export type Invitation = typeof invitations.$inferSelect;
export type Website = typeof websites.$inferSelect;
export type Client = typeof clients.$inferSelect;
export type Plan = typeof plans.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type Crawl = typeof crawls.$inferSelect;
export type CrawlPage = typeof crawlPages.$inferSelect;
export type Audit = typeof audits.$inferSelect;
export type AuditIssue = typeof auditIssues.$inferSelect;
export type CwvResult = typeof cwvResults.$inferSelect;
export type OnpageAnalysis = typeof onpageAnalyses.$inferSelect;
export type Integration = typeof integrations.$inferSelect;
export type WebsiteGoogle = typeof websiteGoogle.$inferSelect;
export type Keyword = typeof keywords.$inferSelect;

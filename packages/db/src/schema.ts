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
  uuid,
  date,
  foreignKey,
  primaryKey
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
export const verificationMethod = pgEnum("verification_method", ["dns_txt", "meta_tag", "html_file"]);

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
    lastError: text("last_error"),
    connectedByUserId: uuid("connected_by_user_id"),
    ...timestamps
  },
  (t) => [unique("integrations_org_provider_uq").on(t.organizationId, t.provider)]
);

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

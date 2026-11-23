# SEO Growth Engine — Architecture

## 1. Technology choices

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) everywhere | One language for the web app, the worker and shared logic |
| Web framework | **Next.js (App Router)**, latest stable at scaffold time | Server components and server actions; deploys on Vercel or self-hosted |
| Database | **PostgreSQL 16+** | Row-Level Security for tenant isolation; JSONB; free on Neon or Supabase, or self-hosted |
| ORM and migrations | **Drizzle ORM + drizzle-kit** | SQL-first migrations in the repo, first-class RLS policy definitions, no query engine binary |
| Auth | **Better Auth** (open source) with its organization plugin | Email/password, magic link, OAuth, 2FA, organisations, invitations and roles, all stored in our Postgres |
| Jobs | **pg-boss** (Postgres-based queue) | No Redis to pay for; transactional, retries, schedules |
| Crawler | `undici` fetch + `cheerio` + `robots-parser` + `fast-xml-parser` | Free, fast, no headless browser needed for SEO checks |
| Core Web Vitals | Google PageSpeed Insights API + CrUX API | Free |
| PDF reports | `@react-pdf/renderer` | Pure JS; works in serverless |
| Email | `nodemailer` over SMTP | Platform mail via any SMTP provider; outreach via each org's own mailbox |
| UI | Tailwind CSS + shadcn/ui (Radix) + Recharts | Open source; themeable with CSS variables for branding |
| Validation | Zod | Shared between forms, actions and APIs |
| Tests | Vitest (unit/integration against a real Postgres in Docker) + Playwright (e2e) | |
| Monorepo | pnpm workspaces | `apps/web`, `apps/worker`, `packages/*` |

## 2. Runtime topology

```
               ┌──────────────────────────────┐
 Browser ────► │ apps/web (Next.js)           │
               │  UI, server actions, /api/v1 │
               │  enqueues jobs only          │
               └──────────┬───────────────────┘
                          │ SQL (app_user role, RLS on)
                          ▼
               ┌──────────────────────────────┐
               │ PostgreSQL                   │
               │  app tables (RLS)            │
               │  pgboss schema (queue)       │
               └──────────▲───────────────────┘
                          │
               ┌──────────┴───────────────────┐
               │ apps/worker (Node)           │──► target websites (crawler, safe fetch)
               │  pg-boss consumers           │──► Google APIs (GSC, GA4, PSI, CrUX)
               │  crawler, verifier, syncs,   │──► SMTP (org mailboxes)
               │  reports                     │──► WordPress REST
               └──────────────────────────────┘
```

**Why a separate worker:** crawls and syncs run for minutes, which does not fit serverless request limits. The worker is a small long-running Node process.

**Deployment options:**
- **A — Vercel + small worker host:** the web app on Vercel, and the worker as a Docker container on any VPS or container host. Note: Vercel's Hobby plan is for non-commercial use, so a paid SaaS needs Vercel Pro.
- **B — Fully self-hosted:** web + worker + Postgres via Docker Compose on one VPS (for example with Coolify). Lowest running cost.
- **Dev:** Docker Compose (Postgres + Mailpit) locally.

A fallback "tick" mode (`/api/cron/tick` processing jobs for at most 45 s) lets a Vercel-only deployment run without a worker for small installs, at reduced throughput.

## 3. Repository layout

```
apps/
  web/                    Next.js app
    app/(marketing)/      public landing, pricing placeholder
    app/(auth)/           sign in, sign up, invites
    app/(app)/[org]/      tenant app, all routes scoped by org slug
      dashboard, clients, websites/[siteId]/{audit,onpage,keywords,
      backlinks,opportunities,outreach,content,competitors,reports,settings}
      settings/{members,branding,integrations,usage}
    app/(platform)/admin/ platform admin (separate guard)
    app/api/v1/           JSON API (same services as actions)
  worker/                 pg-boss consumers + schedulers
packages/
  db/                     Drizzle schema, migrations, RLS policies, tenant client
  core/                   domain services (framework-free), permission checks
  crawler/                safe fetch, robots, sitemap, HTML analysis
  seo-rules/              audit rules (54), health score, comparison, on-page analyser, PSI parsing (pure functions, built M4)
  scoring/                opportunity scoring
  integrations/           google, wordpress, smtp, optional BYO providers
  reports/                report builders + PDF
  ui/                     shared components, theme tokens
  config/                 env schema (zod), plan defaults
docs/
```

## 4. Request flow and tenancy

1. Middleware resolves the session (Better Auth cookie).
2. The route segment `[org]` resolves the org slug → `organization_id`, then checks **membership** and loads the role and client assignments. Non-members get 404 (no existence leak).
3. Every database call in tenant routes goes through `withTenant(ctx, tx => …)`, which:
   - opens a transaction on the **`app_user`** database role (no BYPASSRLS, not the table owner);
   - runs `set_config('app.org_id', $orgId, true)`, `set_config('app.user_id', $userId, true)` and `set_config('app.client_scope', $clientIds|'*', true)` as **transaction-local** settings (safe with pooled connections);
   - executes the callback.
4. Postgres RLS policies filter every row by `organization_id = current_setting('app.org_id')::uuid`, and for the Client, Specialist and assigned-only roles additionally by client scope.
5. Service functions in `packages/core` also call `can(ctx, permission, resource)` **before** acting, so authorisation is checked twice: in the application and in the database.
6. The worker uses the same `withTenant` with the job's `organization_id`, taken from the job payload and re-checked against the database.

The platform admin area uses a separate `platform_admin` database role with BYPASSRLS. It is reachable only for users flagged `is_platform_admin` with 2FA enabled, and every action is audited.

## 5. Crawler and safe fetch

`packages/crawler/safeFetch` is the only way the system makes outbound HTTP to user-supplied URLs:
- schemes `http`/`https` only; ports 80/443 only (configurable);
- DNS resolved first; **every resolved IP checked** against deny ranges (RFC 1918, loopback, link-local, CGNAT 100.64/10, multicast, reserved, IPv6 ULA/link-local, IPv4-mapped IPv6, cloud metadata such as 169.254.169.254); the connection is **pinned to the checked IP** (custom undici `connect.lookup`), which defeats DNS rebinding;
- redirects followed manually, at most 5, with each hop re-validated;
- 15 s total timeout, 5 MB body cap, decompression size cap, allowed content types only;
- per-host politeness: 1 req/s default, honour `Crawl-delay`, global and per-org concurrency caps;
- robots.txt fetched and cached for 24 h; disallowed paths are skipped and reported;
- identifying User-Agent: `SEOGrowthEngineBot/1.0 (+<product-url>/bot)`;
- a platform-wide domain blocklist and per-org crawl budgets (from the plan).

## 6. Job system

- Queues: `audit.crawl`, `audit.analyze`, `backlink.verify`, `opportunity.inspect`, `opportunity.score`, `gsc.sync`, `ga4.sync`, `psi.run`, `outreach.send`, `report.generate`, `report.deliver`, `maintenance.*`.
- Every job payload carries `organizationId` and, where relevant, `websiteId`. Handlers open `withTenant` from those values.
- Idempotency through singleton keys (for example `verify:<backlinkId>:<date>`); retries with exponential backoff; dead-lettered jobs are visible in the UI.
- Fairness: per-organisation concurrency limits so one large agency can't starve the others.
- Long crawls are chunked (for example 200 URLs per job) with a frontier table, so they can resume after a restart.
- A schedules table (per website) drives cron-like recurring work. The worker's scheduler enqueues work only for active, within-limit workspaces.

## 7. Integrations (all free or bring-your-own)

| Integration | Auth | Cost |
|---|---|---|
| Google Search Console API | OAuth 2.0 per workspace (`webmasters.readonly`) | Free |
| GA4 Data API | OAuth 2.0 (`analytics.readonly`) | Free |
| PageSpeed Insights / CrUX | API key (platform or org-provided) | Free quota |
| Tranco top-sites list | Downloaded daily by the worker | Free |
| Open PageRank | Optional API key | Free tier |
| WordPress REST | Application password per site | Free |
| SMTP | Platform SMTP for system mail; org mailbox for outreach | Depends on the user's provider |
| Optional BYO providers | Org-supplied keys (LLM, search, Ahrefs/SEMrush API) | Paid by the org, off by default, never used as a fallback |

OAuth refresh tokens, API keys, SMTP and WordPress passwords are stored encrypted (see `SECURITY.md` §5).

## 8. Branding and theming

- Platform settings: product name, logo, favicon, default theme (CSS variables), support email.
- Org branding: logo, primary/accent colours, report footer and sender name, applied in the app header for that org, the client portal and PDFs.
- Theme tokens are CSS variables consumed by Tailwind, so branding is data, not a rebuild.
- Custom domains (client portal and report links on an agency's own domain) are planned for a later milestone.

## 9. API

- `/api/v1` REST endpoints mirroring the core services, authenticated by session cookie or **org-scoped API keys** (hashed, with scopes), rate-limited per key and per IP.
- Webhooks (later): `backlink.lost`, `audit.completed`, `report.ready`.

## 10. Observability and operations

- Structured JSON logs with `requestId`, `organizationId` and `jobId`; never secrets or full tokens.
- Health endpoints for web and worker; queue depth and failure metrics.
- Error tracking via a self-hosted or free-tier Sentry-compatible service.
- Backups and restore: `SECURITY.md` §9.

## 11. Decision log

### ADR-001 (M3): custom Postgres job queue instead of pg-boss

**Context.** pg-boss creates and migrates its own schema at runtime, which our least-privilege roles can't (and shouldn't) do. It relies on session features that misbehave through Neon's transaction-mode pooler, and its tables would sit outside our RLS model.

**Decision.** `packages/jobs` is a small queue on a `jobs` table:
- **Claiming:** jobs are claimed with `FOR UPDATE SKIP LOCKED` and leases.
- **Fairness:** a window function interleaves organisations, with a per-organisation concurrency cap.
- **Reliability:** idempotency keys, exponential backoff, recovery of expired leases, tenant-side cancellation, and chunked continuation with progress, so long jobs resume instead of exhausting retries.
- **Schedules:** each slot is enqueued exactly once.
- **Worker role:** the dedicated `worker_user` role can access only `jobs` and `schedules`. It works on tenant data through `app_user` and `withContext(job.organization_id)`.

**Runtime modes:** a long-running worker (VPS), `worker --once` from cron (cPanel), `GET /api/cron/tick` with `Bearer CRON_SECRET` (Vercel Cron or an external scheduler), and `after()` processing of the requesting workspace's jobs (serverless demo). All modes share one runner; concurrent ticks are safe.

**Consequence.** Under heavy contention a claim round may return fewer jobs than requested (claimers skip each other's locked rows); the next round picks them up. The per-organisation cap can be exceeded by at most one job in a race.

### ADR-002 (M4): audits reuse the crawl tables; rules live in code

**Context.** §6 of the database design proposed separate `audit_pages`/`audit_frontier` tables and a global `audit_rules` table.

**Decision.**
- **One crawl per audit.** An audit is a row in `audits` tied to exactly one crawl. The crawler stores each page's SEO signals (`crawl_pages.seo`) as it fetches, so no second frontier or page store is needed.
- **Three phases.** When the crawl finishes it enqueues `audit.analyze`, which checks external links (resumable), then runs the pure rule engine in `@sge/seo-rules` and stores the issues in a single transaction.
- **Rules in code.** The rule catalogue (codes, severities, explanations, fixes) ships with the code that evaluates it. Rule changes are then reviewed, tested and deployed together, and can't drift from a database copy.

**Consequence.**
- Raw crawl data and audit results share one retention policy (the newest 10 audits per website).
- Translating or overriding rule text per platform will need a table later. It can be added then, keyed by rule code.

### ADR-003 (M5): Google data sync and the app shell

**Sync.**
- **Order:** each sync job fills the most recent 28 days first (so dashboards are useful within a minute), then catches up forward, then backfills in 14-day windows until it reaches 16 months (Search Console) or 90 days (GA4).
- **Writes:** each window is written as delete + insert in one transaction, so retries and overlapping runs are idempotent.
- **State:** progress lives in `website_google` (`synced_from` / `synced_through`), not in job payloads, so any run mode (worker, cron or `after()`) resumes correctly.

**Data volume.**
- **Totals:** stored exactly per day.
- **Query × page rows:** capped at 500 per day of a sync window (top by clicks), which keeps a 16-month backfill around 240k rows for a busy site and suits free Postgres tiers.
- **Partitioning:** deferred.

**UI.**
- **Layout:** a sidebar shell (client component, for active states and the mobile drawer) wraps every workspace page, and each website has its own tabbed area under `/websites/[id]/…`.
- **Charts:** a small SVG component, so they render on the server, need no chart library, and follow the data-visualisation rules: single series, no dual axes, keyboard-readable, with a table view.

### ADR-004 (M6): the backlink engine as `@sge/backlinks`

**Context.** The backlink acquisition engine (discovery, scoring, fact-checked assets, submission adapters, verification and recovery) was first built and tested as a standalone app with its own auth, tenancy tables, job queue and crawler. It had to join this monorepo without duplicating that infrastructure. The full mapping is in `docs/BACKLINKS_INTEGRATION.md`.

**Decision.**
- **One package, `@sge/backlinks`,** depending on `@sge/core` (workspaces, roles, plans, secrets), `@sge/jobs` (queue), `@sge/crawler` (safe fetch, robots) and `@sge/db`. Nothing in `core` depends on it.
- **Parameterised SQL inside Drizzle transactions.** The engine's ~200 statements run through a small `SqlTx` bridge on the *same* connection and transaction that `withContext` / `inWorkspace` opened, so the tenant settings and RLS apply exactly as they do to Drizzle queries. The tables are still declared in `schema.ts` and migrated by drizzle-kit.
- **Jobs on the shared queue:** `backlinks.discover`, `qualify`, `plan`, `execute`, `execute_browser`, `verify` and a daily per-website `backlinks.tick` schedule. Handlers run as `app_user` in the job's workspace. Deferrals (paused campaign, rate limit, plan allowance) use `{ continue }`, so they don't use up attempts.
- **Browser automation only in the worker.** `execute_browser` jobs are claimed only by a process that registered that handler (the worker with Chromium); web ticks pass `types` so they never claim or fail them. Playwright is a server-external package and is imported lazily.
- **Adapter manifests in code** (like the audit rules, ADR-002), shown in the UI with their test status.
- **Evidence in Postgres** (`bytea`, ≤ 2 MB per item, RLS), because the web app (Vercel or cPanel) can't read the worker's disk.

**Consequences.**
- Two styles of data access exist side by side (Drizzle query builder and parameterised SQL). New engine code may use either; both are tenant-scoped by the same transaction.
- The bridge depends on Drizzle's node-postgres transaction exposing its client (`tx.session.client`, drizzle-orm 0.45). It fails loudly if that changes, and the acceptance suite exercises it on every run.
- Evidence volume counts against the database. Screenshots are typically 50–300 KB; retention by plan is a follow-up.

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
  seo-rules/              audit and on-page rule engine (pure functions)
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

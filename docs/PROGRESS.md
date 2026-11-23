# Progress log

## Decisions (2026-11-16)

| # | Decision |
|---|---|
| D1 | Stack approved: Next.js 16, PostgreSQL + RLS, Drizzle, Better Auth, pg-boss, Tailwind |
| D2 | Hosting: **Vercel Hobby for testing only** (Hobby is non-commercial), then **cPanel** for production |
| D3 | Database: **Neon free tier** (free, doesn't pause projects; supports RLS and custom roles). cPanel's local database is not used, because typical cPanel PostgreSQL/MySQL can't provide the RLS and role setup the isolation model needs |
| D4 | GitHub: private repo `seo-growth-engine` via GitHub CLI (installed; needs `gh auth login` by the account owner) |
| D5 | Default product name: **Futuready Media** (configurable through `PRODUCT_NAME`; per-org branding later) |
| D6 | Seed directory list: compiled and marked for human review before shipping |

### Consequences of cPanel hosting (designed for from M0)

- The web app builds with `output: "standalone"` so it can run under cPanel's **Setup Node.js App** (Phusion Passenger) with `server.js` as the startup file.
- cPanel does not keep long-running background processes alive, so the worker has a **`--once` mode**: a cPanel **cron job every 5 minutes** runs one bounded batch (default budget 4 minutes, so runs never overlap).
- The same worker code also runs as a long-lived process on Vercel-plus-VPS or Docker setups.
- Requires a cPanel host with Node.js 20+ in "Setup Node.js App" and outbound connections to Neon (port 5432). Check both with the hosting provider before production.

## M0 — Foundations ✅ (2026-11-16)

Implemented:
- pnpm monorepo: `apps/web` (Next.js 16.4, React 19, Tailwind 4), `apps/worker`, `packages/db`, `packages/config`
- Docker Compose for local dev: Postgres 17 (port 54329) with `app_owner` / `app_user` roles, and Mailpit
- Drizzle schema with the first tenant tables (`organizations`, `websites`) and SQL migrations
- RLS foundation migration: `app_current_org()` (fail-closed), FORCE RLS, `tenant_isolation` policy template, least-privilege grants for `app_user`
- `withTenant()`: transaction-local tenant settings with input validation
- Env schema (`@sge/config`) that fails closed in production when `ENCRYPTION_KEY` or `CRON_SECRET` is missing
- `/api/health` reporting configuration and database status separately, without leaking details
- Worker with daemon and `--once` (cron) modes and a time-budgeted runner
- GitHub Actions CI: typecheck → tests on real Postgres → migrate → build
- Windows note: `rollup` is overridden to `@rollup/wasm-node` because Windows Application Control blocks rollup's unsigned native binary on this machine

Verified (local, 2026-11-16):
| Check | Result |
|---|---|
| `pnpm typecheck` (web, worker, db, config) | ✅ pass |
| `pnpm --filter @sge/db test`: 3 schema-invariant + 9 isolation tests | ✅ 12/12 |
| `pnpm --filter @sge/worker test` | ✅ 2/2 |
| `pnpm db:migrate` on dev DB | ✅ |
| `next build` (standalone) | ✅ |
| Standalone server `/api/health`: missing secrets → 503 `config: invalid`; healthy → 200; DB stopped → 503 `database: unreachable` | ✅ |
| `worker --once` against dev DB | ✅ exits cleanly |

The isolation tests prove that, as `app_user`:
- a tenant sees only its own rows, including in the organizations table;
- with no tenant set, no rows are returned (fail closed);
- reads by id, updates and deletes against another tenant affect 0 rows;
- inserting into, or moving a row to, another tenant is rejected by RLS;
- tenant settings never leak to the next use of a pooled connection;
- malformed tenant ids are rejected before any SQL runs;
- `app_user` cannot disable RLS or run DDL.

CI on GitHub: ✅ green after the first push.

## M1 — Accounts & workspaces ✅ (2026-11-16)

Implemented:
- **Accounts (Better Auth 1.7):** email + password with required email verification, email sign-in links (magic link), optional Google sign-in (the button appears only when a free Google OAuth client is configured), password reset by email (signs out all sessions), change password, profile name, active-session list with "sign out other sessions", sign out
- **Password policy:** 10–128 characters, breached-password check (Have I Been Pwned range API)
- **Rate limits** stored in Postgres, per client IP: sign-in 5/min; sign-up, magic link, reset and verification resend 5 per 5 min
- **Workspaces:** personal workspace created automatically on sign-up (race-safe, idempotent); agency workspaces (verified email required); workspace switcher; URLs `/w/<slug>`
- **Team:** email invitations (7-day, single-use, hashed tokens, must match the verified email), revoke, change role, remove member, leave workspace, transfer ownership
- **Roles and permissions:** owner, admin, manager, specialist, viewer (client arrives with client management in M2); permission matrix in `packages/core/src/permissions.ts`; enforced in the UI, in every service (with a fresh-role re-check) and by RLS
- **Branding:** workspace name, primary/accent colours and logo URL, applied to the workspace shell through CSS variables; product name and colours from `platform_settings`
- **Audit log:** append-only, per workspace (sign-up and sign-in events are recorded at user level); viewer page for owners and admins
- **Database:** identity schema `auth` with its own `auth_user` role; memberships, invitations, audit_logs and platform_settings with RLS (DATABASE_DESIGN §14)
- **Security headers:** nosniff, frame deny, referrer policy, HSTS, permissions policy
- `scripts/dev-env.mjs` (local env files with generated secrets) and `scripts/prepare-standalone.mjs` (complete production bundle, also for cPanel)
- CI now also runs lint, the production build and the Playwright end-to-end suite

Verified (local, 2026-11-16):
| Check | Result |
|---|---|
| Typecheck (5 packages) and lint | ✅ |
| `@sge/db` schema invariants + RLS isolation (now covering 6 tenant tables) | ✅ 12/12 |
| `@sge/core` permission matrix (108 cases) + workspace flows (24) | ✅ 132/132 |
| `@sge/worker` | ✅ 2/2 |
| Production build (standalone) | ✅ |
| **Playwright e2e against the production bundle, real database and real emails (Mailpit)** | ✅ 12/12 |

The core workspace tests cover:
- concurrent first logins create exactly one personal workspace;
- replayed invitations, wrong or unverified emails, and revoked or expired tokens are all rejected;
- admins can't grant owner or manage the owner;
- a role removed mid-request can't be used;
- **a forged request for another tenant's workspace is rejected by the database** for reads, invites and updates;
- audit rows can't be updated or deleted;
- the tenant role can't read `auth.users` or `auth.sessions`, and the identity role can't read tenant tables.

The e2e suite covers:
- redirect to sign-in when logged out;
- sign-up → verification email → personal workspace; wrong password rejected;
- agency creation; invite by email → invitee signs up from the link → joins as Manager; the link can't be reused;
- a Manager doesn't see the invite form and gets 404 on the audit URL;
- an outsider gets 404 on the agency and doesn't see it in their switcher;
- branding applied and audited;
- sign out and back in; password reset by email revokes the old session;
- the per-IP sign-in rate limit returns 429 while other clients are unaffected.

Known gaps / remaining work:
- **TOTP two-factor authentication:** moved to M11 hardening to keep M1 focused (the PRD lists it as MVP).
- **Logo upload:** the logo is a URL for now; file storage comes later and needs an option that works on cPanel.
- **Google sign-in:** wired up but not tested end to end; it needs a free Google OAuth client ID from you.
- **Before cPanel production:** confirm which header the host's proxy uses for the client IP and set `TRUSTED_IP_HEADERS` (SECURITY §11).
- **Account deletion and data export:** scheduled with the privacy features in M11.

## M2 — Plans, usage, clients, websites ✅ (2026-11-17)

Implemented:
- **Plans and usage (no billing):** plan catalogue in the database (Free and Pro for personal, Agency Free and Agency for agencies; limits editable without code), a subscription per workspace with per-workspace overrides, stock limits (websites, clients, members incl. pending invites) and metered monthly limits (pages crawled, reports) with atomic counters, and a "Plan & usage" page for owners and admins.
- **Clients:** create, edit, archive and restore, with website counts, a client detail page, and its websites and restricted members.
- **Client-scoped access:** the Client role (read-only, assigned clients only) and optional client restriction for any member, set at invitation time or edited later from the Members page. Enforced by RLS (`app_client_allowed`), re-read every request.
- **Websites:** add (URL normalisation, rejects IPs, localhost and reserved names), rename, assign to a client, and remove; one domain per workspace.
- **Ownership verification:** DNS TXT, meta tag or HTML file, with step-by-step instructions, clear failure reasons and a 10-second retry throttle; audited.
- **`@sge/crawler`:** SSRF-safe fetcher with IP pinning, redirect re-validation and limits; HTML meta parsing.
- Overview checklist now reflects real progress (website added, ownership verified).

Verified (local, 2026-11-17):
| Check | Result |
|---|---|
| Typecheck (6 packages) and lint | ✅ |
| `@sge/crawler` (address blocklist incl. IPv6/mapped/NAT64/6to4, SSRF, redirects, limits, pinning) | ✅ 61/61 |
| `@sge/db` schema invariants + isolation (now 10 tenant tables) | ✅ 12/12 |
| `@sge/core` (M1 + plans 8, clients/scope 10, websites/verification 25) | ✅ 175/175 |
| `@sge/worker` | ✅ 2/2 |
| Playwright e2e (M1 12 + M2 7) against the production bundle | ✅ 19/19 |
| Neon demo database migrated; app role can read plans but not change them, sees nothing without a tenant | ✅ |

Notable tests:
- six simultaneous "add website" requests on a 1-website plan → exactly one succeeds;
- the metered counter stops at exactly the limit under concurrency;
- a client user's raw SQL session sees only their client's rows;
- writes can't escape the client scope;
- widening or narrowing a member's access takes effect on their very next request;
- verification rejects tokens in HTML comments and redirects to other domains.

Bugs caught by the new tests:
- **Metered usage SQL compared numbers as text.** "300 ≤ 2000" was false; fixed with explicit casts.
- **Client scope blocked owner-role SQL without a scope.** This was correct behaviour; the test helper now sets the scope.

Known gaps / remaining work:
- **Re-verifying ownership periodically** is designed for but needs the job system (M3).
- **Plan changes** are SQL-only until the platform admin area (M11).
- **Client-specific dashboards:** client users currently see websites and clients read-only; richer dashboards come as data arrives (audits M4, Search Console M5).

## M3 — Job system & crawler ✅ (2026-11-17)

Implemented:
- **`@sge/jobs`: a custom Postgres queue** (ADR-001 in ARCHITECTURE explains why it replaces pg-boss):
  - safe claiming with `SKIP LOCKED` and leases, plus heartbeats;
  - fairness across workspaces and per-workspace concurrency caps;
  - idempotency keys, retries with backoff and permanent failures;
  - recovery from dead workers and tenant-side cancellation;
  - chunked continuation with stored progress, exactly-once schedules, and a time-budgeted runner.
- **Worker role `worker_user`:** job tables only.
- **Run modes:**
  - long-running worker;
  - `worker --once` for cPanel cron;
  - `/api/cron/tick` (Bearer `CRON_SECRET`) for Vercel Cron or an external scheduler;
  - `after()` processing of the requesting workspace's jobs, so the Vercel demo works without a separate worker.
- **Crawler (`@sge/crawler` + `crawl.run` job):**
  - robots.txt (RFC 9309) and crawl-delay;
  - sitemap and sitemap-index seeding;
  - same-site links with URL normalisation (fragments and tracking parameters removed);
  - nofollow handling and non-HTML skipping;
  - per-crawl page caps (500 verified, 25 unverified) and monthly plan metering;
  - resumable frontier.
- **UI:**
  - crawl card on each website (start, crawl again, history);
  - live crawl page (progress bar, auto-refresh, stop, filter by fetched, errors, skipped or queued, titles, HTTP status, timing);
  - "Jobs" page with background task history;
  - health check reports `jobs: enabled`.
- **`scripts/neon-setup.mjs`** now creates only missing roles and keeps existing passwords unless given `--rotate`.

Verified (local, 2026-11-17):
| Check | Result |
|---|---|
| Typecheck (7 packages) and lint | ✅ |
| `@sge/jobs` (fairness, no double claims, retries/backoff, budget, lease recovery, cancel, schedules, worker role isolation) | ✅ 11/11 |
| `@sge/crawler` (+ URL normalisation, robots.txt groups, sitemap parsing, link extraction) | ✅ 79/79 |
| `@sge/core` (+ crawls: polite crawl, resumable slices without re-fetching, page caps, plan limit, robots 5xx, cancel, roles/client scope) | ✅ 181/181 |
| `@sge/db` schema invariants + isolation (now 14 tenant tables) | ✅ 12/12 |
| Playwright e2e: M1 12 + M2 7 + M3 2 (cron auth; real crawl of example.com processed in the background with live refresh) | ✅ 21/21 |
| Neon: worker role created, migrations applied, all three roles verified, existing passwords kept | ✅ |

Bugs caught by the new tests:
- **Drizzle array expansion:** a JS array in a SQL template became a parameter list. The job-type filter now passes a single string.
- **Over-tight time slices:** the handler correctly refused to start a fetch it couldn't finish. The test now uses realistic slices.

Known gaps / remaining work:
- **Periodic ownership re-verification and scheduled crawls:** the schedules table and processor exist, but no UI creates schedules yet (lands with audits in M4).
- **Vercel Hobby cron runs only once a day.** For frequent processing on the demo, either rely on `after()` processing (in place), or point a free external scheduler such as cron-job.org at `/api/cron/tick` every 5 minutes.
- **Compressed sitemaps (`.xml.gz`)** aren't read yet; links still get crawled.

## M4 — Technical audit & on-page analysis ✅ (2026-11-17)

This completes the first release real users could try (M1–M4).

Implemented:
- **`@sge/seo-rules` (new, pure, no I/O):**
  - **Rule catalogue:** 54 rules in 10 categories, each with a severity, an explanation and how to fix it.
    - **Crawlability:** 4xx/5xx, fetch failures, redirect chains, temporary redirects, robots.txt (missing, blocking pages or the homepage), meta refresh, page limit reached.
    - **Indexability:** noindex/nofollow, canonical missing, pointing elsewhere, broken or redirected, or duplicated.
    - **Links:** broken internal and external links, links to redirects, orphan pages (in the sitemap with no inlinks), click depth of 4 or more, internal nofollow, internal http links.
    - **Content:** title (missing, too long or short, multiple, duplicate), meta description (missing, length, multiple, duplicate), H1 (missing or multiple), thin content, duplicate content, image alt text.
    - **Performance:** slow response, large HTML, URL hygiene.
    - **Security:** HTTPS, mixed content.
    - **Mobile:** viewport.
    - **International:** lang attribute, hreflang validity and return links.
    - **Structured data:** JSON-LD validity and presence, Open Graph.
    - **Sitemaps:** sitemap missing, sitemap listing bad URLs, noindex pages in the sitemap.
  - **Engine:** `runAudit()` builds the link graph (inlinks and click depth by breadth-first search from the homepage) and gives the health score.
    - Each page counts 1 (no issues or only notices), 0.5 (a warning) or 0 (anything critical).
    - The score is the average of those page values, minus 10 for each site-wide critical issue and 3 for each site-wide warning.
  - **Audit comparison:** `compareIssues()` reports new and fixed issues per rule.
  - **On-page analyser:** `analyzeOnPage()` runs 24 weighted checks covering keyword placement, density and stuffing, content length, Flesch readability (English pages), headings, meta lengths, links in and out, image alts, schema, canonical, indexability, HTTPS and viewport. It also builds a search-result preview.
  - **PageSpeed parser:** lab metrics, CrUX field data (page or origin), opportunities, and Google's Core Web Vitals thresholds.
- **`@sge/crawler`:**
  - `extractSeo()` reads every signal the rules need: titles, meta tags, robots meta and the X-Robots-Tag header, canonical tags, hreflang, JSON-LD and microdata, Open Graph, images and alt text, followed and nofollow internal and external links, mixed content, visible-text word count and a content hash.
  - `safeFetch` now returns the status code of each redirect hop and the X-Robots-Tag header.
- **Audits (`@sge/core`):**
  - **Each audit has three phases:**
    1. Crawl (the existing M3 crawler, now storing each page's SEO data and redirect chain).
    2. External link check: up to 300 links (25 for unverified sites), one request per host at a time; only 400/404/410/5xx and DNS failures count as broken, while 401/403/429/503 are "unverifiable".
    3. Analysis: issues, inlinks and click depth stored in one transaction.
  - **Background jobs:** every phase is resumable and runs on the M3 queue.
  - **Workflow:** start, stop, history, comparison with the previous audit, issue drill-down with pagination, and CSV export (with spreadsheet formula injection neutralised).
  - **Weekly or monthly scheduled audits** via `schedules`.
  - **Retention:** the newest 10 audits per website are kept.
- **Core Web Vitals:**
  - Mobile and desktop PageSpeed Insights runs as background jobs.
  - Metered by the new plan limit `psi_runs_month`: Free 20, Pro 200, Agency Free 50, Agency 1000.
  - Uses the optional platform key `PSI_API_KEY` (or no key), unless the workspace has added its own free key.
  - Google's 429 rate-limit and 5xx responses are retried; failures are explained in plain language.
- **Integrations:** workspace API keys are stored encrypted with AES-256-GCM (`ENCRYPTION_KEY`, bound to workspace and provider). Only the last 4 characters are ever shown. Owners and admins can set or remove keys.
- **Periodic ownership re-check:** verifying a site schedules a weekly re-check. One failed re-check shows a warning; two in a row remove the verified status and write an audit-log entry.
- **UI:**
  - **Website page:** audit card (latest score, trend sparkline, history, schedule), Core Web Vitals card (lab and real-user tables, opportunities) and an on-page link.
  - **Audit page:** live progress through its 3 steps, score ring, severity counts, changes since the previous audit, filters by severity and category, a "fixed since last audit" list, CSV export and the crawled pages.
  - **Issue page:** why it matters, how to fix it, and affected URLs with details.
  - **On-page:** analyse form, history, and a result page with the score, search-result preview, grouped checks and "what we read".
  - **Elsewhere:** Settings → Integrations; a Health column on the websites list; a site-health panel and audit step on the overview; job labels.
- **Database:**
  - New tables: `audits`, `audit_issues`, `audit_external_links`, `cwv_results`, `onpage_analyses`, `integrations`.
  - New `crawl_pages` columns: `seo`, `redirects`, `inlinks`, `click_depth`.
  - Isolation: forced row-level security plus "website visible" / "audit visible" restrictive policies (migrations 0008 and 0009).

Verified (local, 2026-11-17):
| Check | Result |
|---|---|
| Typecheck (8 packages) and lint | ✅ |
| `@sge/seo-rules`: a 25-URL fixture site where every URL's issue set must match exactly; site-level rules; scoring; comparison; on-page (well-optimised page scores 100, stuffing, non-English); readability; PSI parsing | ✅ 48/48 |
| `@sge/crawler` (+ `extractSeo` on a dense HTML fixture, redirect status codes and X-Robots-Tag via the fixture server) | ✅ 87/87 |
| `@sge/core` (+ full audit through the queue against an in-memory site and fake external sites, comparison after fixes, CSV injection, cancel, roles, client scope, cross-workspace and raw-SQL isolation of all 6 new tables, schedules, retention, Core Web Vitals with platform/workspace key/429 retries/limits, on-page with robots/off-site/404, encryption, two-strike re-verification) | ✅ 198/198 |
| `@sge/db` schema invariants (forced RLS and tenant policy on every table) | ✅ 12/12 |
| `@sge/jobs` | ✅ 11/11 |
| Playwright e2e: M1 12, M2 7, M3 1 (cron), M4 5 (real audit of example.com with live refresh, issue drill-down, CSV, crawl, overview, jobs; schedule; on-page analysis plus off-site refusal; encrypted key set/remove) | ✅ 25/25 (twice in a row) |

Bugs and issues caught while testing:
- **Redirected URLs analysed twice:** a redirect's content was analysed under both the redirecting URL and its destination, causing false "duplicate title" issues. Pages are now analysed once per final URL.
- **Integrations page messages:** after removing a key, the confirmation disappeared while the earlier "Key saved" message stayed. Both messages are now page-level.
- **Test server dropped once:** one full browser-test run lost the test server partway through. It couldn't be reproduced in two later full runs.

Known gaps / remaining work:
- **Core Web Vitals only via PageSpeed:** real-user data comes from the CrUX data inside the PageSpeed response; there's no separate CrUX API call (it would need a key and adds little). The browser tests don't call Google, which is covered with recorded responses.
- **Page limits:** audits cover up to 500 pages (25 unverified). Links to pages beyond the limit aren't checked.
- **Rules in code:** the rule catalogue lives in `@sge/seo-rules`, not in an `audit_rules` table (see DATABASE_DESIGN §17).
- **Not built yet:** JavaScript rendering (no headless browser, by design), gzipped sitemaps, image file-size checks, and PDF reports (M10).
- **Demo database:** apply the M4 migrations to Neon with `node scripts/neon-setup.mjs` before deploying this version.

## M5 — Google integrations, keywords, dashboards and UI overhaul ✅ (2026-11-17)

Implemented:
- **Google OAuth per workspace** (`@sge/core/google`). One Google account per workspace, separate from "Sign in with Google".
  - **Scopes:** read-only `webmasters.readonly` and `analytics.readonly`, plus openid and email.
  - **Flow:** PKCE (S256) and a random state, kept in a signed (HMAC), httpOnly, 10-minute, single-use cookie. The callback also checks the state and the signed-in user, and `/app` passes connection messages on to the Integrations page.
  - **Storage:** refresh tokens are encrypted with AES-256-GCM (the M4 secrets helper), bound to the workspace.
  - **Revoked or expired access:** marks the connection as expired, shows "Reconnect", and stops sync jobs without retrying them.
  - **Disconnect:** revokes the token at Google and disables scheduled syncs; imported data is kept.
- **Property linking per website:**
  - Search Console sites are listed with the website's own domain first; other domains can't be chosen.
  - GA4 properties come from the Admin API account summaries.
  - Choices are re-checked against the Google account on save.
  - Owning the linked Search Console property verifies the website (new method `gsc`), with a weekly re-check through the API.
- **Sync jobs (`gsc.sync`, `ga4.sync`):** resumable and idempotent (delete + insert per date window).
  - **Order:** the newest 28 days first, then forward catch-up, then backfill in 14-day steps.
  - **History:** Search Console 16 months (final data, about 3 days behind); GA4 90 days, with the last 3 days re-fetched on every sync.
  - **Search Console data stored:** daily site totals (exact), device and country per day, and the top 500 query × page rows per day.
  - **GA4 data stored:** daily rows by source, medium, landing page and campaign (sessions, engaged sessions, key events), up to 1,000 rows per day.
  - **Schedule:** a daily sync per linked product, plus "Sync now" (limited to once per 10 minutes).
  - **Error handling:** permission errors are shown on the website, and 429/5xx responses are retried.
- **Keywords module:**
  - **Adding:** add a list, track straight from the Search Console query table or from suggestions (queries you already appear for), or import a CSV.
  - **CSV import:** RFC 4180 parsing with `,`/`;`/tab detection and a BOM. Ahrefs, Semrush, Search Console, Keyword Planner and plain-list headers are recognised. Volume and difficulty need a source label (never invented). Existing keywords are updated, not duplicated.
  - **Fields:** groups, tags, intent, target page and notes; the target page must be on the website.
  - **Metrics from Search Console:** last 28 days against the 28 before: position with its change, clicks, impressions, CTR, and the page that ranks, with a "≠ target" flag when it isn't the target page.
  - **Keyword page:** weekly position and clicks history.
  - **Also:** bulk remove, and the plan's `keywords` limit is now enforced (counted from real rows).
- **Dashboards:**
  - **Search performance:** KPIs with change, separate charts for clicks, impressions, CTR and position (the position axis is inverted), top queries (with "Track"), top pages, devices and countries, and ranges from 7 days to 16 months.
  - **Traffic (GA4):** sessions, engagement, key events, source / medium, landing pages and referral sources.
  - **Website overview:** KPIs, a setup checklist, a clicks chart, top issues and top keywords.
  - **Workspace overview:** workspace-wide KPIs, a health card per website, and a getting-started checklist.
- **UI overhaul:**
  - **App shell:** a sidebar with icons, active states and grouped navigation; a workspace switcher; a user card; a mobile slide-over menu.
  - **Website area:** a header and tabs: Overview, Site audit, Keywords, Search performance, Traffic, On-page, Settings. Verification, Google data, details and removal moved to Settings.
  - **Design system:** refined tokens and shadows; new KPI tiles, change indicators (arrow plus text, never colour alone), segmented range control, empty states, bar lists, cards with headers, and a compact in-row action form. `tailwind-merge` resolves class overrides. Icons come from lucide-react.
  - **Charts:** single-series SVG (no dual axes), 2px lines, a recessive grid, a crosshair and tooltip on hover, arrow-key reading, and a data-table view.

Verified (local, 2026-11-17):
| Check | Result |
|---|---|
| Typecheck (8 packages) and lint | ✅ |
| `@sge/core` (+17: PKCE URL; encrypted token storage; roles; bad code / no offline access / not configured; property listing and domain matching; GSC-owned → verified + schedules; 16-month backfill with exact row counts; idempotent re-sync; incremental sync fetches only new days; dashboard totals and breakdowns; workspace, client-scope and raw-SQL isolation of 6 new tables; revoked token → expired, no retries; 403 handling; disconnect revokes and stops schedules; sync-window planner; keywords: case-insensitive de-duplication, off-site target rejected, Search Console metrics join, suggestions, history, CSV import with source rule, plan limit, roles, cross-workspace delete blocked) | ✅ 215/215 |
| `@sge/crawler` 87, `@sge/seo-rules` 48, `@sge/db` 12, `@sge/jobs` 11 | ✅ |
| Playwright e2e: M1 12, M2 7, M3 1, M4 5, M5 6 (Google start redirect with PKCE and an httpOnly signed cookie; forged and replayed callbacks refused; dashboards on seeded data incl. range switch and keyboard chart reading; Track from queries; keywords add, CSV import, detail, bulk remove; overview; mobile menu) | ✅ 31/31 |
| Screenshots of every new page at desktop and mobile width reviewed | ✅ |

Bugs and issues caught:
- **Lost "expired" message:** an expired Google connection attempt redirected to a page that dropped its message. `/app` now passes it to the Integrations page.
- **Card padding overrides:** class order didn't override padding (`p-0` vs `sm:p-6`) or widths. Fixed with `tailwind-merge`.
- **Sync now without Google:** "Sync now" was shown with no Google connection. It's now hidden until Google is connected.

Known gaps / remaining work:
- **Google consent screen in Testing mode:** only listed test users can connect, and Google expires their refresh tokens after 7 days. For real customers, the OAuth app needs Google's verification for the sensitive read-only scopes. See the deployment notes.
- **No table partitioning yet:** Search Console and GA4 tables use primary-key indexes. Monthly partitioning (DATABASE_DESIGN §7) is deferred until volumes need it.
- **Countries show as codes:** ISO-3 codes from Search Console, without full names.
- **Volume and difficulty only from imports:** there's no paid keyword API, by design.
- **Not built yet:** dark mode, and a workspace-wide keyword list across all websites.

## M6 — Backlink acquisition engine (with most of M7 and the M8 outreach CRM) ✅ (2026-11-23)

Integrated from the standalone build (13/13 acceptance there). What reuses the
monorepo and what is new: [docs/BACKLINKS_INTEGRATION.md](BACKLINKS_INTEGRATION.md). Design decision: ADR-004 in ARCHITECTURE.

Implemented:
- **`@sge/backlinks` (new package):** discovery (curated catalogue, URLs, CSV and competitor-backlink CSV, site expansion, manual research queries), qualification crawler with risk signals, 0–100 scoring with a reason per factor (no DA/DR), fact-checked asset generation from an approved business profile, six adapters (Listing API, HTTP form, Playwright browser form, manual/editorial, outreach email, WordPress partner draft), the browser egress proxy, the 16-state submission machine with full history and evidence, approvals, human tasks, verification with lost-link detection and recovery, outreach CRM, and funnel analytics.
- **On the monorepo's infrastructure:** workspaces/roles/client scope (`inWorkspace`, permission matrix), RLS, the `jobs` queue and `schedules`, `safeFetch`, plan limits, encrypted secrets, audit log, GA4 data for referral sessions.
- **Database:** 19 tables (migration 0012), seed catalogue, triggers, plan limit and RLS (0013).
- **UI:** a Backlinks tab on each website: campaigns (funnel, create, pause/resume, opportunities with score reasons, imports, research queries), approvals (the exact snapshot), tasks (prepared values to copy), submission history and evidence, outreach, business profile, automation and destinations (with each adapter's test status). Failed backlink jobs can be retried from Settings → Jobs.
- **Worker and web:** the worker runs every backlink job (browser jobs need Chromium; `BACKLINKS_BROWSER=off` leaves them queued); web ticks and `after()` processing run everything except browser jobs.
- **Shared packages:** `safeFetch` gained POST, response headers, no-follow and `vetUrl` (existing behaviour unchanged); `runTick({ types })` and tenant-side `requeueJob()`; plan limit `backlink_submissions_month` and a real `backlinks_monitored` count.

Fixed while porting (standalone issues): file-upload fields could read a profile-supplied local path on the worker; API tokens were read from an environment variable named by tenant data; two adapters claimed tests that didn't exist (now tested); a DNS failure on robots.txt was reported as "robots disallows".

Verified (local, 2026-11-23; Postgres 17, Chromium 1255):
| Check | Result |
|---|---|
| Typecheck (all packages + web) and web lint | ✅ |
| `@sge/backlinks` unit (URL/SSRF primitives, signals, scoring, form filling incl. no file uploads, state machine, assets, discovery, autopilot policy, errors) | ✅ 21/21 |
| `@sge/backlinks` acceptance TEST 1–9 + manual mode + worker role (real HTTP to the test destination, real Chromium, the shared queue) | ✅ 11/11 |
| `@sge/backlinks` acceptance TEST 10–12 (isolation and roles, crawler and browser SSRF, retries/leases/time slices/plan allowance/failure queue) | ✅ 3/3 |
| `@sge/backlinks` adapter contracts (WordPress drafts; outreach approval, mailbox, opt-out suppression) | ✅ 4/4 |
| `@sge/crawler` (+4 POST/headers/no-follow/vetUrl) | ✅ 91/91 |
| `@sge/jobs` (+2 type filter, tenant requeue) | ✅ 13/13 |
| `@sge/core` 215, `@sge/seo-rules` 48, `@sge/db` 12 (schema invariants now cover the 19 new tables) | ✅ unchanged and passing |

The acceptance suite runs offline by default: every public hostname fails to resolve, so only the project's own test destination is contacted. `BACKLINKS_LIVE_TESTS=1` also crawls real catalogue sites (read-only, robots-respecting) for TEST 2.

Known gaps / remaining work:
- **E2E (Playwright, browser UI) for the Backlinks pages** is not written yet; the pages are typechecked, linted and built, and every action goes through services covered by the acceptance suite.
- **No per-workspace SMTP mailbox (M8).** Outreach ends in a "send it from your mailbox" task; sending through a mailbox is tested with an in-memory transport only.
- **WordPress partner drafts** are tested against a WordPress-compatible endpoint, not a real WordPress install.
- **No third-party destination is automated.** Every catalogue destination is manual-only until someone records explicit permission.
- **Evidence retention** by plan, and the M7 cadence refinements (daily checks for new links, monthly for lost), are follow-ups; links are re-checked weekly.
- **Search-engine discovery** is manual by design (query templates); a bring-your-own-key search provider is not built.

## Seed directory dataset (reviewed for M6, 2026-11-23)

`packages/db/seed/link_sources.csv`: 108 free or freemium listing sites, research-checked on 2026-11-16. Reviewed and loaded by migration 0013, merged with the standalone's curated list (139 global sources): **all manual-only** (none of these destinations has granted automation), all `unverified`, and four UGC communities (Reddit, Hacker News, Quora, GrowthHackers) retired because posting there to obtain links breaks their rules. The table below is the original research summary.

| Confidence | Rows | Meaning |
|---|---|---|
| high | 19 | page fetched, live, free listing confirmed |
| medium | 33 | strong search evidence, or fetched but free tier not stated |
| low | 56 | from memory or blocked by the site (403/bot check) |

- **Link type:** every row's `link_type_known` is `unknown`; no row is assumed to be dofollow. The link verifier (M7) will fill this in from real pages.
- **Check first:** SelectedFirms, SuperbCompanies and MarTech Series may be paid-only.
- **Excluded:** paid-only (BetaList, Awwwards, CSS Design Awards, Forbes Councils, Entrepreneur), closed (Uneed, Social Media Today contributors), dead or broken (DesignFirms, ClickIndia TLS), partner-status-only (Semrush, BrightLocal, HubSpot, Google Partners), and link-farm-like lists.

## Demo deployment ✅ (2026-11-17)

- **URL:** https://seo-growth-engine-nine.vercel.app (Vercel Hobby, function region Singapore `sin1`)
- **Database:** Neon free tier via the Vercel integration, region ap-southeast-1. Set up by `scripts/neon-setup.mjs`: restricted `app_user` and `auth_user` roles, migrations applied, isolation verified over the pooled endpoint.
- **Live health check:** `{"status":"ok","config":"ok","database":"ok","isolation":"ok","mail":"log"}`
- **Mail:** demo mode (`MAIL_TRANSPORT=log`). Verification, reset and sign-in links appear in Vercel → Logs (search `[mail:log]`). Switch to SMTP before real users sign up.
- **Vercel variables:** the app reads `APP_DATABASE_URL` / `AUTH_DATABASE_URL` only. The integration's `DATABASE_URL`, `PG*` and `POSTGRES_*` (owner role) are present but unused, and `/api/health` reports `isolation: unsafe_role` if the app ever connects with a privileged role.
- Lessons: Vercel's bulk paste dropped two base64 secrets, so secrets are now generated as hex; `/api/health` now names misconfigured variables (names only) and database error codes.

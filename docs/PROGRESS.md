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

## Next: M3 — Job system & crawler

pg-boss worker with per-workspace fairness, schedules, job history UI, and a resumable, polite crawl frontier on top of `safeFetch` (robots.txt, sitemaps). On cPanel the same worker runs in bounded batches from cron.

## Seed directory dataset (draft, needs review)

`packages/db/seed/link_sources.csv`: 108 free or freemium listing sites, research-checked on 2026-11-16. Not loaded into any database yet; it ships only after human review (M6).

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

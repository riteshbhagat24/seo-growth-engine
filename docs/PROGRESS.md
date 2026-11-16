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

Not yet verified: the CI workflow has not run on GitHub (the repo isn't pushed yet).

## Next: M1 — Accounts & workspaces

Better Auth (email/password, verification, magic link, Google sign-in), personal workspace on sign-up, agency workspaces, invitations, roles and permission matrix, membership-based RLS for the workspace switcher, audit logs, branding settings.

# SEO Growth Engine — Development Milestones

## Definition of done (every milestone)

1. Features implemented end to end (UI → service → database → worker where relevant).
2. `pnpm typecheck`, `pnpm lint`, `pnpm test` (unit + integration on Dockerised Postgres) and `pnpm build` pass in CI.
3. **Tenant isolation suite passes**, extended with every new table and route.
4. Playwright e2e for the milestone's main flows.
5. Docs updated; `docs/PROGRESS.md` records what is complete, what was tested and what remains.
6. Nothing is marked complete without a passing test that exercises it.

## Milestones

| # | Milestone | Contents | Exit criteria |
|---|---|---|---|
| **M0** | Foundations | pnpm monorepo, Next.js app, worker skeleton, Docker Compose (Postgres + Mailpit), env schema, CI, Drizzle setup, DB roles, RLS helper `withTenant`, schema test that enforces RLS | `docker compose up` + `pnpm dev` works; CI green; RLS test proves fail-closed |
| **M1** | Accounts & workspaces | Better Auth (email/password, verification, magic link, Google), personal workspace on sign-up, agency workspaces, invitations, roles, workspace switcher, permission matrix, audit logs, branding settings, platform settings (name/logo/theme) | Isolation suite on orgs/memberships; role matrix tests; invite flow e2e |
| **M2** | Plans, usage, clients, websites | Plans/subscriptions/usage counters with limit enforcement (no billing), clients, client assignment, client portal role, websites with DNS/meta/file verification | Limits enforced in tests; Client role sees only assigned websites |
| **M3** | Job system & crawler | pg-boss worker, schedules, job history UI, `safeFetch` with SSRF suite, robots/sitemap parsing, resumable crawl frontier | SSRF tests (private IPs, rebinding, redirect to localhost, IPv6 tricks) pass; a 500-page crawl resumes after a worker kill |
| **M4** ✅ | Technical audit & on-page (**first usable release**) | Audit rule engine (~40 rules), health score, issues UI, PSI/CrUX, on-page analyzer, audit comparison | Rules unit-tested against HTML fixtures; audit of a fixture site matches the expected issues |
| **M5** ✅ | Google integrations & keywords | OAuth (encrypted tokens), GSC sync + backfill, GA4 sync, keywords module, dashboards | Sync idempotency tests with recorded API fixtures |
| **M6** | Backlink discovery, scoring, submissions | Seed `link_sources` dataset, CSV/competitor/manual import, footprint helper, site inspection, scoring with explanations, submission workflow and approvals | Duplicate prevention; scoring explanations complete; no submission without approval |
| **M7** | Verification, monitoring, recovery | Backlink verifier, check history, cadence, lost detection, recovery tasks, funnel metrics | LIVE only after `found = true`; lost detection e2e with a fixture site |
| **M8** | Outreach | Mailboxes (SMTP), templates, threads, approvals, sending limits, suppression, unsubscribe, bounces, follow-ups | Suppressed addresses never sent to; limits enforced |
| **M9** | Content studio & WordPress | Briefs, editor with on-page score, templates, approvals, revisions, WordPress drafts/publish, optional BYO LLM provider (off by default) | Publish requires approval; no published post overwritten |
| **M10** | Competitors & reports | Competitor imports, gap analysis, report builder, PDF, schedules, share links, white-label branding | Report PDFs render with org branding; share links expire |
| **M11** | Platform admin & hardening | Platform admin area, impersonation with audit, abuse controls, API keys + public API, rate limits, security headers, backup/restore runbook, load test | Security checklist complete; restore drill done |
| **M12** | Production launch | New Vercel project (or self-host), managed Postgres, worker host, monitoring, domain | Launch checklist complete |

M1–M4 make up the first release that real users could try (accounts, workspaces, websites and technical audits).

## Decisions needed before M0

| # | Decision | Recommendation |
|---|---|---|
| D1 | Approve the stack: Next.js, PostgreSQL + RLS, Drizzle, Better Auth, pg-boss, Tailwind/shadcn | Yes |
| D2 | Hosting target | Start local (Docker). For production: Vercel Pro for the web app plus a small container host for the worker, or fully self-hosted on one VPS for the lowest cost |
| D3 | Database host for staging/production | Neon or Supabase free tier for staging; both support RLS and point-in-time recovery on paid tiers |
| D4 | GitHub repo `seo-growth-engine`: personal account or an organisation? Private? | Private, under your account |
| D5 | Placeholder product name until branding is chosen | "SEO Growth Engine" |
| D6 | Seed directory dataset: are you happy for me to compile an initial list of ~150 well-known, free business and marketing directories (global + India), verified manually as the platform admin? | Yes, curated and reviewed before shipping |

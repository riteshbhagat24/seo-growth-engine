# Backlink acquisition engine — integration map

The engine was first built and tested as a standalone app. This
document records how it was folded into this monorepo: what reuses existing infrastructure, what is new, and
what changed on the way in. It covers milestones M6 (discovery, scoring, submissions) and most of M7
(verification, monitoring, recovery) and M8 (outreach CRM, without SMTP mailboxes).

## 1. Reused from the monorepo (not duplicated)

| Standalone component | Monorepo equivalent used instead | Notes |
|---|---|---|
| `organizations`, `users`, `sessions`, scrypt auth, `/api/auth/*` | Better Auth (`auth` schema), `organizations`, `memberships` | The standalone's own auth tables and routes were dropped. |
| Roles `owner/admin/member/client` + `assertWebsiteAccess` | `permissions.ts` matrix + `inWorkspace()` + client-scope RLS | `work.run` = prospect/draft/plan; `work.approve` = approve submissions and outreach; `automation.enable` = autopilot and source permissions. Client-restricted members see only their clients' websites, through RLS. |
| `clients`, `websites` | `clients`, `websites` (M2) | Website ownership verification (M2) now also proves `own_property` for automation. |
| `audit_logs` (own shape) | `audit_logs` + `audit()` | Engine actions map to `action`, `entity_type`, `entity_id`, `metadata` (with `actor_type`). |
| `automation_jobs`, job runner, `sge_service` BYPASSRLS role | `jobs` + `@sge/jobs` runner + `worker_user` (no BYPASSRLS) | Handlers run under `app_user` + RLS in the job's workspace. Deferrals use `{ continue, delayMs }`; permanent failures use `PermanentJobError`. |
| Cron `scheduleTick()` (BYPASSRLS, all tenants) | `schedules` table + `processSchedules()` | One `backlinks.tick` schedule per website with an active campaign (daily plan, weekly discovery and re-verification, follow-up reminders). No cross-tenant reads. |
| `automation_usage` + `organizations.quotas` | `usage_counters` + plan limits | New metered limit `backlink_submissions_month`; `backlinks_monitored` (already a plan limit) is now counted. Qualification fetches count against `pages_crawled_month`. |
| `safeFetch` + `ssrf.ts` (`ipaddr.js`) | `@sge/crawler` `safeFetch` + `ip-guard` | Extended (see §3) instead of duplicated. |
| robots.txt parser | `@sge/crawler` `parseRobots` (RFC 9309) | Cached per origin in the engine's polite fetcher. |
| `backlink_referral_stats` (CSV import) | `ga4_daily` (M5) | Referral sessions come from the website's GA4 sync (`medium = referral`, `source` = a verified referring domain). Nothing is estimated. |
| Evidence on the local filesystem (`EVIDENCE_DIR`) | Postgres (`backlink_submission_evidence.data`, RLS) | Works on Vercel and cPanel, where the web app can't read the worker's disk. Capped at 2 MB per item. |
| Adapter registry table `backlink_adapters` | Code only (`@sge/backlinks` registry) | Same reasoning as ADR-002 for audit rules: manifests are reviewed and deployed with the code that implements them. |
| Next.js pages and JSON API | Workspace UI under `/w/[slug]/websites/[websiteId]/backlinks` with server actions | Follows the existing app shell, tabs and components. |

## 2. New (package `@sge/backlinks`)

| Area | What it does |
|---|---|
| Business profile | The only source of facts for generated copy; must be approved, and goes back to draft on every edit. |
| Discovery | Curated catalogue (global `backlink_sources`), user URLs, CSV and competitor-backlink CSV imports, site expansion, query templates for manual research. Search engines are never scraped. |
| Qualification + scoring | Polite crawl of each prospect; signals (relevance, credibility, spam, link selling, hacked/phishing/malware patterns, submission route); 0–100 score with a reason per factor. No DA/DR. |
| Assets + fact check | Template copy per destination (unique per site), every claim traced to the approved profile, fabricated awards/statistics/certifications flagged. |
| Adapters | `listing-api-v1`, `http-form`, `browser-form` (Playwright), `manual-editorial`, `outreach-email`, `wordpress-draft`, each with an honest manifest and test status. |
| Browser egress proxy | Chromium is forced through a local proxy that applies the same SSRF policy and DNS pinning as `safeFetch`. |
| Submission state machine | 16 states, validated transitions, append-only event history; only `VERIFIED` counts as an acquired link. |
| Approvals | Exact snapshot of destination, adapter, values and content; nothing executes without a recorded approval or an autopilot decision. |
| Verification + recovery | Crawler-confirmed links only; two consecutive misses → `LOST`, diagnosis, approval-gated recovery email, automatic recovery detection. |
| Outreach CRM | One-to-one, approval-gated, opt-out suppression across the workspace, at most one follow-up (drafted, never auto-sent). |
| Analytics | Funnel that keeps attempted / submitted / published / verified separate. |
| Test destination | `packages/backlinks/test/fixtures/test-destination.ts`, a real HTTP directory used only by tests. |

## 3. Changes to shared packages

- `@sge/crawler` `safeFetch`: optional `method` (`GET`/`HEAD`/`POST`), `body`, `followRedirects`, and
  `responseHeaders` in the result (needed for form CSRF cookies and `Retry-After`). Existing callers are
  unchanged. A `vetUrl()` export resolves and validates one URL so the browser egress proxy can pin its
  connections. The connection pinning, public-address checks, redirect re-validation and size limits are the
  same code paths as before.
- `@sge/jobs`: `runTick({ types })` claims only the given job types (the web app skips browser jobs, which
  need the worker's Chromium); `requeueJob()` lets a workspace retry its own failed job (RLS-scoped).
- `@sge/core`: plan limit `backlink_submissions_month`; `backlinks_monitored` counted from monitored links.

## 4. Safety guarantees carried over

| Guarantee | Where it lives now |
|---|---|
| SSRF: schemes, ports, credentials, private/reserved/mapped/NAT64 addresses, DNS pinning, redirect re-validation, size and time caps | `@sge/crawler` `safeFetch` (unchanged code paths) + engine `UrlPolicy` hostname checks |
| Browser SSRF | Egress proxy → `vetUrl()` + pinned sockets; Playwright route policy; WebRTC non-proxied UDP disabled; downloads and service workers blocked |
| robots.txt | Engine fetcher (crawler and verifier); permitted-API/form posts don't crawl |
| No CAPTCHA bypass, no account creation, no invented data | Adapters return `human_required` and open a task |
| Approval gating | Executor refuses submissions without a user approval event or a recorded autopilot policy decision |
| Autopilot only for explicit permission | Source permission (`explicit_permission`, `own_property`, `test_destination`) **and** per-website opt-in **and** an autopilot-capable, tested adapter **and** clean fact check |
| Verified-only counting | State machine + analytics |
| Tenant isolation | FORCE RLS + `tenant_isolation` + `website_visible` restrictive policies on every new table; composite FKs `(organization_id, website_id, id)` |

## 5. Deliberate fixes made while porting

- **No local file uploads.** The standalone uploaded `profile.logo_path` from the worker's disk, which an org
  member could point at any server file. Logo upload fields now become a human task.
- **No secrets named by tenant data.** The standalone read API tokens from an environment variable named in
  `api_config.token_env`, which an org could point at a platform secret. Destination credentials are now stored
  encrypted per workspace (AES-256-GCM via `@sge/core` secrets, bound to `<org>:backlink_source:<id>`).
- **Outreach uses only the workspace's own mailbox.** There is no per-workspace SMTP mailbox yet (M8), so
  outreach-email always ends in a "send from your mailbox" task; the platform's system SMTP is never used.
- **Org sources can't self-declare `test_destination`.** Only platform (global) sources may carry it; tests seed
  their source directly. `own_property` requires a verified website on the same domain.

## 6. Seed catalogue review

`packages/db/seed/link_sources.csv` (108 sites) and the standalone's 59 curated platforms were merged by domain
into the global `backlink_sources` catalogue (migration `0013`): 139 sources. **Every** row is `manual_only` and
`unverified` (editorial publications use the approval-gated outreach adapter): none of these destinations has granted automation
permission, so they are discovered, scored and prepared, and a person submits. The CSV's `confidence`, free-tier
and notes are preserved in `permission_evidence.review` and `notes`. Four UGC communities (Reddit, Hacker News,
Quora, GrowthHackers) are `retired`, so they are never discovered: posting there to obtain links breaks their rules.
SelectedFirms, SuperbCompanies and MarTech Series carry a "check first: may be paid-only" note.

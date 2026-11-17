# SEO Growth Engine — Database Design

PostgreSQL 16+, Drizzle ORM, SQL migrations committed in `packages/db/migrations`. UUID v7 primary keys (time-ordered). `snake_case` names. All timestamps are `timestamptz`.

## 1. Tenancy rules

1. Every tenant-owned table has `organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE`.
2. Website-related tables also have `website_id uuid NOT NULL`.
3. **Cross-tenant references are impossible by construction.** Parent tables expose `UNIQUE (id, organization_id)`, and children use **composite foreign keys**, e.g. `FOREIGN KEY (website_id, organization_id) REFERENCES websites(id, organization_id)`. A row cannot point at another tenant's website even if application code is wrong.
4. **Row-Level Security** is `ENABLE`d and `FORCE`d on every tenant table. The runtime role `app_user` is not the owner and has no BYPASSRLS.
5. Standard policy (generated for each tenant table):

```sql
CREATE POLICY tenant_isolation ON <table>
  USING      (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
```

If `app.org_id` is not set, `current_setting(..., true)` returns NULL and **no rows match**, so the default is to fail closed.

6. Client-scoped tables (those with `client_id`, directly or through `websites`) add a restrictive policy:

```sql
CREATE POLICY client_scope ON websites AS RESTRICTIVE
  USING (current_setting('app.client_scope', true) = '*'
         OR client_id = ANY (string_to_array(current_setting('app.client_scope', true), ',')::uuid[]));
```

Website children inherit this through a `website_id IN (SELECT id FROM websites)` policy, which is itself filtered by RLS.

7. A migration test asserts that **every** table with an `organization_id` column has RLS enabled and forced, and the tenant policy. CI fails otherwise.

## 2. Database roles

| Role | Used by | Rights |
|---|---|---|
| `app_owner` | migrations only | owns schema |
| `app_user` | web + worker | DML on app tables, RLS enforced |
| `platform_admin` | platform admin area | BYPASSRLS; separate connection string; audited |
| `readonly_backup` | backup tooling | read-only |

## 3. Identity and tenancy tables

Better Auth core tables (`users`, `sessions`, `accounts`, `verifications`, `two_factors`) are **global** (not tenant-scoped). They are protected by application logic and kept out of `app_user`'s direct reads except through auth services.

| Table | Key columns |
|---|---|
| `organizations` | id, slug unique, name, type (`personal`/`agency`), owner_user_id, branding jsonb, settings jsonb, status (`active`/`suspended`/`deleted`), created_at |
| `memberships` | id, organization_id, user_id, role (`owner`,`admin`,`manager`,`specialist`,`viewer`,`client`), all_clients bool, unique(organization_id, user_id) |
| `membership_clients` | membership_id, client_id, organization_id (composite FKs) |
| `invitations` | id, organization_id, email, role, client_ids uuid[], token_hash, expires_at, invited_by, status |
| `api_keys` | id, organization_id, name, prefix, key_hash, scopes text[], last_used_at, expires_at, revoked_at |

`organizations` RLS: a user sees organisations where they have a membership (policy uses `app.user_id`).

## 4. Commercial tables

| Table | Notes |
|---|---|
| `plans` (global) | id, code unique, name, limits jsonb (`websites`, `clients`, `members`, `pages_crawled_month`, `keywords`, `backlinks_monitored`, `reports_month`, `outreach_emails_day`, `storage_mb`), features jsonb, is_public, sort |
| `subscriptions` | organization_id unique, plan_id, status (`trialing`,`active`,`past_due`,`canceled`,`comped`), trial_ends_at, current_period_start/end, external_ref (for future billing), overrides jsonb |
| `usage_counters` | organization_id, metric, period_start, value bigint; unique(org, metric, period_start); incremented atomically with `INSERT … ON CONFLICT DO UPDATE` and checked against limits in the same transaction |

## 5. Clients and websites

| Table | Key columns |
|---|---|
| `clients` | id, organization_id, name, status, contacts jsonb, notes, archived_at; unique(id, organization_id) |
| `websites` | id, organization_id, client_id nullable (composite FK), url, domain, display_name, niche, country, language, verification_status, verification_method, verification_token, verified_at, gsc_property, ga4_property_id, settings jsonb; unique(organization_id, domain); unique(id, organization_id) |
| `website_schedules` | website_id, organization_id, job_type, cron, enabled, last_run_at, next_run_at |

## 6. Technical audit and on-page

| Table | Key columns |
|---|---|
| `audits` | id, org, website_id, status, started_at, finished_at, pages_crawled, health_score, settings jsonb, error |
| `audit_frontier` | audit_id, org, url_hash, url, depth, status — resumable crawl queue; unique(audit_id, url_hash) |
| `audit_pages` | audit_id, org, website_id, url, status_code, redirect_chain jsonb, canonical, indexable, title, meta_description, h1_count, word_count, depth, inlinks, outlinks, load_ms, bytes, content_hash, data jsonb |
| `audit_issues` | audit_id, org, website_id, page_id nullable, rule_code, severity (`critical`,`warning`,`notice`), details jsonb |
| `audit_rules` (global) | code, category, severity, title, explanation, how_to_fix |
| `cwv_results` | org, website_id, url, strategy (mobile/desktop), source (`psi`,`crux`), metrics jsonb, measured_at |
| `onpage_analyses` | org, website_id, url, keyword, score, checks jsonb, analyzed_at |

High-volume tables (`audit_pages`, `audit_issues`) are pruned by retention policy (keep the last N audits per plan).

## 7. Keywords and search data

| Table | Key columns |
|---|---|
| `keywords` | org, website_id, keyword, group_name, tags text[], target_url, intent, volume int null, volume_source text null, difficulty int null, difficulty_source null; unique(website_id, lower(keyword)) |
| `gsc_daily` | org, website_id, date, query, page, country, device, clicks, impressions, ctr, position; unique on dims; **partitioned by month** |
| `ga4_daily` | org, website_id, date, source, medium, landing_page, campaign, sessions, engaged_sessions, key_events; partitioned by month |

## 8. Backlinks

| Table | Key columns |
|---|---|
| `link_sources` (global) | id, domain unique, name, url, category, country, language, niches text[], submission_url, submission_method, requirements jsonb, tranco_rank, open_pagerank, is_seed, blocked, last_inspected_at. **The curated seed dataset**, maintained by the platform admin and read-only to tenants |
| `opportunities` | id, org, website_id, link_source_id null, domain, url, category, discovery_source (`seed`,`csv`,`competitor`,`manual`,`footprint`,`byo:<provider>`), stage, score int null, priority, score_breakdown jsonb, score_missing text[], submission_method, automation_enabled bool default false, automation_note, target_url, proposed_anchor, rejection_reason, assigned_to; unique(website_id, domain, url) |
| `submissions` | id, org, website_id, opportunity_id, method, content_id null, payload jsonb (exact snapshot), status, approved_by, approved_at, submitted_at, response_code, response_message, publication_url, attempt_count |
| `submission_events` | append-only: submission_id, org, at, event, actor, detail jsonb |
| `backlinks` | id, org, website_id, source_url, source_domain, target_url, anchor_text, rel_nofollow, rel_sponsored, rel_ugc, status, origin (`acquired`,`imported`,`discovered`), opportunity_id null, first_seen_at, last_live_at, lost_at, last_checked_at, next_check_at, data_origin; unique(website_id, source_url, target_url) |
| `backlink_checks` | append-only: backlink_id, org, checked_at, http_status, final_url, found, anchor_text, rel text[], result_status, error, duration_ms; partitioned by month |
| `recovery_tasks` | org, website_id, backlink_id, reason, suggested_action, status, attempts, notes |

## 9. Outreach

| Table | Key columns |
|---|---|
| `mailboxes` | org, name, from_name, from_email, smtp_host, smtp_port, smtp_user, smtp_password_enc, daily_limit, status |
| `outreach_contacts` | org, website_id, opportunity_id null, name, email, domain, role, notes; unique(website_id, email) |
| `outreach_templates` | org, name, subject, body, variables text[] |
| `outreach_threads` | org, website_id, contact_id, mailbox_id, status, topic, proposed_anchor, destination_url, follow_ups, last_sent_at, last_reply_at, publication_url |
| `outreach_messages` | org, thread_id, direction, subject, body, status (`draft`,`approved`,`sent`,`failed`), approved_by, sent_at, message_id |
| `email_suppressions` | org, email, reason, created_at; unique(org, email); checked before every send |

## 10. Content, competitors, WordPress

| Table | Key columns |
|---|---|
| `content_items` | org, website_id, type, title, body (Markdown), target_keyword, target_url, seo_title, meta_description, status (`draft`,`in_review`,`approved`,`published`), onpage_score, approved_by, approved_at, published_ref |
| `content_revisions` | content_id, org, body, author_id, created_at |
| `competitors` | org, website_id, domain, name; unique(website_id, domain) |
| `competitor_backlinks` | org, competitor_id, referring_domain, source_url, target_url, anchor, link_type, import_batch_id |
| `competitor_keywords` | org, competitor_id, keyword, position, volume null, source, import_batch_id |
| `imports` | org, website_id null, kind, filename, rows_total, rows_ok, rows_failed, errors jsonb, status, created_by |
| `wordpress_sites` | org, website_id, base_url, username, app_password_enc, status |

## 11. Integrations, reports, automation, audit

| Table | Key columns |
|---|---|
| `integrations` | org, provider (`google`,`psi`,`openpagerank`,`byo_llm`,`byo_search`, …), status, scopes, credentials_enc bytea, key_version int, connected_by, connected_at, last_error |
| `reports` | org, website_id null, client_id null, title, sections jsonb, branding jsonb, schedule cron null, recipients text[], share_token_hash, share_expires_at |
| `report_runs` | org, report_id, status, period_start, period_end, file_key, generated_at, delivered_at |
| `jobs_history` | org, website_id null, job_type, pg_boss_id, status, started_at, finished_at, error, stats jsonb (a tenant-visible mirror of pg-boss state) |
| `audit_logs` | append-only: id, org null (platform events), actor_user_id, actor_type, action, entity_type, entity_id, ip, user_agent, before jsonb, after jsonb, at. `app_user` has INSERT + SELECT (RLS) only; no UPDATE/DELETE grant |
| `platform_settings` (global) | key, value jsonb |

## 12. Indexing, partitioning and retention

- Every tenant table is indexed by `(organization_id, …)` leading with the most selective filter (for example `backlinks (organization_id, website_id, status)`, `backlinks (next_check_at) WHERE status IN ('pending','live','lost')`).
- `gsc_daily`, `ga4_daily` and `backlink_checks` are partitioned monthly; partitions are created ahead by the worker.
- Retention by plan: audits (last 5–20), check history (12–24 months), job history (90 days).

## 13. Migrations

- Generated with drizzle-kit, reviewed as SQL, and applied by a release step (`pnpm db:migrate`) using `app_owner`.
- RLS policies, roles and grants live in hand-written SQL migrations alongside the generated ones.
- Destructive changes follow expand → migrate → contract across two releases.
- Seeds: `plans` (Free, Pro, Agency defaults), `audit_rules`, and the `link_sources` seed dataset. All are idempotent upserts.

## 14. As built (M1)

- Schemas: `auth` (Better Auth: `users`, `sessions`, `accounts`, `verifications`, `rate_limits`; uuid ids) and `public` (tenant data).
- Roles: `app_owner` (migrations), `app_user` (tenant data, RLS), `auth_user` (identity schema only). `platform_admin` arrives in M11.
- `organizations.personal_owner_user_id` is UNIQUE: one personal workspace per user, race-safe.
- `memberships`: unique (organization_id, user_id); partial unique index allows one `owner` per organisation.
- `invitations`: `token_hash` unique; partial unique index on (organization_id, lower(email)) while `pending`.
- Policies beyond the standard `tenant_isolation`: `membership_self_read` (a user can list their own memberships across workspaces), `org_select` (current tenant, member, or invitation-token holder), `invite_by_token`, `platform_settings.read_all`.
- FORCE RLS applies to the table owner too, so seed rows are inserted before RLS is enabled, and SECURITY DEFINER functions still respect tenant policies on public tables.

## 15. As built (M2)

- `plans` (global, read-only to the app; limit `-1` = unlimited). Seeded: `free` and `pro` (personal), `agency_free` and `agency` (agency). Defaults per workspace type via `is_default`.
- `subscriptions` (one per workspace, created with it; existing workspaces backfilled). `app_user` may INSERT but not UPDATE/DELETE: plan changes are a platform-admin action. `overrides` jsonb adjusts individual limits.
- `usage_counters` (organization_id, metric, period_start = calendar month): atomic, capped increments for metered limits.
- `clients` with composite FKs from `membership_clients` and `websites` (`(client_id, organization_id)` → `clients(id, organization_id)`), so a website or assignment can never reference another workspace's client.
- `membership_clients` + `memberships.all_clients`: per-member client restriction. The `client` role is always restricted.
- `websites`: `client_id`, verification status/method/token/timestamps/last error.
- **Client scope in RLS:** `app_client_allowed(client_id)` reads `app.client_scope` (`*` or a list of ids). RESTRICTIVE policies on `clients` and `websites` apply it on top of tenant isolation. Workspace-level rows (`client_id` NULL) are visible only with `*`. Every request sets the scope from the member's assignments, re-read inside the same transaction.

## 16. As built (M3)

- `jobs`: queue and history.
  - `organization_id` NULL = system job.
  - RLS policies: `tenant_isolation`; `worker_all` scoped `TO worker_user`; and a RESTRICTIVE `website_visible` scoped `TO app_user`, so client-restricted members only see jobs for visible websites.
  - Partial indexes on due and running jobs.
- `schedules`: recurring work. Each slot enqueues one job, idempotent on `schedule:<id>:<epoch>`.
- `crawls` and `crawl_pages` (the frontier plus fetch results):
  - Composite FKs keep both inside one workspace (`crawl_pages(crawl_id, organization_id)` → `crawls`; `crawls(website_id, organization_id)` → `websites`).
  - RESTRICTIVE policies tie visibility to the website's client scope.
  - Unique `(crawl_id, url_hash)` de-duplicates the frontier.
- Role `worker_user`: SELECT/INSERT/UPDATE/DELETE on `jobs` and `schedules` only. It can't read organisations, websites or identity tables (tested locally and on Neon).

## 17. As built (M4)

- **`audits`**: one per audit run, created with its crawl (`crawl_id` is unique, composite FK to `crawls`). Lifecycle: `crawling` → `checking_links` → `analyzing` → `completed`, or `failed`/`cancelled`. Stores the health score, severity counts, `summary` (issue count per rule plus stats), the number of external links checked and the trigger (`manual` or `schedule`).
- **`audit_issues`**: one row per (rule, URL), or per rule for site-wide issues (`url` NULL). Also stores the severity (an enum) and a `details` jsonb with the evidence (link targets, status codes, lengths and so on). Indexed by `(audit_id, rule)`.
- **`audit_external_links`**: the resumable external link check. Unique `(audit_id, url_hash)`. `outcome` is NULL while pending, then `ok`, `broken` or `unverifiable`.
- **`crawl_pages` new columns:**
  - `seo` jsonb: the extracted `PageSeo`, without the full page text;
  - `redirects` jsonb: `{urls, statuses}`;
  - `inlinks` and `click_depth`: written by the analysis.
- **`cwv_results`**: one row per (URL, strategy) measurement: `queued` → `completed` or `failed`. `metrics` jsonb holds the lab metrics, CrUX field data and opportunities.
- **`onpage_analyses`**: the URL, final URL, keyword, score and the full result (checks, stats, search-result preview, the headings that were read).
- **`integrations`**: one row per (workspace, provider).
  - `credentials_enc` holds `v1:` + base64(IV | tag | ciphertext). The AES-256-GCM additional authenticated data is `<org>:<provider>`, so a ciphertext can't be moved between workspaces.
  - `key_hint` stores the last 4 characters for display.
- **Isolation**: every new table has FORCE RLS and a `tenant_isolation` policy. RESTRICTIVE policies scoped `TO app_user` hide rows for websites outside a member's client scope: `website_visible` on audits, CWV and on-page; `audit_visible` on issues and external links. `integrations` is tenant-scoped, and permissions are checked in the app (`integrations.manage`).
- **Plans**: limits gain `psi_runs_month` (Free 20, Pro 200, Agency Free 50, Agency 1000). Migration 0009 lifts FORCE RLS on `plans` only for the duration of that update.
- **Retention**: the newest 10 finished audits per website are kept. Deleting the old crawls cascades to their pages, audits, issues and link checks.
- **Deviation from §6**: there is no `audit_rules` table and no `audit_pages` or `audit_frontier`.
  - The rule catalogue is code (`@sge/seo-rules`), versioned with the rules that use it.
  - Audits reuse `crawls` and `crawl_pages` as frontier and page store, instead of duplicating them.

## 18. As built (M5)

- **`website_google`** (PK `website_id`, composite FK to `websites`):
  - the linked Search Console property and GA4 property (with its display name);
  - per product, the synced date range (`*_synced_from` / `*_synced_through`), the last sync time and the last error.
- **`gsc_site_daily`** (PK website + date): exact daily totals, including anonymised queries. Holds clicks, impressions and position; CTR is computed when read.
- **`gsc_dim_daily`** (PK website + date + dimension + value): the same metrics per `device` or `country` (ISO-3, lower case).
- **`gsc_daily`** (PK website + date + query + page): the top query × page rows (500 per day of a sync window, by clicks). Indexed on `(website_id, lower(query), date)` for the keyword join.
- **`ga4_daily`** (PK website + date + source + medium + landing page + campaign): sessions, engaged sessions and key events. Up to 1,000 rows per day; duplicate keys are aggregated before insert.
- **`keywords`**:
  - unique `(website_id, lower(keyword))`;
  - `tags text[]`, an `intent` enum, `target_url`;
  - `volume` and `difficulty` are only filled from imports, with `*_source` set to the user-supplied label.
- **`integrations`** gains `scopes text[]` and `account_email`. For the `google` provider, `credentials_enc` holds the encrypted refresh token.
- **`verification_method`** enum gains `gsc`.
- **Isolation:** every new table has FORCE RLS, `tenant_isolation`, and a RESTRICTIVE `website_visible` policy scoped `TO app_user` (migration 0011). The schema test enforces this.
- **Deviation from §7:** the tables aren't partitioned yet. Sync writes are idempotent per date window (delete + insert in one transaction), and deleting a website cascades to all its data.

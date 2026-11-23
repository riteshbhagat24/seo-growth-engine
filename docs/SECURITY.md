# SEO Growth Engine — Security and Access Control

## 1. Threat model (main risks)

| Threat | Control |
|---|---|
| Tenant A reads or changes tenant B's data | Membership check + permission check in services + Postgres RLS + composite FKs (§3) |
| Client user sees other clients of the agency | `app.client_scope` restrictive RLS policy + service checks |
| SSRF through the crawler, verifier, webhooks or WordPress URLs | `safeFetch` with IP pinning and deny ranges (ARCHITECTURE §5) |
| Credential theft from the database | Envelope encryption of every secret (§5) |
| Account takeover | Hashed passwords (scrypt/argon2 via Better Auth), rate limits, optional TOTP 2FA, session revoke, verified email |
| Abuse of the platform to spam or crawl aggressively | Outreach approval, daily send limits, suppression lists, crawl budgets, platform blocklist, suspension |
| Privilege escalation through invitations | Inviter cannot grant a role higher than their own; owner role transfer requires re-auth |
| Insider or support misuse | Platform admin role separated, 2FA required, impersonation needs a reason and is audited |

## 2. Authentication and sessions

- Better Auth with database sessions (revocable). Cookies are `HttpOnly`, `Secure`, `SameSite=Lax`, with a host-prefixed name (`__Host-`).
- Session lifetime 7 days rolling; re-authentication required for sensitive actions (change email/password, 2FA, ownership transfer, API key creation, deleting a workspace).
- Email verification required before creating an agency workspace or connecting integrations.
- Password policy: minimum 10 characters and a check against a breached-password list (k-anonymity range API — free — or an offline list).
- Login and sign-up rate limits per IP and per account, with lockout backoff.
- OAuth sign-in (Google) links to existing accounts only after email verification.

## 3. Authorisation (three layers)

1. **Route layer:** `[org]` segment resolves membership; non-members get 404.
2. **Service layer:** `can(ctx, action, resource)` before every read or mutation, using the matrix below.
3. **Database layer:** RLS policies + composite FKs (DATABASE_DESIGN §1). Runtime role has no BYPASSRLS.

### Permission matrix

| Action | Owner | Admin | Manager | Specialist | Viewer | Client |
|---|---|---|---|---|---|---|
| View dashboards/reports (scoped) | ✓ | ✓ | ✓ | ✓ assigned | ✓ | ✓ assigned |
| Manage members & invitations | ✓ | ✓ | – | – | – | – |
| Manage clients | ✓ | ✓ | ✓ | – | – | – |
| Add / verify websites | ✓ | ✓ | ✓ | – | – | – |
| Run audits, analyses | ✓ | ✓ | ✓ | ✓ | – | – |
| Prospect, score, draft | ✓ | ✓ | ✓ | ✓ | – | – |
| **Approve** submissions, outreach sends, publishing | ✓ | ✓ | ✓ | – | – | optional (content only) |
| Enable automation for a site | ✓ | ✓ | – | – | – | – |
| Connect integrations / mailboxes | ✓ | ✓ | – | – | – | – |
| Branding, report templates | ✓ | ✓ | ✓ | – | – | – |
| Plan & usage | ✓ | view | – | – | – | – |
| API keys | ✓ | ✓ | – | – | – | – |
| Delete workspace, transfer ownership | ✓ | – | – | – | – | – |

The matrix lives in code (`packages/core/permissions.ts`) and is covered by a table-driven test.

## 4. Tenant isolation testing (every milestone)

- An **isolation test suite** creates two organisations with data in every tenant table, then for each service and API route asserts that org B's session cannot read, list, update or delete org A's rows (404/403, zero rows).
- A raw SQL test runs as `app_user` with `app.org_id` set to org B and selects from every tenant table; it must return only org B rows. With no `app.org_id` set, it must return zero rows.
- A schema test fails CI if any table with `organization_id` lacks forced RLS and the tenant policy.
- Client-scope tests: a Client member sees only assigned clients' websites and their children.

## 5. Secrets and credential encryption

- Envelope encryption: each secret is encrypted with AES-256-GCM using a random data key, and the data key is encrypted with the master key `ENCRYPTION_KEY` (32 bytes, environment). Stored values: `ciphertext`, `iv`, `tag`, `key_version`.
- Key rotation: add a new key version, re-encrypt in a background job, then retire the old one.
- Secrets are decrypted only inside the worker or server service that needs them, never sent to the browser, and never logged.
- API keys for our own API are shown once and stored as SHA-256 hashes with a visible prefix.
- `.env` files are never committed; `.env.example` lists names only.

## 6. API and abuse protection

- Rate limits (Postgres-backed token bucket, no Redis) per IP, per user, per API key and per organisation, with stricter limits on auth routes.
- Request body size limits; Zod validation on every input; output encoding through React; Markdown rendered with a sanitiser (`rehype-sanitize`).
- CSRF: server actions use Next.js origin checks; JSON API requires `Content-Type: application/json` and checks `Origin` for cookie-authenticated requests.
- Security headers: CSP (nonce-based), HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors 'none'` (except the report share view if embedding is enabled).
- File uploads (logos, CSV): size caps, MIME sniffing, SVG sanitised or rejected, stored outside the web root with random keys.
- CSV imports: formula-injection safe on export (prefix cells starting with `= + - @`).

## 7. Outbound safety

- `safeFetch` for every user-influenced URL (ARCHITECTURE §5).
- Crawl budgets per plan; per-host politeness; platform blocklist; respect for robots.txt.
- Outreach: approval required, daily limits per mailbox, `List-Unsubscribe` header and footer link, suppression list checked at send time, bounce handling.
- No automated form submission unless an org admin enables it for that site with a recorded permission note.

## 8. Audit logging

Logged events include: sign-in and failures, 2FA changes, membership and role changes, invitations, client and website create/delete, verification, integration connect/disconnect, automation toggles, approvals, outreach sends, publishing, exports, API key lifecycle, plan changes, platform admin actions and impersonation. Logs are append-only, readable by workspace owners and admins (their org only), and retained for 12 months.

## 9. Backup and recovery

| Item | Target |
|---|---|
| Automated backups | Daily full + continuous WAL / point-in-time recovery where the host supports it (Neon and Supabase do; self-hosted uses `pgBackRest` or `wal-g` to object storage) |
| Retention | 7 daily + 4 weekly + 3 monthly |
| Encryption | Backups encrypted at rest; credentials for the backup bucket separate from app credentials |
| RPO / RTO | ≤ 15 min / ≤ 4 h |
| Restore test | Quarterly restore into a scratch database, running the isolation test suite against it |
| Runbook | `docs/RUNBOOK.md` (written in M11): restore steps, key rotation, incident response, workspace data export and deletion |

## 10. Privacy

Data export per workspace (JSON/CSV), workspace deletion (soft delete for 30 days, then hard delete including backups as they age out), account deletion, minimal personal data on outreach contacts, and documented legal basis for outreach contacts being the user organisation's responsibility.

## 11. Implementation notes (M1)

- **Identity is separated from tenant data at the database level.** Better Auth's tables live in schema `auth`, reachable only by the `auth_user` role. The tenant role `app_user` cannot read password hashes or sessions, and `auth_user` cannot read tenant tables (both proven by tests). Two narrow `SECURITY DEFINER` functions bridge the gap: `current_user_identity()` (the current user's own email and verification status) and `org_member_profiles()` (names and emails of members of the current tenant only).
- **Invitations:** only `sha256(token)` is stored. A request holding the token can see that one invitation and its workspace name (policy `invite_by_token`), nothing else. Accepting requires a signed-in user whose verified email matches; the token is single-use and expires after 7 days.
- **Stale-role protection:** every workspace mutation re-reads the actor's role inside its own transaction, so a role removed mid-request can't be used.
- **Exactly one owner** per workspace is enforced by a partial unique index; ownership transfer demotes then promotes in one transaction.
- **Audit logs** are append-only for `app_user` (UPDATE/DELETE/TRUNCATE revoked).
- **Rate limits** (Better Auth, stored in Postgres): sign-in 5/min, sign-up, magic link, password reset and verification resend 5 per 5 min, per client IP. Passwords: 10–128 characters, checked against the Have I Been Pwned range API (k-anonymity: only 5 hash characters leave the server).
- **Client IP trust:** rate limiting and audit IPs come from `TRUSTED_IP_HEADERS` (default `x-forwarded-for`). This is only safe if the hosting proxy overwrites that header. Vercel does. **Before going live on cPanel, confirm what the host's proxy sets**, and change the variable if needed; otherwise clients can spoof their IP and bypass per-IP limits.
- **Not yet built (scheduled):** TOTP two-factor authentication and breached-password checks on password change are planned for M11 hardening.
- **Demo mail mode (`MAIL_TRANSPORT=log`):** emails are not sent; verification, reset, sign-in and invitation links are written to the server log, and `/api/health` reports `mail: "log"`. Anyone who can read the logs can use those links, so this is for demos only and must be replaced with SMTP before real users sign up. It must be set explicitly; with neither SMTP nor this flag, production refuses to start.

## 12. Implementation notes (M2)

- **Outbound requests to user-supplied URLs** go through `@sge/crawler`'s `safeFetch`:
  - **Allowed targets:** http/https only, ports 80 and 443, no credentials in URLs.
  - **Address checks:** every DNS answer must be public, so a mixed public/private answer is rejected. Blocked ranges include private, loopback, link-local and cloud metadata, CGNAT, multicast and documentation/benchmark ranges, plus IPv6 equivalents and IPv4 embedded through mapped, NAT64 or 6to4 addresses.
  - **Connection pinning:** the TCP connection is pinned to the vetted IP, which defeats DNS rebinding.
  - **Redirects:** each hop is re-validated, up to 5.
  - **Limits:** 10 s, 1–2 MB, HTML/text only.
  - **Test coverage:** 61 tests, including hex/decimal IP encodings and redirect-to-metadata.
- **Ownership verification** is a network check performed outside any database transaction:
  - **Throttling:** one attempt per website every 10 s, claimed atomically.
  - **Redirects:** a meta tag or file check fails if the site redirects to another domain.
  - **Audit:** results are audited.
- **Client-scoped access** is enforced by RLS, not only by the UI. A client user can't see other clients or agency-level websites even through raw SQL in their own scope (tested). Members restricted to clients cannot manage clients, invite people or change access.
- **Plan limits** are checked under a per-workspace advisory lock, so concurrent requests can't exceed them (tested with 6 simultaneous requests). They count the whole workspace, regardless of the actor's client scope.
- **Malformed ids** from URLs and forms are rejected as "not found" before reaching SQL.

## 13. Implementation notes (M3)

- **Crawler politeness:**
  - **robots.txt** follows RFC 9309, with a specific group for `SEOGrowthEngineBot` overriding `*`. If robots.txt is missing (404), everything is allowed. If it is unreachable or returns 5xx, the crawler stays out entirely.
  - **Crawl-delay** is honoured, with a minimum of 1 s between requests.
  - **Scope:** same site only (host or its www twin); nofollow links and meta robots nofollow are respected; non-HTML files are skipped.
  - **Caps:** 500 pages per crawl for verified sites and 25 for unverified ones, plus the monthly plan allowance. Robots-blocked pages aren't billed.
  - **Requests** go through `safeFetch` (SSRF protection) with an identifying User-Agent.
- **The cron endpoint** requires `Authorization: Bearer CRON_SECRET` (constant-time compare) and is otherwise 401. The crawl progress endpoint requires a session and workspace membership. Member-triggered processing (`after()`) only claims that member's workspace's jobs.
- **The worker** uses a role that can't read tenant or identity tables; tenant work runs under RLS in the job's own workspace.

## 14. Implementation notes (M4)

- **Secrets at rest**:
  - workspace API keys use AES-256-GCM with a random 96-bit IV and `ENCRYPTION_KEY` (32 bytes);
  - the additional authenticated data binds each ciphertext to its workspace and provider;
  - tampering, the wrong workspace or the wrong key all fail to decrypt (tested);
  - keys are never sent back to the browser: only `…last4` is shown, and the settings page HTML is checked for this in e2e;
  - only owners and admins can set or remove keys, and every change is audit-logged.
- **Outbound requests**: crawling, external link checks and on-page fetches all go through `safeFetch` (SSRF protection), and on-page analysis respects robots.txt.
  - **External link checks**: one request per host at a time, 8 s timeout, 256 KB body cap.
  - **On-page analysis**: refuses URLs outside the website's domain, and pages that redirect off-site.
  - **PageSpeed**: requests go only to Google's fixed endpoint, for URLs on the workspace's own website.
- **Untrusted crawled content**:
  - URLs found on crawled pages are rendered as links only when they are http(s), with `rel="noreferrer noopener nofollow"`;
  - everything else is shown as text, and React escapes all text;
  - the CSV export prefixes cells that start with `= + - @` (or a tab or carriage return) with `'`, so spreadsheet formula injection doesn't work (tested).
- **Verified status is kept honest**: verified sites are re-checked weekly. Two consecutive failures remove the verified status (and with it the higher crawl limit), and an audit-log entry is written.
- **Usage metering**: PageSpeed runs (`psi_runs_month`) and on-page fetches (`pages_crawled_month`) are counted against the plan before any work happens.

## 15. Implementation notes (M5)

- **Google OAuth (data access):**
  - **Scopes:** read-only `webmasters.readonly` and `analytics.readonly`, plus `openid email`.
  - **PKCE (S256)** plus a 192-bit random `state`. The state and verifier are kept in a cookie that is HMAC-signed with the auth secret, httpOnly, `SameSite=Lax`, scoped to `/api/integrations/google`, valid for 10 minutes, and cleared on every callback (single use).
  - **The callback checks:**
    - the state, compared in constant time;
    - that the signed-in user is the one who started the flow;
    - that the user is a workspace member with `integrations.manage`.
  - **The refresh token** is stored encrypted (AES-256-GCM, bound to `<org>:google`) and never sent to the browser. Disconnecting revokes it at Google.
  - **Access tokens** are obtained per job run and never stored.
  - Tested: forged state, replayed callback, missing offline access, revoked token, and a viewer trying to connect.
- **Properties:** Search Console and GA4 choices are re-validated against the connected account on save, and Search Console properties must match the website's domain. A GA4 property id must match `properties/<digits>` before it is used in a URL.
- **Verification via Search Console** requires the `siteOwner` or `siteFullUser` permission level and is re-checked weekly. Losing it twice removes the verified status.
- **Keywords import:** CSV files are capped at 2 MB and 5,000 rows. Target URLs must be http(s) on the website's own domain, and imported metric labels are free text, stored escaped.
- **E2E tests** seed Google-like data with the local Postgres superuser, in test databases only. The app never uses that role.

## 16. Implementation notes (M6: backlink acquisition)

- **One outbound path.** Every request the engine makes (prospect crawling, verification, form and API submissions) goes through `@sge/crawler` `safeFetch` (public addresses only, pinned connections, redirect re-validation, size and time limits) plus the engine's `UrlPolicy` (schemes, credentials, ports, internal hostnames such as `*.internal` and `metadata.google.internal`, IP literals including decimal/octal/hex and NAT64). Responses are never decompressed, so compression bombs can't inflate.
- **Browser automation** runs only in the worker. Chromium is launched with a local egress proxy for *all* traffic (including loopback); the proxy validates each target with the same policy and connects to the vetted, pinned address. Downloads and service workers are blocked; WebRTC can't bypass the proxy. The user agent is the honest `SEOGrowthEngineBot`.
- **robots.txt** is respected for crawling and verification; an unreachable robots.txt means "stay out" (RFC 9309).
- **No CAPTCHA solving, no account creation, no invented data.** CAPTCHAs, logins, email verification and required fields without approved data become tasks for a person. Marketing opt-ins are never ticked; a terms checkbox is ticked only when a person recorded acceptance for that destination.
- **No local file reads.** File-upload fields are never filled automatically (the standalone uploaded a profile-supplied local path, which could have exposed server files).
- **Destination credentials** (API tokens, WordPress application passwords) are encrypted with AES-256-GCM bound to `<org>:backlink_source:<id>`, decrypted only for one adapter run, never shown again (last 4 characters only), and redacted from evidence. The standalone's "token from an environment variable named in the source record" was removed (an org could have named a platform secret).
- **Approval gating.** The executor refuses any submission without a user approval event or a recorded autopilot policy decision. Autopilot needs all of: website mode `autopilot` with a recorded permission note (owner/admin), the source enabled for that website, a source permission of `explicit_permission`, `own_property` (a verified website on the same domain) or `test_destination` (platform-only), an autopilot-capable tested adapter, and copy that passed the fact check.
- **Verified-only counting.** Only a link the crawler found live is `VERIFIED`; submitted and published are reported separately. Two consecutive misses are needed before a link is marked lost.
- **Outreach** is one-to-one, approved per message, sent only from the workspace's own mailbox (no per-workspace mailbox exists yet, so it is a "send it yourself" task; the platform's system SMTP is never used), with an opt-out footer and `List-Unsubscribe`, suppression across the workspace, and at most one follow-up (drafted, never sent automatically).
- **Isolation.** All 19 new tables have FORCE RLS and `tenant_isolation`; website-scoped tables add a RESTRICTIVE `website_visible` policy for `app_user` (client scope), and child tables a `parent_visible` policy. Composite foreign keys on `(id, website_id, organization_id)` prevent mixing websites inside one workspace. The global catalogue (`organization_id` NULL) is readable by every workspace and writable by none; a trigger rejects references to another workspace's source. Submission events and evidence are append-only for `app_user`.
- **Evidence download** serves screenshots inline and everything else (third-party HTML, HTTP exchanges) as sandboxed plain-text attachments, so captured pages can never run on our origin.

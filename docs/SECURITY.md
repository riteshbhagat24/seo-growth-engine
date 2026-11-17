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

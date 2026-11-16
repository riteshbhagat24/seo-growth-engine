# SEO Growth Engine — Product Requirements Document

Status: **Draft for approval** · Version 0.1 · 2026-11-16

## 1. Product

A multi-tenant SaaS that helps a website earn organic visibility through technical fixes, better pages, tracked keywords and legitimate backlinks, and proves the results with verified data.

It serves two kinds of customer through one workspace model:

| Mode | Who | Typical use |
|---|---|---|
| **Personal workspace** | Founders, freelancers, small businesses | Run SEO for their own 1–5 websites |
| **Agency workspace** | Digital marketing agencies | Run SEO for many clients, with a team, client logins and white-label reports |

The product is neutral-branded. Product name, logo and colours are configuration, and every organisation can brand its own reports.

## 2. Principles

1. **Zero mandatory paid APIs.** Every module works with free APIs, internal engines, open-source libraries, CSV imports or manual workflows. Paid or bring-your-own-key providers may be *added* by an organisation, are off by default, and are never used as a silent fallback.
2. **Verified, not claimed.** A backlink counts only after the crawler has found it on the live page. Imported, estimated and demo data are always labelled.
3. **Tenant isolation is enforced in the database**, not only in application code.
4. **White-hat only.** No CAPTCHA bypass, fake accounts, scraping of Google results, link schemes or unsolicited bulk email.
5. **Honest metrics.** Values that cannot be known for free (search volume, third-party authority) stay empty unless the user imports them.

## 3. Personas

- **Owner-operator (personal):** wants a checklist of what to fix and a steady flow of relevant link opportunities without learning SEO jargon.
- **Agency owner:** wants client separation, team permissions, usage visibility and branded reports.
- **SEO specialist (agency member):** works daily in audits, prospecting, outreach and verification for assigned clients.
- **Client (agency's customer):** read-only dashboard and reports for their own websites, nothing else.
- **Platform admin (us):** manages plans, organisations, abuse and support.

## 4. Workspace model

- Signing up creates a **user** and a **personal workspace** owned by that user.
- A user can create or be invited to any number of **agency workspaces** and switch between workspaces from the header.
- Agency workspaces contain **clients**; each client has one or more **websites**. Personal workspaces hold websites directly.
- All data belongs to exactly one workspace (organisation). A website belongs to exactly one workspace.
- Agencies can give a client's contacts a **Client** role that only sees that client's websites and reports.

## 5. Roles

| Role | Scope | Can |
|---|---|---|
| Owner | workspace | everything, including billing/plan, deleting the workspace, transferring ownership |
| Admin | workspace | manage members, clients, websites, integrations, settings |
| Manager | workspace or assigned clients | run campaigns, approve submissions/outreach/content, view reports |
| Specialist | assigned clients | audits, prospecting, drafting, verification; cannot approve sending or publishing |
| Viewer | workspace or assigned clients | read-only |
| Client | assigned clients | read-only dashboard and reports; can comment/approve content if enabled |

The permission matrix is in `SECURITY.md`.

## 6. Modules and requirements

Each module lists its free data sources. "MVP" marks what ships in the first public release; the rest follows in later milestones.

### 6.1 Authentication and accounts (MVP)
Email + password with verification, magic link, Google sign-in (free OAuth), optional TOTP 2FA, password reset, session list and revoke, account deletion with data export.

### 6.2 Workspaces and organisations (MVP)
Create personal and agency workspaces, invitations by email, accept/decline, member roles, workspace switcher, ownership transfer, leave workspace, and workspace branding (name, logo, colours).

### 6.3 Client management (MVP, agency)
Client records (name, contacts, notes, status), assigning team members to clients, client portal access, and archiving a client (keeps history, frees usage).

### 6.4 Website management and verification (MVP)
Add a website (URL normalisation, duplicate prevention per workspace), then verify ownership by **DNS TXT record**, **HTML meta tag**, **uploaded HTML file**, or by **connecting Google Search Console** for that property. Unverified sites can be audited only with restricted crawl limits. Background jobs that contact third parties on a site's behalf (outreach, submissions) require verification.

### 6.5 Technical SEO audit (MVP)
An internal crawler (polite, robots.txt-aware, rate-limited) that reads up to the plan's page limit and checks status codes, redirects and chains, broken internal/external links, canonical tags, `noindex`, title/meta presence and length, duplicate titles, H1 count, image alt text, page depth, orphan pages (sitemap vs crawl), sitemap validity, robots.txt, HTTPS and mixed content, hreflang syntax, structured-data presence and JSON-LD validity, and page size.
**Core Web Vitals** come from the free **PageSpeed Insights API** and **CrUX API**; an organisation can add its own free Google API key for higher quota.
Output: issues grouped by severity with affected URLs, an explanation and how to fix it, and a health score with a trend across audits.

### 6.6 On-page SEO analysis (MVP)
Per-URL analysis against a target keyword: title, meta description, headings, keyword placement and density, content length, readability score, internal links in and out, image alt text, schema, and an SERP snippet preview. Internal engine, no external API.

### 6.7 Keyword management (MVP)
Keyword lists per website with groups, tags, target URL and intent. Data comes from **Google Search Console** (queries, clicks, impressions, CTR, average position) plus manual and CSV entry. Search volume and difficulty appear only if imported, and are labelled with their source. Position tracking uses GSC average position. There is no scraping of Google results.

### 6.8 Backlink opportunity discovery (MVP)
Sources:
- curated **seed dataset** of directories and publications shipped with the product, maintained by the platform admin and categorised by niche and country;
- **CSV import** (Ahrefs, SEMrush, Moz or Majestic exports the user already has, and GSC "Top linking sites" export);
- **competitor imports** (the same exports for competitor domains);
- **manual URLs** and pasted lists;
- **footprint helper**: generates search operators (for example `"write for us" + niche`) for the user to run in their own browser, then paste results back;
- **site inspection**: fetches the candidate page to detect submission forms, contact pages, "write for us" guidelines, CAPTCHA and login walls;
- optional bring-your-own-key search providers (off by default).

### 6.9 Qualification and scoring (MVP)
A 0–100 score built from: relevance to the website's niche (internal text similarity using TF-IDF over the candidate and target pages), site quality signals from the crawler (indexability, content depth, outbound-link ratio, spam patterns), popularity (free **Tranco** list rank), optional free **Open PageRank** score, referral potential and submission accessibility. Each factor carries an explanation. Missing factors are shown as unknown, never guessed. Priority bands are 80+ high, 60–79 medium, 40–59 low, and under 40 review or reject.

### 6.10 Submission workflows (MVP)
Each opportunity has a submission method: Manual submission, Editorial outreach, Approved automation, or Not supported. The workflow runs: prepared → awaiting approval → approved → submitted → accepted or declined → published. Manual tasks show copy-ready fields and track result, date and publication URL. Automation exists only as an adapter interface that each organisation must enable per site, with a recorded permission note. Retries are capped. Opportunities and attempts are never counted as links.

### 6.11 Guest post prospecting and outreach (M6)
Publisher CRM (contacts, guidelines, topics, status pipeline), templates with merge fields, sending through the **organisation's own SMTP or mailbox** (free; no shared sending infrastructure), per-mailbox daily limits, approval before sending, automatic opt-out link, suppression list, bounce handling, and follow-up reminders.

### 6.12 Backlink verification and monitoring (MVP)
The crawler fetches each known source page and confirms the link to the website, recording anchor text, `rel` (nofollow, sponsored, ugc), HTTP status and redirects. Statuses: Pending, Live, Lost, Redirected, No longer linked, Error, Unverifiable. Full check history is kept. Cadence: new links daily for 14 days, live links weekly, lost links monthly.

### 6.13 Lost backlink recovery (M7)
Detect loss and its cause (page removed, link removed, blocked, redirected), create a recovery task with a suggested action and outreach template, track attempts, and re-verify.

### 6.14 SEO content studio (M8)
Briefs (target keyword, outline, questions to answer, internal-link suggestions from the website's own crawl), an editor with a live on-page score, templates for directory descriptions, bios and outreach emails, a duplicate-content check against the workspace's own content, and approval workflow. Optional AI writing assistance through a **bring-your-own-key** provider (Claude, OpenAI or a local Ollama server): off by default, the organisation supplies the key, usage is shown, and there is no platform-paid fallback.

### 6.15 Competitor analysis (M9)
Add competitors per website, import their backlink and keyword exports, and run gap analysis (domains linking to competitors but not to you; keywords they have that you lack, from imported data), plus a light crawl of competitor pages for content themes and on-page comparison.

### 6.16 Google Search Console (MVP)
OAuth per workspace, property selection per website, daily sync of queries, pages, countries, devices and dates, with backfill of 16 months on connect.

### 6.17 Google Analytics 4 (M5)
OAuth, property selection, daily sync of sessions, engaged sessions, conversions (key events), and source, medium and landing page, so referral sessions can be attributed to referring domains of verified backlinks.

### 6.18 WordPress (M8)
Connect a site with an application password over HTTPS, then create and update drafts, set categories, tags and featured image, publish only after approval, and never overwrite a published post without confirmation.

### 6.19 Automation and jobs (MVP)
Postgres-backed job queue, scheduled jobs (audits, verification, syncs, reports), per-organisation concurrency and fairness, retries, job history visible to the workspace, and manual "run now".

### 6.20 Reports and white-label (MVP basic, M10 full)
Report builder (sections: summary, technical health, keywords, backlinks funnel, traffic, tasks), schedules (weekly or monthly) emailed as a PDF and a secure share link, and agency branding (logo, colours, sender name, custom footer). Custom report domains come later.

### 6.21 Team roles and permissions (MVP)
As in §5, enforced server-side and in database policies.

### 6.22 Subscription and usage (MVP architecture, no billing)
Plans are configuration in the database (limits: websites, clients, members, pages crawled per month, tracked keywords, backlinks monitored, reports per month, storage). Each workspace has a subscription row (plan, status, trial dates). Usage counters are enforced at the point of use, with clear "limit reached" messages. There is no payment provider yet; billing will plug into the subscription row later.

### 6.23 Platform administration (M11)
A separate admin area for the platform operator: organisations, users, plans, assigning plans, seed dataset management, job health, abuse controls (crawl blocklist, suspend organisation), impersonation with reason and audit, and system settings (product name, logo, theme).

## 7. Non-functional requirements

| Area | Requirement |
|---|---|
| Security | See `SECURITY.md`. Database-level tenant isolation, encrypted credentials, audit logs |
| Performance | Dashboard pages P95 < 1.5 s server render with 10k backlinks per workspace |
| Crawling | Default 1 request/second per host, configurable lower; honour robots.txt and `Crawl-delay`; identifying User-Agent with a contact URL |
| Reliability | Jobs are idempotent and resumable; one workspace cannot starve the others |
| Privacy | GDPR/DPDP-friendly: data export, account and workspace deletion, minimal personal data, DPA-ready subprocessors list |
| Accessibility | WCAG 2.2 AA for the app UI |
| Observability | Structured logs, job metrics, error tracking (self-hostable, for example GlitchTip, or a free tier) |
| Backups | Daily automated backups, point-in-time recovery where the host offers it, quarterly restore test |

## 8. Out of scope

Paid data resale, rank scraping, CAPTCHA solving, account creation on third-party sites, private blog networks, link buying marketplaces, and social media scheduling.

## 9. Success metrics

Activation (website verified and first audit run within 24 h), weekly active workspaces, verified backlinks per active website per month, the funnel conversion rate from opportunity to verified link, and agency retention.

## 10. Open questions for approval

See `MILESTONES.md` → "Decisions needed".

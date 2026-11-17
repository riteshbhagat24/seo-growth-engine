import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, getPool } from "@sge/db";
import { SafeFetchError, type SafeFetchResult } from "@sge/crawler";
import { processSchedules, runTick } from "@sge/jobs";
import {
  addWebsite,
  analyzePage,
  AppError,
  auditIssuesCsv,
  AUDITS_KEPT_PER_WEBSITE,
  cancelAudit,
  createClient,
  decryptSecret,
  encryptSecret,
  getAudit,
  getAuditIssues,
  getAuditSchedule,
  getKeyIntegration,
  jobHandlers,
  listAudits,
  listCwv,
  listOnpage,
  parseEncryptionKey,
  removeApiKey,
  requestCwv,
  setApiKey,
  setAuditSchedule,
  startAudit,
  usageSummary,
  type JobHandlerOptions
} from "../src/index";
import { closeAll, db, makeAgency, owner, ownerInTenant } from "./helpers";

process.env.ENCRYPTION_KEY ??= "ab".repeat(32);
const workerDb = createDb(process.env.TEST_WORKER_DATABASE_URL!);
afterAll(async () => {
  await getPool(process.env.TEST_WORKER_DATABASE_URL!).end();
  await closeAll();
});

const codeOf = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof AppError ? e.code : `unexpected: ${(e as Error).message}`));

/* ─────────────────────────────── Fake web ──────────────────────────────── */

type Route = { status?: number; body?: string; type?: string; redirect?: string; error?: SafeFetchError["code"] };

/** Routes by full URL, so one fake serves the audited site and the external sites it links to. */
function fakeWeb(routes: Record<string, Route>) {
  const fetched: string[] = [];
  const fetch: NonNullable<JobHandlerOptions["fetch"]> = async (url, opts) => {
    fetched.push(url);
    let r = routes[url];
    const redirects: string[] = [];
    const statuses: number[] = [];
    let final = url;
    while (r?.redirect) {
      final = new URL(r.redirect, final).toString();
      redirects.push(final);
      statuses.push(301);
      r = routes[final];
    }
    if (r?.error) throw new SafeFetchError(r.error, `fake ${r.error}`);
    if (!r) return { url: final, status: 404, contentType: "text/html", body: "not found", redirects, redirectStatuses: statuses } satisfies SafeFetchResult;
    const type = r.type ?? "text/html";
    if (opts.contentTypes && (r.status ?? 200) < 400 && !opts.contentTypes.some((t) => type.startsWith(t))) throw new SafeFetchError("bad_content_type", "x");
    return { url: final, status: r.status ?? 200, contentType: type, body: r.body ?? "", redirects, redirectStatuses: statuses };
  };
  return { fetch, fetched };
}

const words = (n: number, seed: string) => Array.from({ length: n }, (_, i) => `${seed}${i % 40}`).join(" ");
function page(path: string, o: { title?: string | null; description?: string | null; links?: string[]; head?: string; body?: string } = {}) {
  const title = o.title === null ? "" : `<title>${o.title ?? `Audit fixture page ${path} for testing`}</title>`;
  const desc = o.description === null ? "" : `<meta name="description" content="${o.description ?? `The description of ${path}, long enough to sit comfortably inside the recommended range.`}">`;
  return `<html lang="en"><head>${title}${desc}<meta name="viewport" content="width=device-width">
<link rel="canonical" href="https://audit-fixture.com${path}"><meta property="og:title" content="x"><meta property="og:image" content="https://audit-fixture.com/i.png">
<script type="application/ld+json">{"@type":"WebPage"}</script>${o.head ?? ""}</head>
<body><h1>Heading for ${path}</h1><p>${o.body ?? words(260, path.replace(/\W/g, "") || "home")}</p>${(o.links ?? []).map((l) => `<a href="${l}">l</a>`).join("")}</body></html>`;
}

const S = (p: string) => `https://audit-fixture.com${p}`;
function auditSite(fixed = false) {
  return fakeWeb({
    [S("/robots.txt")]: { type: "text/plain", body: `User-agent: *\nDisallow: /private\nSitemap: ${S("/sitemap.xml")}\n` },
    [S("/sitemap.xml")]: { type: "application/xml", body: `<urlset><url><loc>${S("/orphan")}</loc></url><url><loc>${S("/about")}</loc></url></urlset>` },
    [S("/")]: { body: page("/", { links: ["/about", "/no-title", fixed ? "/about" : "/broken", "/old", "https://ext-ok.com/", "https://ext-dead.com/x", "https://ext-blocked.com/"] }) },
    [S("/about")]: { body: page("/about", { links: ["/"] }) },
    [S("/no-title")]: { body: page("/no-title", { title: fixed ? undefined : null }) },
    [S("/orphan")]: { body: page("/orphan") },
    [S("/broken")]: { status: 404, body: "gone" },
    [S("/old")]: { redirect: "/about" },
    "https://ext-ok.com/": { body: "ok" },
    "https://ext-dead.com/x": { status: 404 },
    "https://ext-blocked.com/": { status: 403 }
  });
}

const handlers = (opts: JobHandlerOptions) => jobHandlers({ minDelayMs: 0, sleep: async () => undefined, fetchTimeoutMs: 50, ...opts });
async function drain(org: string, opts: JobHandlerOptions, rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    const r = await runTick({ workerDb, appDb: db, handlers: handlers(opts), workerId: "test", budgetMs: 20_000, maxJobMs: 15_000, organizationId: org });
    if (r.claimed === 0) return;
  }
}

async function verifiedSite(a: Awaited<ReturnType<typeof makeAgency>>, domain: string, clientId?: string) {
  const w = await addWebsite(db, a.owner, a.ownerAccess, { url: domain, clientId });
  await ownerInTenant(a.ws.id, `UPDATE websites SET verification_status = 'verified' WHERE id = $1`, [w.id]);
  return w;
}

/* ─────────────────────────────── Audits ────────────────────────────────── */

describe("site audits", () => {
  let a: Awaited<ReturnType<typeof makeAgency>>;
  let websiteId: string;
  let firstAuditId: string;

  beforeAll(async () => {
    a = await makeAgency();
    websiteId = (await verifiedSite(a, "audit-fixture.com")).id;
  });

  it("crawls, checks external links, applies the rules and scores the site", async () => {
    const web = auditSite();
    const started = await startAudit(db, a.owner, a.ownerAccess, websiteId);
    expect(started).toMatchObject({ status: "crawling", trigger: "manual" });
    firstAuditId = started.id;
    await drain(a.ws.id, { fetch: web.fetch });

    const d = await getAudit(db, a.owner, a.ownerAccess, started.id);
    expect(d.audit).toMatchObject({ status: "completed", pagesAnalyzed: 6, externalLinksChecked: 3 });
    expect(d.audit.healthScore).toBeGreaterThan(0);
    expect(d.audit.healthScore).toBeLessThan(100);
    const rules = Object.fromEntries(d.rules.map((r) => [r.rule, r.count]));
    expect(rules).toMatchObject({
      http_4xx: 1,
      broken_internal_link: 1,
      broken_external_link: 1,
      missing_title: 1,
      orphan_page: 1,
      internal_link_to_redirect: 1
    });
    expect(rules.blocked_by_robots).toBeUndefined(); // /private isn't linked
    expect(d.rules[0]!.severity).toBe("critical"); // sorted by severity
    expect(d.previous).toBeNull();
    // Only sites with real failures count as broken: 403 is "unverifiable".
    expect(web.fetched).toContain("https://ext-blocked.com/");

    const broken = await getAuditIssues(db, a.owner, a.ownerAccess, started.id, "broken_internal_link");
    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatchObject({ url: S("/"), details: { targets: [S("/broken")] } });
    const [{ inlinks }] = (
      await ownerInTenant(a.ws.id, `SELECT inlinks FROM crawl_pages WHERE crawl_id = $1 AND url = $2`, [d.crawl.id, S("/about")])
    ).rows as [{ inlinks: number }];
    expect(inlinks).toBeGreaterThanOrEqual(1);
  });

  it("compares with the previous audit after fixes", async () => {
    const second = await startAudit(db, a.owner, a.ownerAccess, websiteId);
    await drain(a.ws.id, { fetch: auditSite(true).fetch });
    const d = await getAudit(db, a.owner, a.ownerAccess, second.id);
    expect(d.audit.status).toBe("completed");
    expect(d.previous?.id).toBe(firstAuditId);
    const diff = Object.fromEntries(d.diff!.map((x) => [x.rule, x]));
    expect(diff.missing_title).toMatchObject({ before: 1, after: 0, fixed: 1, added: 0 });
    expect(diff.http_4xx).toMatchObject({ before: 1, after: 0, fixed: 1 });
    expect(d.audit.healthScore!).toBeGreaterThan((await getAudit(db, a.owner, a.ownerAccess, firstAuditId)).audit.healthScore!);
  });

  it("exports issues as CSV with formula injection neutralised", async () => {
    const csv = await auditIssuesCsv(db, a.owner, a.ownerAccess, firstAuditId);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("Severity,Category,Issue,URL,Details");
    expect(lines.some((l) => l.startsWith("critical,crawlability,Page returns a 4xx error,https://audit-fixture.com/broken"))).toBe(true);
    // A crafted URL can't become a spreadsheet formula.
    await ownerInTenant(a.ws.id, `INSERT INTO audit_issues (id, organization_id, audit_id, rule, severity, url) VALUES (gen_random_uuid(), $1, $2, 'missing_h1', 'warning', '=HYPERLINK("x")')`, [a.ws.id, firstAuditId]);
    expect(await auditIssuesCsv(db, a.owner, a.ownerAccess, firstAuditId)).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it("refuses a second concurrent audit and can cancel a running one", async () => {
    const run = await startAudit(db, a.owner, a.ownerAccess, websiteId);
    expect(await codeOf(startAudit(db, a.owner, a.ownerAccess, websiteId))).toBe("conflict");
    await cancelAudit(db, a.owner, a.ownerAccess, run.id);
    const d = await getAudit(db, a.owner, a.ownerAccess, run.id);
    expect(d.audit.status).toBe("cancelled");
    expect(d.crawl.status).toBe("cancelled");
    expect(await codeOf(cancelAudit(db, a.owner, a.ownerAccess, run.id))).toBe("conflict");
  });

  it("enforces roles: viewers can read audits but not run them", async () => {
    const viewer = await a.addMember("viewer");
    expect(await codeOf(startAudit(db, viewer, viewer.access, websiteId))).toBe("forbidden");
    expect((await listAudits(db, viewer, viewer.access, websiteId)).length).toBeGreaterThan(0);
    expect(await codeOf(cancelAudit(db, viewer, viewer.access, firstAuditId))).toBe("forbidden");
    expect(await codeOf(setAuditSchedule(db, viewer, viewer.access, websiteId, "weekly"))).toBe("forbidden");
  });

  it("isolates audits across workspaces and client scopes (app and database)", async () => {
    const other = await makeAgency();
    expect(await codeOf(getAudit(db, other.owner, other.ownerAccess, firstAuditId))).toBe("not_found");
    expect(await codeOf(auditIssuesCsv(db, other.owner, other.ownerAccess, firstAuditId))).toBe("not_found");
    expect(await getAuditIssues(db, other.owner, other.ownerAccess, firstAuditId, "http_4xx")).toEqual([]);

    // Client scope: a specialist assigned to client B can't see client A's audits.
    const clientA = await createClient(db, a.owner, a.ownerAccess, { name: "Client A" });
    const clientB = await createClient(db, a.owner, a.ownerAccess, { name: "Client B" });
    const siteA = await verifiedSite(a, "client-a-audit.com", clientA.id);
    const auditA = await startAudit(db, a.owner, a.ownerAccess, siteA.id);
    const spec = await a.addMember("specialist", [clientB.id]);
    expect(await codeOf(getAudit(db, spec, spec.access, auditA.id))).toBe("not_found");
    expect(await codeOf(startAudit(db, spec, spec.access, siteA.id))).toBe("not_found");

    // Database level: no tenant → nothing; wrong tenant → nothing.
    const c = await getPool(process.env.TEST_DATABASE_URL!).connect();
    try {
      for (const table of ["audits", "audit_issues", "audit_external_links", "cwv_results", "onpage_analyses", "integrations"])
        expect((await c.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, table).toBe(0);
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.org_id', $1, true), set_config('app.client_scope', '*', true)", [other.ws.id]);
      expect((await c.query("SELECT count(*)::int AS n FROM audit_issues WHERE audit_id = $1", [firstAuditId])).rows[0].n).toBe(0);
      const insert = await c
        .query("INSERT INTO audit_issues (id, organization_id, audit_id, rule, severity) VALUES (gen_random_uuid(), $1, $2, 'x', 'notice')", [a.ws.id, firstAuditId])
        .then(() => "inserted", () => "blocked");
      expect(insert).toBe("blocked");
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });
});

describe("scheduled audits and retention", () => {
  it("a weekly schedule starts audits through the scheduler", async () => {
    const a = await makeAgency();
    const w = await verifiedSite(a, "audit-fixture.com");
    expect((await getAuditSchedule(db, a.owner, a.ownerAccess, w.id)).frequency).toBe("off");
    await setAuditSchedule(db, a.owner, a.ownerAccess, w.id, "weekly");
    const s = await getAuditSchedule(db, a.owner, a.ownerAccess, w.id);
    expect(s.frequency).toBe("weekly");
    expect(s.nextRunAt!.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3600_000);

    await ownerInTenant(a.ws.id, `UPDATE schedules SET next_run_at = now() - interval '1 minute' WHERE website_id = $1 AND job_type = 'audit.scheduled'`, [w.id]);
    expect(await processSchedules(workerDb)).toBeGreaterThanOrEqual(1);
    await drain(a.ws.id, { fetch: auditSite().fetch });
    const [run] = await listAudits(db, a.owner, a.ownerAccess, w.id);
    expect(run).toMatchObject({ trigger: "schedule", status: "completed", createdByUserId: null });

    await setAuditSchedule(db, a.owner, a.ownerAccess, w.id, "monthly");
    expect((await getAuditSchedule(db, a.owner, a.ownerAccess, w.id)).frequency).toBe("monthly");
    await setAuditSchedule(db, a.owner, a.ownerAccess, w.id, "off");
    expect((await getAuditSchedule(db, a.owner, a.ownerAccess, w.id)).frequency).toBe("off");
  });

  it(`keeps the newest ${AUDITS_KEPT_PER_WEBSITE} audits per website`, async () => {
    const a = await makeAgency();
    const w = await verifiedSite(a, "tiny-audit.com");
    const tiny = fakeWeb({ "https://tiny-audit.com/": { body: "<title>Tiny</title>" } });
    for (let i = 0; i < AUDITS_KEPT_PER_WEBSITE + 2; i++) {
      await startAudit(db, a.owner, a.ownerAccess, w.id);
      await drain(a.ws.id, { fetch: tiny.fetch });
    }
    const all = await listAudits(db, a.owner, a.ownerAccess, w.id, 50);
    expect(all).toHaveLength(AUDITS_KEPT_PER_WEBSITE);
    const crawls = await ownerInTenant(a.ws.id, `SELECT count(*)::int AS n FROM crawls WHERE website_id = $1`, [w.id]);
    expect(crawls.rows[0].n).toBe(AUDITS_KEPT_PER_WEBSITE);
  });
});

/* ─────────────────────────── Core Web Vitals ───────────────────────────── */

const PSI_OK = {
  lighthouseResult: {
    categories: { performance: { score: 0.91 } },
    audits: { "largest-contentful-paint": { numericValue: 1800 }, "cumulative-layout-shift": { numericValue: 0.02 }, "total-blocking-time": { numericValue: 90 } }
  },
  loadingExperience: { metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2000, category: "FAST" } }, overall_category: "FAST" }
};

function fakePsi(responses: { status: number; body: unknown }[]) {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    calls.push(String(input));
    const r = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe("Core Web Vitals", () => {
  it("measures mobile and desktop, meters usage, and stores lab + field data", async () => {
    const a = await makeAgency();
    const w = await verifiedSite(a, "cwv-fixture.com");
    const psi = fakePsi([{ status: 200, body: PSI_OK }]);
    const rows = await requestCwv(db, a.owner, a.ownerAccess, w.id, "/pricing");
    expect(rows.map((r) => r.strategy).sort()).toEqual(["desktop", "mobile"]);
    expect(rows[0]!.url).toBe("https://cwv-fixture.com/pricing");
    expect(await codeOf(requestCwv(db, a.owner, a.ownerAccess, w.id))).toBe("conflict"); // one at a time
    await drain(a.ws.id, { psiFetch: psi.fetchFn, psiApiKey: "PLATFORM_KEY_123" });

    const results = await listCwv(db, a.owner, a.ownerAccess, w.id);
    expect(results.every((r) => r.status === "completed")).toBe(true);
    expect(results[0]!.metrics).toMatchObject({ performanceScore: 91, lab: { lcpMs: 1800 }, field: { scope: "page", lcp: { p75: 2000 } } });
    expect(psi.calls).toHaveLength(2);
    expect(new URL(psi.calls[0]!).searchParams.get("key")).toBe("PLATFORM_KEY_123");
    const usage = await usageSummary(db, a.owner, a.ownerAccess);
    expect(usage.lines.find((u) => u.key === "psi_runs_month")?.used).toBe(2);
  });

  it("rejects pages on other domains and enforces the monthly allowance", async () => {
    const a = await makeAgency();
    const w = await verifiedSite(a, "cwv-limits.com");
    expect(await codeOf(requestCwv(db, a.owner, a.ownerAccess, w.id, "https://evil.example/"))).toBe("invalid_input");
    await ownerInTenant(a.ws.id, "UPDATE subscriptions SET overrides = '{\"psi_runs_month\": 1}' WHERE organization_id = $1", [a.ws.id]);
    expect(await codeOf(requestCwv(db, a.owner, a.ownerAccess, w.id))).toBe("limit_reached");
  });

  it("uses the workspace's own encrypted key, and reports failures in plain language", async () => {
    const a = await makeAgency();
    const w = await verifiedSite(a, "cwv-key.com");
    const key = "AIzaSyFAKE_workspace_key_0123456789";
    await setApiKey(db, a.owner, a.ownerAccess, "psi", key);
    const stored = await ownerInTenant(a.ws.id, "SELECT credentials_enc, key_hint FROM integrations WHERE organization_id = $1", [a.ws.id]);
    expect(stored.rows[0].credentials_enc).not.toContain(key);
    expect(stored.rows[0].key_hint).toBe("…6789");
    expect(await getKeyIntegration(db, a.owner, a.ownerAccess, "psi")).toMatchObject({ connected: true, keyHint: "…6789" });

    const psi = fakePsi([{ status: 400, body: { error: { code: 400, message: "API key not valid. Please pass a valid API key." } } }]);
    await requestCwv(db, a.owner, a.ownerAccess, w.id);
    await drain(a.ws.id, { psiFetch: psi.fetchFn, psiApiKey: "PLATFORM" });
    expect(new URL(psi.calls[0]!).searchParams.get("key")).toBe(key);
    const results = await listCwv(db, a.owner, a.ownerAccess, w.id);
    expect(results.every((r) => r.status === "failed" && /rejected the PageSpeed API key/.test(r.error ?? ""))).toBe(true);
    expect((await getKeyIntegration(db, a.owner, a.ownerAccess, "psi")).lastError).toMatch(/rejected/);

    const viewer = await a.addMember("viewer");
    expect(await codeOf(setApiKey(db, viewer, viewer.access, "psi", key))).toBe("forbidden");
    expect(await codeOf(setApiKey(db, a.owner, a.ownerAccess, "psi", "short"))).toBe("invalid_input");
    await removeApiKey(db, a.owner, a.ownerAccess, "psi");
    expect((await getKeyIntegration(db, a.owner, a.ownerAccess, "psi")).connected).toBe(false);
  });

  it("retries Google's rate limit, then gives up with an explanation", async () => {
    const a = await makeAgency();
    const w = await verifiedSite(a, "cwv-busy.com");
    const psi = fakePsi([{ status: 429, body: { error: { code: 429, message: "Quota exceeded" } } }]);
    await requestCwv(db, a.owner, a.ownerAccess, w.id);
    for (let i = 0; i < 4; i++) {
      await drain(a.ws.id, { psiFetch: psi.fetchFn });
      await ownerInTenant(a.ws.id, "UPDATE jobs SET run_at = now() WHERE organization_id = $1 AND status = 'queued'", [a.ws.id]);
    }
    const results = await listCwv(db, a.owner, a.ownerAccess, w.id);
    expect(results.every((r) => r.status === "failed" && /shared PageSpeed quota/.test(r.error ?? ""))).toBe(true);
    expect(psi.calls.length).toBe(6); // 3 attempts × 2 strategies
  });
});

/* ─────────────────────────────── On-page ───────────────────────────────── */

describe("on-page analysis", () => {
  const site = fakeWeb({
    "https://onpage-fixture.com/robots.txt": { type: "text/plain", body: "User-agent: *\nDisallow: /secret\n" },
    "https://onpage-fixture.com/shoes": {
      body: `<html lang="en"><head><title>Trail shoes for muddy runs</title></head><body><h1>Trail shoes</h1><p>${words(300, "trail shoes ")}</p></body></html>`
    },
    "https://onpage-fixture.com/moved": { redirect: "https://elsewhere.example/" },
    "https://elsewhere.example/": { body: "<title>x</title>" }
  });

  it("scores a page, stores it, and meters one page", async () => {
    const a = await makeAgency();
    const w = await verifiedSite(a, "onpage-fixture.com");
    const r = await analyzePage(db, a.owner, a.ownerAccess, { websiteId: w.id, url: "/shoes", keyword: "Trail Shoes" }, { fetch: site.fetch });
    expect(r).toMatchObject({ url: "https://onpage-fixture.com/shoes", keyword: "Trail Shoes" });
    expect(r.score).toBeGreaterThan(0);
    const checks = Object.fromEntries((r.result as { checks: { id: string; status: string }[] }).checks.map((c) => [c.id, c.status]));
    expect(checks).toMatchObject({ title_keyword: "pass", h1_keyword: "pass", url_keyword: "warn", inlinks: "info" });
    expect((await listOnpage(db, a.owner, a.ownerAccess, w.id)).map((x) => x.id)).toEqual([r.id]);
    expect((await usageSummary(db, a.owner, a.ownerAccess)).lines.find((u) => u.key === "pages_crawled_month")?.used).toBe(1);
  });

  it("respects robots.txt, stays on the website and validates input", async () => {
    const a = await makeAgency();
    const w = await verifiedSite(a, "onpage-fixture.com");
    const run = (url: string, keyword = "shoes") => codeOf(analyzePage(db, a.owner, a.ownerAccess, { websiteId: w.id, url, keyword }, { fetch: site.fetch }));
    expect(await run("/secret/page")).toBe("invalid_input");
    expect(await run("https://other-site.example/")).toBe("invalid_input");
    expect(await run("/moved")).toBe("invalid_input"); // redirects off-site
    expect(await run("/missing")).toBe("invalid_input"); // 404
    expect(await run("/shoes", "x")).toBe("invalid_input");
    const viewer = await a.addMember("viewer");
    expect(await codeOf(analyzePage(db, viewer, viewer.access, { websiteId: w.id, url: "/shoes", keyword: "shoes" }, { fetch: site.fetch }))).toBe("forbidden");
  });
});

/* ─────────────────────────────── Secrets ───────────────────────────────── */

describe("secret encryption", () => {
  const key = parseEncryptionKey("cd".repeat(32));
  it("round-trips and binds to its owner", () => {
    const enc = encryptSecret("s3cret-value", "org-1:psi", key);
    expect(enc.startsWith("v1:")).toBe(true);
    expect(enc).not.toContain("s3cret");
    expect(decryptSecret(enc, "org-1:psi", key)).toBe("s3cret-value");
    expect(() => decryptSecret(enc, "org-2:psi", key)).toThrow();
    const tampered = enc.slice(0, -4) + (enc.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(() => decryptSecret(tampered, "org-1:psi", key)).toThrow();
    expect(() => decryptSecret(enc, "org-1:psi", parseEncryptionKey("ef".repeat(32)))).toThrow();
  });
  it("rejects bad keys", () => {
    expect(() => parseEncryptionKey("")).toThrow();
    expect(() => parseEncryptionKey("abc")).toThrow();
    expect(parseEncryptionKey(Buffer.alloc(32, 7).toString("base64")).length).toBe(32);
  });
});

// Keep the owner pool referenced (helpers closes it).
void owner;

/* ──────────────────────────── Re-verification ──────────────────────────── */

describe("periodic ownership re-check", () => {
  it("is scheduled on verification; two failed checks in a row remove the verified status", async () => {
    const { verifyWebsite } = await import("../src/index");
    const a = await makeAgency();
    const w = await addWebsite(db, a.owner, a.ownerAccess, { url: "reverify-fixture.com" });
    const token = (await ownerInTenant(a.ws.id, "SELECT verification_token FROM websites WHERE id = $1", [w.id])).rows[0].verification_token as string;
    let present = true;
    const deps = {
      fetch: async (url: string): Promise<SafeFetchResult> => ({
        url,
        status: 200,
        contentType: "text/html",
        body: present ? `<meta name="sge-site-verification" content="${token}">` : "<html></html>",
        redirects: []
      }),
      resolveTxt: async () => []
    };
    expect((await verifyWebsite(db, a.owner, a.ownerAccess, w.id, "meta_tag", deps)).verified).toBe(true);
    const sched = await ownerInTenant(a.ws.id, "SELECT interval_minutes, enabled FROM schedules WHERE website_id = $1 AND job_type = 'website.reverify'", [w.id]);
    expect(sched.rows[0]).toEqual({ interval_minutes: 7 * 24 * 60, enabled: true });

    // A distinct slot each time: the scheduler enqueues each slot (second) once.
    let slot = 0;
    const due = () => ownerInTenant(a.ws.id, "UPDATE schedules SET next_run_at = now() - make_interval(mins => $2) WHERE website_id = $1", [w.id, ++slot]);
    const status = async () => (await ownerInTenant(a.ws.id, "SELECT verification_status, last_verification_error FROM websites WHERE id = $1", [w.id])).rows[0];
    const recheck = async () => {
      await due();
      await processSchedules(workerDb);
      await drain(a.ws.id, { verificationDeps: deps });
    };

    await recheck(); // tag still there
    expect(await status()).toEqual({ verification_status: "verified", last_verification_error: null });
    present = false;
    await recheck(); // first failure: warning only
    expect((await status()).verification_status).toBe("verified");
    expect((await status()).last_verification_error).toMatch(/^Re-check failed/);
    await recheck(); // second failure: unverified
    expect((await status()).verification_status).toBe("unverified");
    const lost = await ownerInTenant(a.ws.id, "SELECT count(*)::int AS n FROM audit_logs WHERE action = 'website.verification_lost' AND entity_id = $1", [w.id]);
    expect(lost.rows[0].n).toBe(1);
  });
});

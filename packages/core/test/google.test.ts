import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, getPool } from "@sge/db";
import { processSchedules, runTick } from "@sge/jobs";
import {
  addDays,
  addKeywords,
  AppError,
  completeGoogleConnection,
  createClient,
  deleteKeywords,
  disconnectGoogle,
  getGoogleConnection,
  getWebsiteGoogle,
  googleAuthStart,
  gscPropertyMatches,
  isoDate,
  jobHandlers,
  keywordHistory,
  keywordsFromCsv,
  keywordSuggestions,
  listGoogleProperties,
  listKeywords,
  nextWindow,
  parseCsv,
  searchPerformance,
  setWebsiteProperties,
  syncWebsiteNow,
  trafficOverview,
  updateKeyword,
  addWebsite,
  type GoogleDeps
} from "../src/index";
import { closeAll, db, makeAgency, ownerInTenant } from "./helpers";

process.env.ENCRYPTION_KEY ??= "ab".repeat(32);
const workerDb = createDb(process.env.TEST_WORKER_DATABASE_URL!);
afterAll(async () => {
  await getPool(process.env.TEST_WORKER_DATABASE_URL!).end();
  await closeAll();
});

const codeOf = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof AppError ? e.code : `unexpected: ${(e as Error).message}`));
const NOW = new Date("2026-11-17T12:00:00Z");
const TODAY = isoDate(NOW);

/* ─────────────────────────── Fake Google APIs ──────────────────────────── */

interface FakeState {
  refreshValid: boolean;
  gscStatus: number;
  sites: { siteUrl: string; permissionLevel: string }[];
  calls: string[];
  revoked: string[];
}

const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.y`;
const daysIn = (a: string, b: string) => {
  const out: string[] = [];
  for (let d = a; d <= b; d = addDays(d, 1)) out.push(d);
  return out;
};

function fakeGoogle(overrides: Partial<FakeState> = {}) {
  const state: FakeState = {
    refreshValid: true,
    gscStatus: 200,
    sites: [
      { siteUrl: "sc-domain:gsc-fixture.com", permissionLevel: "siteOwner" },
      { siteUrl: "https://unrelated.example/", permissionLevel: "siteFullUser" },
      { siteUrl: "https://gsc-fixture.com/", permissionLevel: "siteRestrictedUser" }
    ],
    calls: [],
    revoked: [],
    ...overrides
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body;
    state.calls.push(`${init?.method ?? "GET"} ${url.hostname}${url.pathname}`);
    if (url.href === "https://oauth2.googleapis.com/token") {
      const p = new URLSearchParams(String(body));
      if (p.get("grant_type") === "authorization_code") {
        if (p.get("code") !== "good-code") return json(400, { error: "invalid_grant" });
        return json(200, {
          access_token: "at-0",
          refresh_token: p.get("code_verifier") === "no-offline" ? undefined : "rt-secret-1",
          scope: "openid email https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly",
          id_token: idToken("owner@gsc-fixture.com")
        });
      }
      return state.refreshValid ? json(200, { access_token: "at-1", expires_in: 3600 }) : json(400, { error: "invalid_grant" });
    }
    if (url.href === "https://oauth2.googleapis.com/revoke") {
      state.revoked.push(new URLSearchParams(String(body)).get("token") ?? "");
      return json(200, {});
    }
    if ((init?.headers as Record<string, string>)?.authorization !== "Bearer at-1") return json(401, { error: { message: "bad token" } });
    if (url.pathname === "/webmasters/v3/sites") return json(200, { siteEntry: state.sites });
    if (url.pathname.endsWith("/searchAnalytics/query")) {
      if (state.gscStatus !== 200) return json(state.gscStatus, { error: { message: "denied" } });
      const q = JSON.parse(String(body)) as { startDate: string; endDate: string; dimensions: string[]; startRow?: number };
      if (q.startRow) return json(200, { rows: [] });
      const rows = daysIn(q.startDate, q.endDate).flatMap((d) => {
        const k = q.dimensions.join(",");
        if (k === "date") return [{ keys: [d], clicks: 10, impressions: 100, ctr: 0.1, position: 5 }];
        if (k === "date,device")
          return [
            { keys: [d, "DESKTOP"], clicks: 6, impressions: 50, ctr: 0.12, position: 4 },
            { keys: [d, "MOBILE"], clicks: 4, impressions: 50, ctr: 0.08, position: 6 }
          ];
        if (k === "date,country") return [{ keys: [d, "ind"], clicks: 10, impressions: 100, ctr: 0.1, position: 5 }];
        return [
          { keys: [d, "running shoes", "https://gsc-fixture.com/shoes"], clicks: 5, impressions: 40, ctr: 0.125, position: 3 },
          { keys: [d, "Running Shoes", "https://gsc-fixture.com/sale"], clicks: 1, impressions: 10, ctr: 0.1, position: 7 },
          { keys: [d, "trail boots", "https://gsc-fixture.com/boots"], clicks: 2, impressions: 30, ctr: 0.066, position: 9 }
        ];
      });
      return json(200, { rows });
    }
    if (url.pathname === "/v1beta/accountSummaries")
      return json(200, { accountSummaries: [{ displayName: "Fixture Co", propertySummaries: [{ property: "properties/123", displayName: "gsc-fixture.com GA4" }] }] });
    if (url.pathname === "/v1beta/properties/123:runReport") {
      const q = JSON.parse(String(body)) as { dateRanges: { startDate: string; endDate: string }[]; offset: string };
      if (Number(q.offset) > 0) return json(200, { rows: [], rowCount: 0 });
      const rows = daysIn(q.dateRanges[0]!.startDate, q.dateRanges[0]!.endDate).flatMap((d) => {
        const day = d.replace(/-/g, "");
        const r = (src: string, med: string, page: string, s: number, e: number, k: number) => ({
          dimensionValues: [day, src, med, page, "(not set)"].map((value) => ({ value })),
          metricValues: [s, e, k].map((v) => ({ value: String(v) }))
        });
        return [r("google", "organic", "/shoes", 20, 15, 1), r("partner.com", "referral", "/boots", 5, 4, 0.5)];
      });
      return json(200, { rows, rowCount: rows.length });
    }
    return json(404, { error: { message: `no fake for ${url.href}` } });
  }) as typeof fetch;
  const deps: GoogleDeps = { fetch: fetchFn, config: () => ({ clientId: "cid", clientSecret: "csecret", redirectUri: "https://app.test/api/integrations/google/callback" }) };
  return { deps, state };
}

async function drain(org: string, deps: GoogleDeps, now = NOW) {
  for (let i = 0; i < 20; i++) {
    const r = await runTick({
      workerDb,
      appDb: db,
      handlers: jobHandlers({ googleDeps: deps, now: () => now }),
      workerId: "test",
      budgetMs: 120_000,
      maxJobMs: 100_000,
      organizationId: org
    });
    if (r.claimed === 0) return;
  }
}

/* ─────────────────────────────── OAuth ─────────────────────────────────── */

describe("Google OAuth connection", () => {
  it("builds a PKCE authorization URL with read-only scopes and offline access", () => {
    const s = googleAuthStart({ clientId: "cid", clientSecret: "x", redirectUri: "https://app.test/cb" }, "me@x.test");
    const u = new URL(s.url);
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("scope")).toBe(
      "openid email https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly"
    );
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("state")).toBe(s.state);
    expect(u.searchParams.get("code_challenge")).toBe(createHash("sha256").update(s.verifier).digest("base64url"));
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(s.state).not.toBe(googleAuthStart({ clientId: "cid", clientSecret: "x", redirectUri: "https://app.test/cb" }).state);
  });

  it("stores the refresh token encrypted, and only admins can connect", async () => {
    const a = await makeAgency();
    const g = fakeGoogle();
    expect((await getGoogleConnection(db, a.owner, a.ownerAccess, g.deps)).connected).toBe(false);
    const viewer = await a.addMember("viewer");
    expect(await codeOf(completeGoogleConnection(db, viewer, viewer.access, { code: "good-code", verifier: "v" }, g.deps))).toBe("forbidden");
    expect(await codeOf(completeGoogleConnection(db, a.owner, a.ownerAccess, { code: "bad-code", verifier: "v" }, g.deps))).toBe("verification_failed");
    expect(await codeOf(completeGoogleConnection(db, a.owner, a.ownerAccess, { code: "good-code", verifier: "no-offline" }, g.deps))).toBe(
      "verification_failed"
    );
    const r = await completeGoogleConnection(db, a.owner, a.ownerAccess, { code: "good-code", verifier: "v" }, g.deps);
    expect(r.email).toBe("owner@gsc-fixture.com");
    const row = (await ownerInTenant(a.ws.id, "SELECT credentials_enc, account_email, scopes FROM integrations WHERE provider = 'google'")).rows[0];
    expect(row.credentials_enc).not.toContain("rt-secret-1");
    expect(row.account_email).toBe("owner@gsc-fixture.com");
    expect(await getGoogleConnection(db, a.owner, a.ownerAccess, g.deps)).toMatchObject({ configured: true, connected: true, email: "owner@gsc-fixture.com" });
    const notConfigured: GoogleDeps = { ...g.deps, config: () => null };
    expect(await codeOf(completeGoogleConnection(db, a.owner, a.ownerAccess, { code: "good-code", verifier: "v" }, notConfigured))).toBe("invalid_input");
  });
});

/* ─────────────────────────── Properties & sync ─────────────────────────── */

describe("Search Console and Analytics sync", () => {
  let a: Awaited<ReturnType<typeof makeAgency>>;
  let websiteId: string;
  let g: ReturnType<typeof fakeGoogle>;

  beforeAll(async () => {
    a = await makeAgency();
    g = fakeGoogle();
    websiteId = (await addWebsite(db, a.owner, a.ownerAccess, { url: "gsc-fixture.com" })).id;
    await completeGoogleConnection(db, a.owner, a.ownerAccess, { code: "good-code", verifier: "v" }, g.deps);
  });

  it("lists properties, matching the website's domain first", async () => {
    const p = await listGoogleProperties(db, a.owner, a.ownerAccess, websiteId, g.deps);
    expect(p.gsc.map((s) => [s.siteUrl, s.matches])).toEqual([
      ["sc-domain:gsc-fixture.com", true],
      ["https://gsc-fixture.com/", true],
      ["https://unrelated.example/", false]
    ]);
    expect(p.ga4).toEqual([{ property: "properties/123", displayName: "gsc-fixture.com GA4", account: "Fixture Co" }]);
  });

  it("refuses properties for other domains or not in the account", async () => {
    expect(await codeOf(setWebsiteProperties(db, a.owner, a.ownerAccess, websiteId, { gsc: "https://unrelated.example/", ga4: null }, g.deps))).toBe("invalid_input");
    expect(await codeOf(setWebsiteProperties(db, a.owner, a.ownerAccess, websiteId, { gsc: "sc-domain:not-mine.com", ga4: null }, g.deps))).toBe("invalid_input");
    expect(await codeOf(setWebsiteProperties(db, a.owner, a.ownerAccess, websiteId, { gsc: null, ga4: "properties/999" }, g.deps))).toBe("invalid_input");
  });

  it("linking an owned GSC property verifies the website and backfills 16 months, recent data first", async () => {
    const r = await setWebsiteProperties(db, a.owner, a.ownerAccess, websiteId, { gsc: "sc-domain:gsc-fixture.com", ga4: "properties/123" }, g.deps);
    expect(r.verified).toBe(true);
    const site = (await ownerInTenant(a.ws.id, "SELECT verification_status, verification_method FROM websites WHERE id = $1", [websiteId])).rows[0];
    expect(site).toEqual({ verification_status: "verified", verification_method: "gsc" });
    const sched = await ownerInTenant(a.ws.id, "SELECT job_type, interval_minutes FROM schedules WHERE website_id = $1 AND enabled ORDER BY job_type", [websiteId]);
    expect(sched.rows.map((x) => x.job_type)).toEqual(["ga4.sync", "gsc.sync", "website.reverify"]);

    await drain(a.ws.id, g.deps);
    const wg = (await getWebsiteGoogle(db, a.owner, a.ownerAccess, websiteId))!;
    expect(wg).toMatchObject({ gscSyncedFrom: addDays(TODAY, -486), gscSyncedThrough: addDays(TODAY, -3), gscError: null });
    expect(wg).toMatchObject({ ga4SyncedFrom: addDays(TODAY, -90), ga4SyncedThrough: addDays(TODAY, -1), ga4Error: null });
    const n = async (table: string) => (await ownerInTenant(a.ws.id, `SELECT count(*)::int AS n FROM ${table} WHERE website_id = $1`, [websiteId])).rows[0].n;
    expect(await n("gsc_site_daily")).toBe(484);
    expect(await n("gsc_dim_daily")).toBe(484 * 3);
    expect(await n("gsc_daily")).toBe(484 * 3);
    expect(await n("ga4_daily")).toBe(90 * 2);
  });

  it("re-syncing is idempotent and an incremental sync only fetches new days", async () => {
    const before = (await searchPerformance(db, a.owner, a.ownerAccess, websiteId, "16m")).totals;
    await syncWebsiteNow(db, a.owner, a.ownerAccess, websiteId);
    g.state.calls.length = 0;
    await drain(a.ws.id, g.deps);
    expect(g.state.calls.filter((c) => c.includes("searchAnalytics"))).toHaveLength(0); // already up to date
    expect((await searchPerformance(db, a.owner, a.ownerAccess, websiteId, "16m")).totals).toEqual(before);

    // Two days later: only the new days are fetched; GA4 re-fetches its last 3 days.
    const later = new Date(NOW.getTime() + 2 * 86_400_000);
    await ownerInTenant(a.ws.id, "UPDATE schedules SET next_run_at = now() - interval '1 minute' WHERE website_id = $1 AND job_type IN ('gsc.sync','ga4.sync')", [websiteId]);
    await processSchedules(workerDb);
    g.state.calls.length = 0;
    await drain(a.ws.id, g.deps, later);
    expect(g.state.calls.filter((c) => c.includes("searchAnalytics"))).toHaveLength(4);
    const wg = (await getWebsiteGoogle(db, a.owner, a.ownerAccess, websiteId))!;
    expect(wg.gscSyncedThrough).toBe(addDays(TODAY, -1));
    const rows = (await ownerInTenant(a.ws.id, "SELECT count(*)::int AS n FROM gsc_site_daily WHERE website_id = $1", [websiteId])).rows[0].n;
    expect(rows).toBe(486);
  });

  it("dashboards aggregate totals, comparisons and breakdowns", async () => {
    const p = await searchPerformance(db, a.owner, a.ownerAccess, websiteId, "28d");
    expect(p.hasData).toBe(true);
    expect(p.totals).toEqual({ clicks: 280, impressions: 2800, ctr: 0.1, position: 5 });
    expect(p.previous).toMatchObject({ clicks: 280 });
    expect(p.series).toHaveLength(28);
    expect(p.queries.map((q) => q.key)).toEqual(["running shoes", "trail boots", "Running Shoes"]);
    expect(p.devices.map((d) => d.key)).toEqual(["desktop", "mobile"]);
    expect(p.devices[0]).toMatchObject({ clicks: 168, position: 4 });
    const t = await trafficOverview(db, a.owner, a.ownerAccess, websiteId, "28d");
    expect(t.totals).toEqual({ sessions: 700, engagedSessions: 532, keyEvents: 42 });
    expect(t.referrers).toEqual([{ key: "partner.com", sessions: 140, engagedSessions: 112, keyEvents: 14 }]);
    expect(t.channels[0]!.key).toBe("google / organic");
  });

  it("keeps data out of other workspaces and client scopes", async () => {
    const other = await makeAgency();
    expect(await codeOf(searchPerformance(db, other.owner, other.ownerAccess, websiteId))).toBe("ok"); // empty, not an error
    expect((await searchPerformance(db, other.owner, other.ownerAccess, websiteId)).hasData).toBe(false);
    expect((await trafficOverview(db, other.owner, other.ownerAccess, websiteId)).hasData).toBe(false);
    expect(await getWebsiteGoogle(db, other.owner, other.ownerAccess, websiteId)).toBeNull();

    const client = await createClient(db, a.owner, a.ownerAccess, { name: "Other client" });
    const spec = await a.addMember("specialist", [client.id]);
    expect((await searchPerformance(db, spec, spec.access, websiteId)).hasData).toBe(false);

    const c = await getPool(process.env.TEST_DATABASE_URL!).connect();
    try {
      for (const table of ["website_google", "gsc_site_daily", "gsc_dim_daily", "gsc_daily", "ga4_daily", "keywords"])
        expect((await c.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, table).toBe(0);
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.org_id', $1, true), set_config('app.client_scope', '*', true)", [other.ws.id]);
      const ins = await c
        .query("INSERT INTO gsc_site_daily (organization_id, website_id, date, clicks, impressions, position) VALUES ($1, $2, '2020-01-01', 1, 1, 1)", [a.ws.id, websiteId])
        .then(() => "inserted", () => "blocked");
      expect(ins).toBe("blocked");
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });

  it("revoked Google access stops syncing with a clear message (no retries)", async () => {
    const revoked = fakeGoogle({ refreshValid: false });
    await syncWebsiteNow(db, a.owner, a.ownerAccess, websiteId).catch(() => 0);
    await ownerInTenant(a.ws.id, "UPDATE jobs SET idempotency_key = NULL WHERE organization_id = $1", [a.ws.id]);
    await syncWebsiteNow(db, a.owner, a.ownerAccess, websiteId);
    await drain(a.ws.id, revoked.deps);
    const wg = (await getWebsiteGoogle(db, a.owner, a.ownerAccess, websiteId))!;
    expect(wg.gscError).toMatch(/expired or was revoked/);
    expect(wg.ga4Error).toMatch(/expired or was revoked/);
    expect(await getGoogleConnection(db, a.owner, a.ownerAccess, revoked.deps)).toMatchObject({ connected: false, status: "expired" });
    const failed = await ownerInTenant(a.ws.id, "SELECT count(*)::int AS n FROM jobs WHERE organization_id = $1 AND status = 'failed'", [a.ws.id]);
    expect(failed.rows[0].n).toBe(0);
  });

  it("disconnecting revokes the token and stops scheduled syncs", async () => {
    await completeGoogleConnection(db, a.owner, a.ownerAccess, { code: "good-code", verifier: "v" }, g.deps);
    await disconnectGoogle(db, a.owner, a.ownerAccess, g.deps);
    expect(g.state.revoked).toContain("rt-secret-1");
    expect((await getGoogleConnection(db, a.owner, a.ownerAccess, g.deps)).connected).toBe(false);
    const on = await ownerInTenant(a.ws.id, "SELECT count(*)::int AS n FROM schedules WHERE website_id = $1 AND enabled AND job_type IN ('gsc.sync','ga4.sync')", [websiteId]);
    expect(on.rows[0].n).toBe(0);
  });
});

describe("Search Console errors and helpers", () => {
  it("records a permission error from Search Console", async () => {
    const a = await makeAgency();
    const g = fakeGoogle();
    const w = await addWebsite(db, a.owner, a.ownerAccess, { url: "gsc-fixture.com" });
    await completeGoogleConnection(db, a.owner, a.ownerAccess, { code: "good-code", verifier: "v" }, g.deps);
    await setWebsiteProperties(db, a.owner, a.ownerAccess, w.id, { gsc: "sc-domain:gsc-fixture.com", ga4: null }, g.deps);
    g.state.gscStatus = 403;
    await drain(a.ws.id, g.deps);
    expect((await getWebsiteGoogle(db, a.owner, a.ownerAccess, w.id))!.gscError).toMatch(/no longer has access/);
  });

  it("matches properties to domains", () => {
    expect(gscPropertyMatches("sc-domain:example.com", "www.example.com")).toBe(true);
    expect(gscPropertyMatches("sc-domain:example.com", "blog.example.com")).toBe(true);
    expect(gscPropertyMatches("https://www.example.com/", "example.com")).toBe(true);
    expect(gscPropertyMatches("https://example.org/", "example.com")).toBe(false);
    expect(gscPropertyMatches("sc-domain:ample.com", "example.com")).toBe(false);
  });

  it("plans sync windows: recent first, then forward, then backfill", () => {
    const latest = "2026-11-14";
    const earliest = "2025-07-15";
    expect(nextWindow({ from: null, through: null }, latest, earliest, { refetchDays: 0 })).toEqual({ start: "2026-10-18", end: latest, direction: "forward" });
    expect(nextWindow({ from: "2026-10-18", through: "2026-11-12" }, latest, earliest, { refetchDays: 0 })).toEqual({ start: "2026-11-13", end: latest, direction: "forward" });
    expect(nextWindow({ from: "2026-10-18", through: latest }, latest, earliest, { refetchDays: 0 })).toEqual({ start: "2026-10-04", end: "2026-10-17", direction: "backward" });
    expect(nextWindow({ from: earliest, through: latest }, latest, earliest, { refetchDays: 0 })).toBeNull();
  });
});

/* ─────────────────────────────── Keywords ──────────────────────────────── */

describe("keywords", () => {
  let a: Awaited<ReturnType<typeof makeAgency>>;
  let websiteId: string;

  beforeAll(async () => {
    a = await makeAgency();
    const g = fakeGoogle();
    websiteId = (await addWebsite(db, a.owner, a.ownerAccess, { url: "gsc-fixture.com" })).id;
    await completeGoogleConnection(db, a.owner, a.ownerAccess, { code: "good-code", verifier: "v" }, g.deps);
    await setWebsiteProperties(db, a.owner, a.ownerAccess, websiteId, { gsc: "sc-domain:gsc-fixture.com", ga4: null }, g.deps);
    await drain(a.ws.id, g.deps);
  });

  it("adds keywords case-insensitively without duplicates and joins Search Console metrics", async () => {
    const r = await addKeywords(db, a.owner, a.ownerAccess, websiteId, [
      { keyword: "  Running   shoes ", groupName: "Shoes", tags: "core, Money", targetUrl: "/shoes", intent: "Commercial" },
      { keyword: "running shoes" },
      { keyword: "never searched phrase", targetUrl: "https://evil.example/x" }
    ]);
    expect(r).toEqual({ added: 2, updated: 0, skipped: 1 });
    const again = await addKeywords(db, a.owner, a.ownerAccess, websiteId, [{ keyword: "RUNNING SHOES", groupName: "Footwear" }]);
    expect(again).toMatchObject({ added: 0, updated: 1 });

    const list = await listKeywords(db, a.owner, a.ownerAccess, websiteId);
    const shoes = list.rows.find((k) => k.keyword === "Running shoes")!;
    expect(shoes).toMatchObject({ groupName: "Footwear", tags: ["core", "money"], targetUrl: "https://gsc-fixture.com/shoes", intent: "commercial" });
    // "running shoes" + "Running Shoes" rows both count: 6 clicks/day × 28.
    expect(shoes).toMatchObject({ clicks: 168, impressions: 1400, rankingPage: "https://gsc-fixture.com/shoes" });
    expect(shoes.position).toBeCloseTo(3.8, 5);
    expect(shoes.prevPosition).toBeCloseTo(3.8, 5);
    const never = list.rows.find((k) => k.keyword === "never searched phrase")!;
    expect(never).toMatchObject({ clicks: 0, position: null, targetUrl: null }); // off-site target dropped
    expect(list.groups).toEqual(["Footwear"]);
    expect((await listKeywords(db, a.owner, a.ownerAccess, websiteId, { q: "never" })).rows).toHaveLength(1);
  });

  it("suggests untracked queries and shows weekly history", async () => {
    const s = await keywordSuggestions(db, a.owner, a.ownerAccess, websiteId);
    expect(s.map((x) => x.query)).toEqual(["trail boots"]);
    const shoes = (await listKeywords(db, a.owner, a.ownerAccess, websiteId)).rows.find((k) => k.keyword === "Running shoes")!;
    const h = await keywordHistory(db, a.owner, a.ownerAccess, shoes.id);
    expect(h.weeks.length).toBeGreaterThan(60);
    expect(h.pages[0]).toMatchObject({ page: "https://gsc-fixture.com/shoes" });
  });

  it("imports CSV exports; volume/difficulty require a source label", async () => {
    const csv = `﻿Keyword,Volume,KD,Parent Topic,URL\n"trail boots, waterproof",1200,35,boots,/boots\nhiking boots,"2,400",48,boots,\n`;
    const parsed = keywordsFromCsv(csv);
    expect(parsed.inputs).toEqual([
      { keyword: "trail boots, waterproof", groupName: "boots", tags: undefined, targetUrl: "/boots", intent: null, volume: "1200", difficulty: "35" },
      { keyword: "hiking boots", groupName: "boots", tags: undefined, targetUrl: null, intent: null, volume: "2,400", difficulty: "48" }
    ]);
    expect(await codeOf(addKeywords(db, a.owner, a.ownerAccess, websiteId, parsed.inputs))).toBe("invalid_input");
    await addKeywords(db, a.owner, a.ownerAccess, websiteId, parsed.inputs, { source: "Ahrefs export, Nov 2026" });
    const hiking = (await listKeywords(db, a.owner, a.ownerAccess, websiteId)).rows.find((k) => k.keyword === "hiking boots")!;
    expect(hiking).toMatchObject({ volume: 2400, volumeSource: "Ahrefs export, Nov 2026", difficulty: 48, difficultySource: "Ahrefs export, Nov 2026" });
    // Plain list without a header; semicolons.
    expect(keywordsFromCsv("alpha\nbeta\n").inputs.map((i) => i.keyword)).toEqual(["alpha", "beta"]);
    expect(parseCsv('a;b\n"x;y";"he said ""hi"""\n')).toEqual([["a", "b"], ["x;y", 'he said "hi"']]);
  });

  it("enforces the plan's keyword limit, roles and deletion", async () => {
    await ownerInTenant(a.ws.id, `UPDATE subscriptions SET overrides = '{"keywords": 5}' WHERE organization_id = $1`, [a.ws.id]);
    expect(await codeOf(addKeywords(db, a.owner, a.ownerAccess, websiteId, [{ keyword: "one" }, { keyword: "two" }]))).toBe("limit_reached");
    const viewer = await a.addMember("viewer");
    expect(await codeOf(addKeywords(db, viewer, viewer.access, websiteId, [{ keyword: "x" }]))).toBe("forbidden");
    const list = await listKeywords(db, a.owner, a.ownerAccess, websiteId);
    const k = list.rows[0]!;
    expect(await codeOf(updateKeyword(db, viewer, viewer.access, k.id, { notes: "x" }))).toBe("forbidden");
    expect((await updateKeyword(db, a.owner, a.ownerAccess, k.id, { notes: " note ", intent: "nonsense" })).intent).toBeNull();
    expect(await deleteKeywords(db, a.owner, a.ownerAccess, websiteId, [k.id])).toBe(1);
    const other = await makeAgency();
    expect(await deleteKeywords(db, other.owner, other.ownerAccess, websiteId, list.rows.map((x) => x.id))).toBe(0);
    expect((await listKeywords(db, other.owner, other.ownerAccess, websiteId)).rows).toEqual([]);
  });
});

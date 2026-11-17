import { afterAll, describe, expect, it } from "vitest";
import { createDb, eq, getPool, schema } from "@sge/db";
import { SafeFetchError, type SafeFetchResult } from "@sge/crawler";
import { runTick } from "@sge/jobs";
import {
  addWebsite,
  AppError,
  cancelCrawl,
  createClient,
  getCrawl,
  jobHandlers,
  listCrawls,
  startCrawl,
  usageSummary,
  type CrawlHandlerOptions
} from "../src/index";
import { closeAll, db, makeAgency, ownerInTenant } from "./helpers";

const workerDb = createDb(process.env.TEST_WORKER_DATABASE_URL!);
afterAll(async () => {
  await getPool(process.env.TEST_WORKER_DATABASE_URL!).end();
  await closeAll();
});

async function codeOf(p: Promise<unknown>) {
  return p.then(() => "ok", (e) => (e instanceof AppError ? e.code : `unexpected: ${(e as Error).message}`));
}

type Route = { status?: number; body?: string; type?: string; redirect?: string };
const html = (title: string, links: string[] = [], head = "") =>
  `<html><head><title>${title}</title>${head}</head><body>${links.map((l) => `<a href="${l}">x</a>`).join("")}</body></html>`;

/** An in-memory website: the handler's fetcher, routed by path. */
function fakeSite(routes: Record<string, Route>) {
  const fetched: string[] = [];
  const fetch: NonNullable<CrawlHandlerOptions["fetch"]> = async (url, opts) => {
    const u = new URL(url);
    fetched.push(u.pathname + u.search);
    const r = routes[u.pathname];
    if (!r) return { url, status: 404, contentType: "text/html", body: "not found", redirects: [] } satisfies SafeFetchResult;
    if (r.redirect) return { url: new URL(r.redirect, url).toString(), status: 200, contentType: "text/html", body: routes[new URL(r.redirect, url).pathname]?.body ?? "", redirects: [r.redirect] };
    const type = r.type ?? "text/html";
    if (opts.contentTypes && !opts.contentTypes.some((t) => type.startsWith(t))) throw new SafeFetchError("bad_content_type", "x");
    return { url, status: r.status ?? 200, contentType: type, body: r.body ?? "", redirects: [] };
  };
  return { fetch, fetched };
}

const tick = (org: string, opts: CrawlHandlerOptions, budgetMs = 20_000, maxJobMs = 15_000) =>
  runTick({
    workerDb,
    appDb: db,
    handlers: jobHandlers({ minDelayMs: 0, sleep: async () => undefined, fetchTimeoutMs: 50, ...opts }),
    workerId: "test",
    budgetMs,
    maxJobMs,
    organizationId: org
  });

async function verifiedSite(a: Awaited<ReturnType<typeof makeAgency>>, domain: string, clientId?: string) {
  const w = await addWebsite(db, a.owner, a.ownerAccess, { url: domain, clientId });
  await ownerInTenant(a.ws.id, `UPDATE websites SET verification_status = 'verified' WHERE id = $1`, [w.id]);
  return w;
}

const standardSite = () =>
  fakeSite({
    "/robots.txt": { type: "text/plain", body: "User-agent: *\nDisallow: /private\nSitemap: https://crawl-fixture.com/sitemap.xml\n" },
    "/sitemap.xml": {
      type: "application/xml",
      body: `<urlset><url><loc>https://crawl-fixture.com/from-sitemap</loc></url><url><loc>https://crawl-fixture.com/about</loc></url></urlset>`
    },
    "/": { body: html("Home", ["/about", "/blog", "/private/secret", "https://other.net/", "/file.pdf", "/about#team", "mailto:x@y.z"]) },
    "/about": { body: html("About us", ["/"]) },
    "/blog": { body: html("Blog", ["/blog/post-1", "/broken"]) },
    "/blog/post-1": { body: html("First post") },
    "/from-sitemap": { body: html("Sitemap-only page") },
    "/broken": { status: 404, body: "gone" }
  });

describe("crawling", () => {
  it("crawls a site politely: robots.txt, sitemap, same-site links, usage metering", async () => {
    const a = await makeAgency();
    const w = await verifiedSite(a, "crawl-fixture.com");
    const site = standardSite();
    const crawl = await startCrawl(db, a.owner, a.ownerAccess, w.id);
    expect(crawl).toMatchObject({ status: "queued", maxPages: 500, pagesFound: 1 });

    await tick(a.ws.id, { fetch: site.fetch });
    const d = await getCrawl(db, a.owner, a.ownerAccess, crawl.id);
    expect(d.crawl.status).toBe("completed");
    const byPath = Object.fromEntries(d.pages.map((p) => [new URL(p.url).pathname, p]));
    expect(Object.keys(byPath).sort()).toEqual(["/", "/about", "/blog", "/blog/post-1", "/broken", "/from-sitemap", "/private/secret"]);
    expect(byPath["/private/secret"]).toMatchObject({ status: "skipped", skipReason: "Blocked by robots.txt" });
    expect(byPath["/broken"]).toMatchObject({ status: "fetched", httpStatus: 404 });
    expect(byPath["/about"]).toMatchObject({ status: "fetched", httpStatus: 200, title: "About us" });
    expect(byPath["/from-sitemap"]!.source).toBe("sitemap");
    expect(site.fetched).not.toContain("/private/secret"); // never requested
    expect(site.fetched.filter((p) => p === "/about")).toHaveLength(1); // fragment de-duplicated
    expect(d.counts).toMatchObject({ fetched: 6, skipped: 1, queued: 0 });

    const usage = (await usageSummary(db, a.owner, a.ownerAccess)).lines.find((l) => l.key === "pages_crawled_month");
    expect(usage!.used).toBe(6); // robots-blocked pages aren't billed
  });

  it("is resumable: short time slices continue where they left off, without refetching", async () => {
    const a = await makeAgency();
    const w = await verifiedSite(a, "crawl-fixture.com");
    const site = standardSite();
    const crawl = await startCrawl(db, a.owner, a.ownerAccess, w.id);
    const slowFetch: NonNullable<CrawlHandlerOptions["fetch"]> = async (u, o) => {
      await new Promise((r) => setTimeout(r, 400));
      return site.fetch(u, o);
    };
    let ticks = 0;
    for (; ticks < 40; ticks++) {
      await tick(a.ws.id, { fetch: slowFetch, fetchTimeoutMs: 50 }, 6_000, 5_000);
      if ((await getCrawl(db, a.owner, a.ownerAccess, crawl.id)).crawl.status === "completed") break;
    }
    expect(ticks).toBeGreaterThan(0); // needed more than one slice
    const pages = site.fetched.filter((p) => !["/robots.txt", "/sitemap.xml"].includes(p));
    expect(new Set(pages).size).toBe(pages.length);
  }, 90_000);

  it("caps unverified sites and stops at the monthly plan allowance", async () => {
    const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`/p${i}`, { body: html(`P${i}`) }]));
    const site = fakeSite({
      "/robots.txt": { status: 404 },
      "/": { body: html("Home", Object.keys(many)) },
      ...many
    });

    const a = await makeAgency();
    const unverified = await addWebsite(db, a.owner, a.ownerAccess, { url: "crawl-fixture.com" });
    const c1 = await startCrawl(db, a.owner, a.ownerAccess, unverified.id);
    expect(c1.maxPages).toBe(25);
    await tick(a.ws.id, { fetch: site.fetch });
    const d1 = await getCrawl(db, a.owner, a.ownerAccess, c1.id);
    expect(d1.crawl).toMatchObject({ status: "completed", pagesFetched: 25 });

    const b = await makeAgency();
    await ownerInTenant(b.ws.id, `UPDATE subscriptions SET overrides = '{"pages_crawled_month": 4}' WHERE organization_id = $1`, [b.ws.id]);
    const w = await verifiedSite(b, "crawl-fixture.com");
    const c2 = await startCrawl(db, b.owner, b.ownerAccess, w.id);
    await tick(b.ws.id, { fetch: site.fetch });
    const d2 = await getCrawl(db, b.owner, b.ownerAccess, c2.id);
    expect(d2.crawl).toMatchObject({ status: "limit_reached", pagesFetched: 4 });
    expect(d2.counts.queued).toBe(0);
  });

  it("stays out when robots.txt is unreachable (5xx)", async () => {
    const a = await makeAgency();
    const w = await verifiedSite(a, "crawl-fixture.com");
    const site = fakeSite({ "/robots.txt": { status: 503, type: "text/plain" }, "/": { body: html("Home") } });
    const c = await startCrawl(db, a.owner, a.ownerAccess, w.id);
    await tick(a.ws.id, { fetch: site.fetch });
    expect((await getCrawl(db, a.owner, a.ownerAccess, c.id)).crawl).toMatchObject({ status: "failed", pagesFetched: 0 });
    expect(site.fetched).toEqual(["/robots.txt"]);
  });

  it("can be cancelled; one crawl per website at a time", async () => {
    const a = await makeAgency();
    const w = await verifiedSite(a, "crawl-fixture.com");
    const c = await startCrawl(db, a.owner, a.ownerAccess, w.id);
    expect(await codeOf(startCrawl(db, a.owner, a.ownerAccess, w.id))).toBe("conflict");
    await cancelCrawl(db, a.owner, a.ownerAccess, c.id);
    const site = standardSite();
    await tick(a.ws.id, { fetch: site.fetch });
    expect(site.fetched).toEqual([]);
    const d = await getCrawl(db, a.owner, a.ownerAccess, c.id);
    expect(d.crawl.status).toBe("cancelled");
    const [job] = await workerDb.select().from(schema.jobs).where(eq(schema.jobs.id, d.crawl.jobId!));
    expect(job!.status).toBe("cancelled");
    await expect(startCrawl(db, a.owner, a.ownerAccess, w.id)).resolves.toBeTruthy();
  });

  it("respects roles and client scope", async () => {
    const a = await makeAgency();
    const acme = await createClient(db, a.owner, a.ownerAccess, { name: "Acme" });
    const acmeSite = await verifiedSite(a, "acme-crawl.com", acme.id);
    const otherSite = await verifiedSite(a, "other-crawl.com");
    const viewer = await a.addMember("viewer");
    expect(await codeOf(startCrawl(db, viewer, viewer.access, acmeSite.id))).toBe("forbidden");

    const c1 = await startCrawl(db, a.owner, a.ownerAccess, acmeSite.id);
    const c2 = await startCrawl(db, a.owner, a.ownerAccess, otherSite.id);
    const client = await a.addMember("client", [acme.id]);
    expect((await listCrawls(db, client, client.access, acmeSite.id)).map((c) => c.id)).toEqual([c1.id]);
    expect(await codeOf(getCrawl(db, client, client.access, c2.id))).toBe("not_found");
    expect(await listCrawls(db, client, client.access, otherSite.id)).toEqual([]);
  });
});

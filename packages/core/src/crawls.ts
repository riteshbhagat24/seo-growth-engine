import { and, asc, desc, eq, schema, sql, withContext, type Db, type Tx } from "@sge/db";
import type { Crawl, CrawlPage } from "@sge/db/schema";
import {
  compactSeo,
  extractSeo,
  looksLikeHtml,
  normalizeCrawlUrl,
  parseRobots,
  parseSitemap,
  safeFetch,
  SafeFetchError,
  sameSite,
  urlHash,
  type SafeFetchOptions,
  type SafeFetchResult
} from "@sge/crawler";
import { cancelJob, enqueue, type JobHandler } from "@sge/jobs";
import { audit } from "./audit";
import { assertId, inWorkspace, requireAction, type Actor, type WorkspaceAccess } from "./context";
import { AppError } from "./errors";
import { consumeUsage } from "./plans";

const { crawls, crawlPages, websites, jobs, audits } = schema;

export const CRAWL_JOB = "crawl.run";
/** Analyses a finished audit crawl (external link checks, rules, score). */
export const AUDIT_ANALYZE_JOB = "audit.analyze";
/** Pages per crawl: verified sites get the full cap; unverified sites a small sample. */
export const CRAWL_MAX_PAGES = { verified: 500, unverified: 25 } as const;
export const CRAWL_MAX_DEPTH = 10;
const SITEMAP_LIMIT = { documents: 5, urls: 5_000 };

/* ─────────────────────────────── Service API ────────────────────────────── */

/**
 * Creates a crawl (frontier seeded with the homepage) and enqueues it. Runs in
 * the caller's tenant transaction; callers check permissions.
 */
export async function createCrawl(tx: Tx, organizationId: string, websiteId: string, userId: string | null): Promise<Crawl> {
  const [w] = await tx.select().from(websites).where(eq(websites.id, websiteId));
  if (!w) throw new AppError("not_found", "Website not found");
  const [active] = await tx
    .select({ id: crawls.id })
    .from(crawls)
    .where(and(eq(crawls.websiteId, w.id), sql`${crawls.status} in ('queued', 'running')`));
  if (active) throw new AppError("conflict", "A crawl or audit is already running for this website");

  const maxPages = w.verificationStatus === "verified" ? CRAWL_MAX_PAGES.verified : CRAWL_MAX_PAGES.unverified;
  const startUrl = normalizeCrawlUrl(`${w.url}/`)!;
  const [crawl] = await tx
    .insert(crawls)
    .values({ organizationId, websiteId: w.id, startUrl, maxPages, maxDepth: CRAWL_MAX_DEPTH, createdByUserId: userId })
    .returning();
  await tx.insert(crawlPages).values({ organizationId, crawlId: crawl!.id, url: startUrl, urlHash: urlHash(startUrl), depth: 0, source: "start" });
  const job = await enqueue(tx, {
    type: CRAWL_JOB,
    organizationId,
    websiteId: w.id,
    payload: { crawlId: crawl!.id },
    idempotencyKey: `crawl:${crawl!.id}`,
    maxAttempts: 3,
    createdByUserId: userId
  });
  const [saved] = await tx.update(crawls).set({ jobId: job.id, pagesFound: 1 }).where(eq(crawls.id, crawl!.id)).returning();
  return saved!;
}

export async function startCrawl(db: Db, actor: Actor, access: WorkspaceAccess, websiteId: string): Promise<Crawl> {
  assertId(websiteId, "Website");
  return inWorkspace(db, actor, access, async (tx, { role }) => {
    requireAction(role, "work.run");
    const saved = await createCrawl(tx, access.workspace.id, websiteId, actor.userId);
    const crawl = saved;
    const [w] = await tx.select({ domain: websites.domain }).from(websites).where(eq(websites.id, websiteId));
    const maxPages = saved.maxPages;
    await audit(tx, {
      organizationId: access.workspace.id,
      actorUserId: actor.userId,
      action: "crawl.started",
      entityType: "crawl",
      entityId: crawl!.id,
      metadata: { domain: w?.domain, maxPages },
      ip: actor.ip,
      userAgent: actor.userAgent
    });
    return saved;
  });
}

export async function cancelCrawl(db: Db, actor: Actor, access: WorkspaceAccess, crawlId: string): Promise<void> {
  assertId(crawlId, "Crawl");
  await inWorkspace(db, actor, access, async (tx, { role }) => {
    requireAction(role, "work.run");
    const [c] = await tx
      .update(crawls)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(and(eq(crawls.id, crawlId), sql`${crawls.status} in ('queued', 'running')`))
      .returning();
    if (!c) throw new AppError("conflict", "This crawl isn't running");
    if (c.jobId) await cancelJob(tx, c.jobId);
    await tx.update(crawlPages).set({ status: "skipped", skipReason: "Crawl cancelled" }).where(and(eq(crawlPages.crawlId, c.id), eq(crawlPages.status, "queued")));
    await tx.update(audits).set({ status: "cancelled", finishedAt: new Date() }).where(and(eq(audits.crawlId, c.id), eq(audits.status, "crawling")));
    await audit(tx, {
      organizationId: access.workspace.id,
      actorUserId: actor.userId,
      action: "crawl.cancelled",
      entityType: "crawl",
      entityId: c.id,
      ip: actor.ip,
      userAgent: actor.userAgent
    });
  });
}

export async function listCrawls(db: Db, actor: Actor, access: WorkspaceAccess, websiteId: string, limit = 10): Promise<Crawl[]> {
  assertId(websiteId, "Website");
  return inWorkspace(db, actor, access, (tx) =>
    tx.select().from(crawls).where(eq(crawls.websiteId, websiteId)).orderBy(desc(crawls.createdAt)).limit(limit)
  );
}

export interface CrawlDetail {
  crawl: Crawl;
  counts: Record<CrawlPage["status"], number>;
  pages: CrawlPage[];
}

export async function getCrawl(
  db: Db,
  actor: Actor,
  access: WorkspaceAccess,
  crawlId: string,
  opts: { status?: CrawlPage["status"]; limit?: number; offset?: number } = {}
): Promise<CrawlDetail> {
  assertId(crawlId, "Crawl");
  return inWorkspace(db, actor, access, async (tx) => {
    const [crawl] = await tx.select().from(crawls).where(eq(crawls.id, crawlId));
    if (!crawl) throw new AppError("not_found", "Crawl not found");
    const grouped = await tx
      .select({ status: crawlPages.status, n: sql<number>`count(*)::int` })
      .from(crawlPages)
      .where(eq(crawlPages.crawlId, crawlId))
      .groupBy(crawlPages.status);
    const counts = { queued: 0, fetched: 0, error: 0, skipped: 0 };
    for (const g of grouped) counts[g.status] = g.n;
    const pages = await tx
      .select()
      .from(crawlPages)
      .where(opts.status ? and(eq(crawlPages.crawlId, crawlId), eq(crawlPages.status, opts.status)) : eq(crawlPages.crawlId, crawlId))
      .orderBy(asc(crawlPages.depth), asc(crawlPages.createdAt))
      .limit(Math.min(opts.limit ?? 100, 500))
      .offset(Math.max(0, opts.offset ?? 0));
    return { crawl, counts, pages };
  });
}

export async function listWorkspaceJobs(db: Db, actor: Actor, access: WorkspaceAccess, limit = 100) {
  return inWorkspace(db, actor, access, async (tx, { role }) => {
    requireAction(role, "work.run");
    return tx.select().from(jobs).where(eq(jobs.organizationId, access.workspace.id)).orderBy(desc(jobs.createdAt)).limit(limit);
  });
}

/* ─────────────────────────────── Job handler ────────────────────────────── */

export interface CrawlHandlerOptions {
  /** Injected for tests; defaults to safeFetch. */
  fetch?: (url: string, opts: SafeFetchOptions) => Promise<SafeFetchResult>;
  sleep?: (ms: number) => Promise<void>;
  minDelayMs?: number;
  fetchTimeoutMs?: number;
}

const HTML_TYPES = ["text/html", "application/xhtml+xml"];
const DEFAULT_FETCH_TIMEOUT_MS = 12_000;

export function createCrawlHandler(o: CrawlHandlerOptions = {}): JobHandler {
  const fetchFn = o.fetch ?? safeFetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const minDelay = o.minDelayMs ?? 1_000;
  const FETCH_TIMEOUT_MS = o.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

  return async ({ job, appDb, deadline, heartbeat }) => {
    const org = job.organizationId!;
    const crawlId = String(job.payload.crawlId ?? "");
    assertId(crawlId, "Crawl");
    const t = <T>(fn: (tx: Tx) => Promise<T>) => withContext(appDb, { organizationId: org }, fn);
    const finish = (status: Crawl["status"], error: string | null = null) =>
      t(async (tx) => {
        await tx.update(crawls).set({ status, error, finishedAt: new Date() }).where(eq(crawls.id, crawlId));
        if (status !== "completed")
          await tx
            .update(crawlPages)
            .set({ status: "skipped", skipReason: error ?? "Crawl stopped" })
            .where(and(eq(crawlPages.crawlId, crawlId), eq(crawlPages.status, "queued")));
        await onCrawlFinished(tx, org, crawlId, status, error);
      });

    let [crawl] = await t((tx) => tx.select().from(crawls).where(eq(crawls.id, crawlId)));
    if (!crawl || ["cancelled", "completed", "failed", "limit_reached"].includes(crawl.status)) return { done: true };
    const site = new URL(crawl.startUrl);

    // ── First run: robots.txt and sitemaps ─────────────────────────────────
    if (crawl.status === "queued") {
      const robotsUrl = `${site.origin}/robots.txt`;
      let robotsStatus = 0;
      let robotsBody = "";
      try {
        const r = await fetchFn(robotsUrl, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: 512 * 1024, contentTypes: ["text/plain", "text/html", "application/octet-stream"] });
        robotsStatus = r.status;
        robotsBody = r.status < 300 ? r.body : "";
      } catch (e) {
        // Unreachable robots.txt → RFC 9309 says assume everything is disallowed.
        robotsStatus = e instanceof SafeFetchError && e.code === "bad_content_type" ? 404 : 0;
      }
      const robots = parseRobots(robotsUrl, robotsStatus, robotsBody);
      const delay = Math.max(minDelay, robots.crawlDelayMs ?? 0);
      await t((tx) =>
        tx
          .update(crawls)
          .set({ status: "running", startedAt: new Date(), robotsTxt: robotsBody.slice(0, 50_000), robotsStatus, crawlDelayMs: delay })
          .where(eq(crawls.id, crawlId))
      );
      if (robotsStatus === 0 || robotsStatus >= 500) {
        await finish("failed", "robots.txt couldn't be fetched, so the crawler stays out (RFC 9309). Check the site is online.");
        return { done: true };
      }
      const sitemapPages = await readSitemaps(robots.sitemaps.length ? robots.sitemaps : [`${site.origin}/sitemap.xml`], site.hostname, fetchFn, FETCH_TIMEOUT_MS);
      if (sitemapPages.length) {
        await t(async (tx) => {
          const room = crawl!.maxPages - 1;
          const rows = sitemapPages.slice(0, Math.max(0, room)).map((url) => ({
            organizationId: org,
            crawlId,
            url,
            urlHash: urlHash(url),
            depth: 1,
            source: "sitemap"
          }));
          if (rows.length) await tx.insert(crawlPages).values(rows).onConflictDoNothing();
          await tx.update(crawls).set({ sitemapUrls: sitemapPages.length }).where(eq(crawls.id, crawlId));
        });
      }
      [crawl] = await t((tx) => tx.select().from(crawls).where(eq(crawls.id, crawlId)));
    }

    const c = crawl!;
    const robots = parseRobots(`${site.origin}/robots.txt`, c.robotsStatus ?? 404, c.robotsTxt ?? "");

    // ── Fetch pages until the time slice runs out ──────────────────────────
    while (Date.now() + c.crawlDelayMs + FETCH_TIMEOUT_MS + 2_000 < deadline) {
      if (!(await heartbeat())) return { cancelled: true };

      const step = await t(async (tx) => {
        const [cur] = await tx.select().from(crawls).where(eq(crawls.id, crawlId));
        if (!cur || cur.status !== "running") return { stop: true as const };
        if (cur.pagesFetched >= cur.maxPages) return { done: "max_pages" as const };
        const [next] = await tx
          .select()
          .from(crawlPages)
          .where(and(eq(crawlPages.crawlId, crawlId), eq(crawlPages.status, "queued")))
          .orderBy(asc(crawlPages.depth), asc(crawlPages.createdAt))
          .limit(1);
        if (!next) return { done: "empty" as const };
        return { next };
      });
      if ("stop" in step) return { done: true };
      if ("done" in step) {
        await finish("completed");
        return { done: true };
      }
      const page = step.next;

      if (!robots.isAllowed(page.url)) {
        await t((tx) => tx.update(crawlPages).set({ status: "skipped", skipReason: "Blocked by robots.txt" }).where(eq(crawlPages.id, page.id)));
        continue;
      }
      const allowed = await t((tx) => consumeUsage(tx, org, "pages_crawled_month", 1));
      if (!allowed) {
        await finish("limit_reached", "This month's page-crawl allowance for your plan is used up.");
        return { done: true };
      }

      const started = Date.now();
      let result: SafeFetchResult | null = null;
      let error: string | null = null;
      let notHtml = false;
      try {
        result = await fetchFn(page.url, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: 2 * 1024 * 1024, contentTypes: HTML_TYPES });
      } catch (e) {
        if (e instanceof SafeFetchError && e.code === "bad_content_type") notHtml = true;
        else error = e instanceof SafeFetchError ? e.message : "Fetch failed";
      }
      const ms = Date.now() - started;

      await t(async (tx) => {
        if (notHtml) {
          await tx.update(crawlPages).set({ status: "skipped", skipReason: "Not an HTML page", durationMs: ms, fetchedAt: new Date() }).where(eq(crawlPages.id, page.id));
        } else if (!result) {
          await tx.update(crawlPages).set({ status: "error", error, durationMs: ms, fetchedAt: new Date() }).where(eq(crawlPages.id, page.id));
        } else {
          const onSite = sameSite(result.url, site.hostname);
          const seo = result.status < 300 && onSite ? compactSeo(extractSeo(result.body, result.url, { headers: result.headers })) : null;
          const parsed = seo ? { title: seo.title, links: seo.internalLinks, nofollow: seo.nofollow } : null;
          await tx
            .update(crawlPages)
            .set({
              status: "fetched",
              httpStatus: result.status,
              finalUrl: result.url !== page.url ? result.url : null,
              contentType: result.contentType.slice(0, 120),
              bytes: Buffer.byteLength(result.body),
              durationMs: ms,
              title: parsed?.title ?? null,
              linksOut: seo ? seo.internalLinks.length + seo.externalLinks.length : null,
              redirects: result.redirects.length ? { urls: result.redirects, statuses: result.redirectStatuses ?? [] } : null,
              seo: seo as unknown as Record<string, unknown> | null,
              fetchedAt: new Date()
            })
            .where(eq(crawlPages.id, page.id));
          if (parsed && !parsed.nofollow && page.depth < c.maxDepth) {
            const [{ n }] = (await tx
              .select({ n: sql<number>`count(*)::int` })
              .from(crawlPages)
              .where(eq(crawlPages.crawlId, crawlId))) as [{ n: number }];
            const room = c.maxPages - n;
            const fresh = parsed.links.filter((u) => sameSite(u, site.hostname) && looksLikeHtml(u)).slice(0, Math.max(0, room));
            if (fresh.length)
              await tx
                .insert(crawlPages)
                .values(fresh.map((url) => ({ organizationId: org, crawlId, url, urlHash: urlHash(url), depth: page.depth + 1, source: "link" })))
                .onConflictDoNothing();
          }
        }
        await tx
          .update(crawls)
          .set({
            pagesFetched: sql`${crawls.pagesFetched} + 1`,
            pagesFound: sql`(select count(*)::int from crawl_pages where crawl_id = ${crawlId})`
          })
          .where(eq(crawls.id, crawlId));
      });
      await sleep(c.crawlDelayMs);
    }
    return { continue: true, progress: { at: new Date().toISOString() } };
  };
}

/** Reads sitemap URLs (following one level of sitemap indexes), same-site pages only. */
async function readSitemaps(
  roots: string[],
  host: string,
  fetchFn: NonNullable<CrawlHandlerOptions["fetch"]>,
  timeoutMs: number
): Promise<string[]> {
  const pages = new Set<string>();
  const queue = roots.filter((u) => normalizeCrawlUrl(u) && sameSite(u, host)).slice(0, SITEMAP_LIMIT.documents);
  let docs = 0;
  while (queue.length && docs < SITEMAP_LIMIT.documents && pages.size < SITEMAP_LIMIT.urls) {
    const url = queue.shift()!;
    docs++;
    try {
      const r = await fetchFn(url, {
        timeoutMs,
        maxBytes: 5 * 1024 * 1024,
        contentTypes: ["application/xml", "text/xml", "text/plain", "application/rss+xml"]
      });
      if (r.status >= 300) continue;
      const parsed = parseSitemap(r.body, url);
      for (const p of parsed.pages) if (sameSite(p, host) && looksLikeHtml(p)) pages.add(p);
      for (const s of parsed.sitemaps) if (sameSite(s, host) && queue.length < SITEMAP_LIMIT.documents) queue.push(s);
    } catch {
      // A missing or broken sitemap isn't fatal: links still get crawled.
    }
  }
  return [...pages].slice(0, SITEMAP_LIMIT.urls);
}

/** If the crawl belongs to an audit, move the audit on: analyse, or stop with the crawl. */
async function onCrawlFinished(tx: Tx, org: string, crawlId: string, status: Crawl["status"], error: string | null) {
  const [a] = await tx.select().from(audits).where(and(eq(audits.crawlId, crawlId), eq(audits.status, "crawling")));
  if (!a) return;
  if (status === "cancelled" || status === "failed") {
    await tx
      .update(audits)
      .set({ status: status === "cancelled" ? "cancelled" : "failed", error, finishedAt: new Date() })
      .where(eq(audits.id, a.id));
    return;
  }
  // completed or limit_reached: analyse what was crawled.
  await tx.update(audits).set({ status: "checking_links" }).where(eq(audits.id, a.id));
  await enqueue(tx, {
    type: AUDIT_ANALYZE_JOB,
    organizationId: org,
    websiteId: a.websiteId,
    payload: { auditId: a.id },
    idempotencyKey: `audit:${a.id}`,
    maxAttempts: 3,
    createdByUserId: a.createdByUserId
  });
}

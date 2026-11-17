import { and, desc, eq, schema, type Db } from "@sge/db";
import type { OnpageAnalysis } from "@sge/db/schema";
import { extractSeo, parseRobots, safeFetch, SafeFetchError, sameSite, type SafeFetchOptions, type SafeFetchResult } from "@sge/crawler";
import { analyzeOnPage, type OnPageResult } from "@sge/seo-rules";
import { assertId, inWorkspace, requireAction, type Actor, type WorkspaceAccess } from "./context";
import { urlOnWebsite } from "./cwv";
import { AppError } from "./errors";
import { consumeUsage } from "./plans";

const { onpageAnalyses, websites, audits, crawlPages } = schema;

export interface OnPageStored extends OnPageResult {
  page: { title: string | null; metaDescription: string | null; h1: string[]; h2: string[]; canonical: string | null; status: number };
}

export interface OnPageDeps {
  fetch: (url: string, opts: SafeFetchOptions) => Promise<SafeFetchResult>;
}
const defaultDeps: OnPageDeps = { fetch: safeFetch };

/**
 * Fetches one page of the website (robots.txt respected), scores it against
 * a target keyword and stores the result. Counts as one crawled page.
 */
export async function analyzePage(
  db: Db,
  actor: Actor,
  access: WorkspaceAccess,
  input: { websiteId: string; url: string; keyword: string },
  deps: OnPageDeps = defaultDeps
): Promise<OnpageAnalysis> {
  assertId(input.websiteId, "Website");
  const keyword = input.keyword.replace(/\s+/g, " ").trim();
  if (keyword.length < 2 || keyword.length > 80) throw new AppError("invalid_input", "Enter a target keyword (2–80 characters)");

  // 1) Authorise, resolve the URL, meter usage, look up inlinks from the latest audit.
  const { url, inlinks } = await inWorkspace(db, actor, access, async (tx, { role }) => {
    requireAction(role, "work.run");
    const [w] = await tx.select().from(websites).where(eq(websites.id, input.websiteId));
    if (!w) throw new AppError("not_found", "Website not found");
    const url = urlOnWebsite(input.url, w);
    if (!(await consumeUsage(tx, access.workspace.id, "pages_crawled_month", 1)))
      throw new AppError("limit_reached", "This month's page allowance for your plan is used up.");
    const [latest] = await tx
      .select({ crawlId: audits.crawlId })
      .from(audits)
      .where(and(eq(audits.websiteId, w.id), eq(audits.status, "completed")))
      .orderBy(desc(audits.createdAt))
      .limit(1);
    let inlinks: number | null = null;
    if (latest) {
      const [p] = await tx
        .select({ inlinks: crawlPages.inlinks })
        .from(crawlPages)
        .where(and(eq(crawlPages.crawlId, latest.crawlId), eq(crawlPages.url, url)));
      inlinks = p ? (p.inlinks ?? 0) : 0;
    }
    return { url, inlinks };
  });

  // 2) Network, outside any transaction.
  const origin = new URL(url).origin;
  let robotsStatus = 0;
  let robotsBody = "";
  try {
    const r = await deps.fetch(`${origin}/robots.txt`, { timeoutMs: 10_000, maxBytes: 512 * 1024, contentTypes: ["text/plain", "text/html", "application/octet-stream"] });
    robotsStatus = r.status;
    robotsBody = r.status < 300 ? r.body : "";
  } catch (e) {
    robotsStatus = e instanceof SafeFetchError && e.code === "bad_content_type" ? 404 : 0;
  }
  if (!parseRobots(`${origin}/robots.txt`, robotsStatus, robotsBody).isAllowed(url))
    throw new AppError("invalid_input", robotsStatus === 0 || robotsStatus >= 500 ? "The site's robots.txt couldn't be read, so the page wasn't fetched." : "robots.txt blocks this page for crawlers.");

  let res: SafeFetchResult;
  try {
    res = await deps.fetch(url, { timeoutMs: 15_000, maxBytes: 3 * 1024 * 1024, contentTypes: ["text/html", "application/xhtml+xml"] });
  } catch (e) {
    throw new AppError("invalid_input", e instanceof SafeFetchError ? `Couldn't fetch the page: ${e.message}` : "Couldn't fetch the page.");
  }
  if (res.status >= 400) throw new AppError("invalid_input", `The page returned HTTP ${res.status}.`);
  if (!sameSite(res.url, new URL(url).hostname)) throw new AppError("invalid_input", `The page redirected to another site (${new URL(res.url).hostname}).`);

  const seo = extractSeo(res.body, res.url, { headers: res.headers });
  const result = analyzeOnPage(seo, url, keyword, { inlinks, finalUrl: res.url });
  const stored: OnPageStored = {
    ...result,
    page: { title: seo.title, metaDescription: seo.metaDescription, h1: seo.h1, h2: seo.h2.slice(0, 20), canonical: seo.canonical, status: res.status }
  };

  // 3) Store.
  return inWorkspace(db, actor, access, async (tx) => {
    const [row] = await tx
      .insert(onpageAnalyses)
      .values({
        organizationId: access.workspace.id,
        websiteId: input.websiteId,
        url,
        finalUrl: res.url !== url ? res.url : null,
        keyword,
        score: result.score,
        result: stored as unknown as Record<string, unknown>,
        createdByUserId: actor.userId
      })
      .returning();
    return row!;
  });
}

export async function listOnpage(db: Db, actor: Actor, access: WorkspaceAccess, websiteId: string, limit = 20): Promise<OnpageAnalysis[]> {
  assertId(websiteId, "Website");
  return inWorkspace(db, actor, access, (tx) =>
    tx.select().from(onpageAnalyses).where(eq(onpageAnalyses.websiteId, websiteId)).orderBy(desc(onpageAnalyses.createdAt)).limit(Math.min(limit, 100))
  );
}

export async function getOnpage(db: Db, actor: Actor, access: WorkspaceAccess, analysisId: string): Promise<OnpageAnalysis & { result: OnPageStored }> {
  assertId(analysisId, "Analysis");
  return inWorkspace(db, actor, access, async (tx) => {
    const [row] = await tx.select().from(onpageAnalyses).where(eq(onpageAnalyses.id, analysisId));
    if (!row) throw new AppError("not_found", "Analysis not found");
    return row as OnpageAnalysis & { result: OnPageStored };
  });
}

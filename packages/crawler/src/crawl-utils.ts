import { createHash } from "node:crypto";
import { load } from "cheerio";
import robotsParser from "robots-parser";

/** Product token matched against robots.txt User-agent lines. */
export const ROBOTS_TOKEN = "SEOGrowthEngineBot";

/* ───────────────────────────── URL handling ─────────────────────────────── */

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|ref_src)$/i;
const NON_HTML = /\.(?:pdf|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|mp[34]|m4a|mov|avi|webm|wav|ogg|zip|rar|7z|gz|tgz|tar|exe|dmg|msi|apk|docx?|xlsx?|pptx?|csv|css|js|mjs|json|xml|rss|atom|woff2?|ttf|eot)$/i;

/** Canonical form for de-duplication: no fragment, no tracking params, default port dropped. */
export function normalizeCrawlUrl(href: string, base?: string): string | null {
  let u: URL;
  try {
    u = base ? new URL(href, base) : new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) u.port = "";
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  const out = u.toString();
  return out.length > 2048 ? null : out;
}

export const urlHash = (url: string) => createHash("sha256").update(url).digest("hex").slice(0, 32);

/** Same site = same host, or the www/non-www twin. */
export function sameSite(url: string, siteHost: string): boolean {
  const h = new URL(url).hostname.toLowerCase();
  const bare = (x: string) => x.replace(/^www\./, "");
  return bare(h) === bare(siteHost.toLowerCase());
}

export const looksLikeHtml = (url: string) => !NON_HTML.test(new URL(url).pathname);

/* ─────────────────────────────── HTML ───────────────────────────────────── */

export interface PageLinks {
  title: string | null;
  links: string[];
  /** <meta name="robots" content="nofollow"> */
  nofollow: boolean;
  noindex: boolean;
}

export function extractPage(html: string, pageUrl: string): PageLinks {
  const $ = load(html);
  const baseHref = $("base[href]").first().attr("href");
  const base = baseHref ? (normalizeCrawlUrl(baseHref, pageUrl) ?? pageUrl) : pageUrl;
  const robots = ($('meta[name="robots" i]').attr("content") ?? "").toLowerCase();
  const links = new Set<string>();
  $("a[href]").each((_, el) => {
    const rel = ($(el).attr("rel") ?? "").toLowerCase();
    if (rel.split(/\s+/).includes("nofollow")) return;
    const u = normalizeCrawlUrl($(el).attr("href")!, base);
    if (u) links.add(u);
  });
  const title = $("title").first().text().replace(/\s+/g, " ").trim();
  return {
    title: title ? title.slice(0, 300) : null,
    links: [...links],
    nofollow: /\b(nofollow|none)\b/.test(robots),
    noindex: /\b(noindex|none)\b/.test(robots)
  };
}

/* ─────────────────────────────── robots.txt ─────────────────────────────── */

export interface RobotsRules {
  isAllowed(url: string): boolean;
  crawlDelayMs: number | null;
  sitemaps: string[];
}

/**
 * RFC 9309: 4xx (no robots.txt) → everything allowed; 5xx or unreachable →
 * assume everything disallowed. Pass status 0 for "unreachable".
 */
export function parseRobots(robotsUrl: string, status: number, body: string): RobotsRules {
  if (status >= 400 && status < 500) return { isAllowed: () => true, crawlDelayMs: null, sitemaps: [] };
  if (status === 0 || status >= 500) return { isAllowed: () => false, crawlDelayMs: null, sitemaps: [] };
  const r = robotsParser(robotsUrl, body.slice(0, 500 * 1024));
  const delay = r.getCrawlDelay(ROBOTS_TOKEN);
  return {
    isAllowed: (url) => r.isAllowed(url, ROBOTS_TOKEN) !== false,
    crawlDelayMs: typeof delay === "number" && delay > 0 ? Math.min(delay, 60) * 1000 : null,
    sitemaps: r.getSitemaps()
  };
}

/* ─────────────────────────────── Sitemaps ───────────────────────────────── */

export interface ParsedSitemap {
  pages: string[];
  sitemaps: string[];
}

/** Parses <urlset> and <sitemapindex> documents (namespace-agnostic). */
export function parseSitemap(xml: string, sitemapUrl: string): ParsedSitemap {
  const $ = load(xml, { xml: true });
  const locs = (sel: string) =>
    $(sel)
      .toArray()
      .map((el) => normalizeCrawlUrl($(el).text().trim(), sitemapUrl))
      .filter((u): u is string => u !== null);
  return { pages: locs("urlset > url > loc"), sitemaps: locs("sitemapindex > sitemap > loc") };
}

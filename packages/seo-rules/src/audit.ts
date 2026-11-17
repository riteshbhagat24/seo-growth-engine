import type { PageSeo } from "@sge/crawler";
import { RULES, SEVERITY_RANK, type Severity } from "./rules";

/** One crawled URL, as stored by the crawler. */
export interface AuditPage {
  url: string;
  /** "start" | "link" | "sitemap" */
  source: string;
  status: "queued" | "fetched" | "error" | "skipped";
  httpStatus: number | null;
  finalUrl: string | null;
  redirects: string[];
  redirectStatuses: number[];
  error: string | null;
  skipReason: string | null;
  bytes: number | null;
  durationMs: number | null;
  /** Null when the page wasn't parsed (non-200, off-site redirect, not HTML). */
  seo: PageSeo | null;
}

export interface ExternalCheck {
  url: string;
  outcome: "ok" | "broken" | "unverifiable";
  httpStatus: number | null;
}

export interface AuditInput {
  startUrl: string;
  robotsStatus: number | null;
  /** URLs listed in the sitemap(s) found by the crawler. */
  sitemapUrlCount: number;
  /** True when the crawl stopped at its page limit with URLs still queued. */
  hitPageLimit: boolean;
  pages: AuditPage[];
  externalChecks?: ExternalCheck[];
}

export interface Issue {
  rule: string;
  severity: Severity;
  url: string | null;
  details?: Record<string, unknown>;
}

export interface AuditResult {
  issues: Issue[];
  /** 0–100, or null when nothing could be analysed. */
  healthScore: number | null;
  stats: {
    pagesAnalyzed: number;
    pagesHealthy: number;
    critical: number;
    warning: number;
    notice: number;
    /** Click depth from the start page, by URL (unreachable pages omitted). */
    maxDepth: number;
  };
  /** Per-URL inlink counts and click depth, for display and the on-page analyser. */
  linkGraph: Record<string, { inlinks: number; depth: number | null }>;
}

export const THRESHOLDS = {
  titleMax: 60,
  titleMin: 30,
  descriptionMax: 160,
  descriptionMin: 70,
  lowWords: 200,
  slowMs: 3_000,
  largeBytes: 1_000_000,
  urlMaxLength: 115,
  deepClicks: 4,
  examples: 10
} as const;

const HREFLANG = /^(x-default|[a-z]{2,3}(-[a-z]{4})?(-([a-z]{2}|\d{3}))?)$/i;
/** Common region mistakes: UK (→ GB), and language-only codes used as regions. */
const BAD_REGION = /-(uk|eu)$/i;

export function validHreflang(code: string): boolean {
  return HREFLANG.test(code) && !BAD_REGION.test(code);
}

/** Runs every rule over a crawl. Pure: same input, same output. */
export function runAudit(input: AuditInput): AuditResult {
  const issues: Issue[] = [];
  const add = (rule: string, url: string | null, details?: Record<string, unknown>) => {
    const def = RULES[rule];
    if (!def) throw new Error(`Unknown audit rule: ${rule}`);
    issues.push({ rule, severity: def.severity, url, ...(details ? { details } : {}) });
  };

  const byUrl = new Map(input.pages.map((p) => [p.url, p]));
  const fetched = input.pages.filter((p) => p.status === "fetched" || p.status === "error");
  const ok = (p: AuditPage) => p.status === "fetched" && p.httpStatus !== null && p.httpStatus < 300;
  const broken = (p: AuditPage) => p.status === "error" || (p.httpStatus !== null && p.httpStatus >= 400);
  const redirected = (p: AuditPage) => p.redirects.length > 0;
  /** The URL a crawled page ends up at. */
  const landing = (p: AuditPage) => p.finalUrl ?? p.url;
  // HTML pages, one per landing URL: a redirect's content is its destination's,
  // analysed under the destination (or the first URL that reached it).
  const seen = new Set<string>();
  const html = fetched.filter((p) => {
    if (!ok(p) || p.seo === null) return false;
    if (redirected(p) && p.finalUrl && byUrl.has(p.finalUrl)) return false;
    if (seen.has(landing(p))) return false;
    seen.add(landing(p));
    return true;
  }) as (AuditPage & { seo: PageSeo })[];
  const canonicalOf = (p: AuditPage & { seo: PageSeo }) => p.seo.canonical;
  const selfCanonical = (p: AuditPage & { seo: PageSeo }) => !p.seo.canonical || p.seo.canonical === landing(p) || p.seo.canonical === p.url;
  const indexable = html.filter((p) => !p.seo.noindex && selfCanonical(p));

  // ── Link graph: inlinks and click depth (BFS from the start page) ─────────
  const inlinkSources = new Map<string, Set<string>>();
  const outlinks = new Map<string, string[]>();
  for (const p of html) {
    const from = landing(p);
    outlinks.set(from, p.seo.internalLinks);
    for (const to of p.seo.internalLinks) {
      if (to === from) continue;
      let s = inlinkSources.get(to);
      if (!s) inlinkSources.set(to, (s = new Set()));
      s.add(from);
    }
  }
  // A redirecting URL's inlinks also count for its destination.
  for (const p of input.pages) {
    if (!redirected(p) || !p.finalUrl) continue;
    const src = inlinkSources.get(p.url);
    if (!src) continue;
    let dest = inlinkSources.get(p.finalUrl);
    if (!dest) inlinkSources.set(p.finalUrl, (dest = new Set()));
    for (const s of src) dest.add(s);
  }
  const depth = new Map<string, number>();
  const start = byUrl.get(input.startUrl);
  if (start) {
    const queue: string[] = [landing(start)];
    depth.set(landing(start), 0);
    depth.set(start.url, 0);
    while (queue.length) {
      const cur = queue.shift()!;
      const d = depth.get(cur)!;
      for (const next of outlinks.get(cur) ?? []) {
        const target = byUrl.get(next);
        const resolved = target ? landing(target) : next;
        for (const u of [next, resolved])
          if (!depth.has(u)) {
            depth.set(u, d + 1);
            if (u === resolved) queue.push(u);
          }
      }
    }
  }
  const linkGraph: AuditResult["linkGraph"] = {};
  for (const p of input.pages) {
    const key = landing(p);
    linkGraph[p.url] = { inlinks: inlinkSources.get(key)?.size ?? inlinkSources.get(p.url)?.size ?? 0, depth: depth.get(key) ?? depth.get(p.url) ?? null };
  }

  // ── Site-level rules ───────────────────────────────────────────────────────
  if (input.robotsStatus !== null && input.robotsStatus >= 400 && input.robotsStatus < 500) add("robots_txt_missing", null);
  if (start?.status === "skipped" && /robots/i.test(start.skipReason ?? "")) add("robots_blocks_homepage", null);
  const home = start ? landing(start) : input.startUrl;
  if (new URL(home).protocol === "http:") add("no_https", null, { url: home });
  if (input.sitemapUrlCount === 0) add("sitemap_missing", null);
  if (input.hitPageLimit) add("crawl_limit_reached", null, { pages: input.pages.length });

  // ── Status codes and redirects ─────────────────────────────────────────────
  const examples = <T>(xs: T[]) => xs.slice(0, THRESHOLDS.examples);
  const linkedFrom = (url: string) => examples([...(inlinkSources.get(url) ?? [])]);

  for (const p of input.pages) {
    if (p.status === "skipped" && /robots/i.test(p.skipReason ?? "") && p !== start) add("blocked_by_robots", p.url);
    if (p.status === "error") add("fetch_failed", p.url, { error: p.error, linkedFrom: linkedFrom(p.url) });
    if (p.status !== "fetched" || p.httpStatus === null) continue;
    if (p.httpStatus >= 500) add("http_5xx", p.url, { status: p.httpStatus, linkedFrom: linkedFrom(p.url) });
    else if (p.httpStatus >= 400) add("http_4xx", p.url, { status: p.httpStatus, linkedFrom: linkedFrom(p.url) });
    if (p.redirects.length >= 2) add("redirect_chain", p.url, { chain: [p.url, ...p.redirects], hops: p.redirects.length });
    if (p.redirectStatuses.some((s) => s === 302 || s === 307)) add("temporary_redirect", p.url, { to: p.finalUrl, statuses: p.redirectStatuses });
    if (p.source === "sitemap" && (redirected(p) || p.httpStatus >= 400))
      add("sitemap_bad_url", p.url, { status: p.httpStatus, redirectsTo: p.finalUrl });
  }

  // ── Links ──────────────────────────────────────────────────────────────────
  const external = new Map((input.externalChecks ?? []).map((c) => [c.url, c]));
  for (const p of html) {
    const brokenTargets: string[] = [];
    const redirectTargets: string[] = [];
    for (const to of p.seo.internalLinks) {
      const t = byUrl.get(to);
      if (!t) continue;
      if (broken(t)) brokenTargets.push(to);
      else if (t.status === "fetched" && redirected(t)) redirectTargets.push(to);
    }
    if (brokenTargets.length) add("broken_internal_link", p.url, { count: brokenTargets.length, targets: examples(brokenTargets) });
    if (redirectTargets.length) add("internal_link_to_redirect", p.url, { count: redirectTargets.length, targets: examples(redirectTargets) });
    const badExternal = p.seo.externalLinks.filter((u) => external.get(u)?.outcome === "broken");
    if (badExternal.length)
      add("broken_external_link", p.url, {
        count: badExternal.length,
        targets: examples(badExternal.map((u) => ({ url: u, status: external.get(u)?.httpStatus ?? null })))
      });
    if (p.seo.nofollowInternal > 0) add("nofollow_internal_links", p.url, { count: p.seo.nofollowInternal });
    if (new URL(landing(p)).protocol === "https:") {
      const insecure = p.seo.internalLinks.filter((u) => u.startsWith("http://"));
      if (insecure.length) add("internal_http_links", p.url, { count: insecure.length, targets: examples(insecure) });
    }
  }
  for (const p of indexable) {
    if (p === start) continue;
    const info = linkGraph[p.url]!;
    if (p.source === "sitemap" && info.inlinks === 0) add("orphan_page", p.url);
    else if (info.depth !== null && info.depth >= THRESHOLDS.deepClicks) add("deep_page", p.url, { clicks: info.depth });
  }

  // ── Per-page HTML checks ───────────────────────────────────────────────────
  for (const p of html) {
    const s = p.seo;
    const url = p.url;
    if (s.noindex) add("noindex_page", url);
    if (s.nofollow) add("nofollow_page", url);
    if (s.noindex && p.source === "sitemap") add("noindex_in_sitemap", url);
    if (s.metaRefresh) add("meta_refresh", url);

    if (s.canonicalCount > 1) add("multiple_canonicals", url, { count: s.canonicalCount });
    if (!s.canonical) add("canonical_missing", url);
    else if (!selfCanonical(p)) {
      add("canonical_points_elsewhere", url, { canonical: s.canonical });
      const target = byUrl.get(s.canonical);
      if (target && (broken(target) || redirected(target)))
        add("canonical_to_bad_url", url, { canonical: s.canonical, status: target.httpStatus, redirectsTo: target.finalUrl });
    }

    if (!s.noindex) {
      if (!s.title) add("missing_title", url);
      else if (s.title.length > THRESHOLDS.titleMax) add("title_too_long", url, { length: s.title.length, title: s.title });
      else if (s.title.length < THRESHOLDS.titleMin) add("title_too_short", url, { length: s.title.length, title: s.title });
      if (s.titleCount > 1) add("multiple_titles", url, { count: s.titleCount });
      if (!s.metaDescription) add("missing_meta_description", url);
      else if (s.metaDescription.length > THRESHOLDS.descriptionMax)
        add("meta_description_too_long", url, { length: s.metaDescription.length });
      else if (s.metaDescription.length < THRESHOLDS.descriptionMin)
        add("meta_description_too_short", url, { length: s.metaDescription.length });
      if (s.descriptionCount > 1) add("multiple_meta_descriptions", url, { count: s.descriptionCount });
      if (s.h1.length === 0) add("missing_h1", url);
      else if (s.h1.length > 1) add("multiple_h1", url, { count: s.h1.length, headings: examples(s.h1) });
      if (s.wordCount < THRESHOLDS.lowWords) add("low_word_count", url, { words: s.wordCount });
      if (!s.jsonLd.blocks && !s.microdata) add("no_structured_data", url);
      if (!s.og.title || !s.og.image) add("missing_open_graph", url, { missing: [!s.og.title && "og:title", !s.og.image && "og:image"].filter(Boolean) });
    }
    if (s.images.missingAlt > 0) add("images_missing_alt", url, { count: s.images.missingAlt, total: s.images.total, examples: s.images.missingAltSrcs });
    if (s.mixedContent.length) add("mixed_content", url, { count: s.mixedContent.length, resources: examples(s.mixedContent) });
    if (!s.viewport) add("missing_viewport", url);
    if (!s.lang) add("missing_lang", url);
    if (s.jsonLd.invalid > 0) add("invalid_json_ld", url, { invalid: s.jsonLd.invalid, blocks: s.jsonLd.blocks });

    const bad = s.hreflang.filter((h) => !validHreflang(h.lang)).map((h) => h.lang);
    if (bad.length) add("hreflang_invalid", url, { codes: examples([...new Set(bad)]) });
    const missingReturn = s.hreflang
      .filter((h) => validHreflang(h.lang) && h.href !== url && h.href !== landing(p))
      .filter((h) => {
        const alt = byUrl.get(h.href);
        if (!alt || !ok(alt) || !alt.seo) return false; // can't tell
        return !alt.seo.hreflang.some((back) => back.href === url || back.href === landing(p));
      })
      .map((h) => h.href);
    if (missingReturn.length) add("hreflang_no_return", url, { alternates: examples(missingReturn) });
  }

  // Performance + URL hygiene (every fetched page)
  for (const p of fetched) {
    if (p.durationMs !== null && p.durationMs > THRESHOLDS.slowMs) add("slow_response", p.url, { ms: p.durationMs });
    if (p.bytes !== null && p.bytes > THRESHOLDS.largeBytes) add("page_too_large", p.url, { bytes: p.bytes });
    const u = new URL(p.url);
    if (p.url.length > THRESHOLDS.urlMaxLength) add("url_too_long", p.url, { length: p.url.length });
    if (/[A-Z]/.test(u.pathname)) add("url_uppercase", p.url);
    if (u.pathname.includes("_")) add("url_underscores", p.url);
  }

  // ── Duplicates across indexable pages ──────────────────────────────────────
  const dupes = (key: (p: AuditPage & { seo: PageSeo }) => string | null, rule: string) => {
    const groups = new Map<string, string[]>();
    for (const p of indexable) {
      const k = key(p);
      if (!k) continue;
      const g = groups.get(k);
      if (g) g.push(p.url);
      else groups.set(k, [p.url]);
    }
    for (const urls of groups.values())
      if (urls.length > 1) for (const u of urls) add(rule, u, { count: urls.length, others: examples(urls.filter((x) => x !== u)) });
  };
  dupes((p) => p.seo.title?.toLowerCase() ?? null, "duplicate_title");
  dupes((p) => p.seo.metaDescription?.toLowerCase() ?? null, "duplicate_meta_description");
  dupes((p) => p.seo.contentHash, "duplicate_content");

  // ── Health score ───────────────────────────────────────────────────────────
  const worst = new Map<string, Severity>();
  for (const i of issues) {
    if (!i.url) continue;
    const prev = worst.get(i.url);
    if (!prev || SEVERITY_RANK[i.severity] < SEVERITY_RANK[prev]) worst.set(i.url, i.severity);
  }
  const analysed = fetched;
  let healthy = 0;
  let weight = 0;
  for (const p of analysed) {
    const w = worst.get(p.url);
    if (!w || w === "notice") {
      weight += 1;
      healthy++;
    } else if (w === "warning") weight += 0.5;
  }
  const siteIssues = issues.filter((i) => !i.url);
  const sitePenalty = siteIssues.reduce((n, i) => n + (i.severity === "critical" ? 10 : i.severity === "warning" ? 3 : 0), 0);
  const healthScore = analysed.length ? Math.max(0, Math.round((100 * weight) / analysed.length - sitePenalty)) : null;

  const count = (s: Severity) => issues.filter((i) => i.severity === s).length;
  return {
    issues,
    healthScore,
    stats: {
      pagesAnalyzed: analysed.length,
      pagesHealthy: healthy,
      critical: count("critical"),
      warning: count("warning"),
      notice: count("notice"),
      maxDepth: Math.max(0, ...depth.values())
    },
    linkGraph
  };
}

/** Issue-level comparison between two audits of the same website. */
export interface RuleDiff {
  rule: string;
  before: number;
  after: number;
  added: number;
  fixed: number;
}

export function compareIssues(before: Pick<Issue, "rule" | "url">[], after: Pick<Issue, "rule" | "url">[]): RuleDiff[] {
  const key = (i: Pick<Issue, "rule" | "url">) => `${i.rule}\u0000${i.url ?? ""}`;
  const a = new Set(before.map(key));
  const b = new Set(after.map(key));
  const rules = new Set([...before, ...after].map((i) => i.rule));
  return [...rules]
    .map((rule) => {
      const inA = [...a].filter((k) => k.startsWith(`${rule}\u0000`));
      const inB = [...b].filter((k) => k.startsWith(`${rule}\u0000`));
      return {
        rule,
        before: inA.length,
        after: inB.length,
        added: inB.filter((k) => !a.has(k)).length,
        fixed: inA.filter((k) => !b.has(k)).length
      };
    })
    .sort((x, y) => SEVERITY_RANK[RULES[x.rule]?.severity ?? "notice"] - SEVERITY_RANK[RULES[y.rule]?.severity ?? "notice"] || y.after - x.after);
}

import { createHash } from "node:crypto";
import { load } from "cheerio";
import { normalizeCrawlUrl, sameSite } from "./crawl-utils";

/** Everything the audit rules and on-page analyser read from one HTML page. */
export interface PageSeo {
  title: string | null;
  titleCount: number;
  metaDescription: string | null;
  descriptionCount: number;
  h1: string[];
  h2: string[];
  h3Count: number;
  canonical: string | null;
  canonicalCount: number;
  noindex: boolean;
  nofollow: boolean;
  lang: string | null;
  viewport: boolean;
  metaRefresh: boolean;
  hreflang: { lang: string; href: string }[];
  jsonLd: { blocks: number; invalid: number; types: string[] };
  microdata: boolean;
  og: { title: boolean; description: boolean; image: boolean };
  images: { total: number; missingAlt: number; missingAltSrcs: string[]; alts: string[] };
  /** Followed same-site links (normalised, unique). */
  internalLinks: string[];
  nofollowInternal: number;
  /** Followed off-site links (normalised, unique). */
  externalLinks: string[];
  /** http:// sub-resources on an https page. */
  mixedContent: string[];
  wordCount: number;
  /** Hash of the visible text, for duplicate-content detection. */
  contentHash: string | null;
}

/** PageSeo plus the visible text, for the on-page analyser (not stored per crawled page). */
export interface PageSeoFull extends PageSeo {
  text: string;
  firstWords: string;
}

const LIMITS = { internal: 500, external: 150, mixed: 20, missingAlt: 20, alts: 200, hreflang: 100, headings: 50 };
const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const words = (s: string) => s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];

export function extractSeo(html: string, pageUrl: string, opts: { headers?: Record<string, string> } = {}): PageSeoFull {
  const $ = load(html);
  const page = new URL(pageUrl);
  const baseHref = $("base[href]").first().attr("href");
  const base = baseHref ? (normalizeCrawlUrl(baseHref, pageUrl) ?? pageUrl) : pageUrl;

  const metaByName = (name: string) =>
    $("meta")
      .toArray()
      .filter((el) => ($(el).attr("name") ?? "").toLowerCase() === name)
      .map((el) => clean($(el).attr("content") ?? ""));
  const metaByProperty = (p: string) =>
    $("meta")
      .toArray()
      .some((el) => ($(el).attr("property") ?? "").toLowerCase() === p && clean($(el).attr("content") ?? "") !== "");

  const titles = $("head title, title").toArray();
  const title = titles.length ? clean($(titles[0]).text()).slice(0, 500) : "";
  const descriptions = metaByName("description");
  const robots = [...metaByName("robots"), ...metaByName("googlebot"), opts.headers?.["x-robots-tag"] ?? ""]
    .join(",")
    .toLowerCase();

  const canonicals = $('link[rel~="canonical" i]').toArray();
  const canonicalHref = canonicals.length ? $(canonicals[0]).attr("href") : undefined;

  // Links
  const internal = new Set<string>();
  const external = new Set<string>();
  let nofollowInternal = 0;
  $("a[href]").each((_, el) => {
    const u = normalizeCrawlUrl($(el).attr("href")!, base);
    if (!u) return;
    const nofollow = ($(el).attr("rel") ?? "").toLowerCase().split(/\s+/).includes("nofollow");
    if (sameSite(u, page.hostname)) {
      if (nofollow) nofollowInternal++;
      else if (internal.size < LIMITS.internal) internal.add(u);
    } else if (!nofollow && external.size < LIMITS.external) external.add(u);
  });

  // Images
  const imgs = $("img").toArray();
  const missingAltSrcs: string[] = [];
  const alts: string[] = [];
  let missingAlt = 0;
  for (const el of imgs) {
    const alt = $(el).attr("alt");
    if (alt === undefined) {
      missingAlt++;
      const src = $(el).attr("src") ?? $(el).attr("data-src");
      const abs = src ? normalizeCrawlUrl(src, base) : null;
      if (abs && missingAltSrcs.length < LIMITS.missingAlt) missingAltSrcs.push(abs);
    } else if (alts.length < LIMITS.alts) alts.push(clean(alt));
  }

  // Mixed content (only meaningful on https pages)
  const mixed = new Set<string>();
  if (page.protocol === "https:") {
    $("img[src], script[src], iframe[src], source[src], video[src], audio[src], embed[src], link[href][rel~='stylesheet' i]").each((_, el) => {
      const raw = $(el).attr("src") ?? $(el).attr("href") ?? "";
      if (/^http:\/\//i.test(raw.trim()) && mixed.size < LIMITS.mixed) mixed.add(raw.trim().slice(0, 500));
    });
  }

  // Structured data
  const types = new Set<string>();
  let invalid = 0;
  const ld = $('script[type="application/ld+json" i]').toArray();
  const collectTypes = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(collectTypes);
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    const t = o["@type"];
    for (const v of Array.isArray(t) ? t : [t]) if (typeof v === "string" && types.size < 30) types.add(v);
    if (o["@graph"]) collectTypes(o["@graph"]);
  };
  for (const el of ld) {
    try {
      const parsed: unknown = JSON.parse($(el).text());
      if (parsed && typeof parsed === "object") collectTypes(parsed);
      else invalid++;
    } catch {
      invalid++;
    }
  }

  const hreflang = $('link[rel~="alternate" i][hreflang]')
    .toArray()
    .slice(0, LIMITS.hreflang)
    .map((el) => ({ lang: clean($(el).attr("hreflang") ?? ""), href: normalizeCrawlUrl($(el).attr("href") ?? "", base) ?? ($(el).attr("href") ?? "") }));

  // Visible text
  const text = visibleText(html);
  const w = words(text);

  return {
    title: title || null,
    titleCount: titles.length,
    metaDescription: descriptions[0] || null,
    descriptionCount: descriptions.length,
    h1: $("h1").toArray().slice(0, LIMITS.headings).map((el) => clean($(el).text()).slice(0, 300)),
    h2: $("h2").toArray().slice(0, LIMITS.headings).map((el) => clean($(el).text()).slice(0, 300)),
    h3Count: $("h3").length,
    canonical: canonicalHref ? normalizeCrawlUrl(canonicalHref, base) : null,
    canonicalCount: canonicals.length,
    noindex: /\b(noindex|none)\b/.test(robots),
    nofollow: /\b(nofollow|none)\b/.test(robots),
    lang: clean($("html").attr("lang") ?? "") || null,
    viewport: metaByName("viewport").some((v) => v !== ""),
    metaRefresh: $("meta[http-equiv]").toArray().some((el) => ($(el).attr("http-equiv") ?? "").toLowerCase() === "refresh"),
    hreflang,
    jsonLd: { blocks: ld.length, invalid, types: [...types] },
    microdata: $("[itemscope]").length > 0,
    og: { title: metaByProperty("og:title"), description: metaByProperty("og:description"), image: metaByProperty("og:image") },
    images: { total: imgs.length, missingAlt, missingAltSrcs, alts },
    internalLinks: [...internal],
    nofollowInternal,
    externalLinks: [...external],
    mixedContent: [...mixed],
    wordCount: w.length,
    contentHash: w.length >= 20 ? createHash("sha256").update(w.join(" ").toLowerCase()).digest("hex").slice(0, 32) : null,
    text: text.slice(0, 200_000),
    firstWords: w.slice(0, 100).join(" ")
  };
}

function visibleText(html: string): string {
  // Separate parse: this mutates the tree.
  const $ = load(html);
  $("head, script, style, noscript, template, svg, iframe").remove();
  // Keep block boundaries as spaces so words don't run together.
  $("p, div, li, h1, h2, h3, h4, h5, h6, br, td, th, section, article").append(" ");
  return clean($("body").length ? $("body").text() : $.root().text());
}

/** Stored per crawled page: PageSeo without the bulky text fields. */
export function compactSeo(full: PageSeoFull): PageSeo {
  const { text: _text, firstWords: _first, ...rest } = full;
  return rest;
}

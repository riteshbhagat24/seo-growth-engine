import type { PageSeoFull } from "@sge/crawler";

export type CheckStatus = "pass" | "warn" | "fail" | "info";

export interface OnPageCheck {
  id: string;
  group: "Keyword" | "Content" | "Meta" | "Links" | "Technical";
  label: string;
  status: CheckStatus;
  /** Contribution to the score; "info" checks don't count. */
  weight: number;
  message: string;
}

export interface OnPageResult {
  score: number;
  checks: OnPageCheck[];
  stats: {
    wordCount: number;
    keywordCount: number;
    densityPct: number;
    readability: number | null;
    readabilityLabel: string | null;
    internalLinks: number;
    externalLinks: number;
    images: number;
    inlinks: number | null;
  };
  serp: { title: string; titleTruncated: boolean; description: string; descriptionTruncated: boolean; breadcrumb: string };
}

const SERP = { title: 60, description: 158 };

/** Lower-cases, strips accents and splits into word tokens. */
export function tokens(s: string): string[] {
  return (
    s
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/** Non-overlapping occurrences of the keyword phrase in a token stream. */
export function countPhrase(hay: string[], needle: string[]): number {
  if (!needle.length || hay.length < needle.length) return 0;
  let n = 0;
  for (let i = 0; i <= hay.length - needle.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++)
      if (hay[i + j] !== needle[j]) {
        match = false;
        break;
      }
    if (match) {
      n++;
      i += needle.length - 1;
    }
  }
  return n;
}

const contains = (text: string | null | undefined, kw: string[]) => (text ? countPhrase(tokens(text), kw) > 0 : false);

/** English syllable estimate (vowel groups, minus silent e). */
export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "").match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups?.length ?? 1);
}

/** Flesch Reading Ease (English). Higher = easier; 60–70 is plain English. */
export function fleschReadingEase(text: string): number | null {
  const sentences = text.split(/[.!?]+(?:\s|$)/).filter((s) => /[a-z]/i.test(s)).length;
  const ws = text.match(/[A-Za-z][A-Za-z'’-]*/g) ?? [];
  if (ws.length < 30 || sentences === 0) return null;
  const syl = ws.reduce((n, w) => n + syllables(w), 0);
  const score = 206.835 - 1.015 * (ws.length / sentences) - 84.6 * (syl / ws.length);
  return Math.round(Math.max(0, Math.min(100, score)));
}

export function readabilityLabel(score: number): string {
  if (score >= 80) return "Very easy";
  if (score >= 60) return "Plain English";
  if (score >= 50) return "Fairly difficult";
  if (score >= 30) return "Difficult";
  return "Very difficult";
}

function truncate(s: string, max: number) {
  if (s.length <= max) return { text: s, truncated: false };
  const cut = s.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return { text: `${(at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd()} …`, truncated: true };
}

/**
 * Scores one page against a target keyword. Pure and local: no external API.
 * `inlinks` comes from the website's latest audit (null if unknown).
 */
export function analyzeOnPage(seo: PageSeoFull, pageUrl: string, keyword: string, opts: { inlinks?: number | null; finalUrl?: string } = {}): OnPageResult {
  const kw = tokens(keyword);
  const url = new URL(opts.finalUrl ?? pageUrl);
  const body = tokens(seo.text);
  const kwCount = countPhrase(body, kw);
  const density = body.length ? Math.round(((kwCount * kw.length) / body.length) * 1000) / 10 : 0;
  const english = !seo.lang || /^en\b/i.test(seo.lang);
  const readability = english ? fleschReadingEase(seo.text) : null;
  const slug = tokens(decodeURIComponent(url.pathname).replace(/[-_/]+/g, " "));
  const checks: OnPageCheck[] = [];
  const add = (c: OnPageCheck) => checks.push(c);
  const titleLen = seo.title?.length ?? 0;
  const descLen = seo.metaDescription?.length ?? 0;

  // ── Keyword placement ─────────────────────────────────────────────────────
  const titleHas = contains(seo.title, kw);
  add({
    id: "title_keyword", group: "Keyword", label: "Keyword in title", weight: 10,
    status: titleHas ? "pass" : "fail",
    message: titleHas ? "The title contains the keyword." : `Add "${keyword}" to the title, ideally near the start.`
  });
  if (titleHas && seo.title) {
    const pos = tokens(seo.title).findIndex((_, i, arr) => kw.every((k, j) => arr[i + j] === k));
    add({
      id: "title_keyword_start", group: "Keyword", label: "Keyword near the start of the title", weight: 3,
      status: pos <= 2 ? "pass" : "warn",
      message: pos <= 2 ? "The keyword appears early in the title." : "Move the keyword closer to the start of the title."
    });
  }
  const descHas = contains(seo.metaDescription, kw);
  add({
    id: "description_keyword", group: "Keyword", label: "Keyword in meta description", weight: 5,
    status: descHas ? "pass" : "warn",
    message: descHas ? "The meta description mentions the keyword (search engines bold it)." : "Mention the keyword in the meta description."
  });
  const h1Has = seo.h1.some((h) => contains(h, kw));
  add({
    id: "h1_keyword", group: "Keyword", label: "Keyword in H1", weight: 8,
    status: h1Has ? "pass" : "fail",
    message: h1Has ? "The H1 contains the keyword." : seo.h1.length ? "Include the keyword in the H1 heading." : "Add an H1 heading containing the keyword."
  });
  const introHas = contains(seo.firstWords, kw);
  add({
    id: "intro_keyword", group: "Keyword", label: "Keyword in the first 100 words", weight: 6,
    status: introHas ? "pass" : "warn",
    message: introHas ? "The keyword appears early in the content." : "Use the keyword in the opening paragraph."
  });
  const subHas = seo.h2.some((h) => contains(h, kw));
  add({
    id: "subheading_keyword", group: "Keyword", label: "Keyword in a subheading (H2)", weight: 4,
    status: subHas ? "pass" : seo.h2.length ? "warn" : "warn",
    message: subHas ? "At least one H2 uses the keyword." : seo.h2.length ? "Use the keyword (or a close variant) in one H2." : "Break the content up with H2 subheadings, one using the keyword."
  });
  const urlHas = countPhrase(slug, kw) > 0 || kw.every((k) => slug.includes(k));
  add({
    id: "url_keyword", group: "Keyword", label: "Keyword in URL", weight: 5,
    status: urlHas ? "pass" : url.pathname === "/" ? "info" : "warn",
    message: urlHas ? "The URL contains the keyword." : url.pathname === "/" ? "Homepage URLs don't need the keyword." : "Consider a short URL slug containing the keyword (redirect the old URL if you change it)."
  });
  add({
    id: "density", group: "Keyword", label: "Keyword density", weight: 6,
    status: density === 0 ? "fail" : density < 0.5 ? "warn" : density > 3 ? "fail" : density > 2.5 ? "warn" : "pass",
    message:
      density === 0
        ? "The keyword doesn't appear in the body text."
        : density < 0.5
          ? `${density}% is low; use the keyword a little more naturally.`
          : density > 2.5
            ? `${density}% is high and can read as keyword stuffing; use synonyms instead.`
            : `${density}% (${kwCount} uses) is a natural level.`
  });
  const altHas = seo.images.alts.some((a) => contains(a, kw));
  if (seo.images.total > 0)
    add({
      id: "alt_keyword", group: "Keyword", label: "Keyword in an image alt", weight: 2,
      status: altHas ? "pass" : "warn",
      message: altHas ? "An image's alt text mentions the keyword." : "Describe a relevant image with alt text that includes the keyword."
    });

  // ── Content ──────────────────────────────────────────────────────────────
  const wc = seo.wordCount;
  add({
    id: "word_count", group: "Content", label: "Content length", weight: 10,
    status: wc >= 600 ? "pass" : wc >= 300 ? "warn" : "fail",
    message: wc >= 600 ? `${wc} words: substantial content.` : wc >= 300 ? `${wc} words: consider expanding to 600+ to cover the topic fully.` : `${wc} words is thin; aim for 600+ useful words.`
  });
  add({
    id: "readability", group: "Content", label: "Readability (Flesch)", weight: readability === null ? 0 : 5,
    status: readability === null ? "info" : readability >= 60 ? "pass" : readability >= 30 ? "warn" : "fail",
    message:
      readability === null
        ? english
          ? "Not enough text to score readability."
          : "Readability scoring is available for English pages only."
        : readability >= 60
          ? `${readability} (${readabilityLabel(readability)}): easy to read.`
          : `${readability} (${readabilityLabel(readability)}): use shorter sentences and simpler words.`
  });
  add({
    id: "single_h1", group: "Content", label: "One H1 heading", weight: 4,
    status: seo.h1.length === 1 ? "pass" : "warn",
    message: seo.h1.length === 1 ? "The page has exactly one H1." : seo.h1.length === 0 ? "Add an H1 heading." : `The page has ${seo.h1.length} H1s; keep one.`
  });
  if (seo.images.total > 0)
    add({
      id: "image_alts", group: "Content", label: "Images have alt text", weight: 4,
      status: seo.images.missingAlt === 0 ? "pass" : "warn",
      message: seo.images.missingAlt === 0 ? `All ${seo.images.total} images have alt text.` : `${seo.images.missingAlt} of ${seo.images.total} images have no alt attribute.`
    });

  // ── Meta ─────────────────────────────────────────────────────────────────
  add({
    id: "title_length", group: "Meta", label: "Title length", weight: 5,
    status: !seo.title ? "fail" : titleLen >= 30 && titleLen <= 60 ? "pass" : "warn",
    message: !seo.title ? "The page has no title." : `${titleLen} characters${titleLen > 60 ? ": likely truncated in search results" : titleLen < 30 ? ": room to say more" : " (30–60 is ideal)"}.`
  });
  add({
    id: "description_length", group: "Meta", label: "Meta description length", weight: 4,
    status: !seo.metaDescription ? "fail" : descLen >= 70 && descLen <= 160 ? "pass" : "warn",
    message: !seo.metaDescription ? "The page has no meta description." : `${descLen} characters${descLen > 160 ? ": likely truncated" : descLen < 70 ? ": a bit short" : " (70–160 is ideal)"}.`
  });
  add({
    id: "open_graph", group: "Meta", label: "Social sharing tags", weight: 2,
    status: seo.og.title && seo.og.image ? "pass" : "warn",
    message: seo.og.title && seo.og.image ? "Open Graph title and image are set." : "Add og:title and og:image for better social previews."
  });

  // ── Links ────────────────────────────────────────────────────────────────
  const internal = seo.internalLinks.length;
  add({
    id: "internal_links", group: "Links", label: "Internal links out", weight: 4,
    status: internal >= 3 ? "pass" : internal >= 1 ? "warn" : "fail",
    message: internal >= 3 ? `${internal} links to other pages on the site.` : "Link to at least 3 related pages on your site."
  });
  add({
    id: "external_links", group: "Links", label: "External links", weight: 2,
    status: seo.externalLinks.length >= 1 ? "pass" : "warn",
    message: seo.externalLinks.length ? `${seo.externalLinks.length} outbound links.` : "Cite at least one authoritative source where it helps the reader."
  });
  const inl = opts.inlinks ?? null;
  add({
    id: "inlinks", group: "Links", label: "Internal links pointing here", weight: inl === null ? 0 : 4,
    status: inl === null ? "info" : inl >= 3 ? "pass" : inl >= 1 ? "warn" : "fail",
    message: inl === null ? "Run a site audit to count internal links to this page." : inl === 0 ? "No crawled page links here; add internal links to it." : `${inl} crawled page${inl === 1 ? "" : "s"} link here.`
  });

  // ── Technical ────────────────────────────────────────────────────────────
  add({
    id: "indexable", group: "Technical", label: "Indexable", weight: 8,
    status: seo.noindex ? "fail" : "pass",
    message: seo.noindex ? "The page is set to noindex, so it can't rank." : "Search engines are allowed to index the page."
  });
  const canonicalSelf = seo.canonical === url.toString() || seo.canonical === pageUrl;
  add({
    id: "canonical", group: "Technical", label: "Canonical tag", weight: 3,
    status: !seo.canonical ? "warn" : canonicalSelf ? "pass" : "fail",
    message: !seo.canonical ? "Add a self-referencing canonical tag." : canonicalSelf ? "Canonical points to this page." : `Canonical points to ${seo.canonical}, so this page may not rank.`
  });
  add({
    id: "structured_data", group: "Technical", label: "Structured data", weight: 4,
    status: seo.jsonLd.blocks > seo.jsonLd.invalid || seo.microdata ? (seo.jsonLd.invalid ? "warn" : "pass") : "warn",
    message:
      seo.jsonLd.invalid > 0
        ? `${seo.jsonLd.invalid} JSON-LD block(s) can't be parsed.`
        : seo.jsonLd.types.length
          ? `Schema types: ${seo.jsonLd.types.slice(0, 5).join(", ")}.`
          : seo.microdata
            ? "Microdata markup found."
            : "Add relevant schema.org JSON-LD to qualify for rich results."
  });
  add({
    id: "https", group: "Technical", label: "HTTPS", weight: 3,
    status: url.protocol === "https:" && !seo.mixedContent.length ? "pass" : "fail",
    message: url.protocol !== "https:" ? "The page isn't served over HTTPS." : seo.mixedContent.length ? "The page loads insecure http:// resources." : "Served securely over HTTPS."
  });
  add({
    id: "viewport", group: "Technical", label: "Mobile viewport", weight: 3,
    status: seo.viewport ? "pass" : "fail",
    message: seo.viewport ? "Viewport meta tag present." : "Add a viewport meta tag for mobile rendering."
  });

  const scored = checks.filter((c) => c.status !== "info" && c.weight > 0);
  const total = scored.reduce((n, c) => n + c.weight, 0);
  const got = scored.reduce((n, c) => n + c.weight * (c.status === "pass" ? 1 : c.status === "warn" ? 0.5 : 0), 0);

  const t = truncate(seo.title ?? url.hostname, SERP.title);
  const d = truncate(seo.metaDescription ?? seo.firstWords.slice(0, 300), SERP.description);
  const crumbs = url.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
  return {
    score: total ? Math.round((100 * got) / total) : 0,
    checks,
    stats: {
      wordCount: wc,
      keywordCount: kwCount,
      densityPct: density,
      readability,
      readabilityLabel: readability === null ? null : readabilityLabel(readability),
      internalLinks: internal,
      externalLinks: seo.externalLinks.length,
      images: seo.images.total,
      inlinks: inl
    },
    serp: {
      title: t.text,
      titleTruncated: t.truncated,
      description: d.text,
      descriptionTruncated: d.truncated,
      breadcrumb: [url.hostname, ...crumbs].join(" › ")
    }
  };
}

import { describe, expect, it } from "vitest";
import { compareIssues, runAudit, validHreflang, type AuditInput } from "../src/audit";
import { RULES, RULES_LIST } from "../src/rules";
import { doc, site, U } from "./fixture-site";

const words = (n: number, seed: string) => Array.from({ length: n }, (_, i) => `${seed}${i % 40}`).join(" ");

/** A small site with one known problem (or cluster of problems) per URL. */
function fixture(extra: Partial<AuditInput> = {}) {
  const home = doc({
    path: "/",
    links: [
      "/about", "/blog", "/broken", "/moved", "/old-chain", "/dup-a", "/dup-b", "/noindex", "/thin", "/Upper_Case",
      "/canon", "/canon-bad", "/messy", "/slow", "/timeout", "/hreflang-en", "/private/x", "/server",
      "https://ext-ok.test/", "https://ext-dead.test/gone", "https://ext-blocked.test/"
    ]
  });
  const dup = (path: string) =>
    doc({ path, title: "Duplicate page title for testing", description: "The same description on two pages, which is long enough to pass the length check.", body: words(250, "dup"), canonical: U(path) });
  return site(
    {
      "/": { html: home },
      "/about": { html: doc({ path: "/about", links: ["/"] }) },
      "/blog": { html: doc({ path: "/blog", links: ["/blog/deep1"] }) },
      "/blog/deep1": { html: doc({ path: "/blog/deep1", links: ["/blog/deep2"] }) },
      "/blog/deep2": { html: doc({ path: "/blog/deep2", links: ["/blog/deep3"] }) },
      "/blog/deep3": { html: doc({ path: "/blog/deep3" }) },
      "/broken": { httpStatus: 404 },
      "/moved": { finalUrl: U("/about"), redirects: [U("/about")], redirectStatuses: [301], html: doc({ path: "/about", links: ["/"] }) },
      "/old-chain": { finalUrl: U("/about"), redirects: [U("/step"), U("/about")], redirectStatuses: [302, 301], html: doc({ path: "/about", links: ["/"] }) },
      "/dup-a": { html: dup("/dup-a") },
      "/dup-b": { html: dup("/dup-b") },
      "/noindex": { source: "sitemap", html: doc({ path: "/noindex", description: null, head: '<meta name="robots" content="noindex, follow">' }) },
      "/thin": { html: doc({ path: "/thin", body: "Just a few words here." }) },
      "/Upper_Case": { html: doc({ path: "/Upper_Case" }) },
      "/canon": { html: doc({ path: "/canon", canonical: U("/about") }) },
      "/canon-bad": { html: doc({ path: "/canon-bad", canonical: U("/broken") }) },
      "/messy": {
        html: doc({
          path: "/messy",
          title: null,
          description: null,
          h1: [],
          viewport: false,
          lang: null,
          og: false,
          schema: false,
          head: `<script type="application/ld+json">{ not json </script><link rel="canonical" href="${U("/messy")}">
                 <link rel="alternate" hreflang="en-UK" href="${U("/messy")}"><script src="http://cdn.fixture.test/x.js"></script>`,
          extraBody: `<img src="/a.png"><img src="/b.png" alt=""><a href="/about" rel="nofollow">n</a><a href="http://fixture.test/about">h</a>`
        })
      },
      "/orphan": { source: "sitemap", html: doc({ path: "/orphan" }) },
      "/slow": { durationMs: 4_000, bytes: 2_000_000, html: doc({ path: "/slow" }) },
      "/timeout": { status: "error", httpStatus: null, error: "Timed out" },
      "/hreflang-en": {
        html: doc({
          path: "/hreflang-en",
          head: `<link rel="alternate" hreflang="en" href="${U("/hreflang-en")}"><link rel="alternate" hreflang="de" href="${U("/hreflang-de")}">`,
          links: ["/hreflang-de"]
        })
      },
      "/hreflang-de": { html: doc({ path: "/hreflang-de" }) },
      "/private/x": { status: "skipped", httpStatus: null, skipReason: "Blocked by robots.txt" },
      "/server": { httpStatus: 500 },
      "/sitemap-gone": { source: "sitemap", httpStatus: 404 }
    },
    {
      externalChecks: [
        { url: "https://ext-ok.test/", outcome: "ok", httpStatus: 200 },
        { url: "https://ext-dead.test/gone", outcome: "broken", httpStatus: 404 },
        { url: "https://ext-blocked.test/", outcome: "unverifiable", httpStatus: 403 }
      ],
      ...extra
    }
  );
}

const EXPECTED: Record<string, string[]> = {
  "/": ["broken_external_link", "broken_internal_link", "internal_link_to_redirect"],
  "/about": [],
  "/blog": [],
  "/blog/deep1": [],
  "/blog/deep2": [],
  "/blog/deep3": ["deep_page"],
  "/broken": ["http_4xx"],
  "/moved": [],
  "/old-chain": ["redirect_chain", "temporary_redirect"],
  "/dup-a": ["duplicate_content", "duplicate_meta_description", "duplicate_title"],
  "/dup-b": ["duplicate_content", "duplicate_meta_description", "duplicate_title"],
  "/noindex": ["noindex_in_sitemap", "noindex_page"],
  "/thin": ["low_word_count"],
  "/Upper_Case": ["url_underscores", "url_uppercase"],
  "/canon": ["canonical_points_elsewhere"],
  "/canon-bad": ["canonical_points_elsewhere", "canonical_to_bad_url"],
  "/messy": [
    "hreflang_invalid", "images_missing_alt", "internal_http_links", "invalid_json_ld", "missing_h1", "missing_lang",
    "missing_meta_description", "missing_open_graph", "missing_title", "missing_viewport", "mixed_content",
    "multiple_canonicals", "nofollow_internal_links"
  ],
  "/orphan": ["orphan_page"],
  "/slow": ["page_too_large", "slow_response"],
  "/timeout": ["fetch_failed"],
  "/hreflang-en": ["hreflang_no_return"],
  "/hreflang-de": [],
  "/private/x": ["blocked_by_robots"],
  "/server": ["http_5xx"],
  "/sitemap-gone": ["http_4xx", "sitemap_bad_url"]
};

describe("audit rules on a fixture site", () => {
  const result = runAudit(fixture());
  const byPath = (path: string) =>
    result.issues
      .filter((i) => i.url === U(path))
      .map((i) => i.rule)
      .sort();

  for (const [path, rules] of Object.entries(EXPECTED)) {
    it(`${path} → ${rules.length ? rules.join(", ") : "no issues"}`, () => {
      expect(byPath(path)).toEqual([...rules].sort());
    });
  }

  it("reports no site-level issues for a healthy setup", () => {
    expect(result.issues.filter((i) => !i.url)).toEqual([]);
  });

  it("explains broken links with their targets", () => {
    const broken = result.issues.find((i) => i.rule === "broken_internal_link")!;
    expect(broken.details).toMatchObject({ count: 3 });
    expect(broken.details!.targets).toEqual(expect.arrayContaining([U("/broken"), U("/timeout"), U("/server")]));
    const ext = result.issues.find((i) => i.rule === "broken_external_link")!;
    expect(ext.details).toMatchObject({ count: 1, targets: [{ url: "https://ext-dead.test/gone", status: 404 }] });
    const http404 = result.issues.find((i) => i.rule === "http_4xx" && i.url === U("/broken"))!;
    expect(http404.details).toMatchObject({ status: 404, linkedFrom: [U("/")] });
  });

  it("computes inlinks and click depth", () => {
    expect(result.linkGraph[U("/blog/deep3")]).toEqual({ inlinks: 1, depth: 4 });
    expect(result.linkGraph[U("/orphan")]).toEqual({ inlinks: 0, depth: null });
    expect(result.linkGraph[U("/about")]!.inlinks).toBeGreaterThanOrEqual(1);
  });

  it("every issue references a catalogued rule with matching severity", () => {
    for (const i of result.issues) expect(RULES[i.rule]?.severity).toBe(i.severity);
  });

  it("scores health between 0 and 100 and counts severities", () => {
    expect(result.healthScore).toBeGreaterThan(0);
    expect(result.healthScore).toBeLessThan(100);
    expect(result.stats.critical + result.stats.warning + result.stats.notice).toBe(result.issues.length);
    expect(result.stats.pagesAnalyzed).toBe(24); // fetched + errors; skipped excluded
  });
});

describe("site-level rules", () => {
  const healthy = () => site({ "/": { html: doc({ path: "/" }) } });

  it("a single clean page scores 100", () => {
    const r = runAudit(healthy());
    expect(r.issues).toEqual([]);
    expect(r.healthScore).toBe(100);
  });

  it("flags a missing sitemap, missing robots.txt and the page limit", () => {
    const r = runAudit({ ...healthy(), sitemapUrlCount: 0, robotsStatus: 404, hitPageLimit: true });
    expect(r.issues.map((i) => i.rule).sort()).toEqual(["crawl_limit_reached", "robots_txt_missing", "sitemap_missing"]);
    expect(r.healthScore).toBe(97); // one site-level warning
  });

  it("flags http-only sites", () => {
    const input = healthy();
    input.startUrl = "http://fixture.test/";
    input.pages[0]!.url = "http://fixture.test/";
    expect(runAudit(input).issues.map((i) => i.rule)).toContain("no_https");
  });

  it("flags robots.txt blocking the homepage", () => {
    const r = runAudit(site({ "/": { status: "skipped", httpStatus: null, skipReason: "Blocked by robots.txt" } }));
    expect(r.issues.map((i) => i.rule)).toEqual(["robots_blocks_homepage"]);
    expect(r.healthScore).toBeNull();
  });
});

describe("helpers", () => {
  it("validates hreflang codes", () => {
    for (const ok of ["en", "en-GB", "x-default", "zh-Hant-TW", "es-419", "pt-br"]) expect(validHreflang(ok)).toBe(true);
    for (const bad of ["en-UK", "english", "en_GB", "", "e"]) expect(validHreflang(bad)).toBe(false);
  });

  it("compares two audits per rule", () => {
    const diff = compareIssues(
      [
        { rule: "missing_title", url: "a" },
        { rule: "missing_title", url: "b" },
        { rule: "sitemap_missing", url: null }
      ],
      [
        { rule: "missing_title", url: "b" },
        { rule: "missing_title", url: "c" },
        { rule: "missing_h1", url: "c" }
      ]
    );
    expect(diff).toEqual(
      expect.arrayContaining([
        { rule: "missing_title", before: 2, after: 2, added: 1, fixed: 1 },
        { rule: "sitemap_missing", before: 1, after: 0, added: 0, fixed: 1 },
        { rule: "missing_h1", before: 0, after: 1, added: 1, fixed: 0 }
      ])
    );
    expect(diff[0]!.rule).toBe("missing_title"); // critical first
  });

  it("has a unique, complete rule catalogue", () => {
    expect(new Set(RULES_LIST.map((r) => r.code)).size).toBe(RULES_LIST.length);
    expect(RULES_LIST.length).toBeGreaterThanOrEqual(40);
    for (const r of RULES_LIST) {
      expect(r.title.length).toBeGreaterThan(5);
      expect(r.explanation.length).toBeGreaterThan(20);
      expect(r.howToFix.length).toBeGreaterThan(10);
    }
  });
});

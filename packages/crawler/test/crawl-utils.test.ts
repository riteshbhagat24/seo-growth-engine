import { describe, expect, it } from "vitest";
import { extractPage, looksLikeHtml, normalizeCrawlUrl, parseRobots, parseSitemap, sameSite } from "../src/crawl-utils";

describe("normalizeCrawlUrl", () => {
  it.each([
    ["https://Example.com:443/a?utm_source=x&b=2&a=1#frag", undefined, "https://example.com/a?a=1&b=2"],
    ["/about", "https://example.com/blog/post", "https://example.com/about"],
    ["../x", "https://example.com/a/b/", "https://example.com/a/x"],
    ["http://example.com:80/", undefined, "http://example.com/"],
    ["?gclid=1", "https://example.com/p", "https://example.com/p"]
  ])("%s (base %s) → %s", (href, base, out) => {
    expect(normalizeCrawlUrl(href, base)).toBe(out);
  });

  it.each(["mailto:a@b.com", "javascript:alert(1)", "tel:+911234", "ftp://example.com/x", "https://u:p@example.com/", "http://[bad"])(
    "rejects %s",
    (href) => expect(normalizeCrawlUrl(href, "https://example.com/")).toBeNull()
  );
});

describe("site scope and file types", () => {
  it("treats www and bare host as the same site, nothing else", () => {
    expect(sameSite("https://www.example.com/x", "example.com")).toBe(true);
    expect(sameSite("https://example.com/x", "www.example.com")).toBe(true);
    expect(sameSite("https://blog.example.com/x", "example.com")).toBe(false);
    expect(sameSite("https://example.com.evil.net/x", "example.com")).toBe(false);
  });
  it("skips non-HTML resources", () => {
    expect(looksLikeHtml("https://example.com/report.PDF")).toBe(false);
    expect(looksLikeHtml("https://example.com/img/logo.png?v=2")).toBe(false);
    expect(looksLikeHtml("https://example.com/about")).toBe(true);
    expect(looksLikeHtml("https://example.com/page.html")).toBe(true);
  });
});

describe("extractPage", () => {
  it("collects followable links, title, base href and robots meta", () => {
    const html = `<html><head><title>  Hello
      World </title><base href="https://example.com/sub/"><meta name="ROBOTS" content="noindex, follow"></head>
      <body><a href="a">A</a><a href="/b#x">B</a><a href="https://other.net/">O</a>
      <a href="/c" rel="nofollow ugc">C</a><a href="mailto:x@y.z">M</a><a href="a">dup</a></body></html>`;
    const p = extractPage(html, "https://example.com/page");
    expect(p.title).toBe("Hello World");
    expect(p.links.sort()).toEqual(["https://example.com/b", "https://example.com/sub/a", "https://other.net/"]);
    expect(p).toMatchObject({ noindex: true, nofollow: false });
  });
});

describe("parseRobots (RFC 9309)", () => {
  const txt = `User-agent: *\nDisallow: /private\nCrawl-delay: 2\nSitemap: https://example.com/sitemap.xml\n\nUser-agent: SEOGrowthEngineBot\nDisallow: /no-bots\n`;
  it("applies the group for our token", () => {
    const r = parseRobots("https://example.com/robots.txt", 200, txt);
    expect(r.isAllowed("https://example.com/no-bots/x")).toBe(false);
    expect(r.isAllowed("https://example.com/private")).toBe(true); // our specific group overrides *
    expect(r.sitemaps).toEqual(["https://example.com/sitemap.xml"]);
  });
  it("uses * rules and crawl-delay when no specific group exists", () => {
    const r = parseRobots("https://example.com/robots.txt", 200, `User-agent: *\nDisallow: /private\nCrawl-delay: 2\n`);
    expect(r.isAllowed("https://example.com/private/a")).toBe(false);
    expect(r.isAllowed("https://example.com/public")).toBe(true);
    expect(r.crawlDelayMs).toBe(2000);
  });
  it("404 allows everything; 5xx or unreachable allows nothing", () => {
    expect(parseRobots("https://e.com/robots.txt", 404, "").isAllowed("https://e.com/x")).toBe(true);
    expect(parseRobots("https://e.com/robots.txt", 503, "").isAllowed("https://e.com/x")).toBe(false);
    expect(parseRobots("https://e.com/robots.txt", 0, "").isAllowed("https://e.com/x")).toBe(false);
  });
});

describe("parseSitemap", () => {
  it("reads urlsets and sitemap indexes", () => {
    const urlset = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc> https://example.com/a </loc></url><url><loc>https://example.com/b?utm_medium=x</loc></url></urlset>`;
    expect(parseSitemap(urlset, "https://example.com/sitemap.xml")).toEqual({
      pages: ["https://example.com/a", "https://example.com/b"],
      sitemaps: []
    });
    const index = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://example.com/s1.xml</loc></sitemap></sitemapindex>`;
    expect(parseSitemap(index, "https://example.com/sitemap.xml")).toEqual({ pages: [], sitemaps: ["https://example.com/s1.xml"] });
  });
});

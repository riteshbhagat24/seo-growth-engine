import { describe, expect, it } from "vitest";
import { extractSeo } from "@sge/crawler";
import { analyzeOnPage, countPhrase, fleschReadingEase, syllables, tokens } from "../src/onpage";

const para = (s: string, n: number) => Array.from({ length: n }, () => s).join(" ");

const GOOD = `<!doctype html><html lang="en"><head>
<title>Running Shoes Guide: How to Pick the Right Pair</title>
<meta name="description" content="Our running shoes guide explains cushioning, fit and support so you can choose the right pair for your stride and budget.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="canonical" href="https://shop.test/guides/running-shoes">
<meta property="og:title" content="Running shoes guide"><meta property="og:image" content="https://shop.test/og.png">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"Running shoes guide"}</script>
</head><body>
<h1>The Running Shoes Guide</h1>
<p>Choosing running shoes is easier than it looks. This guide walks through the basics step by step.</p>
<h2>How running shoes should fit</h2>
<p>${para("A good shoe fits well. It feels soft and light. You can run far in it. Try it on in the shop first.", 40)}</p>
<p>${para("Running shoes wear out over time.", 3)}</p>
<img src="/a.jpg" alt="Running shoes on a track"><img src="/b.jpg" alt="Laces">
<a href="/guides/socks">socks</a><a href="/guides/insoles">insoles</a><a href="/shop">shop</a>
<a href="https://example.org/study">study</a>
</body></html>`;

describe("on-page analyser", () => {
  it("scores a well-optimised page highly", () => {
    const url = "https://shop.test/guides/running-shoes";
    const r = analyzeOnPage(extractSeo(GOOD, url), url, "running shoes", { inlinks: 5 });
    const failing = r.checks.filter((c) => c.status === "fail" || c.status === "warn").map((c) => c.id);
    expect(failing).toEqual([]);
    expect(r.score).toBe(100);
    expect(r.stats.keywordCount).toBeGreaterThanOrEqual(6);
    expect(r.stats.densityPct).toBeGreaterThan(0.5);
    expect(r.stats.densityPct).toBeLessThan(2.5);
    expect(r.stats.readability).toBeGreaterThanOrEqual(60);
    expect(r.serp).toMatchObject({ title: "Running Shoes Guide: How to Pick the Right Pair", titleTruncated: false, breadcrumb: "shop.test › guides › running-shoes" });
  });

  it("flags missing keyword placement, thin content and noindex", () => {
    const html = `<html><head><title>Home</title><meta name="robots" content="noindex"></head><body><p>Welcome to our site.</p></body></html>`;
    const r = analyzeOnPage(extractSeo(html, "https://shop.test/"), "https://shop.test/", "trail running shoes");
    const status = Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
    expect(status).toMatchObject({
      title_keyword: "fail",
      h1_keyword: "fail",
      density: "fail",
      word_count: "fail",
      indexable: "fail",
      description_length: "fail",
      viewport: "fail",
      url_keyword: "info", // homepage
      inlinks: "info" // no audit yet
    });
    expect(r.score).toBeLessThan(30);
    expect(r.serp.breadcrumb).toBe("shop.test");
  });

  it("detects keyword stuffing", () => {
    const html = `<html lang="en"><head><title>Cheap shoes cheap shoes</title></head><body><h1>Cheap shoes</h1><p>${para("cheap shoes", 60)} and other words</p></body></html>`;
    const r = analyzeOnPage(extractSeo(html, "https://shop.test/cheap-shoes"), "https://shop.test/cheap-shoes", "cheap shoes");
    expect(r.checks.find((c) => c.id === "density")!.status).toBe("fail");
    expect(r.stats.densityPct).toBeGreaterThan(3);
  });

  it("truncates long SERP titles at a word boundary", () => {
    const long = "An extremely long page title that keeps going well past the sixty character limit";
    const r = analyzeOnPage(extractSeo(`<title>${long}</title>`, "https://a.test/x"), "https://a.test/x", "title");
    expect(r.serp.titleTruncated).toBe(true);
    expect(r.serp.title.endsWith(" …")).toBe(true);
    expect(r.serp.title.length).toBeLessThanOrEqual(62);
  });

  it("skips readability for non-English pages", () => {
    const html = `<html lang="de"><head><title>Laufschuhe</title></head><body><p>${para("Ein guter Schuh passt gut.", 50)}</p></body></html>`;
    const r = analyzeOnPage(extractSeo(html, "https://a.test/laufschuhe"), "https://a.test/laufschuhe", "Laufschuhe");
    expect(r.checks.find((c) => c.id === "readability")).toMatchObject({ status: "info", weight: 0 });
  });
});

describe("text helpers", () => {
  it("tokenises accents and punctuation", () => {
    expect(tokens("Café-Crème, NOW!")).toEqual(["cafe", "creme", "now"]);
    expect(countPhrase(tokens("red shoes, blue shoes, red shoes"), tokens("red shoes"))).toBe(2);
    expect(countPhrase(tokens("a a a"), tokens("a a"))).toBe(1);
  });

  it("estimates syllables and Flesch scores", () => {
    expect(syllables("cat")).toBe(1);
    expect(syllables("running")).toBe(2);
    expect(syllables("readability")).toBeGreaterThanOrEqual(4);
    expect(fleschReadingEase("Too short.")).toBeNull();
    const easy = fleschReadingEase(para("The cat sat on the mat. It was fun.", 10))!;
    const hard = fleschReadingEase(para("Notwithstanding considerable organisational complexity, interdepartmental communication necessitates comprehensive documentation.", 10))!;
    expect(easy).toBeGreaterThan(80);
    expect(hard).toBeLessThan(20);
  });
});

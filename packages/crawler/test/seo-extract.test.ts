import { describe, expect, it } from "vitest";
import { compactSeo, extractSeo } from "../src/seo-extract";

const HTML = `<!doctype html><html lang="en-GB"><head>
<title> Blue   Widgets | Shop </title><title>Second</title>
<meta name="description" content="Buy blue widgets.">
<meta name="ROBOTS" content="index, nofollow">
<meta name="viewport" content="width=device-width">
<link rel="canonical" href="/widgets/blue?utm_source=x">
<link rel="alternate" hreflang="en-gb" href="/widgets/blue"><link rel="alternate" hreflang="fr" href="https://shop.test/fr/widgets/bleu">
<meta property="og:title" content="Blue widgets"><meta property="og:image" content="">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Product"},{"@type":["BreadcrumbList","Thing"]}]}</script>
<script type="application/ld+json">{ broken </script>
<script src="http://cdn.shop.test/legacy.js"></script>
<style>.x{color:red}</style>
</head><body>
<h1>Blue widgets</h1><h1>Also blue</h1><h2>Sizes</h2><h3>Small</h3>
<p>These blue widgets are great.</p><div>Hidden?<script>var notText = 1;</script></div>
<img src="/a.png" alt="A blue widget"><img src="/b.png"><img src="http://shop.test/c.png" alt="">
<a href="/widgets/red">red</a><a href="/widgets/red#reviews">dup</a><a href="/cart" rel="nofollow">cart</a>
<a href="https://www.shop.test/about">www twin</a><a href="https://other.test/x?utm_medium=y">ext</a><a href="mailto:a@b.c">mail</a>
<a href="https://sponsor.test/" rel="sponsored nofollow">ad</a>
</body></html>`;

describe("extractSeo", () => {
  const s = extractSeo(HTML, "https://shop.test/widgets/blue", { headers: { "x-robots-tag": "noindex" } });

  it("reads head metadata", () => {
    expect(s).toMatchObject({
      title: "Blue Widgets | Shop",
      titleCount: 2,
      metaDescription: "Buy blue widgets.",
      descriptionCount: 1,
      canonical: "https://shop.test/widgets/blue",
      canonicalCount: 1,
      lang: "en-GB",
      viewport: true,
      metaRefresh: false,
      og: { title: true, description: false, image: false }
    });
  });

  it("combines meta robots and X-Robots-Tag", () => {
    expect(s.nofollow).toBe(true);
    expect(s.noindex).toBe(true);
    expect(extractSeo("<title>x</title>", "https://a.test/").noindex).toBe(false);
  });

  it("collects headings, hreflang and structured data", () => {
    expect(s.h1).toEqual(["Blue widgets", "Also blue"]);
    expect(s.h2).toEqual(["Sizes"]);
    expect(s.h3Count).toBe(1);
    expect(s.hreflang).toEqual([
      { lang: "en-gb", href: "https://shop.test/widgets/blue" },
      { lang: "fr", href: "https://shop.test/fr/widgets/bleu" }
    ]);
    expect(s.jsonLd).toEqual({ blocks: 2, invalid: 1, types: ["Product", "BreadcrumbList", "Thing"] });
  });

  it("classifies links: followed internal (incl. www twin), nofollow, external", () => {
    expect(s.internalLinks).toEqual(["https://shop.test/widgets/red", "https://www.shop.test/about"]);
    expect(s.nofollowInternal).toBe(1);
    expect(s.externalLinks).toEqual(["https://other.test/x"]);
  });

  it("finds images without alt and mixed content", () => {
    expect(s.images).toMatchObject({ total: 3, missingAlt: 1, missingAltSrcs: ["https://shop.test/b.png"], alts: ["A blue widget", ""] });
    expect(s.mixedContent.sort()).toEqual(["http://cdn.shop.test/legacy.js", "http://shop.test/c.png"]);
  });

  it("counts visible words only and hashes content", () => {
    expect(s.text).toContain("These blue widgets are great.");
    expect(s.text).not.toContain("notText");
    expect(s.text).not.toContain("color:red");
    expect(s.wordCount).toBe(s.text.split(" ").filter((w) => /[a-z0-9]/i.test(w)).length);
    expect(s.contentHash).toBeNull(); // under 20 words
    const long = (extra = "") => extractSeo(`<p>${"word ".repeat(30)}${extra}</p>`, "https://a.test/").contentHash;
    expect(long()).toMatch(/^[0-9a-f]{32}$/);
    expect(long()).toBe(long());
    expect(long("different")).not.toBe(long());
  });

  it("compactSeo drops the bulky text", () => {
    const c = compactSeo(s) as unknown as Record<string, unknown>;
    expect(c.text).toBeUndefined();
    expect(c.firstWords).toBeUndefined();
    expect(c.title).toBe("Blue Widgets | Shop");
  });

  it("http pages have no mixed content", () => {
    expect(extractSeo('<img src="http://x.test/a.png">', "http://a.test/").mixedContent).toEqual([]);
  });
});

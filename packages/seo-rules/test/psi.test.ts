import { describe, expect, it } from "vitest";
import { parsePsi, psiRequestUrl, rate } from "../src/psi";

/** Trimmed real-shape PSI v5 response. */
export const PSI_FIXTURE = {
  loadingExperience: {
    id: "https://shop.test/",
    metrics: {
      LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2100, category: "FAST" },
      INTERACTION_TO_NEXT_PAINT: { percentile: 240, category: "AVERAGE" },
      CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 5, category: "FAST" },
      FIRST_CONTENTFUL_PAINT_MS: { percentile: 1500, category: "FAST" },
      EXPERIMENTAL_TIME_TO_FIRST_BYTE: { percentile: 900, category: "AVERAGE" }
    },
    overall_category: "AVERAGE"
  },
  originLoadingExperience: { metrics: {} },
  lighthouseResult: {
    categories: { performance: { score: 0.82 } },
    audits: {
      "largest-contentful-paint": { numericValue: 2843.2 },
      "cumulative-layout-shift": { numericValue: 0.0412 },
      "total-blocking-time": { numericValue: 310.7 },
      "first-contentful-paint": { numericValue: 1210 },
      "speed-index": { numericValue: 3001 },
      "server-response-time": { numericValue: 420 },
      "render-blocking-resources": { title: "Eliminate render-blocking resources", score: 0.3, details: { type: "opportunity", overallSavingsMs: 650 } },
      "unused-javascript": { title: "Reduce unused JavaScript", score: 0.5, details: { type: "opportunity", overallSavingsMs: 900 } },
      "uses-text-compression": { title: "Enable text compression", score: 1, details: { type: "opportunity", overallSavingsMs: 0 } }
    }
  }
};

describe("PageSpeed Insights parsing", () => {
  it("extracts lab, field and opportunities", () => {
    const m = parsePsi(PSI_FIXTURE);
    expect(m.performanceScore).toBe(82);
    expect(m.lab).toEqual({ lcpMs: 2843, cls: 0.041, tbtMs: 311, fcpMs: 1210, speedIndexMs: 3001, ttfbMs: 420 });
    expect(m.field).toMatchObject({ scope: "page", overall: "AVERAGE", lcp: { p75: 2100, category: "FAST" }, cls: { p75: 0.05 }, inp: { p75: 240 } });
    expect(m.opportunities.map((o) => o.id)).toEqual(["unused-javascript", "render-blocking-resources"]);
  });

  it("falls back to origin field data, or none", () => {
    const origin = parsePsi({
      ...PSI_FIXTURE,
      loadingExperience: { origin_fallback: true, metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 1 } } },
      originLoadingExperience: { metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 3000, category: "AVERAGE" } }, overall_category: "AVERAGE" }
    });
    expect(origin.field).toMatchObject({ scope: "origin", lcp: { p75: 3000 } });
    const none = parsePsi({ lighthouseResult: PSI_FIXTURE.lighthouseResult });
    expect(none.field.scope).toBeNull();
  });

  it("throws on API errors", () => {
    expect(() => parsePsi({ error: { code: 429, message: "Quota exceeded" } })).toThrow("Quota exceeded");
  });

  it("builds request URLs and rates metrics", () => {
    const u = new URL(psiRequestUrl("https://shop.test/a?b=1", "mobile", "KEY"));
    expect(u.searchParams.get("url")).toBe("https://shop.test/a?b=1");
    expect(u.searchParams.get("strategy")).toBe("mobile");
    expect(u.searchParams.get("key")).toBe("KEY");
    expect(new URL(psiRequestUrl("https://x.test/", "desktop")).searchParams.has("key")).toBe(false);
    expect(rate("lcpMs", 2000)).toBe("good");
    expect(rate("inpMs", 300)).toBe("needs_improvement");
    expect(rate("cls", 0.3)).toBe("poor");
    expect(rate("cls", null)).toBeNull();
  });
});

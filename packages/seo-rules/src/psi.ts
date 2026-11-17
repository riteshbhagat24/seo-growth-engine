/** Google PageSpeed Insights v5 (free; optional API key for higher quota). */
export const PSI_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

export type Strategy = "mobile" | "desktop";
export type FieldCategory = "FAST" | "AVERAGE" | "SLOW" | null;

export interface FieldMetric {
  p75: number;
  category: FieldCategory;
}

export interface CwvMetrics {
  /** Lighthouse performance score 0–100. */
  performanceScore: number | null;
  lab: {
    lcpMs: number | null;
    cls: number | null;
    tbtMs: number | null;
    fcpMs: number | null;
    speedIndexMs: number | null;
    ttfbMs: number | null;
  };
  /** Chrome UX Report data (real users), when Google has enough traffic for the page or origin. */
  field: {
    scope: "page" | "origin" | null;
    overall: FieldCategory;
    lcp: FieldMetric | null;
    inp: FieldMetric | null;
    cls: FieldMetric | null;
    fcp: FieldMetric | null;
    ttfb: FieldMetric | null;
  };
  opportunities: { id: string; title: string; savingsMs: number }[];
}

export function psiRequestUrl(pageUrl: string, strategy: Strategy, apiKey?: string | null): string {
  const u = new URL(PSI_ENDPOINT);
  u.searchParams.set("url", pageUrl);
  u.searchParams.set("strategy", strategy);
  u.searchParams.set("category", "performance");
  if (apiKey) u.searchParams.set("key", apiKey);
  return u.toString();
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const cat = (v: unknown): FieldCategory => (v === "FAST" || v === "AVERAGE" || v === "SLOW" ? v : null);

function fieldMetric(metrics: Json, key: string, divide = 1): FieldMetric | null {
  const m = obj(metrics[key]);
  const p = num(m.percentile);
  return p === null ? null : { p75: Math.round((p / divide) * 1000) / 1000, category: cat(m.category) };
}

/** Extracts lab + field metrics from a PSI response body. Throws on an error payload. */
export function parsePsi(body: unknown): CwvMetrics {
  const root = obj(body);
  if (root.error) {
    const e = obj(root.error);
    throw new Error(typeof e.message === "string" ? e.message.slice(0, 300) : "PageSpeed Insights returned an error");
  }
  const lh = obj(root.lighthouseResult);
  const audits = obj(lh.audits);
  const val = (id: string) => num(obj(audits[id]).numericValue);
  const perf = num(obj(obj(lh.categories).performance).score);

  const pageExp = obj(root.loadingExperience);
  const originExp = obj(root.originLoadingExperience);
  const hasMetrics = (x: Json) => Object.keys(obj(x.metrics)).length > 0 && !x.origin_fallback;
  const scope = hasMetrics(pageExp) ? "page" : Object.keys(obj(originExp.metrics)).length ? "origin" : null;
  const exp = scope === "page" ? pageExp : scope === "origin" ? originExp : {};
  const metrics = obj(exp.metrics);

  const opportunities = Object.entries(audits)
    .map(([id, a]) => ({ id, a: obj(a) }))
    .filter(({ a }) => obj(a.details).type === "opportunity" && (num(a.score) ?? 1) < 0.9)
    .map(({ id, a }) => ({ id, title: String(a.title ?? id).slice(0, 200), savingsMs: Math.round(num(obj(a.details).overallSavingsMs) ?? 0) }))
    .filter((o) => o.savingsMs > 0)
    .sort((x, y) => y.savingsMs - x.savingsMs)
    .slice(0, 6);

  const round = (v: number | null) => (v === null ? null : Math.round(v));
  return {
    performanceScore: perf === null ? null : Math.round(perf * 100),
    lab: {
      lcpMs: round(val("largest-contentful-paint")),
      cls: (() => {
        const c = val("cumulative-layout-shift");
        return c === null ? null : Math.round(c * 1000) / 1000;
      })(),
      tbtMs: round(val("total-blocking-time")),
      fcpMs: round(val("first-contentful-paint")),
      speedIndexMs: round(val("speed-index")),
      ttfbMs: round(val("server-response-time"))
    },
    field: {
      scope,
      overall: cat(exp.overall_category),
      lcp: fieldMetric(metrics, "LARGEST_CONTENTFUL_PAINT_MS"),
      inp: fieldMetric(metrics, "INTERACTION_TO_NEXT_PAINT"),
      // CrUX reports CLS ×100.
      cls: fieldMetric(metrics, "CUMULATIVE_LAYOUT_SHIFT_SCORE", 100),
      fcp: fieldMetric(metrics, "FIRST_CONTENTFUL_PAINT_MS"),
      ttfb: fieldMetric(metrics, "EXPERIMENTAL_TIME_TO_FIRST_BYTE")
    },
    opportunities
  };
}

/** Google's Core Web Vitals thresholds ("good" upper bound, "poor" lower bound). */
export const CWV_THRESHOLDS = {
  lcpMs: [2500, 4000],
  inpMs: [200, 500],
  cls: [0.1, 0.25],
  fcpMs: [1800, 3000],
  ttfbMs: [800, 1800],
  tbtMs: [200, 600]
} as const;

export function rate(metric: keyof typeof CWV_THRESHOLDS, v: number | null): "good" | "needs_improvement" | "poor" | null {
  if (v === null) return null;
  const [good, poor] = CWV_THRESHOLDS[metric];
  return v <= good ? "good" : v <= poor ? "needs_improvement" : "poor";
}

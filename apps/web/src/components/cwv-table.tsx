import type { CwvResult } from "@sge/db/schema";
import { rate, type CwvMetrics, type FieldMetric } from "@sge/seo-rules";
import { scoreTone } from "./audit-ui";

type Rating = ReturnType<typeof rate>;
const TONE: Record<string, string> = { good: "text-success", needs_improvement: "text-warning", poor: "text-danger" };
const fieldTone: Record<string, string> = { FAST: "text-success", AVERAGE: "text-warning", SLOW: "text-danger" };

const ms = (v: number | null | undefined) => (v === null || v === undefined ? "–" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`);

function Cell({ value, rating }: { value: string; rating: Rating }) {
  return <td className={`px-3 py-2 text-right tabular-nums ${rating ? TONE[rating] : "text-muted"}`}>{value}</td>;
}
function FieldCell({ m, fmt }: { m: FieldMetric | null; fmt: (v: number) => string }) {
  return <td className={`px-3 py-2 text-right tabular-nums ${m?.category ? fieldTone[m.category] : "text-muted"}`}>{m ? fmt(m.p75) : "–"}</td>;
}

/** Latest mobile + desktop results for one URL. */
export function CwvTable({ rows }: { rows: CwvResult[] }) {
  const sorted = [...rows].sort((a, b) => a.strategy.localeCompare(b.strategy)).reverse(); // mobile first
  const done = sorted.filter((r) => r.status === "completed" && r.metrics) as (CwvResult & { metrics: CwvMetrics })[];
  const field = done.find((r) => r.metrics.field.scope)?.metrics.field;
  const when = sorted[0]!.measuredAt ?? sorted[0]!.createdAt;
  return (
    <div className="mt-4">
      <p className="text-xs text-muted">
        {new URL(sorted[0]!.url).pathname} · {when.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
      </p>
      {sorted.some((r) => r.status === "queued") && <p className="mt-2 text-sm text-muted">Measuring… this usually takes under a minute.</p>}
      {sorted
        .filter((r) => r.status === "failed")
        .map((r) => (
          <p key={r.id} className="mt-2 text-sm text-danger">
            {r.strategy === "mobile" ? "Mobile" : "Desktop"}: {r.error}
          </p>
        ))}
      {done.length > 0 && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Lab measurements</caption>
            <thead className="text-xs text-muted">
              <tr>
                <th className="py-2 text-left font-medium">Lab test</th>
                <th className="px-3 py-2 text-right font-medium">Score</th>
                <th className="px-3 py-2 text-right font-medium" title="Largest Contentful Paint">LCP</th>
                <th className="px-3 py-2 text-right font-medium" title="Cumulative Layout Shift">CLS</th>
                <th className="px-3 py-2 text-right font-medium" title="Total Blocking Time (lab proxy for INP)">TBT</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {done.map((r) => (
                <tr key={r.id}>
                  <th className="py-2 text-left font-medium capitalize">{r.strategy}</th>
                  <td className={`px-3 py-2 text-right font-semibold tabular-nums ${scoreTone(r.metrics.performanceScore)}`}>{r.metrics.performanceScore ?? "–"}</td>
                  <Cell value={ms(r.metrics.lab.lcpMs)} rating={rate("lcpMs", r.metrics.lab.lcpMs)} />
                  <Cell value={r.metrics.lab.cls?.toFixed(3) ?? "–"} rating={rate("cls", r.metrics.lab.cls)} />
                  <Cell value={ms(r.metrics.lab.tbtMs)} rating={rate("tbtMs", r.metrics.lab.tbtMs)} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {done.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          {field ? (
            <table className="w-full text-sm">
              <caption className="sr-only">Real-user measurements</caption>
              <thead className="text-xs text-muted">
                <tr>
                  <th className="py-2 text-left font-medium">Real users ({field.scope === "page" ? "this page" : "whole site"}, p75)</th>
                  <th className="px-3 py-2 text-right font-medium">LCP</th>
                  <th className="px-3 py-2 text-right font-medium">INP</th>
                  <th className="px-3 py-2 text-right font-medium">CLS</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th className={`py-2 text-left font-medium ${field.overall ? fieldTone[field.overall] : ""}`}>
                    {field.overall === "FAST" ? "Passes" : field.overall === "SLOW" ? "Fails" : field.overall === "AVERAGE" ? "Needs improvement" : "—"}
                  </th>
                  <FieldCell m={field.lcp} fmt={(v) => ms(v)} />
                  <FieldCell m={field.inp} fmt={(v) => ms(v)} />
                  <FieldCell m={field.cls} fmt={(v) => v.toFixed(2)} />
                </tr>
              </tbody>
            </table>
          ) : (
            <p className="text-xs text-muted">No real-user (CrUX) data: Google needs more traffic to this page or site.</p>
          )}
        </div>
      )}
      {done[0] && done[0].metrics.opportunities.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-brand">Top opportunities ({done[0].strategy})</summary>
          <ul className="mt-2 flex flex-col gap-1 text-muted">
            {done[0].metrics.opportunities.map((o) => (
              <li key={o.id}>
                {o.title} <span className="text-xs">(~{ms(o.savingsMs)})</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

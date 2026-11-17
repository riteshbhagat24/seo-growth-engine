import type { ReactNode } from "react";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export const scoreTone = (score: number | null) =>
  score === null ? "text-muted" : score >= 80 ? "text-success" : score >= 50 ? "text-warning" : "text-danger";

/** Circular 0–100 gauge. */
export function ScoreRing({ score, label, size = 112 }: { score: number | null; label: string; size?: number }) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const pct = score === null ? 0 : Math.max(0, Math.min(100, score)) / 100;
  return (
    <div className="flex flex-col items-center gap-1">
      <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label={`${label}: ${score ?? "not available"}${score === null ? "" : " out of 100"}`}>
        <circle cx="50" cy="50" r={r} fill="none" stroke="currentColor" strokeWidth="9" className="text-border" />
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={`${c * pct} ${c}`}
          transform="rotate(-90 50 50)"
          className={scoreTone(score)}
        />
        <text x="50" y="50" textAnchor="middle" dominantBaseline="central" className="fill-foreground text-[26px] font-semibold">
          {score ?? "–"}
        </text>
      </svg>
      <span className="text-xs text-muted">{label}</span>
    </div>
  );
}

const SEVERITY: Record<string, { label: string; cls: string }> = {
  critical: { label: "Critical", cls: "border-danger/30 bg-danger/5 text-danger" },
  warning: { label: "Warning", cls: "border-warning/30 bg-warning/5 text-warning" },
  notice: { label: "Notice", cls: "border-border bg-background text-muted" }
};

export function SeverityBadge({ severity }: { severity: string }) {
  const s = SEVERITY[severity] ?? SEVERITY.notice!;
  return <span className={cx("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium", s.cls)}>{s.label}</span>;
}

const AUDIT_STATUS: Record<string, string> = {
  crawling: "Crawling…",
  checking_links: "Checking links…",
  analyzing: "Analysing…",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled"
};
export const ACTIVE_AUDIT = ["crawling", "checking_links", "analyzing"];

export function AuditStatus({ status }: { status: string }) {
  const tone =
    status === "completed"
      ? "border-success/30 bg-success/5 text-success"
      : status === "failed"
        ? "border-danger/30 bg-danger/5 text-danger"
        : ACTIVE_AUDIT.includes(status)
          ? "border-brand/30 bg-brand/5 text-brand"
          : "border-border bg-background text-muted";
  return <span className={cx("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium", tone)}>{AUDIT_STATUS[status] ?? status}</span>;
}

/** Tiny trend line of health scores, oldest → newest. */
export function Sparkline({ values, label }: { values: number[]; label: string }) {
  if (values.length < 2) return null;
  const w = 120;
  const h = 32;
  const step = w / (values.length - 1);
  const y = (v: number) => h - 2 - (v / 100) * (h - 4);
  const d = values.map((v, i) => `${i ? "L" : "M"}${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${label}: ${values.join(", ")}`} className="text-brand">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={(values.length - 1) * step} cy={y(values.at(-1)!)} r="3" fill="currentColor" />
    </svg>
  );
}

export function Delta({ value, invert = false, suffix = "" }: { value: number; invert?: boolean; suffix?: string }) {
  if (value === 0) return <span className="text-muted">±0{suffix}</span>;
  const good = invert ? value < 0 : value > 0;
  return (
    <span className={good ? "text-success" : "text-danger"}>
      {value > 0 ? "+" : "−"}
      {Math.abs(value)}
      {suffix}
    </span>
  );
}

export function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 text-2xl font-semibold">{children}</dd>
    </div>
  );
}

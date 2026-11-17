import Link from "next/link";
import type { ReactNode } from "react";
import { cx } from "./ui";

/**
 * Ranked list with a magnitude bar per row (single hue; length encodes the
 * value, the number is always printed so the bar is never the only cue).
 */
export function BarList({
  rows,
  valueLabel,
  format = (n) => Math.round(n).toLocaleString("en-IN"),
  extra
}: {
  rows: { key: string; label: ReactNode; value: number; href?: string; title?: string }[];
  valueLabel: string;
  format?: (n: number) => string;
  extra?: { label: string; render: (key: string) => ReactNode }[];
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <p className="py-6 text-center text-sm text-subtle">No data for this period.</p>;
  return (
    <table className="w-full table-fixed text-sm">
      <thead>
        <tr className="text-left text-xs text-muted">
          <th className="pb-2 font-medium">
            <span className="sr-only">Item</span>
          </th>
          {extra?.map((e) => (
            <th key={e.label} className="w-20 pb-2 text-right font-medium">
              {e.label}
            </th>
          ))}
          <th className="w-20 pb-2 text-right font-medium">{valueLabel}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="group">
            <td className="py-1 pr-3">
              <div className="relative overflow-hidden rounded-md">
                <div className="absolute inset-y-0 left-0 rounded-md bg-series-1-soft/70" style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} aria-hidden />
                <div className="relative truncate px-2 py-1" title={r.title}>
                  {r.label}
                </div>
              </div>
            </td>
            {extra?.map((e) => (
              <td key={e.label} className="py-1 text-right tabular-nums text-muted">
                {e.render(r.key)}
              </td>
            ))}
            <td className="py-1 text-right font-medium tabular-nums">{format(r.value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Tab strip for sub-pages (server-rendered; `current` decides the active tab). */
export function Tabs({ items, current, label }: { items: { key: string; label: string; href: string; count?: number }[]; current: string; label: string }) {
  return (
    <nav className="-mb-px flex gap-1 overflow-x-auto border-b border-border" aria-label={label}>
      {items.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === current ? "page" : undefined}
          className={cx(
            "whitespace-nowrap border-b-2 border-transparent px-3 py-2.5 text-sm text-muted transition hover:text-foreground",
            "aria-[current=page]:border-brand aria-[current=page]:font-medium aria-[current=page]:text-foreground"
          )}
        >
          {t.label}
          {t.count !== undefined && <span className="ml-1.5 rounded-full bg-surface-2 px-1.5 text-xs text-subtle">{t.count}</span>}
        </Link>
      ))}
    </nav>
  );
}

/** A setup step for onboarding checklists. */
export function Step({ done, title, children, action }: { done: boolean; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <li className="flex items-start gap-3 py-3">
      <span
        aria-hidden
        className={cx(
          "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border text-[11px] font-bold",
          done ? "border-success bg-success text-white" : "border-border-strong bg-surface text-transparent"
        )}
      >
        ✓
      </span>
      <div className="min-w-0 flex-1">
        <div className={cx("text-sm font-medium", done && "text-muted line-through")}>
          {title}
          <span className="sr-only">{done ? " (done)" : " (to do)"}</span>
        </div>
        {children && !done && <div className="mt-0.5 text-sm text-muted">{children}</div>}
      </div>
      {action && !done && <div className="shrink-0">{action}</div>}
    </li>
  );
}
